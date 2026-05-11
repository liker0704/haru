/**
 * `ha mission debug <status|retry|accept|abort>` — operator interactions
 * with a mission paused after Stage C debug-loop exhaustion.
 *
 * When the done-phase debug-loop exhausts 3 attempts, the engine writes a
 * Consultation Request Pack and freezes the mission with
 * `pendingInputKind="debug-escalation"`. Operator uses these commands to:
 *
 *   status — inspect what was tried (per-attempt hypotheses + outcomes)
 *   retry  — clean up debug worktrees and reset attempt counter; engine
 *            re-enters done-phase:holdout on next tick (e.g., operator
 *            fixed the issue manually or wants debugger to try again with
 *            fresh context)
 *   accept — operator says "I'll fix this manually"; cleanup worktrees,
 *            mark mission completed with a notes field
 *   abort  — give up; mark mission failed with operator-provided reason
 *
 * Separate from `ha mission answer` (which is kind-agnostic single-thread
 * reply for Stage A clarifier intent questions). Debug-escalation has its
 * own state-transition semantics.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { detectHaruDir, loadConfig } from "../config.ts";
import { jsonError, jsonOutput } from "../json.ts";
import { accent, muted, printError, printSuccess } from "../logging/color.ts";
import { createMissionStore } from "../missions/store.ts";
import type { Mission } from "../types.ts";

export function createMissionDebugCommand(): Command {
	const cmd = new Command("debug").description(
		"Operator actions on a mission paused after Stage C debug-loop exhaustion",
	);

	cmd
		.command("status [mission]")
		.description("Show debug-loop attempts and hypotheses for a paused mission")
		.option("--json", "Output as JSON")
		.action(async (missionArg: string | undefined, opts: { json?: boolean }) => {
			await runStatus(missionArg, opts);
		});

	cmd
		.command("retry [mission]")
		.description("Clean up debug worktrees, reset attempt counter, resume engine")
		.option("--json", "Output as JSON")
		.action(async (missionArg: string | undefined, opts: { json?: boolean }) => {
			await runRetry(missionArg, opts);
		});

	cmd
		.command("accept [mission]")
		.description("Mark mission completed (operator fixed manually); cleanup worktrees")
		.option("--notes <text>", "Operator notes on the manual fix")
		.option("--json", "Output as JSON")
		.action(async (missionArg: string | undefined, opts: { notes?: string; json?: boolean }) => {
			await runAccept(missionArg, opts);
		});

	cmd
		.command("abort [mission]")
		.description("Mark mission failed; cleanup worktrees")
		.option("--reason <text>", "Reason for aborting")
		.option("--json", "Output as JSON")
		.action(async (missionArg: string | undefined, opts: { reason?: string; json?: boolean }) => {
			await runAbort(missionArg, opts);
		});

	return cmd;
}

async function resolveMission(
	missionArg: string | undefined,
	opts: { json?: boolean },
): Promise<{
	mission: Mission;
	overstoryDir: string;
	projectRoot: string;
} | null> {
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;
	const overstoryDir = join(projectRoot, detectHaruDir(projectRoot));
	const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
	try {
		let mission: Mission | null = null;
		if (missionArg) {
			mission = missionStore.getById(missionArg) ?? missionStore.getBySlug(missionArg);
		} else {
			mission = missionStore.getActive();
		}
		if (!mission) {
			const message = missionArg
				? `Mission "${missionArg}" not found`
				: "No active mission; pass <mission-id> explicitly";
			if (opts.json) jsonError("mission debug", message);
			else printError(message);
			process.exitCode = 1;
			return null;
		}
		return { mission, overstoryDir, projectRoot };
	} finally {
		missionStore.close();
	}
}

async function runStatus(missionArg: string | undefined, opts: { json?: boolean }): Promise<void> {
	const ctx = await resolveMission(missionArg, opts);
	if (!ctx) return;
	const { mission } = ctx;

	const artifactRoot = mission.artifactRoot ?? "";
	const attemptsDir = join(artifactRoot, "debug", "attempts");

	let attempts: Array<{ n: number; hypothesis: string; reportPath: string }> = [];
	try {
		const entries = (await readdir(attemptsDir, { withFileTypes: true })).filter((e) =>
			e.isDirectory(),
		);
		for (const entry of entries) {
			const n = Number(entry.name);
			if (!Number.isFinite(n)) continue;
			const hypothesisPath = join(attemptsDir, entry.name, "hypothesis.md");
			const reportPath = join(attemptsDir, entry.name, "test-report.json");
			const hypothesisFile = Bun.file(hypothesisPath);
			const hypothesis = (await hypothesisFile.exists())
				? await hypothesisFile.text()
				: "(missing)";
			attempts.push({ n, hypothesis: hypothesis.slice(0, 500), reportPath });
		}
		attempts = attempts.sort((a, b) => a.n - b.n);
	} catch {
		// No attempts dir — fall through with empty array
	}

	const packPath = join(artifactRoot, "debug", "consultation-request-pack.md");
	const packExists = await Bun.file(packPath).exists();

	if (opts.json) {
		jsonOutput("mission debug status", {
			missionId: mission.id,
			slug: mission.slug,
			state: mission.state,
			phase: mission.phase,
			pendingInputKind: mission.pendingInputKind,
			pauseReason: mission.pauseReason,
			attempts,
			consultationPackPath: packExists ? packPath : null,
		});
		return;
	}

	console.log(`Mission ${accent(mission.slug)} (${mission.id})`);
	console.log(`  state:             ${mission.state}`);
	console.log(`  phase:             ${mission.phase}`);
	console.log(`  pendingInputKind:  ${mission.pendingInputKind ?? "(none)"}`);
	if (mission.pauseReason) {
		console.log(`  pauseReason:       ${mission.pauseReason}`);
	}
	console.log(`  debug attempts:    ${attempts.length}`);
	for (const a of attempts) {
		console.log(`\n  --- Attempt ${a.n} ---`);
		console.log(`  ${muted(a.hypothesis)}`);
	}
	if (packExists) {
		console.log(`\n  ${accent("Consultation pack:")} ${packPath}`);
	}
}

async function runRetry(missionArg: string | undefined, opts: { json?: boolean }): Promise<void> {
	const ctx = await resolveMission(missionArg, opts);
	if (!ctx) return;
	const { mission, overstoryDir, projectRoot } = ctx;

	// N4 fix from review: cleanup OLD attempt-* worktrees FIRST, otherwise
	// dispatch-debugger's `git worktree add` will collide on path reuse.
	await cleanupDebugWorktrees(projectRoot, overstoryDir, mission.slug);

	// Reset attempt counter (next dispatch reads 0 + 1 = 1).
	const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
	try {
		missionStore.checkpoints.saveCheckpoint(mission.id, "done-phase:dispatch-debugger", {
			debugAttempts: 0,
			resetByOperator: true,
			resetAt: new Date().toISOString(),
		});
		// Unfreeze — engine re-evaluates done-phase:holdout on next tick.
		missionStore.unfreeze(mission.id);
		missionStore.updatePauseReason(mission.id, null);
		// Move current node back to the holdout gate so engine retries.
		missionStore.updateCurrentNode(mission.id, "done-phase:holdout");
	} finally {
		missionStore.close();
	}

	if (opts.json) {
		jsonOutput("mission debug retry", { missionId: mission.id, slug: mission.slug });
	} else {
		printSuccess(`Reset debug attempts; mission resumed at done-phase:holdout`, mission.slug);
	}
}

async function runAccept(
	missionArg: string | undefined,
	opts: { notes?: string; json?: boolean },
): Promise<void> {
	const ctx = await resolveMission(missionArg, opts);
	if (!ctx) return;
	const { mission, overstoryDir, projectRoot } = ctx;

	await cleanupDebugWorktrees(projectRoot, overstoryDir, mission.slug);

	const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
	try {
		const notes = opts.notes ?? "Operator accepted; manual fix applied outside debug-loop";
		missionStore.unfreeze(mission.id);
		missionStore.updatePauseReason(mission.id, `accepted: ${notes}`);
		missionStore.completeMission(mission.id);
	} finally {
		missionStore.close();
	}

	if (opts.json) {
		jsonOutput("mission debug accept", { missionId: mission.id, slug: mission.slug });
	} else {
		printSuccess("Mission completed (operator accepted)", mission.slug);
	}
}

async function runAbort(
	missionArg: string | undefined,
	opts: { reason?: string; json?: boolean },
): Promise<void> {
	const ctx = await resolveMission(missionArg, opts);
	if (!ctx) return;
	const { mission, overstoryDir, projectRoot } = ctx;

	await cleanupDebugWorktrees(projectRoot, overstoryDir, mission.slug);

	const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
	try {
		const reason = opts.reason ?? "Operator aborted debug-loop";
		missionStore.unfreeze(mission.id);
		missionStore.updatePauseReason(mission.id, `aborted: ${reason}`);
		missionStore.updateState(mission.id, "failed");
	} finally {
		missionStore.close();
	}

	if (opts.json) {
		jsonOutput("mission debug abort", { missionId: mission.id, slug: mission.slug });
	} else {
		printSuccess("Mission marked failed (operator aborted)", mission.slug);
	}
}

/**
 * Remove all `worktrees/debug/<slug>-attempt-*` worktrees. Best-effort: per
 * worktree errors are logged but don't block the CLI action.
 */
async function cleanupDebugWorktrees(
	projectRoot: string,
	overstoryDir: string,
	slug: string,
): Promise<void> {
	const debugWorktreesDir = join(overstoryDir, "worktrees", "debug");
	try {
		const entries = await readdir(debugWorktreesDir).catch(() => []);
		for (const entry of entries) {
			if (!entry.startsWith(`${slug}-attempt-`)) continue;
			const worktreePath = join(debugWorktreesDir, entry);
			const proc = Bun.spawn(["git", "worktree", "remove", "--force", worktreePath], {
				cwd: projectRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			await proc.exited;
		}
	} catch (err) {
		process.stderr.write(
			`[mission debug] worktree cleanup failed: ${err instanceof Error ? err.message : err}\n`,
		);
	}
}
