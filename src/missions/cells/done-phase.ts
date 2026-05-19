/**
 * Done-phase subgraph cell.
 *
 * Pre-Stage-C subgraph:
 *   summary → holdout → cleanup → terminal
 *
 * Stage C extension — post-merge integration gate + debug-loop:
 *   summary → run-holdout (KEEP node id 'done-phase:holdout' for backward compat)
 *               ├─ holdout_pass → cleanup → complete
 *               ├─ holdout_skip → cleanup → complete (legacy null featureBranch)
 *               └─ holdout_fail → dispatch-debugger
 *                                   ↓
 *                                 request-analyst-brief (async, 600s)
 *                                   ├─ brief_ready → await-debug-fix
 *                                   └─ timeout → check-debug-attempts
 *                                 await-debug-fix (async, 3600s)
 *                                   ├─ fix_committed → merge-debug-fix
 *                                   │                    ├─ merged → run-holdout (loop)
 *                                   │                    └─ merge_conflict → check-debug-attempts
 *                                   ├─ fix_failed → check-debug-attempts
 *                                   └─ timeout → check-debug-attempts
 *                                 check-debug-attempts
 *                                   ├─ retry → dispatch-debugger (loop)
 *                                   └─ exhausted → escalate → debug-paused (terminal)
 */

import { join } from "node:path";
import type { SessionStore } from "../../sessions/store.ts";
import type { AgentSession, Mission, MissionGraph, MissionState } from "../../types.ts";
import type { HandlerRegistry } from "../types.ts";
import { isRealTaskId } from "../task-id.ts";
import { makeDebugLoopHandlers } from "./debug-loop-handlers.ts";
import type { PhaseCellConfig, PhaseCellDefinition, PhaseCellDeps } from "./types.ts";

const CELL_TYPE = "done-phase";
const MAX_DEBUG_ATTEMPTS = 3;

function buildCloseReason(slug: string | null | undefined, state: MissionState, isoNow: string): string {
	const displaySlug = slug ?? "<unknown>";
	switch (state) {
		case "completed":
			return `Mission ${displaySlug} completed at ${isoNow}`;
		case "failed":
			return `Mission ${displaySlug} failed at ${isoNow}`;
		case "stopped":
			return `Mission ${displaySlug} stopped at ${isoNow}`;
		case "suspended":
			return `Mission ${displaySlug} suspended at ${isoNow}`;
		case "superseded":
			return `Mission ${displaySlug} superseded at ${isoNow}`;
		case "frozen":
			return `Mission ${displaySlug} frozen at ${isoNow}`;
		case "active":
			return `Mission ${displaySlug} done-phase cleanup at ${isoNow}`;
		default: {
			// Exhaustive guard. If MissionState gains a new variant, this branch surfaces it.
			const _exhaustive: never = state;
			void _exhaustive;
			return `Mission ${displaySlug} done-phase cleanup at ${isoNow}`;
		}
	}
}

