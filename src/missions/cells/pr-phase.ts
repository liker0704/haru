/**
 * PR-phase subgraph cell (Stage E, workstream w3).
 *
 * 17-node subgraph covering PR creation, CI integration, triage, approval, and merge.
 * Shares the debug-loop handler factory with done-phase for CI failure recovery.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MergeReadinessPack, renderMrpMarkdown } from "../../merge/mrp-renderer.ts";
import type { MissionGraph } from "../../types.ts";
import { getGhBudget } from "../gh-budget.ts";
import { isRealTaskId } from "../task-id.ts";
import type { HandlerRegistry } from "../types.ts";
import { makeDebugLoopHandlers } from "./debug-loop-handlers.ts";
import type { PrPhaseTrigger } from "./pr-phase-triggers.ts";
import type { PhaseCellConfig, PhaseCellDefinition, PhaseCellDeps } from "./types.ts";

const CELL_TYPE = "pr-phase";

const MERGE_METHOD_ALLOWLIST = new Set(["SQUASH", "MERGE", "REBASE"]);

function edge(from: string, to: string, trigger: PrPhaseTrigger | "timeout" | "escalated") {
	return { from: `${CELL_TYPE}:${from}`, to: `${CELL_TYPE}:${to}`, trigger };
}

function buildSubgraph(config: PhaseCellConfig): MissionGraph {
	const prCfg = config.pr;
	return {
		version: 1,
		nodes: [
			{ kind: "cell", id: `${CELL_TYPE}:preflight`, cellType: CELL_TYPE, handler: "preflight" },
			{ kind: "cell", id: `${CELL_TYPE}:create`, cellType: CELL_TYPE, handler: "create" },
			{
				kind: "cell",
				id: `${CELL_TYPE}:await-ci`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: Math.floor((prCfg?.ciTimeoutMs ?? 14_400_000) / 1000),
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:classify-ci-red`,
				cellType: CELL_TYPE,
				handler: "classify-ci-red",
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
				id: `${CELL_TYPE}:await-debug-complete`,
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
				id: `${CELL_TYPE}:await-comments`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: Math.floor((prCfg?.commentsTimeoutMs ?? 604_800_000) / 1000),
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:dispatch-triage`,
				cellType: CELL_TYPE,
				handler: "dispatch-triage",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:resume-coordinator`,
				cellType: CELL_TYPE,
				handler: "resume-coordinator",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:await-approval`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: Math.floor((prCfg?.approvalTimeoutMs ?? 172_800_000) / 1000),
			},
			{ kind: "cell", id: `${CELL_TYPE}:merge`, cellType: CELL_TYPE, handler: "merge" },
			{ kind: "cell", id: `${CELL_TYPE}:escalate`, cellType: CELL_TYPE, handler: "escalate" },
			{ kind: "cell", id: `${CELL_TYPE}:done`, cellType: CELL_TYPE, terminal: true },
			{ kind: "cell", id: `${CELL_TYPE}:paused`, cellType: CELL_TYPE, terminal: true },
		],
		edges: [
			// preflight
			edge("preflight", "create", "preflight_passed"),
			edge("preflight", "paused", "gh_auth_missing"),
			edge("preflight", "paused", "pr_phase_disabled"),
			// create
			edge("create", "await-ci", "pr_created"),
			edge("create", "await-ci", "pr_already_exists"),
			edge("create", "paused", "pr_create_network_fail"),
			edge("create", "paused", "pr_rate_limited"),
			edge("create", "paused", "pr_branch_protected"),
			// #398: when the mission produced no commits, that's a clean
			// no-op outcome (audit/verification missions); route to the success
			// terminal rather than paused so the mission completes normally
			// without operator escalation.
			edge("create", "done", "pr_no_commits"),
			// await-ci
			edge("await-ci", "classify-ci-red", "ci_failed"),
			edge("await-ci", "await-comments", "ci_passed"),
			edge("await-ci", "escalate", "ci_timeout"),
			// classify-ci-red
			edge("classify-ci-red", "await-ci", "ci_flake_retry"),
			edge("classify-ci-red", "dispatch-debugger", "ci_code_fail"),
			edge("classify-ci-red", "escalate", "ci_infra_fail"),
			// debug-loop
			edge("dispatch-debugger", "request-analyst-brief", "debugger_dispatched"),
			edge("dispatch-debugger", "escalate", "dispatch_failed"),
			edge("dispatch-debugger", "escalate", "capability_missing"),
			edge("request-analyst-brief", "await-debug-complete", "brief_ready"),
			{
				from: `${CELL_TYPE}:request-analyst-brief`,
				to: `${CELL_TYPE}:check-debug-attempts`,
				trigger: "timeout",
			},
			edge("await-debug-complete", "merge-debug-fix", "fix_committed"),
			edge("await-debug-complete", "check-debug-attempts", "fix_failed"),
			edge("await-debug-complete", "check-debug-attempts", "debug_timeout"),
			edge("merge-debug-fix", "await-ci", "merged"),
			edge("merge-debug-fix", "check-debug-attempts", "merge_conflict"),
			edge("check-debug-attempts", "dispatch-debugger", "retry"),
			edge("check-debug-attempts", "escalate", "exhausted"),
			// await-comments
			edge("await-comments", "dispatch-triage", "new_comment"),
			edge("await-comments", "await-approval", "approval_event"),
			edge("await-comments", "escalate", "comments_stale"),
			// dispatch-triage
			edge("dispatch-triage", "await-comments", "trivial_fix"),
			edge("dispatch-triage", "await-comments", "needs_context"),
			edge("dispatch-triage", "await-comments", "refactor_request"),
			edge("dispatch-triage", "await-comments", "reply_only"),
			edge("dispatch-triage", "resume-coordinator", "approval_event"),
			edge("dispatch-triage", "escalate", "human_triage_request"),
			edge("dispatch-triage", "escalate", "pr_triage_flood"),
			// resume-coordinator
			edge("resume-coordinator", "await-comments", "coordinator_done"),
			edge("resume-coordinator", "escalate", "coordinator_session_unavailable"),
			edge("resume-coordinator", "escalate", "pr_triage_flood"),
			// await-approval
			edge("await-approval", "merge", "approved"),
			edge("await-approval", "await-comments", "changes_requested"),
			edge("await-approval", "escalate", "approval_pending_long"),
			// merge
			edge("merge", "done", "merged"),
			edge("merge", "escalate", "pr_head_changed"),
			edge("merge", "escalate", "pr_merge_conflict"),
			// escalate terminal
			edge("escalate", "paused", "escalated"),
		],
	};
}

function buildHandlers(deps: PhaseCellDeps, config?: PhaseCellConfig): HandlerRegistry {
	const prCfg = config?.pr;
	const debugLoop = makeDebugLoopHandlers(
		{ cellType: CELL_TYPE, maxAttempts: 3, failureSource: "ci" },
		deps,
	);

	return {
		...debugLoop,

		escalate: async () => ({ trigger: "escalated" }),

		preflight: async (_ctx) => {
			if (prCfg?.enabled === false) {
				return { trigger: "pr_phase_disabled" };
			}
			const result = await getGhBudget().runGh(["auth", "status"]);
			if (result.exitCode !== 0) {
				return { trigger: "gh_auth_missing" };
			}
			return { trigger: "preflight_passed" };
		},

		create: async (ctx) => {
			const mission = ctx.getMission();
			const featureBranch = mission?.featureBranch ?? null;
			if (!featureBranch) {
				return { trigger: "pr_no_commits" };
			}

			const spawnFn = deps.spawn ?? Bun.spawn;
			// The local feature_branch was created at mission start pointing to
			// origin/main, but builder merges land on local `main`, leaving
			// feature_branch stale. Reset it to local main HEAD so the push
			// carries the merged work; without this, gh pr create sees no diff
			// between head and base and fails silently into pr_create_network_fail.
			const resetProc = spawnFn(["git", "branch", "-f", featureBranch, "main"], {
				cwd: deps.projectRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			await resetProc.exited;

			// Bug fix #398: pre-flight check whether main has any commits ahead of
			// origin/main. If 0, the mission produced no diff (audit/verification
			// missions, scope=0). Emit a clean pr_no_commits trigger rather than
			// pushing an empty branch and getting a misleading pr_create_network_fail.
			const countProc = spawnFn(["git", "rev-list", "--count", "origin/main..main"], {
				cwd: deps.projectRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			const countExit = await countProc.exited;
			if (countExit === 0) {
				const countStdout = countProc.stdout ? await new Response(countProc.stdout).text() : "0";
				const ahead = Number.parseInt(countStdout.trim(), 10);
				if (Number.isFinite(ahead) && ahead === 0) {
					return { trigger: "pr_no_commits" };
				}
			}

			// Use --force-with-lease so the local update is reflected on origin
			// without clobbering unrelated remote work; the remote ref was
			// previously the stale origin/main, so this is the legitimate update.
			const pushProc = spawnFn(
				["git", "push", "--force-with-lease", "-u", "origin", featureBranch],
				{
					cwd: deps.projectRoot,
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const pushExit = await pushProc.exited;
			if (pushExit !== 0) {
				const pushStderr = pushProc.stderr ? await new Response(pushProc.stderr).text() : "";
				if (/protected branch/i.test(pushStderr) || /pre-receive hook declined/i.test(pushStderr)) {
					return { trigger: "pr_branch_protected" };
				}
				return { trigger: "pr_create_network_fail" };
			}

			const title = mission?.slug ?? featureBranch;
			const mrpPath = join(mission?.artifactRoot ?? "", "merge-readiness-pack.json");
			const taskIdForFooter = mission && isRealTaskId(mission.taskId) ? mission.taskId : undefined;
			let body: string;
			try {
				const mrpText = await Bun.file(mrpPath).text();
				const mrp = JSON.parse(mrpText) as MergeReadinessPack;
				body = renderMrpMarkdown(mrp, {
					showCost: prCfg?.showCost ?? false,
					taskId: taskIdForFooter,
				});
			} catch {
				console.warn(`[pr-phase] MRP unavailable at ${mrpPath}, using fallback body`);
				body = `Automated PR for mission: ${title}`;
				if (taskIdForFooter) body += `\n\nCloses ${taskIdForFooter}`;
				body += `\n\n(MRP unavailable — pre-pr-phase may have failed to write it)`;
			}
			const bodyTmpPath = join(tmpdir(), `pr-body-${ctx.missionId}.md`);
			await Bun.write(bodyTmpPath, body);

			const createResult = await getGhBudget().runGh([
				"pr",
				"create",
				"--title",
				title,
				"--body-file",
				bodyTmpPath,
				"--head",
				featureBranch,
				"--base",
				"main",
			]);

			if (createResult.exitCode !== 0) {
				const stderr = createResult.stderr;
				if (/pull request .* already exists/i.test(stderr)) {
					const viewResult = await getGhBudget().runGh([
						"pr",
						"view",
						featureBranch,
						"--json",
						"number,url,headRefOid",
					]);
					const parsed = JSON.parse(viewResult.stdout) as {
						number: number;
						url: string;
						headRefOid: string;
					};
					deps.missionStore.upsertPrState({
						missionId: ctx.missionId,
						prNumber: parsed.number,
						prUrl: parsed.url,
						branch: featureBranch,
						createdAt: new Date().toISOString(),
						lastCiStatus: null,
						lastReviewDecision: null,
						approvedHeadSha: null,
						mergedAt: null,
					});
					const payload = { prNumber: parsed.number, prUrl: parsed.url };
					return { trigger: "pr_already_exists", ...{ payload } };
				}
				if (/branch protection/i.test(stderr)) {
					return { trigger: "pr_branch_protected" };
				}
				return { trigger: "pr_create_network_fail" };
			}

			// Success — stdout contains the PR URL
			const prUrl = createResult.stdout.trim();
			const prNumberMatch = /\/pull\/(\d+)/.exec(prUrl);
			const prNumber = prNumberMatch?.[1] ? parseInt(prNumberMatch[1], 10) : 0;
			deps.missionStore.upsertPrState({
				missionId: ctx.missionId,
				prNumber,
				prUrl,
				branch: featureBranch,
				createdAt: new Date().toISOString(),
				lastCiStatus: null,
				lastReviewDecision: null,
				approvedHeadSha: null,
				mergedAt: null,
			});
			const payload = { prNumber, prUrl };
			return { trigger: "pr_created", ...{ payload } };
		},

		"classify-ci-red": async (ctx) => {
			const cp = ctx.checkpoint as {
				checks: Array<{ conclusion: string; durationMs: number }>;
				flakeRetryCount?: number;
			} | null;
			const checks = cp?.checks ?? [];
			const prevFlakeCount = cp?.flakeRetryCount ?? 0;

			const maxFlakeRetries = prCfg?.classifyCiRed?.maxFlakeRetries ?? 3;
			const flakeThresholdMs = prCfg?.classifyCiRed?.flakeThresholdMs ?? 30_000;

			// Any CANCELLED or TIMED_OUT → infra failure
			if (checks.some((c) => c.conclusion === "CANCELLED" || c.conclusion === "TIMED_OUT")) {
				return { trigger: "ci_infra_fail" };
			}

			const failures = checks.filter((c) => c.conclusion === "FAILURE");
			if (failures.length > 0 && failures.every((c) => c.durationMs < flakeThresholdMs)) {
				// All failures are fast — potential flakes
				if (prevFlakeCount >= maxFlakeRetries) {
					return { trigger: "ci_code_fail" };
				}
				const newCount = prevFlakeCount + 1;
				const backoffMs = Math.min(60_000 * 2 ** prevFlakeCount, 600_000);
				await ctx.saveCheckpoint({
					...((cp ?? {}) as object),
					flakeRetryCount: newCount,
					nextPollAfter: new Date(Date.now() + backoffMs).toISOString(),
				});
				return { trigger: "ci_flake_retry" };
			}

			return { trigger: "ci_code_fail" };
		},

		"dispatch-triage": async (ctx) => {
			const cp = ctx.checkpoint as {
				comment: { commentId: string; author: string; body: string };
				classification?: { action: string; confidence: number };
			} | null;

			const comment = cp?.comment;
			const classification = cp?.classification;

			// Post-triage path: classification result arrived
			if (classification) {
				const minConfidence = prCfg?.triage?.minConfidence ?? 0.7;
				if (classification.confidence < minConfidence) {
					return { trigger: "human_triage_request" };
				}
				if (classification.action === "trivial_fix" && classification.confidence < 0.85) {
					return { trigger: "human_triage_request" };
				}
				const action = classification.action;
				if (
					action === "trivial_fix" ||
					action === "needs_context" ||
					action === "refactor_request" ||
					action === "reply_only" ||
					action === "approval_event" ||
					action === "human_triage_request"
				) {
					return { trigger: action as PrPhaseTrigger };
				}
				return { trigger: "human_triage_request" };
			}

			// New comment to triage
			if (!comment) {
				return { trigger: "reply_only" };
			}

			const { commentId, author } = comment;

			// Allowlist check first (security-correct: non-allowlisted authors never touch counters)
			const allowList = prCfg?.commentTriageAuthors ?? [];
			if (!allowList.includes(author)) {
				deps.missionStore.updatePrCommentAction(commentId, "reply_only", "responded");
				return { trigger: "reply_only" };
			}

			// Per-mission cap check (atomic CAS to close race from #305)
			const maxPerMission = prCfg?.maxTriageSpawnsPerMission ?? 50;
			const prState = deps.missionStore.getPrState(ctx.missionId);
			const prStart = prState?.createdAt ?? new Date(0).toISOString();

			const maxPerAuthor = prCfg?.maxTriagePerAuthorPerHour ?? 5;
			const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
			const authorCount = deps.missionStore.countTriagePerAuthorSince(
				ctx.missionId,
				author,
				oneHourAgo,
			);
			if (authorCount >= maxPerAuthor) {
				const payload = { kind: "per_author", limit: maxPerAuthor };
				return { trigger: "pr_triage_flood", ...{ payload } };
			}

			// Atomic claim — replaces the prior count+update read-then-write race (#305).
			const claimed = deps.missionStore.tryClaimTriageSlot(
				ctx.missionId,
				commentId,
				prStart,
				maxPerMission,
			);
			if (!claimed) {
				const payload = { kind: "per_mission", limit: maxPerMission };
				return { trigger: "pr_triage_flood", ...{ payload } };
			}

			const spawnFn = deps.spawn ?? Bun.spawn;
			const triageProc = spawnFn(
				["ha", "sling", `triage-${commentId}`, "--capability", "triage", "--comment-id", commentId],
				{
					cwd: deps.projectRoot,
					stdout: "pipe",
					stderr: "pipe",
					detached: true,
				},
			);
			triageProc.unref();

			return { trigger: "new_comment" };
		},

		"resume-coordinator": async (ctx) => {
			const mission = ctx.getMission();
			if (!mission || mission.coordinatorSessionId === null) {
				return { trigger: "coordinator_session_unavailable" };
			}

			const cp = ctx.checkpoint as {
				coordinatorResumeCount?: number;
				comment: { commentId: string; author: string; body: string };
				classification: { action: string; confidence: number };
			} | null;

			const resumeCount = cp?.coordinatorResumeCount ?? 0;
			const maxResumes = prCfg?.maxCoordinatorResumesPerPr ?? 3;
			if (resumeCount >= maxResumes) {
				const payload = { kind: "coordinator_resume_cap" };
				return { trigger: "pr_triage_flood", ...{ payload } };
			}

			const comment = cp?.comment;
			const classification = cp?.classification;
			const commentId = comment?.commentId ?? "unknown";
			const artifactRoot = mission.artifactRoot ?? deps.overstoryDir ?? "/tmp";

			// Write a dispatch spec that references the comment file by path, not inline body
			const commentFilePath = join(artifactRoot, "pr-comments", `${commentId}.json`);
			const specPath = join(artifactRoot, "pr-comments", `${commentId}.dispatch-spec.md`);
			const specContent = [
				`# Coordinator Resume: ${commentId}`,
				``,
				`Comment file: ${commentFilePath}`,
				`Classification: ${JSON.stringify(classification ?? {})}`,
				`Session: ${mission.coordinatorSessionId}`,
			].join("\n");
			await Bun.write(specPath, specContent);

			await ctx.saveCheckpoint({
				...cp,
				coordinatorResumeCount: resumeCount + 1,
			});

			const spawnFn = deps.spawn ?? Bun.spawn;
			const resumeProc = spawnFn(
				[
					"ha",
					"sling",
					`coordinator-resume-${commentId}`,
					"--capability",
					"coordinator",
					"--spec",
					specPath,
					"--files",
					commentFilePath,
					"--resume-session-id",
					mission.coordinatorSessionId,
				],
				{
					cwd: deps.projectRoot,
					stdout: "pipe",
					stderr: "pipe",
					detached: true,
				},
			);
			resumeProc.unref();

			return { trigger: "coordinator_done" };
		},

		merge: async (ctx) => {
			const prState = deps.missionStore.getPrState(ctx.missionId);
			if (!prState || prState.approvedHeadSha === null) {
				const payload = { reason: "approved_head_sha unset; refusing to merge without SHA pin" };
				return { trigger: "pr_head_changed", ...{ payload } };
			}

			const viewResult = await getGhBudget().runGh([
				"pr",
				"view",
				String(prState.prNumber),
				"--json",
				"headRefOid,id",
			]);
			const current = JSON.parse(viewResult.stdout) as { headRefOid: string; id: string };

			if (current.headRefOid !== prState.approvedHeadSha) {
				const payload = {
					approvedSha: prState.approvedHeadSha,
					currentSha: current.headRefOid,
				};
				return { trigger: "pr_head_changed", ...{ payload } };
			}

			const raw = (prCfg?.mergeStrategy ?? "squash").toUpperCase();
			if (!MERGE_METHOD_ALLOWLIST.has(raw)) {
				const payload = { reason: `invalid mergeMethod: ${raw}` };
				return { trigger: "pr_merge_conflict", ...{ payload } };
			}
			const mergeMethod = raw;
			const mutation = `mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) { mergePullRequest(input: {pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid, mergeMethod: ${mergeMethod}}) { pullRequest { merged } } }`;
			const graphqlResult = await getGhBudget().runGh([
				"api",
				"graphql",
				"-f",
				`query=${mutation}`,
				"-f",
				`pullRequestId=${current.id}`,
				"-f",
				`expectedHeadOid=${prState.approvedHeadSha}`,
			]);

			if (graphqlResult.exitCode !== 0) {
				if (graphqlResult.stderr.includes("staleData")) {
					return { trigger: "pr_head_changed" };
				}
				return { trigger: "pr_merge_conflict" };
			}

			deps.missionStore.markPrMerged(ctx.missionId, new Date().toISOString());
			return { trigger: "merged" };
		},
	};
}

export const prPhaseCell: PhaseCellDefinition = {
	cellType: CELL_TYPE,
	buildSubgraph,
	buildHandlers,
};
