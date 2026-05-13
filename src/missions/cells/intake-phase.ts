/**
 * Intake-phase subgraph cell — Stage A.
 *
 * Runs as the FIRST phase of every mission, before `understand-phase`. Turns
 * a raw operator intent into a structured `product-spec.md` + a deterministic
 * tier classification, then advances to `understand-phase` (planned/full) or
 * `execute-phase` (direct).
 *
 * Subgraph nodes:
 *   ensure-context-generate (handler) → context_ready
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
 * Dispatch handlers shell out via `spawnEphemeralAgent` for ephemeral agents
 * (clarifier, tier-classifier) and call `ensureMissionAnalyst` for the
 * persistent analyst. Synchronous spawn failure routes to dispatch_failed →
 * escalate rather than silently returning the success trigger.
 */

import type { MissionGraph } from "../../types.ts";
import type { HandlerRegistry } from "../types.ts";
import { spawnEphemeralAgent } from "./spawn-helpers.ts";
import type { PhaseCellConfig, PhaseCellDefinition, PhaseCellDeps } from "./types.ts";

const CELL_TYPE = "intake-phase";

/** Hard cap for spec rejection retry loop before escalation to operator. */
const MAX_SPEC_REJECTIONS = 3;

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
			// Approval — proceed to tier classification
			{
				from: `${CELL_TYPE}:human-spec-review`,
				to: `${CELL_TYPE}:dispatch-tier-classifier`,
				trigger: "approved",
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

function buildHandlers(deps: PhaseCellDeps): HandlerRegistry {
	return {
		"ensure-context-generate": async (_ctx) => {
			// Plan #231 (locked-in): compare cached project-context against the
			// current state of the repo and regenerate on mismatch. The existing
			// context system uses a structural hash (dir layout + package.json +
			// tsconfig.json) rather than raw `git rev-parse HEAD`, but the
			// purpose is identical: invalidate the cache when the project shape
			// changed so analyst-intake gets fresh signal.
			if (!deps.projectRoot || !deps.overstoryDir) {
				return { trigger: "context_ready" };
			}
			try {
				const { join } = await import("node:path");
				const { readCachedContext, writeCachedContext, isCacheValid, computeStructuralHash } =
					await import("../../context/cache.ts");
				const { analyzeProject } = await import("../../context/analyze.ts");
				const cachePath = join(deps.overstoryDir, "project-context.json");
				const cached = readCachedContext(cachePath);
				const currentHash = await computeStructuralHash(deps.projectRoot);
				if (cached && isCacheValid(cached, currentHash)) {
					return { trigger: "context_ready" };
				}
				// Stale or missing — regenerate before the analyst spawns.
				const fresh = await analyzeProject(deps.projectRoot, {});
				await writeCachedContext(cachePath, fresh);
			} catch (err) {
				// Best-effort — never block the graph on context-generation failure.
				// The analyst can still spawn and operate against whatever cached
				// context (if any) is present.
				process.stderr.write(`[intake-phase] ensure-context-generate failed: ${String(err)}\n`);
			}
			return { trigger: "context_ready" };
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
