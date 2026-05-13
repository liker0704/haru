/**
 * Reusable debug-loop handler factory (arch-01 refactor).
 *
 * Consumed by done-phase now and pr-phase (w3). Checkpoint keys are namespaced
 * by cellType so handlers from different cells can coexist in the same store.
 */

import { join } from "node:path";
import { createManifestLoader } from "../../agents/manifest.ts";
import type { DebugBriefRequestPayload, DebugEscalationPayload } from "../../mail/types.ts";
import type { HandlerRegistry } from "../types.ts";
import type { PhaseCellDeps } from "./types.ts";

const DEFAULT_MAX_ATTEMPTS = 3;

export interface DebugLoopOpts {
	cellType: string;
	maxAttempts?: number;
	briefTimeoutSeconds?: number;
	fixTimeoutSeconds?: number;
	// Forward-compat seam: w3 (pr-phase) will switch on this when the
	// DebugBriefRequestPayload union is introduced. Currently unused in payload
	// construction — DebugBriefRequestPayload is non-discriminated.
	failureSource: "holdout" | "ci";
}

export interface DebugLoopDeps {
	mailSend: PhaseCellDeps["mailSend"];
	checkpointStore: PhaseCellDeps["checkpointStore"];
	missionStore: PhaseCellDeps["missionStore"];
	mailStore?: PhaseCellDeps["mailStore"];
	overstoryDir?: string;
	projectRoot?: string;
}

export function makeDebugLoopHandlers(opts: DebugLoopOpts, deps: DebugLoopDeps): HandlerRegistry {
	const cellType = opts.cellType;
	const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const dispatchKey = `${cellType}:dispatch-debugger`;
	const escalateKey = `${cellType}:escalate`;

	return {
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
				deps.missionStore.checkpoints.saveCheckpoint(mission.id, dispatchKey, {
					capabilityMissing: true,
					dispatchFailureReason:
						"debugger capability not registered in agent-manifest.json — run `ha update --manifest`",
					dispatchedAt: new Date().toISOString(),
				});
				return { trigger: "capability_missing" };
			}

			// Increment attempt counter (stored on this node's checkpoint)
			const cp = deps.missionStore.checkpoints.getCheckpoint(mission.id, dispatchKey);
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
					deps.missionStore.checkpoints.saveCheckpoint(mission.id, dispatchKey, {
						debugAttempts,
						worktreeAddFailed: true,
						stderr: addStderr.slice(0, 500),
						dispatchedAt: new Date().toISOString(),
					});
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
			deps.missionStore.checkpoints.saveCheckpoint(mission.id, dispatchKey, {
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
				failureSource: "holdout",
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
			const cp = deps.missionStore.checkpoints.getCheckpoint(mission.id, dispatchKey);
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
			const cp = deps.missionStore.checkpoints.getCheckpoint(mission.id, dispatchKey);
			const data = cp?.data as { debugAttempts?: number } | null;
			const attempts = data?.debugAttempts ?? 0;
			return { trigger: attempts < maxAttempts ? "retry" : "exhausted" };
		},

		escalate: async (ctx) => {
			const mission = ctx.getMission();
			if (!mission) return { trigger: "escalated" };
			const artifactRoot = mission.artifactRoot ?? "";
			const packPath = join(artifactRoot, "debug", "consultation-request-pack.md");

			// Build Consultation Pack from attempts/<N>/hypothesis.md records.
			const debugCp = deps.missionStore.checkpoints.getCheckpoint(mission.id, dispatchKey);
			const debugData = debugCp?.data as {
				debugAttempts?: number;
				dispatchFailureReason?: string;
			} | null;
			const totalAttempts = debugData?.debugAttempts ?? maxAttempts;
			const dispatchFailureReason = debugData?.dispatchFailureReason ?? null;

			// B3 fix from review (N8): send `question` mail FIRST, capture
			// returned messageId, use it as threadId in freeze(). Otherwise the
			// frozen mission has no thread anchor for operator response.
			//
			// Round-3 da-risk-12: placeholder-checkpoint pattern guards against the
			// crash window between send and persist — prevents duplicate operator mail
			// on replay.
			let threadId: string | null = null;
			const escalateCp = deps.missionStore.checkpoints.getCheckpoint(mission.id, escalateKey);
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
					deps.missionStore.checkpoints.saveCheckpoint(mission.id, escalateKey, {
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
					deps.missionStore.checkpoints.saveCheckpoint(mission.id, escalateKey, {
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
	};
}
