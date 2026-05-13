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
import type { MissionGraph } from "../../types.ts";
import type { HandlerRegistry } from "../types.ts";
import { makeDebugLoopHandlers } from "./debug-loop-handlers.ts";
import type { PhaseCellConfig, PhaseCellDefinition, PhaseCellDeps } from "./types.ts";

const CELL_TYPE = "done-phase";
const MAX_DEBUG_ATTEMPTS = 3;

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
			// Stage C: clean up debug worktrees on success path.
			// Escalation path leaves them in place for operator inspection.
			if (mission && deps.projectRoot) {
				const overstoryDir = deps.overstoryDir;
				if (overstoryDir) {
					await cleanupDebugWorktrees(deps.projectRoot, overstoryDir, mission.slug);
				}
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

export const donePhaseCell: PhaseCellDefinition = {
	cellType: CELL_TYPE,
	buildSubgraph,
	buildHandlers,
};