function buildSubgraph(_config: PhaseCellConfig): MissionGraph {
	return {
		version: 1,
		nodes: [
			{
				kind: "cell",
				id: `${CELL_TYPE}:summary`,
				cellType: CELL_TYPE,
				handler: "summary",
			},
			// Stage C: holdout is now a real gate (was dead-code; KEEP node id)
			{
				kind: "cell",
				id: `${CELL_TYPE}:holdout`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 3600, // up to 2min × adoption polls
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:dispatch-debugger`,
				cellType: CELL_TYPE,
				handler: "dispatch-debugger",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:request-analyst-brief`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 600,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:await-debug-fix`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 3600,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:merge-debug-fix`,
				cellType: CELL_TYPE,
				handler: "merge-debug-fix",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:check-debug-attempts`,
				cellType: CELL_TYPE,
				handler: "check-debug-attempts",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:escalate`,
				cellType: CELL_TYPE,
				handler: "escalate",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:cleanup`,
				cellType: CELL_TYPE,
				handler: "cleanup",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:complete`,
				cellType: CELL_TYPE,
				terminal: true,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:debug-paused`,
				cellType: CELL_TYPE,
				terminal: true,
			},
		],
		edges: [
			{ from: `${CELL_TYPE}:summary`, to: `${CELL_TYPE}:holdout`, trigger: "summary_ready" },
			// Holdout outcomes
			{ from: `${CELL_TYPE}:holdout`, to: `${CELL_TYPE}:cleanup`, trigger: "holdout_pass" },
			{ from: `${CELL_TYPE}:holdout`, to: `${CELL_TYPE}:cleanup`, trigger: "holdout_skip" },
			{
				from: `${CELL_TYPE}:holdout`,
				to: `${CELL_TYPE}:dispatch-debugger`,
				trigger: "holdout_fail",
			},
			// Debug-loop
			{
				from: `${CELL_TYPE}:dispatch-debugger`,
				to: `${CELL_TYPE}:request-analyst-brief`,
				trigger: "debugger_dispatched",
			},
			{
				// Fix #4 from full-PR review: infrastructure failure (no projectRoot,
				// no featureBranch, worktree-add failed) short-circuits to escalation.
				from: `${CELL_TYPE}:dispatch-debugger`,
				to: `${CELL_TYPE}:escalate`,
				trigger: "dispatch_failed",
			},
			{
				from: `${CELL_TYPE}:dispatch-debugger`,
				to: `${CELL_TYPE}:escalate`,
				trigger: "capability_missing",
			},
			{
				from: `${CELL_TYPE}:request-analyst-brief`,
				to: `${CELL_TYPE}:await-debug-fix`,
				trigger: "brief_ready",
			},
			{
				from: `${CELL_TYPE}:request-analyst-brief`,
				to: `${CELL_TYPE}:check-debug-attempts`,
				trigger: "timeout",
			},
			{
				from: `${CELL_TYPE}:await-debug-fix`,
				to: `${CELL_TYPE}:merge-debug-fix`,
				trigger: "fix_committed",
			},
			{
				from: `${CELL_TYPE}:await-debug-fix`,
				to: `${CELL_TYPE}:check-debug-attempts`,
				trigger: "fix_failed",
			},
			{
				from: `${CELL_TYPE}:await-debug-fix`,
				to: `${CELL_TYPE}:check-debug-attempts`,
				trigger: "timeout",
			},
			{
				from: `${CELL_TYPE}:merge-debug-fix`,
				to: `${CELL_TYPE}:holdout`,
				trigger: "merged",
			},
			{
				from: `${CELL_TYPE}:merge-debug-fix`,
				to: `${CELL_TYPE}:check-debug-attempts`,
				trigger: "merge_conflict",
			},
			{
				from: `${CELL_TYPE}:check-debug-attempts`,
				to: `${CELL_TYPE}:dispatch-debugger`,
				trigger: "retry",
			},
			{
				from: `${CELL_TYPE}:check-debug-attempts`,
				to: `${CELL_TYPE}:escalate`,
				trigger: "exhausted",
			},
			{
				from: `${CELL_TYPE}:escalate`,
				to: `${CELL_TYPE}:debug-paused`,
				trigger: "escalated",
			},
			{
				from: `${CELL_TYPE}:escalate`,
				to: `${CELL_TYPE}:debug-paused`,
				trigger: "pending_replay_aborted",
			},
			{ from: `${CELL_TYPE}:cleanup`, to: `${CELL_TYPE}:complete`, trigger: "cleanup_done" },
		],
	};
}

function buildHandlers(deps: PhaseCellDeps): HandlerRegistry {
	const debugLoop = makeDebugLoopHandlers(
		{
			cellType: CELL_TYPE,
			maxAttempts: MAX_DEBUG_ATTEMPTS,
			failureSource: "holdout",
		},
		deps,
	);
	return {
		...debugLoop,
		summary: async (ctx) => {
			const mission = ctx.getMission();
			if (!mission) return { trigger: "summary_ready" };
			const artifactRoot =
				mission.artifactRoot ??
				(deps.overstoryDir ? join(deps.overstoryDir, "missions", mission.id) : "");
			if (!artifactRoot) return { trigger: "summary_ready" };

			const summaryPath = join(artifactRoot, "results", "summary.md");
			const lines = [
				`# Mission Summary — ${mission.slug ?? mission.id}`,
				"",
				`- Mission ID: ${mission.id}`,
				`- Objective: ${mission.objective ?? "(unset)"}`,
				`- Phase: done`,
				`- State: ${mission.state}`,
				`- Tier: ${mission.tier ?? "unknown"}`,
				`- Generated: ${new Date().toISOString()}`,
				"",
				"## Workstreams",
				"",
				"_See `plan/workstreams.json` for the full workstream list._",
				"",
				"## Notes",
				"",
				"_Engine-generated baseline. Operators may replace with a richer post-mission summary._",
			];
			await Bun.write(summaryPath, `${lines.join("\n")}\n`);
			return { trigger: "summary_ready" };
		},
		cleanup: async (ctx) => {
			const mission = ctx.getMission();
			if (mission && isRealTaskId(mission.taskId)) {
				const reason = buildCloseReason(mission.slug, mission.state, new Date().toISOString());
				try {
					await deps.tracker.close(mission.taskId, reason);
				} catch (err) {
					console.warn(
						`[done-phase:cleanup] tracker.close failed (best-effort, mission proceeds): ${
							err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)
						}`,
					);
				}
			}
			// Stage C: clean up debug worktrees on success path.
			// Escalation path leaves them in place for operator inspection.
			if (mission && deps.projectRoot) {
				const overstoryDir = deps.overstoryDir;
				if (overstoryDir) {
					await cleanupDebugWorktrees(deps.projectRoot, overstoryDir, mission.slug);
				}
			}
			// Issue #322: terminate intake-phase + other mission-owned agents (and
			// prune their worktrees) when the engine auto-completes the mission.
			// `lifecycle-terminate.ts` only fires when an operator runs
			// `ha mission complete/stop`; the engine's auto-completion path
			// (watchdog/mission-tick.ts terminal handler) bypasses it, leaving
			// `product-clarifier-<slug>`, `tier-classifier-<slug>`, and the
			// mission's coordinator/analyst alive with their worktrees on disk.
			if (mission && deps.projectRoot && deps.overstoryDir && deps.sessionStore) {
				await terminateMissionOwnedAgents({
					mission,
					sessionStore: deps.sessionStore,
					projectRoot: deps.projectRoot,
					overstoryDir: deps.overstoryDir,
				});
			}
			if (mission && deps.projectRoot && deps.overstoryDir && mission.slug) {
				await cleanupMissionWorktrees({
					projectRoot: deps.projectRoot,
					overstoryDir: deps.overstoryDir,
					slug: mission.slug,
				});
			}
			return { trigger: "cleanup_done" };
		},
	};
}

