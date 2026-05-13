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
import { createManifestLoader } from "../../agents/manifest.ts";
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
	return {
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

		"dispatch-debugger": async (ctx) => {
			const mission = ctx.getMission();
			if (!mission) return { trigger: "dispatch_failed" };
			const projectRoot = deps.projectRoot;
			const overstoryDir = deps.overstoryDir;
			if (!projectRoot || !overstoryDir) {
				// Required deps missing — can't spawn worktree or sling. Escalate
				// immediately rather than burn attempts on infrastructure failure.
				return { trigger: "dispatch_failed" };
			}

			// Preflight: verify debugger capability is registered before any side effect.
			const manifestPath = join(overstoryDir, "agent-manifest.json");
			const agentBaseDir = join(overstoryDir, "agent-defs");
			const manifestLoader = createManifestLoader(manifestPath, agentBaseDir);
			let debuggerAgent: { file: string } | undefined;
			try {
				const manifest = await manifestLoader.load();
				debuggerAgent = manifest.agents.debugger;
			} catch {
				// Manifest unloadable (missing file, malformed JSON, or broken .md ref).
				// Treat as effectively-missing capability — same coordinator surfacing path.
			}
			if (!debuggerAgent) {
				deps.missionStore.checkpoints.saveCheckpoint(mission.id, `${CELL_TYPE}:dispatch-debugger`, {
					capabilityMissing: true,
					dispatchFailureReason:
						"debugger capability not registered in agent-manifest.json — run `ha update --manifest`",
					dispatchedAt: new Date().toISOString(),
				});
				return { trigger: "capability_missing" };
			}

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
				return { trigger: "dispatch_failed" };
			}

			// N7 fix: re-resolve feature-branch HEAD fresh each attempt so prior
			// merge-debug-fix commits are captured. `git rev-parse` is cheap.
			let integrationSha = "";
			try {
				const proc = Bun.spawn(["git", "rev-parse", `refs/heads/${featureBranch}`], {
					cwd: projectRoot,
					stdout: "pipe",
					stderr: "pipe",
				});
				const stdout = await new Response(proc.stdout).text();
				if ((await proc.exited) === 0) integrationSha = stdout.trim();
			} catch {
				// Best-effort; empty sha means analyst will derive from local state.
			}

			const debuggerName = `debugger-${mission.slug}-attempt-${debugAttempts}`;
			const debugBranch = `haru/${mission.slug}/debug-attempt-${debugAttempts}`;
			const worktreePath = join(
				overstoryDir,
				"worktrees",
				"debug",
				`${mission.slug}-attempt-${debugAttempts}`,
			);

			// Create debug worktree from current feature-branch HEAD. New branch
			// off the feature ref; debugger commits land there.

			// Probe for prior worktree to make handler replay-safe.
			let worktreeAlreadyExists = false;
			try {
				const listProc = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
					cwd: projectRoot,
					stdout: "pipe",
					stderr: "pipe",
				});
				const out = await new Response(listProc.stdout).text();
				await listProc.exited;
				worktreeAlreadyExists = out
					.split("\n")
					.some((line) => line.startsWith("worktree ") && line.endsWith(worktreePath));
			} catch {
				// Probe failure is non-fatal; fall through to add and let it fail explicitly.
			}

			if (!worktreeAlreadyExists) {
				let addExit: number;
				let addStderr = "";
				try {
					const addProc = Bun.spawn(
						["git", "worktree", "add", "-b", debugBranch, worktreePath, featureBranch],
						{ cwd: projectRoot, stdout: "pipe", stderr: "pipe" },
					);
					addExit = await addProc.exited;
					if (addExit !== 0) addStderr = await new Response(addProc.stderr).text();
				} catch (err) {
					// Bun.spawn throws when cwd is missing or git is not found.
					addExit = 1;
					addStderr = err instanceof Error ? err.message : String(err);
				}
				if (addExit !== 0) {
					process.stderr.write(
						`[dispatch-debugger] worktree add failed: ${addStderr.slice(0, 200)}\n`,
					);
					// Fix #4 from full-PR review: short-circuit to escalation. Plan
					// §S8 risk-7: "worktree creation fails → escalate immediately, not
					// retry". Wasting 3 attempts on infrastructure failures the
					// debugger has no power to fix burns tokens for nothing.
					deps.missionStore.checkpoints.saveCheckpoint(
						mission.id,
						`${CELL_TYPE}:dispatch-debugger`,
						{
							debugAttempts,
							worktreeAddFailed: true,
							stderr: addStderr.slice(0, 500),
							dispatchedAt: new Date().toISOString(),
						},
					);
					return { trigger: "dispatch_failed" };
				}
			}

			// Spawn debugger via sling. Add debug attempts dir + brief path to
			// FILE_SCOPE so debugger can write hypothesis.md outside worktree
			// (the artifact root is the mission's debug/ — explicit exception
			// to PATH_BOUNDARY_VIOLATION).
			const artifactRoot = mission.artifactRoot ?? "";
			const debugAttemptsDir = join(artifactRoot, "debug", "attempts");
			const debugBriefPath = join(artifactRoot, "debug", "debug-brief.md");
			const slingProc = Bun.spawn(
				[
					"ha",
					"sling",
					`debug-${mission.slug}-${debugAttempts}`,
					"--capability",
					"debugger",
					"--name",
					debuggerName,
					"--branch",
					debugBranch,
					"--files",
					`${debugAttemptsDir}/**`,
					"--files",
					debugBriefPath,
				],
				{
					cwd: projectRoot,
					stdout: "pipe",
					stderr: "pipe",
					detached: true,
				},
			);
			slingProc.unref();

			// Persist attempt N + dispatched debugger + worktree path.
			deps.missionStore.checkpoints.saveCheckpoint(mission.id, `${CELL_TYPE}:dispatch-debugger`, {
				debugAttempts,
				debuggerName,
				debugBranch,
				featureBranch,
				integrationSha,
				worktreePath,
				dispatchedAt: new Date().toISOString(),
			});

			// Construct debug_brief_request payload for mission-analyst.
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
			// B2 fix from review: ff-update the feature branch ref WITHOUT checking
			// it out in canonical (canonical may be on a different branch — operator
			// may be working there). `git push . <src>:<dst>` does a local ref
			// fast-forward; only succeeds if dst is ancestor of src (true since
			// debug branch was forked from feature-branch HEAD).
			const proc = Bun.spawn(["git", "push", ".", `${data.debugBranch}:${data.featureBranch}`], {
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

			// Build Consultation Pack from attempts/<N>/hypothesis.md records.
			const debugCp = deps.missionStore.checkpoints.getCheckpoint(
				mission.id,
				`${CELL_TYPE}:dispatch-debugger`,
			);
			const debugData = debugCp?.data as {
				debugAttempts?: number;
				dispatchFailureReason?: string;
			} | null;
			const totalAttempts = debugData?.debugAttempts ?? MAX_DEBUG_ATTEMPTS;
			const dispatchFailureReason = debugData?.dispatchFailureReason ?? null;

			// B3 fix from review (N8): send `question` mail FIRST, capture
			// returned messageId, use it as threadId in freeze(). Otherwise the
			// frozen mission has no thread anchor for operator response.
			//
			// Round-3 da-risk-12: placeholder-checkpoint pattern guards against the
			// crash window between send and persist — prevents duplicate operator mail
			// on replay.
			let threadId: string | null = null;
			const escalateCp = deps.missionStore.checkpoints.getCheckpoint(
				mission.id,
				`${CELL_TYPE}:escalate`,
			);
			const prior = escalateCp?.data as {
				escalationPending?: boolean;
				escalationThreadId?: string;
			} | null;

			if (prior?.escalationThreadId) {
				// Already sent (with successful threadId persistence). Reuse.
				threadId = prior.escalationThreadId;
			} else if (prior?.escalationPending) {
				// Crash between send and persist. Cannot tell if the mail landed.
				// Route to pending_replay_aborted rather than risk double-send.
				await ctx.sendMail(
					"operator",
					`Escalation interrupted: ${mission.slug ?? mission.id}`,
					`An escalation mail send was interrupted mid-flight (escalationPending=true, no threadId). The first mail may or may not have landed. Inspect operator inbox before deciding.`,
					"mission_finding",
				);
				return { trigger: "pending_replay_aborted" };
			} else {
				// Fresh path: build pack, write, placeholder checkpoint, send, persist threadId.
				const pack =
					`# Consultation Request Pack\n\n` +
					(dispatchFailureReason
						? `Mission ${mission.slug} could not dispatch debugger. Reason: ${dispatchFailureReason}\n\n`
						: `Mission ${mission.slug} exhausted ${totalAttempts} debug attempts. ` +
							`Inspect attempts/<N>/hypothesis.md for what was tried. `) +
					`Run \`ha mission debug status ${mission.id}\` to review, then ` +
					`\`ha mission debug retry|accept|abort\` to resolve.\n`;
				await Bun.write(packPath, pack);

				const escalationPayload: DebugEscalationPayload = {
					missionId: mission.id,
					totalAttempts,
					packPath,
				};

				const mailStore = deps.mailStore;
				if (mailStore) {
					deps.missionStore.checkpoints.saveCheckpoint(mission.id, `${CELL_TYPE}:escalate`, {
						...(prior ?? {}),
						escalationPending: true,
					});
					const { createMailClient } = await import("../../mail/client.ts");
					const mailClient = createMailClient(mailStore);
					threadId = mailClient.send({
						from: `coordinator-${mission.slug}`,
						to: "operator",
						subject: `Debug escalation: ${mission.slug}`,
						body:
							`Mission ${mission.slug} needs human intervention after ${totalAttempts} debug attempts. ` +
							`Pack: ${packPath}\n\n` +
							`Run \`ha mission debug status ${mission.id}\` to inspect, then ` +
							`retry/accept/abort.`,
						type: "question",
						missionId: mission.id,
						payload: JSON.stringify(escalationPayload),
					});
					deps.missionStore.checkpoints.saveCheckpoint(mission.id, `${CELL_TYPE}:escalate`, {
						...(prior ?? {}),
						escalationPending: false,
						escalationThreadId: threadId,
					});
				}

				// Notification mail for observability (non-blocking; Stage E integrations).
				await deps.mailSend(
					"operator",
					`[notification] Debug escalation: ${mission.slug}`,
					`Pack: ${packPath}`,
					"debug_escalation",
				);
			}

			// Freeze with the question's messageId as threadId so future thread-
			// based unfreeze (post-Stage-C operator flow extensions) can resolve
			// the relationship cleanly.
			deps.missionStore.freeze(mission.id, "debug-escalation", threadId);
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
