/**
 * Mission role lifecycle management.
 *
 * Wraps the persistent-root abstraction for mission-coordinator,
 * mission-analyst, and execution-director agents. All roles run at the
 * project root (no worktree), are linked to the mission's run, and follow
 * the same tmux-based lifecycle.
 */

import { join } from "node:path";
import type {
	StartPersistentAgentOpts,
	StartPersistentAgentResult,
	StopPersistentAgentResult,
} from "../agents/persistent-root.ts";
import { startPersistentAgent, stopPersistentAgent } from "../agents/persistent-root.ts";
import { AgentError } from "../errors.ts";
import type { Mission, MissionStore } from "../types.ts";
import {
	buildMissionRoleBeacon,
	type MaterializedMissionRolePrompt,
	materializeMissionRolePrompt,
} from "./context.ts";
import { drainAgentInbox } from "./messaging.ts";
import { createMissionStore } from "./store.ts";

// === Interfaces ===

/** Options for starting a mission role (analyst or execution-director). */
export interface StartMissionRoleOpts {
	/** Mission ID to bind the session to. */
	missionId: string;
	/** Absolute path to the project root. */
	projectRoot: string;
	/** Absolute path to the .overstory directory. */
	overstoryDir: string;
	/** Mission-owned run ID to link the agent to. */
	existingRunId: string;
	/** Optional role-specific prompt file override. */
	appendSystemPromptFile?: string;
	/** Optional inline prompt suffix override. */
	appendSystemPrompt?: string;
	/** Optional startup beacon. */
	beacon?: string;
	/** Mission slug for scoped tmux session naming. */
	missionSlug?: string;
	/** Override agent name for parallel mission support. */
	agentName?: string;
	/** Capability variant. Defaults to the role's legacy capability (e.g.
	 *  "mission-analyst") when omitted. Used by intake-phase and tier-set to
	 *  spawn role variants like "mission-analyst-intake" or
	 *  "mission-analyst-planned". */
	capability?: string;
}

/** Options for stopping a mission role. */
export interface StopMissionRoleOpts {
	/** Absolute path to the project root. */
	projectRoot: string;
	/** Absolute path to the .overstory directory. */
	overstoryDir: string;
	/** Whether stopping this role should also complete the shared run. */
	completeRun?: boolean;
	/** Shared run terminal status when completeRun is enabled. */
	runStatus?: "completed" | "stopped";
}

/** Internal dependency injection — used in tests to avoid real tmux and store I/O. */
export interface MissionRoleDeps {
	startAgent?: (opts: StartPersistentAgentOpts) => Promise<StartPersistentAgentResult>;
	stopAgent?: (
		agentName: string,
		opts: {
			projectRoot: string;
			overstoryDir: string;
			runStatus?: "completed" | "stopped";
			completeRun?: boolean;
		},
	) => Promise<StopPersistentAgentResult>;
	createStore?: (dbPath: string) => MissionStore;
	/** Override prompt materialization — used by ensureArchitect tests to
	 *  avoid real filesystem writes. */
	materializePrompt?: (opts: {
		overstoryDir: string;
		agentName: string;
		capability: string;
		roleLabel: string;
		mission: Mission;
		siblingNames?: Record<string, string>;
	}) => Promise<{ promptPath: string; contextPath: string }>;
	/** Override inbox drain — used by ensureArchitect tests to avoid real
	 *  mail-store mutation. */
	drainInbox?: (overstoryDir: string, agentName: string) => void;
	/** Override session liveness check — used by ensureArchitect tests to
	 *  avoid real session-store I/O. Returns true when the named role agent
	 *  is alive (not completed/zombie). */
	isRoleSessionAlive?: (overstoryDir: string, agentName: string) => boolean;
}

// === Role Lifecycle ===

/**
 * Start the mission-analyst persistent root agent.
 *
 * Calls startPersistentAgent with capability='mission-analyst', links the
 * resulting session to the mission via MissionStore.bindSessions, and returns
 * the start result.
 */
