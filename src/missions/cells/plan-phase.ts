/**
 * Plan-phase subgraph cell.
 *
 * Tier-aware routing:
 *
 * - Full tier (or undefined for back-compat):
 *     dispatch-planning → await-plan (async) → ensure-architect (handler) →
 *     architect-design (async) → review → review-stuck | await-handoff (async) → terminal
 *   The architect ALWAYS runs in full tier. The gate evaluator adapts artifact
 *   requirements based on TDD mode (architecture.md only vs + test-plan.yaml).
 *
 * - Planned tier:
 *     dispatch-planning → await-plan (async) → review → review-stuck |
 *     await-handoff (async) → terminal
 *   No architect — planned tier coordinator owns the plan directly. The
 *   architect-design and ensure-architect nodes are omitted entirely; the
 *   `await-plan → review` edge fires on `plan_written`.
 */

import type { MissionGraph } from "../../types.ts";
import type { HandlerRegistry } from "../types.ts";
import type { PhaseCellConfig, PhaseCellDefinition, PhaseCellDeps } from "./types.ts";

const CELL_TYPE = "plan-phase";

function buildSubgraph(config: PhaseCellConfig): MissionGraph {
	const tier = config.tier ?? "full";
	const skipArchitect = tier === "planned";

	const baseNodes: MissionGraph["nodes"] = [
		{
			kind: "cell",
			id: `${CELL_TYPE}:dispatch-planning`,
			cellType: CELL_TYPE,
			gate: "async",
			gateTimeout: 3600,
		},
		{
			kind: "cell",
			id: `${CELL_TYPE}:await-plan`,
			cellType: CELL_TYPE,
			gate: "async",
			gateTimeout: 3600,
		},
	];

	const architectNodes: MissionGraph["nodes"] = skipArchitect
		? []
		: [
				{
					kind: "cell",
					id: `${CELL_TYPE}:ensure-architect`,
					cellType: CELL_TYPE,
					handler: "ensure-architect",
				},
				{
					kind: "cell",
					id: `${CELL_TYPE}:architect-design`,
					cellType: CELL_TYPE,
					gate: "async",
					gateTimeout: 3600,
				},
			];

	const tailNodes: MissionGraph["nodes"] = [
		{
			kind: "cell",
			id: `${CELL_TYPE}:review`,
			cellType: CELL_TYPE,
			gate: "async",
			gateTimeout: 3600,
		},
		{
			kind: "cell",
			id: `${CELL_TYPE}:review-stuck`,
			cellType: CELL_TYPE,
			gate: "async",
			gateTimeout: 300,
		},
		{
			kind: "cell",
			id: `${CELL_TYPE}:await-handoff`,
			cellType: CELL_TYPE,
			gate: "async",
			gateTimeout: 3600,
		},
		{
			kind: "cell",
			id: `${CELL_TYPE}:complete`,
			cellType: CELL_TYPE,
			terminal: true,
		},
	];

	const dispatchEdges: MissionGraph["edges"] = [
		{
			from: `${CELL_TYPE}:dispatch-planning`,
			to: `${CELL_TYPE}:await-plan`,
			trigger: "planning_started",
		},
	];

	// In planned tier, await-plan goes directly to review on plan_written.
	// In full tier, await-plan transitions through ensure-architect (sync handler)
	// which spawns/binds the architect, then on to architect-design (async gate)
	// which waits for architect_ready, then to review.
	const architectEdges: MissionGraph["edges"] = skipArchitect
		? [
				{
					from: `${CELL_TYPE}:await-plan`,
					to: `${CELL_TYPE}:review`,
					trigger: "plan_written",
				},
			]
		: [
				{
					from: `${CELL_TYPE}:await-plan`,
					to: `${CELL_TYPE}:ensure-architect`,
					trigger: "plan_written",
				},
				{
					from: `${CELL_TYPE}:ensure-architect`,
					to: `${CELL_TYPE}:architect-design`,
					trigger: "architect_spawned",
				},
				{
					from: `${CELL_TYPE}:architect-design`,
					to: `${CELL_TYPE}:review`,
					trigger: "architect_ready",
				},
			];

	const tailEdges: MissionGraph["edges"] = [
		{
			from: `${CELL_TYPE}:review`,
			to: `${CELL_TYPE}:await-handoff`,
			trigger: "approved",
		},
		{
			from: `${CELL_TYPE}:review`,
			to: `${CELL_TYPE}:review-stuck`,
			trigger: "stuck",
		},
		{
			from: `${CELL_TYPE}:review-stuck`,
			to: `${CELL_TYPE}:review`,
			trigger: "resolved",
		},
		{
			from: `${CELL_TYPE}:review-stuck`,
			to: `${CELL_TYPE}:await-handoff`,
			trigger: "override",
		},
		{
			from: `${CELL_TYPE}:await-handoff`,
			to: `${CELL_TYPE}:complete`,
			trigger: "handoff_complete",
		},
	];

	return {
		version: 1,
		nodes: [...baseNodes, ...architectNodes, ...tailNodes],
		edges: [...dispatchEdges, ...architectEdges, ...tailEdges],
	};
}

function buildHandlers(deps: PhaseCellDeps): HandlerRegistry {
	return {
		"ensure-architect": async (ctx) => {
			const mission = ctx.getMission();
			if (!mission) {
				// Without a mission we cannot bind sessions; advance and let the
				// async gate evaluator surface the failure if it persists.
				return { trigger: "architect_spawned" };
			}
			if (!deps.overstoryDir || !deps.projectRoot) {
				// Missing wiring — advance defensively. The async gate evaluator
				// will still gate on architectSessionId presence.
				return { trigger: "architect_spawned" };
			}
			// Dynamic import to break circular dependency:
			// plan-phase → roles → messaging → lifecycle → engine-wiring → plan-phase.
			const { ensureArchitect } = await import("../roles.ts");
			await ensureArchitect(mission, deps.overstoryDir, deps.projectRoot);
			return { trigger: "architect_spawned" };
		},
	};
}

export const planPhaseCell: PhaseCellDefinition = {
	cellType: CELL_TYPE,
	buildSubgraph,
	buildHandlers,
};
