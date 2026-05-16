/**
 * Arch-review phase subgraph cell — extracted from execute-phase (#345).
 *
 * Runs AFTER execute-phase for full-tier missions only. Dispatches the architect,
 * awaits review, optionally schedules a refactor pass, then awaits the architect's
 * final sign-off before advancing the lifecycle to the next phase.
 *
 * Subgraph nodes (6):
 *   dispatch-architect  (async gate, 900s)
 *   await-arch-review   (async gate, 3600s)
 *   check-refactor      (handler) → refactor_needed | no_refactor
 *   await-refactor      (async gate, 14400s)
 *   await-arch-final    (async gate, 3600s)
 *   complete            (terminal)
 *
 * NOTE: This cell has no `escalate` handler and no `paused` terminal. Per D5,
 * operator escalation for a stalled `dispatch-architect` gate is handled at the
 * watchdog level via `mission-tick.ts` emitting an `arch-review-stall`
 * mission_finding. Registering an `escalate` handler key here would silently
 * collide with the flat-keyspace `HandlerRegistry` entries already registered by
 * pr-phase, pre-pr-phase, intake-phase, and debug-loop-handlers.
 */

import type { MissionGraph } from "../../types.ts";
import type { HandlerRegistry } from "../types.ts";
import type { PhaseCellConfig, PhaseCellDefinition, PhaseCellDeps } from "./types.ts";

const CELL_TYPE = "arch-review-phase";

function buildSubgraph(_config: PhaseCellConfig): MissionGraph {
	return {
		version: 1,
		nodes: [
			{
				kind: "cell",
				id: `${CELL_TYPE}:dispatch-architect`,
				cellType: CELL_TYPE,
				gate: "async",
				// 900s = coordinator wake (~2m) + ha sling architect (~1m) + dispatch mail (~10s)
				// + watchdog tick interval headroom. Higher values just delay the escalation
				// emission; the actual work is short.
				gateTimeout: 900,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:await-arch-review`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 3600,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:check-refactor`,
				cellType: CELL_TYPE,
				handler: "check-refactor",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:await-refactor`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 14400,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:await-arch-final`,
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
		],
		// Edges below preserve trigger names from execute-phase's previous arch-review subgraph
		// (approved/stuck/refactor_needed/no_refactor/refactor_done/architecture_final) per D2 —
		// minimizes test-fixture churn vs. spec's review_received/review_timeout rename.
		edges: [
			{
				from: `${CELL_TYPE}:dispatch-architect`,
				to: `${CELL_TYPE}:await-arch-review`,
				trigger: "review_dispatched",
			},
			{
				from: `${CELL_TYPE}:await-arch-review`,
				to: `${CELL_TYPE}:check-refactor`,
				trigger: "approved",
			},
			{
				from: `${CELL_TYPE}:await-arch-review`,
				to: `${CELL_TYPE}:await-arch-final`,
				trigger: "stuck",
			},
			{
				from: `${CELL_TYPE}:check-refactor`,
				to: `${CELL_TYPE}:await-refactor`,
				trigger: "refactor_needed",
			},
			{
				from: `${CELL_TYPE}:check-refactor`,
				to: `${CELL_TYPE}:await-arch-final`,
				trigger: "no_refactor",
			},
			{
				from: `${CELL_TYPE}:await-refactor`,
				to: `${CELL_TYPE}:await-arch-final`,
				trigger: "refactor_done",
			},
			{
				from: `${CELL_TYPE}:await-arch-final`,
				to: `${CELL_TYPE}:complete`,
				trigger: "architecture_final",
			},
		],
	};
}

function buildHandlers(_deps: PhaseCellDeps): HandlerRegistry {
	return {
		"check-refactor": async (ctx) => {
			const data = ctx.checkpoint as { hasRefactorSpecs?: boolean } | null;
			if (data?.hasRefactorSpecs) return { trigger: "refactor_needed" };
			return { trigger: "no_refactor" };
		},
	};
}

export const archReviewPhaseCell: PhaseCellDefinition = {
	cellType: CELL_TYPE,
	buildSubgraph,
	buildHandlers,
};