export async function startMissionAnalyst(
	opts: StartMissionRoleOpts,
	_deps?: MissionRoleDeps,
): Promise<StartPersistentAgentResult> {
	const startAgent = _deps?.startAgent ?? startPersistentAgent;
	const storeFactory = _deps?.createStore ?? createMissionStore;

	const analystName = opts.agentName ?? "mission-analyst";
	const tmuxSession = opts.missionSlug ? `ha-analyst-${opts.missionSlug}` : "ha-mission-analyst";

	const result = await startAgent({
		agentName: analystName,
		capability: opts.capability ?? "mission-analyst",
		projectRoot: opts.projectRoot,
		overstoryDir: opts.overstoryDir,
		tmuxSession,
		createRun: false,
		existingRunId: opts.existingRunId,
		appendSystemPromptFile: opts.appendSystemPromptFile,
		appendSystemPrompt: opts.appendSystemPrompt,
		beacon: opts.beacon,
	});

	const store = storeFactory(join(opts.overstoryDir, "sessions.db"));
	try {
		const mission = store.getById(opts.missionId);
		if (!mission) {
			throw new AgentError(`Mission not found: ${opts.missionId}`, {
				agentName: "mission-analyst",
			});
		}
		store.bindSessions(opts.missionId, { analystSessionId: result.session.id });
	} finally {
		store.close();
	}

	return result;
}

/**
 * Mission analyst role variant. Determines which capability/.md is loaded.
 *
 * - `intake`: pre-tier-set sketch + answer clarifier questions
 *   (`mission-analyst-intake.md`). Used by `intake-phase`.
 * - `planned`: planned-tier full role (`mission-analyst-planned.md`).
 * - `full`: full-tier role with architect + TDD (`mission-analyst.md`).
 */
export type AnalystRole = "intake" | "planned" | "full";

/**
 * Map an analyst role to its registered capability string.
 *
 * The role is determined by either an explicit caller argument (e.g. intake-phase
 * passes `"intake"`) or by `mission.tier`. When tier is null and no explicit role,
 * default to `"intake"` so pre-tier dispatches resolve correctly.
 */
function analystCapabilityFor(role: AnalystRole): string {
	switch (role) {
		case "intake":
			return "mission-analyst-intake";
		case "planned":
			return "mission-analyst-planned";
		case "full":
			return "mission-analyst";
	}
}

/**
 * Resolve an analyst role from an optional explicit override and the mission's
 * current tier. `intake` is the default when tier is null.
 */
function resolveAnalystRole(mission: Mission, override?: AnalystRole): AnalystRole {
	if (override) return override;
	if (mission.tier === "planned") return "planned";
	if (mission.tier === "full") return "full";
	return "intake";
}

/**
 * Ensure the mission analyst is running. If no analyst session exists or
 * it's dead, spawn one with role-appropriate capability and slug-scoped name.
 *
 * Pass an explicit `role` to override the tier-derived default — used by
 * `intake-phase` to spawn the intake variant before tier is set, and by
 * `mission-tier set` to prompt-swap into planned/full after tier is known.
 */
export async function ensureMissionAnalyst(
	mission: Mission,
	overstoryDir: string,
	projectRoot: string,
	role?: AnalystRole,
): Promise<void> {
	const resolvedRole = resolveAnalystRole(mission, role);

	if (mission.analystSessionId) {
		// Analyst already bound — check if alive
		const { openSessionStore } = await import("../sessions/compat.ts");
		const { store: sessionStore } = openSessionStore(overstoryDir);
		try {
			const analystName = mission.slug ? `mission-analyst-${mission.slug}` : "mission-analyst";
			const session = sessionStore.getByName(analystName);
			if (session && session.state !== "completed" && session.state !== "zombie") {
				return; // Analyst is alive
			}
		} finally {
			sessionStore.close();
		}
	}

	// Spawn analyst with role-appropriate capability
	const analystName = mission.slug ? `mission-analyst-${mission.slug}` : "mission-analyst";
	const analystCapability = analystCapabilityFor(resolvedRole);
	const coordAgentName = mission.slug ? `coordinator-${mission.slug}` : "coordinator";

	const analystPrompt = await materializeMissionRolePrompt({
		overstoryDir,
		agentName: analystName,
		capability: analystCapability,
		roleLabel: "Mission Analyst",
		mission,
		siblingNames: {
			"Coordinator agent": coordAgentName,
		},
	});
	drainAgentInbox(overstoryDir, analystName);

	await startMissionAnalyst({
		missionId: mission.id,
		missionSlug: mission.slug,
		agentName: analystName,
		capability: analystCapability,
		projectRoot,
		overstoryDir,
		existingRunId: mission.runId ?? "",
		appendSystemPromptFile: analystPrompt.promptPath,
		beacon: buildMissionRoleBeacon({
			agentName: analystName,
			missionId: mission.id,
			contextPath: analystPrompt.contextPath,
		}),
	});
}

