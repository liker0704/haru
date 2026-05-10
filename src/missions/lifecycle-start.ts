/**
 * Mission start and resume operations.
 */

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { resumeAgent } from "../commands/resume.ts";
import { loadConfig } from "../config.ts";
import { jsonError, jsonOutput } from "../json.ts";
import { accent, printError, printHint, printSuccess, printWarning } from "../logging/color.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { createRunStore } from "../sessions/store.ts";
import type { InsertMission } from "../types.ts";
import { createWatchdogControl } from "../watchdog/control.ts";
import { attachOrSwitch, listSessions } from "../worktree/tmux.ts";
import {
	buildMissionRoleBeacon,
	ensureMissionArtifacts,
	materializeMissionRolePrompt,
} from "./context.ts";
import { shouldUseEngine, transitionMissionViaEngine } from "./engine-wiring.ts";
import { recordMissionEvent } from "./events.ts";
import { resolveCurrentMissionId, toSummary } from "./lifecycle-helpers.ts";
import type { MissionCommandDeps } from "./lifecycle-types.ts";
import {
	drainAgentInbox,
	nudgeMissionRoleBestEffort,
	sendMissionControlMail,
	sendMissionDispatchMail,
} from "./messaging.ts";
import { startMissionAnalyst, startMissionCoordinator, stopMissionRole } from "./roles.ts";
import { removeActiveMission, writeMissionRuntimePointers } from "./runtime-context.ts";
import { createMissionStore } from "./store.ts";

// === ha mission start ===

interface StartOpts {
	slug?: string;
	objective?: string;
	json?: boolean;
	attach?: boolean;
	/** Stage A: mission autonomy level — controls intake gates. Default `supervised`. */
	autonomy?: import("../types.ts").MissionAutonomy;
}

