/**
 * Intake-phase subgraph cell — Stage A.
 *
 * Runs as the FIRST phase of every mission, before `understand-phase`. Turns
 * a raw operator intent into a structured `product-spec.md` + a deterministic
 * tier classification, then advances to `understand-phase` (planned/full) or
 * `execute-phase` (direct).
 *
 * Subgraph nodes:
 *   ensure-context-generate (handler) → context_ready | context_generating
 *   await-context (async, 600s) → context_ready
 *   dispatch-analyst-intake (handler) → analyst_dispatched | dispatch_failed
 *   await-research-complete (async, 1500s) → research_ready
 *   dispatch-clarifier (handler) → clarifier_dispatched | dispatch_failed
 *   await-spec-ready (async, 3600s) → spec_ready
 *   human-spec-review (human, AUTO-SKIP if mission.autonomy != supervised) → approved | rejected
 *   spec-rejected (handler — capture reason, retry counter) → retry | escalate | dispatch_failed
 *   dispatch-tier-classifier (handler) → classifier_dispatched | dispatch_failed
 *   await-tier-set (async, 300s) → tier_set
 *   escalate (handler) → escalated
 *   complete (terminal)
 *
 * The `ensure-context-generate` handler is non-blocking (#236): if the cached
 * project-context.json is recent (< 1h old by mtime), it returns `context_ready`
 * immediately; otherwise it spawns `ha context generate` in a detached
 * background process and returns `context_generating`, routing the graph to
 * the `await-context` async gate which polls for the regenerated cache file.
 * This keeps the watchdog tick fast (<500ms) even on 10k+ file monorepos
 * where analyzeProject can otherwise take 30s+ and starve other missions.
 *
 * Dispatch handlers shell out via `spawnEphemeralAgent` for ephemeral agents
 * (clarifier, tier-classifier) and call `ensureMissionAnalyst` for the
 * persistent analyst. Synchronous spawn failure routes to dispatch_failed →
 * escalate rather than silently returning the success trigger.
 */

import { join } from "node:path";
import type { MissionGraph } from "../../types.ts";
import { PENDING_SENTINEL, isRealTaskId } from "../task-id.ts";
import type { HandlerRegistry } from "../types.ts";
import { extractSpecTitle } from "./spec-title.ts";
import { spawnEphemeralAgent } from "./spawn-helpers.ts";
import type { PhaseCellConfig, PhaseCellDefinition, PhaseCellDeps } from "./types.ts";

const CELL_TYPE = "intake-phase";

/** Hard cap for spec rejection retry loop before escalation to operator. */
const MAX_SPEC_REJECTIONS = 3;

/**
 * Window during which an existing project-context.json is treated as fresh
 * enough to skip regeneration. 1h matches the typical mission intake cadence:
 * structural project shape rarely changes within an hour, and analyzeProject
 * on 10k+ file monorepos can take 30s+ — too long to run inline on a watchdog
 * tick. See #236.
 */
const CONTEXT_CACHE_FRESH_MS = 60 * 60 * 1000;