/**
 * Swap the live analyst session's role prompt to a new variant without respawning.
 *
 * Called by `ha mission tier set` — once tier transitions from null to
 * direct/planned/full, the analyst's role file changes from `mission-analyst-intake`
 * to the tier-appropriate variant. Research findings and conversation context
 * are retained because we paste the new prompt into the same tmux session via
 * `nudgeAgent` (existing pattern used for coordinator prompt-swap).
 *
 * Returns the path to the materialized prompt file. Caller is responsible for
 * the actual nudge delivery (typically via `nudgeAgent(..., promptPath)`).
 */
export async function materializeAnalystRoleSwap(
	mission: Mission,
	overstoryDir: string,
	role: AnalystRole,
): Promise<MaterializedMissionRolePrompt> {
	const analystName = mission.slug ? `mission-analyst-${mission.slug}` : "mission-analyst";
	const capability = analystCapabilityFor(role);
	const coordAgentName = mission.slug ? `coordinator-${mission.slug}` : "coordinator";

	return materializeMissionRolePrompt({
		overstoryDir,
		agentName: analystName,
		capability,
		roleLabel: "Mission Analyst",
		mission,
		siblingNames: {
			"Coordinator agent": coordAgentName,
		},
	});
}

/**
 * Ensure the architect role is running and bound to the mission.
 *
 * Idempotent: if `architectSessionId` is already bound and the session is
 * alive (not completed/zombie), returns immediately without spawning. Otherwise
 * spawns a new architect via `startArchitectRole`, which writes
 * `architectSessionId` via `MissionStore.bindSessions`.
 *
 * Errors from `startArchitectRole` propagate — callers should not silently
 * swallow them, since a missing architect causes the architect-design gate to
 * stall indefinitely.
 */
export async function ensureArchitect(
	mission: Mission,
	overstoryDir: string,
	projectRoot: string,
	_deps?: MissionRoleDeps,
): Promise<void> {
	const architectName = mission.slug ? `architect-${mission.slug}` : "architect";

	if (mission.architectSessionId) {
		// Architect already bound — check if alive
		if (_deps?.isRoleSessionAlive) {
			if (_deps.isRoleSessionAlive(overstoryDir, architectName)) {
				return;
			}
		} else {
			const { openSessionStore } = await import("../sessions/compat.ts");
			const { store: sessionStore } = openSessionStore(overstoryDir);
			try {
				const session = sessionStore.getByName(architectName);
				if (session && session.state !== "completed" && session.state !== "zombie") {
					return; // Architect is alive
				}
			} finally {
				sessionStore.close();
			}
		}
	}

	// Spawn architect
	const coordAgentName = mission.slug ? `coordinator-${mission.slug}` : "coordinator";

	const materialize = _deps?.materializePrompt ?? materializeMissionRolePrompt;
	const drain = _deps?.drainInbox ?? drainAgentInbox;

	const architectPrompt = await materialize({
		overstoryDir,
		agentName: architectName,
		capability: "architect",
		roleLabel: "Architect",
		mission,
		siblingNames: {
			"Coordinator agent": coordAgentName,
		},
	});
	drain(overstoryDir, architectName);

	await startArchitectRole(
		{
			missionId: mission.id,
			missionSlug: mission.slug,
			agentName: architectName,
			projectRoot,
			overstoryDir,
			existingRunId: mission.runId ?? "",
			appendSystemPromptFile: architectPrompt.promptPath,
			beacon: buildMissionRoleBeacon({
				agentName: architectName,
				missionId: mission.id,
				contextPath: architectPrompt.contextPath,
			}),
		},
		_deps,
	);
}

/**
 * Start the mission coordinator persistent root agent.
 *
 * Calls startPersistentAgent with capability='coordinator-mission', links the
 * resulting session to the mission via MissionStore.bindCoordinatorSession,
 * and returns the start result. The agent name is 'coordinator' (reusing the
 * existing coordinator slot), but the capability selects the mission-specific
 * prompt definition.
 */