export async function missionStart(
	overstoryDir: string,
	projectRoot: string,
	opts: StartOpts,
	deps: MissionCommandDeps = {},
): Promise<void> {
	const slug = opts.slug ?? `mission-${Date.now()}`;
	const objective = opts.objective ?? "Pending — clarifier will resolve from intent";

	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);
	const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-mission`;
	const missionId = `mission-${Date.now()}-${slug}`;
	const artifactRoot = join(overstoryDir, "missions", missionId);
	let missionCreated = false;
	// Stage A: no coordinator spawned at start; intake-phase drives.
	// `coordinatorStarted` and `analystStarted` retained as `false` so the
	// catch-block cleanup loop is a no-op for these roles (intake-phase
	// agents are leaf-spawn via `ha sling` and clean themselves up).
	const coordinatorStarted = false;
	const analystStarted = false;
	const stopRole = deps.stopMissionRole ?? stopMissionRole;

	try {
		const config = await loadConfig(projectRoot);
		const maxConcurrent = config.mission?.maxConcurrent ?? 1;
		const activeMissions = missionStore.getActiveList();
		if (activeMissions.length >= maxConcurrent) {
			const listing = activeMissions.map((m) => m.slug).join(", ");
			if (opts.json) {
				jsonError(
					"mission start",
					`Maximum concurrent missions reached (${activeMissions.length} active, limit ${maxConcurrent})`,
				);
			} else {
				printError(
					`Maximum concurrent missions reached (${activeMissions.length} active, limit ${maxConcurrent})`,
				);
				printHint(`Active missions: ${listing}`);
				printHint("Stop one first with: ha mission stop");
			}
			process.exitCode = 1;
			return;
		}

		const runStore = createRunStore(dbPath);
		try {
			runStore.createRun({
				id: runId,
				startedAt: new Date().toISOString(),
				coordinatorSessionId: null,
				coordinatorName: "coordinator",
				status: "active",
			});
		} finally {
			runStore.close();
		}

		const insertMission: InsertMission = {
			id: missionId,
			slug,
			objective,
			runId,
			artifactRoot,
			startedAt: new Date().toISOString(),
			tier: null,
			autonomy: opts.autonomy ?? "supervised",
		};
		const createdMission = missionStore.create(insertMission);
		missionCreated = true;
		missionStore.start(missionId);
		// Stage A: missions begin in `intake` phase. The engine seeds
		// currentNode from `${phase}:active` automatically when null.
		// The intake-phase subgraph drives clarifier + tier-classifier; once
		// `ha mission tier set` fires, the operational coordinator is spawned
		// by `tierSetCommand`.
		missionStore.updatePhase(missionId, "intake");
		missionStore.updateCurrentNode(missionId, "intake:active");
		const mission = missionStore.getById(missionId) ?? createdMission;

		await mkdir(artifactRoot, { recursive: true });

		await ensureMissionArtifacts(mission);
		await writeMissionRuntimePointers(overstoryDir, mission.id, runId);

		// Stage A: no coordinator spawned at mission-start. The intake-phase
		// subgraph (running inside the watchdog/engine) takes over from here:
		//   1. dispatch-analyst-intake — spawns mission-analyst-intake
		//   2. dispatch-clarifier — spawns product-clarifier (interacts with
		//      operator via `ha mail send --to operator --type question`)
		//   3. dispatch-tier-classifier — calls `ha mission tier set <tier>`
		//   4. tier-set spawns the operational coordinator (direct/planned/full)
		//      via `tierSetCommand`.
		//
		// Legacy `coordinator-mission-assess.md` is no longer the entry agent.
		// Resume of pre-Stage-A missions is still supported via
		// `restartMissionRoles()` below (which keeps the assess-tier branch).
		recordMissionEvent({
			overstoryDir,
			mission,
			agentName: "operator",
			data: {
				kind: "mission_started",
				detail: "Mission started — intake-phase subgraph will drive intake",
			},
		});

		// Auto-start watchdog for rate-limit detection and health monitoring
		try {
			const config = await loadConfig(projectRoot);
			if (config.watchdog.tier0Enabled) {
				const watchdog = createWatchdogControl(projectRoot);
				const watchdogResult = await watchdog.start();
				if (watchdogResult && !opts.json) {
					printHint("Watchdog started");
				}
			}
			// Guard: note graph execution engine availability (advisory only)
			if (shouldUseEngine(mission, config)) {
				recordMissionEvent({
					overstoryDir,
					mission,
					agentName: "operator",
					data: { kind: "engine_available", detail: "Graph execution engine is enabled" },
				});
			}
		} catch {
			if (!opts.json) printWarning("Watchdog failed to start");
		}

		if (opts.json) {
			jsonOutput("mission start", { mission: toSummary(mission), runId });
		} else {
			printSuccess("Mission started", mission.slug);
			process.stdout.write(`  ID:          ${accent(mission.id)}\n`);
			process.stdout.write(`  Objective:   ${mission.objective}\n`);
			process.stdout.write(`  Run:         ${runId}\n`);
			process.stdout.write(`  Artifacts:   ${artifactRoot}\n`);
			process.stdout.write(`  Phase:       ${accent("intake")}\n`);
			process.stdout.write(`  Tier:        ${accent("null (set after classifier)")}\n`);
		}
	} catch (err) {
		for (const roleName of ["coordinator", "mission-analyst"]) {
			if (roleName === "coordinator" && !coordinatorStarted) continue;
			if (roleName === "mission-analyst" && !analystStarted) continue;
			try {
				await stopRole(roleName, {
					projectRoot,
					overstoryDir,
					completeRun: false,
				});
			} catch {
				// Best-effort cleanup.
			}
		}
		if (missionCreated) {
			missionStore.delete(missionId);
		}
		try {
			const runStore = createRunStore(dbPath);
			try {
				runStore.completeRun(runId, "stopped");
			} finally {
				runStore.close();
			}
		} catch {
			// Best-effort cleanup.
		}
		if (missionCreated) {
			await removeActiveMission(overstoryDir, missionId);
		}
		await rm(artifactRoot, { recursive: true, force: true });

		const message = err instanceof Error ? err.message : String(err);
		if (opts.json) {
			jsonError("mission start", message);
		} else {
			printError("Mission start failed", message);
		}
		process.exitCode = 1;
	} finally {
		missionStore.close();
	}
}

/**
 * Restart coordinator and mission-analyst from scratch against an existing mission.
 * Used by resume when prior sessions are gone (e.g. after --kill).
 */
async function restartMissionRoles(
	overstoryDir: string,
	projectRoot: string,
	mission: import("../types.ts").Mission,
): Promise<void> {
	if (!mission.runId) {
		throw new Error(`Mission ${mission.id} has no runId — cannot restart roles`);
	}
	const runId = mission.runId;
	const tier = mission.tier;

	// Stage A: tier=null means mission is still in intake phase — there are no
	// persistent roles to restart. The intake-phase subgraph (driven by the
	// watchdog tick) re-spawns ephemeral clarifier/analyst-intake/tier-classifier
	// agents on the next tick if needed.
	if (tier === null) {
		return;
	}

	// Slug-scoped agent names (mirrors missionStart pattern)
	const coordAgentName = mission.slug ? `coordinator-${mission.slug}` : "coordinator";
	const analystAgentName = mission.slug ? `mission-analyst-${mission.slug}` : "mission-analyst";
	const edAgentName = mission.slug ? `execution-director-${mission.slug}` : "execution-director";

	// Tier-aware coordinator capability
	let coordCapability: string;
	const siblingNames: Record<string, string> = {};
	if (tier === "direct") {
		coordCapability = "coordinator-mission-direct";
	} else if (tier === "planned") {
		coordCapability = "coordinator-mission-planned";
		siblingNames["Mission Analyst agent"] = analystAgentName;
	} else {
		// tier === "full"
		coordCapability = "coordinator-mission";
		siblingNames["Mission Analyst agent"] = analystAgentName;
		siblingNames["Execution Director agent"] = edAgentName;
	}

	const coordPrompt = await materializeMissionRolePrompt({
		overstoryDir,
		agentName: coordAgentName,
		capability: coordCapability,
		roleLabel: "Mission Coordinator",
		mission,
		siblingNames,
	});
	drainAgentInbox(overstoryDir, coordAgentName);

	const coordResult = await startMissionCoordinator({
		missionId: mission.id,
		missionSlug: mission.slug,
		agentName: coordAgentName,
		projectRoot,
		overstoryDir,
		existingRunId: runId,
		appendSystemPromptFile: coordPrompt.promptPath,
		beacon: buildMissionRoleBeacon({
			agentName: coordAgentName,
			missionId: mission.id,
			contextPath: coordPrompt.contextPath,
		}),
	});

	const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
	try {
		missionStore.bindCoordinatorSession(mission.id, coordResult.session.id);
	} finally {
		missionStore.close();
	}

	// Conditionally spawn analyst — only for planned/full tiers
	if (tier === "planned" || tier === "full") {
		const analystCapability = tier === "planned" ? "mission-analyst-planned" : "mission-analyst";
		const analystPrompt = await materializeMissionRolePrompt({
			overstoryDir,
			agentName: analystAgentName,
			capability: analystCapability,
			roleLabel: "Mission Analyst",
			mission,
			siblingNames: {
				"Coordinator agent": coordAgentName,
			},
		});
		drainAgentInbox(overstoryDir, analystAgentName);

		const analystResult = await startMissionAnalyst({
			missionId: mission.id,
			missionSlug: mission.slug,
			agentName: analystAgentName,
			projectRoot,
			overstoryDir,
			existingRunId: runId,
			appendSystemPromptFile: analystPrompt.promptPath,
			beacon: buildMissionRoleBeacon({
				agentName: analystAgentName,
				missionId: mission.id,
				contextPath: analystPrompt.contextPath,
			}),
		});

		const missionStore2 = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			missionStore2.bindSessions(mission.id, { analystSessionId: analystResult.session.id });
		} finally {
			missionStore2.close();
		}

		// Notify analyst of resumed mission
		await sendMissionControlMail({
			overstoryDir,
			to: analystAgentName,
			subject: `Mission resumed: ${mission.slug}`,
			body: [
				`Mission ID: ${mission.id}`,
				`Objective: ${mission.objective}`,
				`Artifact root: ${mission.artifactRoot ?? "none"}`,
				`Context file: ${analystPrompt.contextPath}`,
				"",
				"This mission is being RESUMED. Check artifacts for prior analysis.",
				"Report findings to coordinator via mail.",
			].join("\n"),
			type: "dispatch",
		});
		await nudgeMissionRoleBestEffort(
			projectRoot,
			analystAgentName,
			`Mission resumed: ${mission.slug}. Check mail and review prior work.`,
		);
	}

	// Notify coordinator of resumed mission
	const analystNote =
		tier === "planned" || tier === "full"
			? "Mission Analyst is running and available for research queries via mail."
			: "";
	await sendMissionDispatchMail({
		overstoryDir,
		to: coordAgentName,
		subject: `Mission resumed: ${mission.slug}`,
		body: [
			`Mission ID: ${mission.id}`,
			`Objective: ${mission.objective}`,
			`Artifact root: ${mission.artifactRoot ?? "none"}`,
			`Context file: ${coordPrompt.contextPath}`,
			"",
			"This mission is being RESUMED (not started fresh).",
			"Check the mission artifacts directory for prior work.",
			analystNote,
		]
			.filter(Boolean)
			.join("\n"),
	});
	await nudgeMissionRoleBestEffort(
		projectRoot,
		coordAgentName,
		`Mission resumed: ${mission.slug}. Check mail and review prior artifacts.`,
	);
}

export async function missionResumeAll(
	overstoryDir: string,
	projectRoot: string,
	json: boolean,
	missionId?: string,
): Promise<void> {
	// Find suspended mission
	const resolvedMissionId = missionId ?? (await resolveCurrentMissionId(overstoryDir));
	const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
	try {
		let mission: import("../types.ts").Mission | undefined;
		if (resolvedMissionId) {
			mission = missionStore.getById(resolvedMissionId) ?? undefined;
		}
		if (!mission || mission.state !== "suspended") {
			// Try finding most recent suspended mission
			const suspended = missionStore.list({ state: "suspended", limit: 1 });
			mission = suspended[0];
		}
		if (!mission) {
			if (json) {
				jsonError("mission resume", "No suspended mission to resume");
			} else {
				printError("No suspended mission to resume");
			}
			process.exitCode = 1;
			return;
		}

		// Restore mission state
		const transResult = await transitionMissionViaEngine(mission.id, "resume", {
			checkpointStore: missionStore.checkpoints,
			missionStore,
		});
		if (transResult.status === "error") {
			printWarning("Graph transition failed", transResult.error ?? "unknown");
		}
		missionStore.updateState(mission.id, "active");
		recordMissionEvent({
			overstoryDir,
			mission,
			agentName: "operator",
			data: { kind: "state_change", from: "suspended", to: "active" },
		});

		// Reactivate the run if it was stopped/completed by a prior kill
		if (mission.runId) {
			const runStore = createRunStore(join(overstoryDir, "sessions.db"));
			try {
				const run = runStore.getRun(mission.runId);
				if (run && run.status !== "active") {
					runStore.reactivateRun(mission.runId);
				}
			} finally {
				runStore.close();
			}
		}

		// Ensure runtime pointers are written
		await writeMissionRuntimePointers(overstoryDir, mission.id, mission.runId ?? null);

		// Find all resumable agents from this mission's run
		const config = await loadConfig(projectRoot);
		const { store } = openSessionStore(overstoryDir);
		try {
			const aliveSessions = new Set((await listSessions()).map((s) => s.name));
			const allSessions = mission.runId ? store.getByRun(mission.runId) : [];
			const resumable = allSessions.filter((s) => {
				if (s.state === "completed") return false;
				if (aliveSessions.has(s.tmuxSession)) return false;
				return true;
			});

			// Resume persistent roles first, then workers (by depth)
			const roleNames = new Set(["coordinator", "mission-analyst", "execution-director"]);
			const roles = resumable.filter((s) => roleNames.has(s.agentName));
			const workers = resumable
				.filter((s) => !roleNames.has(s.agentName))
				.sort((a, b) => a.depth - b.depth);
			const ordered = [...roles, ...workers];

			const results: Array<{ agentName: string; success: boolean; error?: string }> = [];

			if (ordered.length === 0) {
				// No resumable sessions — restart roles fresh against existing mission
				await restartMissionRoles(overstoryDir, projectRoot, mission);
				results.push({ agentName: "coordinator", success: true });
				results.push({ agentName: "mission-analyst", success: true });
				if (!json) {
					printSuccess("Restarted coordinator and mission-analyst (no prior sessions to resume)");
				}
			} else {
				for (const session of ordered) {
					try {
						await resumeAgent(session, config, projectRoot);
						results.push({ agentName: session.agentName, success: true });
						if (!json) {
							printSuccess(`Resumed ${session.agentName}`);
						}
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						results.push({ agentName: session.agentName, success: false, error: msg });
						if (!json) {
							printWarning(`Failed to resume ${session.agentName}: ${msg}`);
						}
					}
				}
			}

			// Auto-start watchdog for rate-limit detection and health monitoring
			try {
				if (config.watchdog.tier0Enabled) {
					const watchdog = createWatchdogControl(projectRoot);
					const watchdogResult = await watchdog.start();
					if (watchdogResult && !json) {
						printHint("Watchdog started");
					}
				}
			} catch {
				if (!json) printWarning("Watchdog failed to start");
			}

			if (json) {
				jsonOutput("mission resume", {
					missionId: mission.id,
					slug: mission.slug,
					state: "active",
					resumed: results,
				});
			}
		} finally {
			store.close();
		}
	} finally {
		missionStore.close();
	}
}
