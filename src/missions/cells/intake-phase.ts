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
 *   dispatch-analyst-intake (handler) → analyst_dispatched
 *   await-research-complete (async, 1500s) → research_ready
 *   dispatch-clarifier (handler) → clarifier_dispatched
 *   await-spec-ready (async, 3600s) → spec_ready
 *   human-spec-review (human, AUTO-SKIP if mission.autonomy != supervised) → approved | rejected
 *   spec-rejected (handler — capture reason, retry counter) → retry | escalate
 *   dispatch-tier-classifier (handler) → classifier_dispatched
 *   await-tier-set (async, 300s) → tier_set
 *   complete (terminal)
 *
 * Dispatch handlers shell out via `Bun.spawn(["ha", "sling", ...])` for
 * ephemeral agents (clarifier, tier-classifier) and call `ensureMissionAnalyst`
 * for the persistent analyst.
 */

import type { MissionGraph } from "../../types.ts";
import type { HandlerRegistry } from "../types.ts";
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
		],
	};
}

interface IntakeCheckpoint {
	rejectionCount?: number;
	rejectionReason?: string;
}

/**
 * Spawn an ephemeral leaf-node agent (clarifier or tier-classifier) by shelling
 * out to `ha sling`. Headless, no worktree (these agents are read-only).
 *
 * The intake-phase handler treats spawn failure as non-fatal — the gate
 * evaluator's nudge will surface stuck state. We don't await session
 * completion here; the agent runs asynchronously and signals via mail.
 */
async function spawnEphemeralAgent(opts: {
	capability: string;
	agentName: string;
	projectRoot?: string;
}): Promise<void> {
	const cwd = opts.projectRoot ?? process.cwd();
	const proc = Bun.spawn(
		[
			"ha",
			"sling",
			opts.capability, // task ID positional — used as the agent's task slug
			"--capability",
			opts.capability,
			"--name",
			opts.agentName,
			"--depth",
			"0",
			"--skip-task-check",
			"--json",
		],
		{
			cwd,
			stderr: "pipe",
			stdout: "pipe",
		},
	);
	// Don't await — agent runs in background; mail signals completion.
	// Just verify spawn didn't fail synchronously.
	await new Promise((resolve) => setTimeout(resolve, 50));
	if (proc.exitCode !== null && proc.exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`ha sling failed (exit ${proc.exitCode}): ${stderr}`);
	}
}

function buildHandlers(deps: PhaseCellDeps): HandlerRegistry {
	return {
		"ensure-context-generate": async () => {
			// project-context.json freshness check happens at spawn-time per agent
			// (existing pattern in spawn.ts). For now this is a pass-through —
			// actual auto-regen on git-HEAD-changed is a follow-up enhancement.
			return { trigger: "context_ready" };
		},

		"dispatch-analyst-intake": async (ctx) => {
			const mission = ctx.getMission();
			if (!mission || !deps.overstoryDir || !deps.projectRoot) {
				return { trigger: "analyst_dispatched" };
			}
			// Lazy import to avoid circular deps (roles → context → engine-wiring)
			const { ensureMissionAnalyst } = await import("../roles.ts");
			try {
				await ensureMissionAnalyst(mission, deps.overstoryDir, deps.projectRoot, "intake");
			} catch (err) {
				// Don't block the graph — gate evaluator (`evaluateAwaitResearchComplete`)
				// will surface stuck state via its nudge.
				process.stderr.write(`[intake-phase] dispatch-analyst-intake failed: ${String(err)}\n`);
			}
			return { trigger: "analyst_dispatched" };
		},

		"dispatch-clarifier": async (ctx) => {
			const mission = ctx.getMission();
			if (!mission) return { trigger: "clarifier_dispatched" };

			// Spawn ephemeral clarifier via `ha sling`. Same Bun.spawn pattern used
			// by existing handlers (e.g. plan-phase ensure-architect uses
			// startArchitectRole; we use sling because clarifier is ephemeral).
			const slug = mission.slug;
			const clarifierName = slug ? `product-clarifier-${slug}` : "product-clarifier";
			try {
				await spawnEphemeralAgent({
					capability: "product-clarifier",
					agentName: clarifierName,
					projectRoot: deps.projectRoot,
				});
			} catch (err) {
				process.stderr.write(`[intake-phase] dispatch-clarifier failed: ${String(err)}\n`);
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
			if (!mission) return { trigger: "classifier_dispatched" };

			const slug = mission.slug;
			const classifierName = slug ? `tier-classifier-${slug}` : "tier-classifier";
			try {
				await spawnEphemeralAgent({
					capability: "tier-classifier",
					agentName: classifierName,
					projectRoot: deps.projectRoot,
				});
			} catch (err) {
				process.stderr.write(`[intake-phase] dispatch-tier-classifier failed: ${String(err)}\n`);
			}
			return { trigger: "classifier_dispatched" };
		},
	};
}

export const intakePhaseCell: PhaseCellDefinition = {
	cellType: CELL_TYPE,
	buildSubgraph,
	buildHandlers,
};