function buildSubgraph(_config: PhaseCellConfig): MissionGraph {
	return {
		version: 1,
		nodes: [
			{
				kind: "cell",
				id: `${CELL_TYPE}:ensure-context-generate`,
				cellType: CELL_TYPE,
				handler: "ensure-context-generate",
			},
			{
				// #236: async gate polled by evaluateAwaitContext — waits for
				// background `ha context generate` (spawned by the handler when
				// the cache is stale) to materialize project-context.json.
				kind: "cell",
				id: `${CELL_TYPE}:await-context`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 600,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:dispatch-analyst-intake`,
				cellType: CELL_TYPE,
				handler: "dispatch-analyst-intake",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:await-research-complete`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 1500,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:dispatch-clarifier`,
				cellType: CELL_TYPE,
				handler: "dispatch-clarifier",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:await-spec-ready`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 3600,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:human-spec-review`,
				cellType: CELL_TYPE,
				gate: "human",
				handler: "human-spec-review",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:spec-rejected`,
				cellType: CELL_TYPE,
				handler: "spec-rejected",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:create-tracker-issue`,
				cellType: CELL_TYPE,
				handler: "create-tracker-issue",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:dispatch-tier-classifier`,
				cellType: CELL_TYPE,
				handler: "dispatch-tier-classifier",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:await-tier-set`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 300,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:escalate`,
				cellType: CELL_TYPE,
				handler: "escalate",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:complete`,
				cellType: CELL_TYPE,
				terminal: true,
			},
		],
		edges: [
			{
				from: `${CELL_TYPE}:ensure-context-generate`,
				to: `${CELL_TYPE}:dispatch-analyst-intake`,
				trigger: "context_ready",
			},
			// #236: stale-cache path — handler spawns background regen and routes
			// to the async gate, which polls for the regenerated file.
			{
				from: `${CELL_TYPE}:ensure-context-generate`,
				to: `${CELL_TYPE}:await-context`,
				trigger: "context_generating",
			},
			{
				from: `${CELL_TYPE}:await-context`,
				to: `${CELL_TYPE}:dispatch-analyst-intake`,
				trigger: "context_ready",
			},
			{
				from: `${CELL_TYPE}:dispatch-analyst-intake`,
				to: `${CELL_TYPE}:await-research-complete`,
				trigger: "analyst_dispatched",
			},
			{
				from: `${CELL_TYPE}:await-research-complete`,
				to: `${CELL_TYPE}:dispatch-clarifier`,
				trigger: "research_ready",
			},
			{
				from: `${CELL_TYPE}:dispatch-clarifier`,
				to: `${CELL_TYPE}:await-spec-ready`,
				trigger: "clarifier_dispatched",
			},
			{
				from: `${CELL_TYPE}:await-spec-ready`,
				to: `${CELL_TYPE}:human-spec-review`,
				trigger: "spec_ready",
			},
			// Approval — create tracker issue, then proceed to tier classification
			{
				from: `${CELL_TYPE}:human-spec-review`,
				to: `${CELL_TYPE}:create-tracker-issue`,
				trigger: "approved",
			},
			{
				from: `${CELL_TYPE}:create-tracker-issue`,
				to: `${CELL_TYPE}:dispatch-tier-classifier`,
				trigger: "issue_created",
			},
			{
				from: `${CELL_TYPE}:create-tracker-issue`,
				to: `${CELL_TYPE}:dispatch-tier-classifier`,
				trigger: "issue_already_set",
			},
			{
				from: `${CELL_TYPE}:create-tracker-issue`,
				to: `${CELL_TYPE}:dispatch-tier-classifier`,
				trigger: "spec_missing",
			},
			{
				from: `${CELL_TYPE}:create-tracker-issue`,
				to: `${CELL_TYPE}:dispatch-tier-classifier`,
				trigger: "issue_create_failed",
			},
			// Rejection — capture reason, retry or escalate
			{
				from: `${CELL_TYPE}:human-spec-review`,
				to: `${CELL_TYPE}:spec-rejected`,
				trigger: "rejected",
			},
			{
				from: `${CELL_TYPE}:spec-rejected`,
				to: `${CELL_TYPE}:dispatch-clarifier`,
				trigger: "retry",
			},
			// Escalation after MAX_SPEC_REJECTIONS — operator gets manual edit/cancel
			{
				from: `${CELL_TYPE}:spec-rejected`,
				to: `${CELL_TYPE}:human-spec-review`,
				trigger: "escalate",
			},
			{
				from: `${CELL_TYPE}:dispatch-tier-classifier`,
				to: `${CELL_TYPE}:await-tier-set`,
				trigger: "classifier_dispatched",
			},
			{
				from: `${CELL_TYPE}:await-tier-set`,
				to: `${CELL_TYPE}:complete`,
				trigger: "tier_set",
			},
			// dispatch_failed edges: all three dispatch handlers + spec-rejected
			// (pending-replay non-safe path) route to escalate for operator notification.
			{
				from: `${CELL_TYPE}:dispatch-clarifier`,
				to: `${CELL_TYPE}:escalate`,
				trigger: "dispatch_failed",
			},
			{
				from: `${CELL_TYPE}:dispatch-tier-classifier`,
				to: `${CELL_TYPE}:escalate`,
				trigger: "dispatch_failed",
			},
			{
				from: `${CELL_TYPE}:dispatch-analyst-intake`,
				to: `${CELL_TYPE}:escalate`,
				trigger: "dispatch_failed",
			},
			{
				from: `${CELL_TYPE}:spec-rejected`,
				to: `${CELL_TYPE}:escalate`,
				trigger: "dispatch_failed",
			},
			{
				from: `${CELL_TYPE}:escalate`,
				to: `${CELL_TYPE}:complete`,
				trigger: "escalated",
			},
		],
	};
}

interface IntakeCheckpoint {
	rejectionCount?: number;
	rejectionReason?: string;
}

function isValidTrackerId(id: unknown): id is string {
	return (
		typeof id === "string" &&
		id.length > 0 &&
		id.length <= 64 &&
		/^[A-Za-z0-9_-]+$/.test(id) &&
		id !== PENDING_SENTINEL
	);
}

function buildHandlers(deps: PhaseCellDeps): HandlerRegistry {
	return {
		"ensure-context-generate": async (_ctx) => {
			// #236: non-blocking. analyzeProject can take 5-30s on 10k+ file
			// monorepos and was previously called inline, starving the watchdog
			// tick. New flow: if the cache file is fresh (< 1h old by mtime),
			// fast-path `context_ready`; otherwise spawn `ha context generate`
			// in a detached background process and return `context_generating`
			// → routes to the `await-context` async gate, which polls for the
			// regenerated cache file.
			if (!deps.projectRoot || !deps.overstoryDir) {
				return { trigger: "context_ready" };
			}
			try {
				const { join } = await import("node:path");
				const { statSync, existsSync } = await import("node:fs");
				const cachePath = join(deps.overstoryDir, "project-context.json");
				if (existsSync(cachePath)) {
					try {
						const ageMs = Date.now() - statSync(cachePath).mtimeMs;
						if (ageMs < CONTEXT_CACHE_FRESH_MS) {
							return { trigger: "context_ready" };
						}
					} catch {
						// stat failed — treat as stale and fall through to regen
					}
				}
				// Stale or missing — spawn background regen and route to async gate.
				const spawn = deps.spawn ?? Bun.spawn;
				try {
					const proc = spawn(["ha", "--project", deps.projectRoot, "context", "generate"], {
						cwd: deps.projectRoot,
						stdout: "ignore",
						stderr: "ignore",
						detached: true,
					});
					proc.unref();
				} catch (err) {
					// Best-effort — if spawn fails synchronously, fall back to
					// context_ready so the analyst can still proceed against
					// whatever cache (if any) is present. Better stale context
					// than a stalled mission.
					process.stderr.write(
						`[intake-phase] ensure-context-generate spawn failed: ${String(err)}\n`,
					);
					return { trigger: "context_ready" };
				}
				return { trigger: "context_generating" };
			} catch (err) {
				// Defensive — any unexpected failure short-circuits to ready.
				process.stderr.write(`[intake-phase] ensure-context-generate failed: ${String(err)}\n`);
				return { trigger: "context_ready" };
			}
		},

		"dispatch-analyst-intake": async (ctx) => {
			const mission = ctx.getMission();
			if (!mission || !deps.overstoryDir || !deps.projectRoot) {
				return { trigger: "analyst_dispatched" };
			}
			const ensureMissionAnalyst =
				deps.ensureMissionAnalyst ?? (await import("../roles.ts")).ensureMissionAnalyst;
			try {
				await ensureMissionAnalyst(mission, deps.overstoryDir, deps.projectRoot, "intake");
			} catch (err) {
				await ctx.saveCheckpoint({
					dispatchFailureReason: err instanceof Error ? err.message : String(err),
					failedAt: new Date().toISOString(),
				});
				return { trigger: "dispatch_failed" };
			}
			return { trigger: "analyst_dispatched" };
		},

		"dispatch-clarifier": async (ctx) => {
			const mission = ctx.getMission();
			if (!mission) return { trigger: "dispatch_failed" };

			const slug = mission.slug;
			const clarifierName = slug ? `product-clarifier-${slug}` : "product-clarifier";
			const result = spawnEphemeralAgent(
				{
					capability: "product-clarifier",
					agentName: clarifierName,
					projectRoot: deps.projectRoot,
				},
				{ spawn: deps.spawn },
			);
			if (!result.spawned) {
				await ctx.saveCheckpoint({
					dispatchFailureReason: result.reason ?? "synchronous spawn failure",
					failedAt: new Date().toISOString(),
				});
				return { trigger: "dispatch_failed" };
			}
			return { trigger: "clarifier_dispatched" };
		},

		"human-spec-review": async () => {
			// NOTE: this handler is unreachable from the production engine —
			// `gate: "human"` nodes return gate-result BEFORE invoking node
			// handlers (see src/missions/engine.ts). Both the auto-skip
			// (auto-spec/auto-all) AND the supervised approve/reject wiring live
			// in `evaluateHumanSpecReview` (src/watchdog/gate-evaluators.ts).
			//
			// Kept here as a defensive default so that any future refactor that
			// switches this node from `gate:"human"` to a non-gate node still has
			// safe behavior.
			return { trigger: "approved" };
		},

		"create-tracker-issue": async (ctx) => {
			const mission = ctx.getMission();
			if (!mission) return { trigger: "issue_create_failed" };

			if (isRealTaskId(mission.taskId)) return { trigger: "issue_already_set" };

			if (!mission.artifactRoot) return { trigger: "spec_missing" };
			const specPath = join(mission.artifactRoot, "product-spec.md");
			const specFile = Bun.file(specPath);
			if (!(await specFile.exists())) return { trigger: "spec_missing" };

			const rawSpec = await specFile.text();
			const title = extractSpecTitle(rawSpec) ?? mission.objective.slice(0, 80);

			const SPEC_DESCRIPTION_CAP = 32 * 1024;
			const description =
				rawSpec.length > SPEC_DESCRIPTION_CAP
					? `${rawSpec.slice(0, SPEC_DESCRIPTION_CAP)}\n\n[truncated at 32 KiB — see <artifactRoot>/product-spec.md for full content]`
					: rawSpec;

			let issueId: string;
			try {
				issueId = await deps.tracker.create(title, { type: "task", description });
			} catch (err) {
				console.warn(
					`[intake-phase:create-tracker-issue] tracker.create failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`,
				);
				return { trigger: "issue_create_failed" };
			}

			if (!isValidTrackerId(issueId as unknown)) {
				console.warn(
					`[intake-phase:create-tracker-issue] tracker.create returned invalid id (length=${issueId.length}); skipping setTaskId`,
				);
				return { trigger: "issue_create_failed" };
			}

			try {
				deps.missionStore.setTaskId(mission.id, issueId);
			} catch (err) {
				console.error(
					`[intake-phase:create-tracker-issue] setTaskId failed AFTER tracker.create succeeded (issueId=${issueId}, missionId=${mission.id}): ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}. Orphan tracker issue exists; manual reconciliation required.`,
				);
				return { trigger: "issue_create_failed" };
			}

			return { trigger: "issue_created" };
		},

		"spec-rejected": async (ctx) => {
			const checkpoint = (ctx.checkpoint ?? {}) as IntakeCheckpoint;
			const count = (checkpoint.rejectionCount ?? 0) + 1;

			// Persist the incremented count so the next rejection sees it.
			// Without this the engine reads the same checkpoint forever and
			// MAX_SPEC_REJECTIONS escalation never fires.
			await ctx.saveCheckpoint({ ...checkpoint, rejectionCount: count });

			if (count >= MAX_SPEC_REJECTIONS) {
				// Escalation — clarifier exhausted retry budget. Emit
				// `mission_finding` so the operator sees a clear signal that the
				// auto-flow stopped trying. Control returns to human-spec-review:
				// operator can `ha mission spec approve` to proceed despite issues,
				// `ha mission update --objective <new>` and re-spin, or
				// `ha mission stop` to abandon.
				try {
					await ctx.sendMail(
						"operator",
						`Spec clarification exhausted (${MAX_SPEC_REJECTIONS} attempts)`,
						"The product-clarifier hit the max retry budget. Review the latest " +
							"product-spec.md and choose: `ha mission spec approve` (accept as-is), " +
							"`ha mission update --objective <text>` (reset), or `ha mission stop`.",
						"mission_finding",
					);
				} catch {
					// Best-effort — never block the trigger on mail failure.
				}
				return { trigger: "escalate" };
			}
			// Loop back to clarifier for another attempt.
			return { trigger: "retry" };
		},

		"dispatch-tier-classifier": async (ctx) => {
			const mission = ctx.getMission();
			if (!mission) return { trigger: "dispatch_failed" };

			const slug = mission.slug;
			const classifierName = slug ? `tier-classifier-${slug}` : "tier-classifier";
			const result = spawnEphemeralAgent(
				{
					capability: "tier-classifier",
					agentName: classifierName,
					projectRoot: deps.projectRoot,
				},
				{ spawn: deps.spawn },
			);
			if (!result.spawned) {
				await ctx.saveCheckpoint({
					dispatchFailureReason: result.reason ?? "synchronous spawn failure",
					failedAt: new Date().toISOString(),
				});
				return { trigger: "dispatch_failed" };
			}
			return { trigger: "classifier_dispatched" };
		},

		escalate: async (ctx) => {
			const mission = ctx.getMission();
			if (!mission) return { trigger: "escalated" };
			const checkpoint = ctx.checkpoint as { dispatchFailureReason?: string } | null;
			await ctx.sendMail(
				"operator",
				`Intake dispatch failed: ${mission.slug ?? mission.id}`,
				`Intake-phase dispatch failed. Reason: ${checkpoint?.dispatchFailureReason ?? "(unknown)"}. ` +
					`Mission cannot proceed without operator intervention.`,
				"mission_finding",
			);
			return { trigger: "escalated" };
		},
	};
}

export const intakePhaseCell: PhaseCellDefinition = {
	cellType: CELL_TYPE,
	buildSubgraph,
	buildHandlers,
};