/**
 * Stage C: remove all `worktrees/debug/<slug>-attempt-*` worktrees on cleanup.
 * Best-effort: per-worktree failures logged but don't block mission completion.
 */
async function cleanupDebugWorktrees(
	projectRoot: string,
	overstoryDir: string,
	slug: string,
): Promise<void> {
	const debugWorktreesDir = join(overstoryDir, "worktrees", "debug");
	try {
		const { readdir } = await import("node:fs/promises");
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
			`[done-phase:cleanup] worktree cleanup failed: ${err instanceof Error ? err.message : err}\n`,
		);
	}
}

/**
 * Issue #322: identify sessions owned by this mission and terminate any that
 * are still alive. Mission ownership is established via three signals:
 *   1. Session belongs to `mission.runId` (the canonical link).
 *   2. Session's agentName matches a slug-scoped pattern
 *      (e.g. `product-clarifier-<slug>`, `coordinator-<slug>`).
 *   3. Session's worktreePath is under `<overstoryDir>/worktrees/<slug>/`.
 *
 * Best-effort: each per-session failure is logged but never blocks completion.
 */
async function terminateMissionOwnedAgents(opts: {
	mission: Mission;
	sessionStore: SessionStore;
	projectRoot: string;
	overstoryDir: string;
}): Promise<void> {
	const { mission, sessionStore, projectRoot, overstoryDir } = opts;
	const slug = mission.slug;
	const runId = mission.runId;
	const missionWorktreeDir = slug ? join(overstoryDir, "worktrees", slug) : null;

	const candidates = new Map<string, AgentSession>();
	if (runId) {
		for (const s of sessionStore.getByRun(runId)) candidates.set(s.agentName, s);
	}
	if (slug) {
		// Backstop for sessions whose runId was never set or got cleared. Avoids
		// false positives by requiring the slug to appear as a `-<slug>` suffix
		// OR the worktree path to live under the mission's worktree dir.
		const slugSuffix = `-${slug}`;
		for (const s of sessionStore.getAll()) {
			if (candidates.has(s.agentName)) continue;
			const matchesName = s.agentName === slug || s.agentName.endsWith(slugSuffix);
			const matchesPath = missionWorktreeDir
				? s.worktreePath.startsWith(`${missionWorktreeDir}/`) ||
					s.worktreePath === missionWorktreeDir
				: false;
			if (matchesName || matchesPath) candidates.set(s.agentName, s);
		}
	}

	if (candidates.size === 0) return;

	// Lazy-load runtime primitives so unit tests can run without tmux installed.
	const { isProcessAlive, isSessionAlive, killProcessTree, killSession, removeAgentEnvFile } =
		await import("../../worktree/tmux.ts");

	for (const session of candidates.values()) {
		if (session.state === "completed") continue;
		try {
			const isHeadless = session.tmuxSession === "" && session.pid !== null;
			if (isHeadless && session.pid !== null) {
				if (isProcessAlive(session.pid)) {
					await killProcessTree(session.pid);
				}
			} else if (session.tmuxSession.length > 0) {
				if (await isSessionAlive(session.tmuxSession)) {
					await killSession(session.tmuxSession);
				}
			}
			if (session.worktreePath) {
				try {
					removeAgentEnvFile(session.worktreePath);
				} catch {
					// best-effort
				}
			}
			sessionStore.updateState(session.agentName, "completed");
			sessionStore.updateLastActivity(session.agentName);
		} catch (err) {
			process.stderr.write(
				`[done-phase:cleanup] failed to stop agent ${session.agentName}: ${
					err instanceof Error ? err.message : err
				}\n`,
			);
		}
	}

	// Avoid an unused-import lint complaint when projectRoot is not consumed
	// by the runtime primitives above (they operate purely on tmux/pid).
	void projectRoot;
}