export async function startMissionCoordinator(
	opts: StartMissionRoleOpts,
	_deps?: MissionRoleDeps,
): Promise<StartPersistentAgentResult> {
	const startAgent = _deps?.startAgent ?? startPersistentAgent;
	const storeFactory = _deps?.createStore ?? createMissionStore;

	const coordName = opts.agentName ?? "coordinator";
	const tmuxSession = opts.missionSlug
		? `ha-coordinator-${opts.missionSlug}`
		: "ha-mission-coordinator";

	const result = await startAgent({
		agentName: coordName,
		capability: opts.capability ?? "coordinator-mission",
		projectRoot: opts.projectRoot,
		overstoryDir: opts.overstoryDir,
		tmuxSession,
		createRun: false,
		existingRunId: opts.existingRunId,
		appendSystemPromptFile: opts.appendSystemPromptFile,
		appendSystemPrompt: opts.appendSystemPrompt,
		beacon: opts.beacon,
	});

	const store = storeFactory(join(opts.overstoryDir, "sessions.db"));
	try {
		const mission = store.getById(opts.missionId);
		if (!mission) {
			throw new AgentError(`Mission not found: ${opts.missionId}`, { agentName: "coordinator" });
		}
		store.bindCoordinatorSession(opts.missionId, result.session.id);
	} finally {
		store.close();
	}

	return result;
}

/**
 * Start the execution-director persistent root agent.
 *
 * Calls startPersistentAgent with capability='execution-director', links the
 * resulting session to the mission via MissionStore.bindSessions, and returns
 * the start result.
 */
export async function startExecutionDirector(
	opts: StartMissionRoleOpts,
	_deps?: MissionRoleDeps,
): Promise<StartPersistentAgentResult> {
	const startAgent = _deps?.startAgent ?? startPersistentAgent;
	const storeFactory = _deps?.createStore ?? createMissionStore;

	const edName = opts.agentName ?? "execution-director";
	const tmuxSession = opts.missionSlug ? `ha-ed-${opts.missionSlug}` : "ha-execution-director";

	const result = await startAgent({
		agentName: edName,
		capability: "execution-director",
		projectRoot: opts.projectRoot,
		overstoryDir: opts.overstoryDir,
		tmuxSession,
		createRun: false,
		existingRunId: opts.existingRunId,
		appendSystemPromptFile: opts.appendSystemPromptFile,
		appendSystemPrompt: opts.appendSystemPrompt,
		beacon: opts.beacon,
	});

	const store = storeFactory(join(opts.overstoryDir, "sessions.db"));
	try {
		const mission = store.getById(opts.missionId);
		if (!mission) {
			throw new AgentError(`Mission not found: ${opts.missionId}`, {
				agentName: "execution-director",
			});
		}
		store.bindSessions(opts.missionId, {
			executionDirectorSessionId: result.session.id,
		});
	} finally {
		store.close();
	}

	return result;
}

/**
 * Start the architect persistent root agent.
 *
 * Calls startPersistentAgent with capability='architect', links the
 * resulting session to the mission via MissionStore.bindSessions, and returns
 * the start result.
 */
export async function startArchitectRole(
	opts: StartMissionRoleOpts,
	_deps?: MissionRoleDeps,
): Promise<StartPersistentAgentResult> {
	const startAgent = _deps?.startAgent ?? startPersistentAgent;
	const storeFactory = _deps?.createStore ?? createMissionStore;

	const architectName = opts.agentName ?? "architect";
	const tmuxSession = opts.missionSlug ? `ha-architect-${opts.missionSlug}` : "ha-architect";

	const result = await startAgent({
		agentName: architectName,
		capability: "architect",
		projectRoot: opts.projectRoot,
		overstoryDir: opts.overstoryDir,
		tmuxSession,
		createRun: false,
		existingRunId: opts.existingRunId,
		appendSystemPromptFile: opts.appendSystemPromptFile,
		appendSystemPrompt: opts.appendSystemPrompt,
		beacon: opts.beacon,
	});

	const store = storeFactory(join(opts.overstoryDir, "sessions.db"));
	try {
		const mission = store.getById(opts.missionId);
		if (!mission) {
			throw new AgentError(`Mission not found: ${opts.missionId}`, {
				agentName: "architect",
			});
		}
		// architectSessionId is added by data-layer-builder in parallel; cast is temporary.
		const sessions = { architectSessionId: result.session.id } as unknown as Parameters<
			typeof store.bindSessions
		>[1];
		store.bindSessions(opts.missionId, sessions);
	} finally {
		store.close();
	}

	return result;
}

