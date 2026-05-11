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
import type { DebugBriefRequestPayload, DebugEscalationPayload } from "../../mail/types.ts";
import type { MissionGraph } from "../../types.ts";
import type { HandlerRegistry } from "../types.ts";
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
				gate: "async",
				gateTimeout: 600,
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
			{ from: `${CELL_TYPE}:cleanup`, to: `${CELL_TYPE}:complete`, trigger: "cleanup_done" },
		],
	};
}

function buildHandlers(deps: PhaseCellDeps): HandlerRegistry {
	return {
		"dispatch-debugger": async (ctx) => {
			const mission = ctx.getMission();
			if (!mission) return { trigger: "debugger_dispatched" };

			// Increment attempt counter (stored on this node's checkpoint)
			const cp = deps.missionStore.checkpoints.getCheckpoint(
				mission.id,
				`${CELL_TYPE}:dispatch-debugger`,
			);
			const prev = (cp?.data as { debugAttempts?: number } | null) ?? null;
			const debugAttempts = (prev?.debugAttempts ?? 0) + 1;

			const featureBranch = mission.featureBranch ?? null;
			if (!featureBranch) {
				// Should not reach here — holdout_skip should have fired upstream.
				return { trigger: "debugger_dispatched" };
			}

			const debuggerName = `debugger-${mission.slug}-attempt-${debugAttempts}`;
			const debugBranch = `haru/${mission.slug}/debug-attempt-${debugAttempts}`;

			// Persist attempt N + dispatched debugger name; gate evaluators read this.
			deps.missionStore.checkpoints.saveCheckpoint(mission.id, `${CELL_TYPE}:dispatch-debugger`, {
				debugAttempts,
				debuggerName,
				debugBranch,
				featureBranch,
				dispatchedAt: new Date().toISOString(),
			});

			// Construct debug_brief_request payload for mission-analyst.
			// Recent holdout result lives at debug/holdout-result-<N-1>.json
			// (the failing attempt that triggered this dispatch).
			const artifactRoot = mission.artifactRoot ?? "";
			const integrationSha = ""; // Filled in by analyst via git rev-parse
			const payload: DebugBriefRequestPayload = {
				missionId: mission.id,
				attemptN: debugAttempts,
				integrationBranch: featureBranch,
				integrationSha,
				debuggerName,
				failedGates: [], // Analyst reads holdout-result file directly
			};

			// Notify analyst — they package the brief and mail debugger directly.
			const analystName = `mission-analyst-${mission.slug}`;
			await deps.mailSend(
				analystName,
				`Debug brief request (attempt ${debugAttempts})`,
				`Package failure context for ${debuggerName}. ` +
					`See ${artifactRoot}/debug/holdout-result-${debugAttempts - 1}.json for failed gates. ` +
					`Write to debug/debug-brief.md.\n\n` +
					`Payload: ${JSON.stringify(payload)}`,
				"debug_brief_request",
			);

			return { trigger: "debugger_dispatched" };
		},

		"merge-debug-fix": async (ctx) => {
			const mission = ctx.getMission();
			if (!mission) return { trigger: "merge_conflict" };
			const cp = deps.missionStore.checkpoints.getCheckpoint(
				mission.id,
				`${CELL_TYPE}:dispatch-debugger`,
			);
			const data = cp?.data as { debugBranch?: string; featureBranch?: string } | null;
			if (!data?.debugBranch || !data.featureBranch || !deps.projectRoot) {
				return { trigger: "merge_conflict" };
			}
			// FF-merge debug branch into feature branch in canonical repo.
			const proc = Bun.spawn(["git", "merge", "--ff-only", data.debugBranch], {
				cwd: deps.projectRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			return { trigger: exitCode === 0 ? "merged" : "merge_conflict" };
		},

		"check-debug-attempts": async (ctx) => {
			const mission = ctx.getMission();
			if (!mission) return { trigger: "exhausted" };
			const cp = deps.missionStore.checkpoints.getCheckpoint(
				mission.id,
				`${CELL_TYPE}:dispatch-debugger`,
			);
			const data = cp?.data as { debugAttempts?: number } | null;
			const attempts = data?.debugAttempts ?? 0;
			return { trigger: attempts < MAX_DEBUG_ATTEMPTS ? "retry" : "exhausted" };
		},

		escalate: async (ctx) => {
			const mission = ctx.getMission();
			if (!mission) return { trigger: "escalated" };
			const artifactRoot = mission.artifactRoot ?? "";
			const packPath = join(artifactRoot, "debug", "consultation-request-pack.md");

			// Write a basic Consultation Pack stub (S10 will produce full content).
			const cp = deps.missionStore.checkpoints.getCheckpoint(
				mission.id,
				`${CELL_TYPE}:dispatch-debugger`,
			);
			const data = cp?.data as { debugAttempts?: number } | null;
			const totalAttempts = data?.debugAttempts ?? MAX_DEBUG_ATTEMPTS;

			const pack =
				`# Consultation Request Pack\n\n` +
				`Mission ${mission.slug} exhausted ${totalAttempts} debug attempts. ` +
				`Inspect attempts/<N>/hypothesis.md for what was tried. ` +
				`Run \`ha mission debug status ${mission.id}\` to review, then ` +
				`\`ha mission debug retry|accept|abort\` to resolve.\n`;
			await Bun.write(packPath, pack);

			// Send `question` mail to operator and freeze mission with returned threadId.
			// Mail dependency interface here is minimal; we use mailSend without
			// direct threadId access — escalate writes the pack, sends notification,
			// and writes a pendingInput marker via the dedicated `freeze` API.
			// Send notification mail (not threaded — Stage C uses dedicated CLI flow).
			const escalationPayload: DebugEscalationPayload = {
				missionId: mission.id,
				totalAttempts,
				packPath,
			};
			await deps.mailSend(
				"operator",
				`Debug escalation: ${mission.slug}`,
				`Mission ${mission.slug} needs human intervention after ${totalAttempts} debug attempts. ` +
					`Pack: ${packPath}\n\n` +
					`Run \`ha mission debug status ${mission.id}\` to inspect, then ` +
					`retry/accept/abort.\n\n` +
					`Payload: ${JSON.stringify(escalationPayload)}`,
				"debug_escalation",
			);

			// Freeze mission with pendingInputKind=debug-escalation. Engine sees
			// terminal node + frozen state, stops ticking until operator acts.
			// freeze(id, kind, threadId) verified at types.ts:462.
			deps.missionStore.freeze(mission.id, "debug-escalation", null);
			deps.missionStore.updatePauseReason(
				mission.id,
				`Stage C debug loop exhausted after ${totalAttempts} attempts`,
			);

			return { trigger: "escalated" };
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