/**
 * Issue #322: prune every git worktree whose path lives under
 * `<overstoryDir>/worktrees/<slug>/`. Uses `git worktree list --porcelain`
 * to enumerate the live registry (so orphans pruned out-of-band are skipped),
 * then force-removes each match.
 *
 * Best-effort: per-worktree failures are logged but never block completion.
 */
async function cleanupMissionWorktrees(opts: {
	projectRoot: string;
	overstoryDir: string;
	slug: string;
}): Promise<void> {
	const { projectRoot, overstoryDir, slug } = opts;
	const missionWorktreeDir = join(overstoryDir, "worktrees", slug);
	const prefix = `${missionWorktreeDir}/`;
	try {
		const { listWorktrees, removeWorktree } = await import("../../worktree/manager.ts");
		const entries = await listWorktrees(projectRoot).catch(() => []);
		for (const entry of entries) {
			if (!entry.path.startsWith(prefix) && entry.path !== missionWorktreeDir) continue;
			try {
				await removeWorktree(projectRoot, entry.path, { force: true, forceBranch: true });
			} catch (err) {
				process.stderr.write(
					`[done-phase:cleanup] failed to remove worktree ${entry.path}: ${
						err instanceof Error ? err.message : err
					}\n`,
				);
			}
		}
	} catch (err) {
		process.stderr.write(
			`[done-phase:cleanup] mission worktree cleanup failed: ${
				err instanceof Error ? err.message : err
			}\n`,
		);
	}
}

export const donePhaseCell: PhaseCellDefinition = {
	cellType: CELL_TYPE,
	buildSubgraph,
	buildHandlers,
};