/**
 * Start the plan-review-lead persistent root agent.
 *
 * Spawned during the plan phase to coordinate critic agents. Unlike other
 * mission roles, the plan-review-lead is ephemeral — it runs only during
 * plan review and is stopped after the review completes. It does NOT bind
 * to a mission session column (no dedicated DB field).
 */
export async function startPlanReviewLead(
	opts: StartMissionRoleOpts,
	_deps?: MissionRoleDeps,
): Promise<StartPersistentAgentResult> {
	const startAgent = _deps?.startAgent ?? startPersistentAgent;

	const tmuxSession = opts.missionSlug
		? `ha-plan-review-${opts.missionSlug}`
		: "ha-plan-review-lead";

	return startAgent({
		agentName: "plan-review-lead",
		capability: "plan-review-lead",
		projectRoot: opts.projectRoot,
		overstoryDir: opts.overstoryDir,
		tmuxSession,
		createRun: false,
		existingRunId: opts.existingRunId,
		appendSystemPromptFile: opts.appendSystemPromptFile,
		appendSystemPrompt: opts.appendSystemPrompt,
		beacon: opts.beacon,
	});
}

/**
 * Stop the plan-review-lead agent.
 *
 * Convenience wrapper around stopMissionRole for the plan-review-lead.
 */
export async function stopPlanReviewLead(
	opts: StopMissionRoleOpts,
	_deps?: MissionRoleDeps,
): Promise<StopPersistentAgentResult> {
	const stopAgent = _deps?.stopAgent ?? stopPersistentAgent;
	return stopAgent("plan-review-lead", {
		projectRoot: opts.projectRoot,
		overstoryDir: opts.overstoryDir,
		runStatus: opts.runStatus ?? "stopped",
		completeRun: false,
	});
}

/**
 * Stop a mission role agent (coordinator, mission-analyst, or execution-director).
 *
 * Calls stopPersistentAgent with the given agent name and returns the result.
 */
export async function stopMissionRole(
	agentName: string,
	opts: StopMissionRoleOpts,
	_deps?: MissionRoleDeps,
): Promise<StopPersistentAgentResult> {
	const stopAgent = _deps?.stopAgent ?? stopPersistentAgent;
	return stopAgent(agentName, {
		projectRoot: opts.projectRoot,
		overstoryDir: opts.overstoryDir,
		runStatus: opts.runStatus ?? "stopped",
		completeRun: opts.completeRun,
	});
}

/**
 * Stop all descendant agents for a mission run, excluding specified agent names.
 * Stops in reverse depth order (deepest first).
 */
export async function stopMissionRunDescendants(opts: {
	overstoryDir: string;
	projectRoot: string;
	runId: string | null;
	excludedAgentNames: ReadonlySet<string>;
	stopAgentCommand: (agentName: string, opts: { force: boolean }) => Promise<void>;
}): Promise<string[]> {
	if (!opts.runId) {
		return [];
	}

	const { openSessionStore } = await import("../sessions/compat.ts");
	const { store } = openSessionStore(opts.overstoryDir);
	try {
		const descendants = store
			.getByRun(opts.runId)
			.filter((session) => !opts.excludedAgentNames.has(session.agentName))
			.sort((left, right) => {
				if (right.depth !== left.depth) {
					return right.depth - left.depth;
				}
				return left.agentName.localeCompare(right.agentName);
			});
		const stopped: string[] = [];
		const originalCwd = process.cwd();
		process.chdir(opts.projectRoot);
		try {
			for (const session of descendants) {
				try {
					await opts.stopAgentCommand(session.agentName, { force: true });
					stopped.push(session.agentName);
				} catch {
					// Completed descendants without a live runtime do not need additional cleanup.
				}
			}
		} finally {
			process.chdir(originalCwd);
		}
		return stopped;
	} finally {
		store.close();
	}
}
