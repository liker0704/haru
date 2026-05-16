/**
 * Execute-phase subgraph cell.
 *
 * Subgraph with dispatch loop:
 *   ensure-ed → dispatch-ready → await-ws-completion (async)
 *   await-ws-completion --ws_merged--> update-status → check-remaining
 *   check-remaining --more_ws--> dispatch-ready (LOOP, reserved for future batch dispatch)
 *   check-remaining --waiting--> await-ws-completion (LOOP)
 *   check-remaining --all_done--> complete (terminal)
 */

import type { MissionGraph } from "../../types.ts";
import type { HandlerRegistry } from "../types.ts";
import type { PhaseCellConfig, PhaseCellDefinition, PhaseCellDeps } from "./types.ts";

const CELL_TYPE = "execute-phase";

function buildSubgraph(_config: PhaseCellConfig): MissionGraph {
	return {
		version: 1,
		nodes: [
			{
				kind: "cell",
				id: `${CELL_TYPE}:ensure-ed`,
				cellType: CELL_TYPE,
				handler: "ensure-ed",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:dispatch-ready`,
				cellType: CELL_TYPE,
				handler: "dispatch-ready",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:await-ws-completion`,
				cellType: CELL_TYPE,
				gate: "async",
				gateTimeout: 14400,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:update-status`,
				cellType: CELL_TYPE,
				handler: "update-status",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:check-remaining`,
				cellType: CELL_TYPE,
				handler: "check-remaining",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:complete`,
				cellType: CELL_TYPE,
				terminal: true,
			},
		],
		edges: [
			// Main flow
			{
				from: `${CELL_TYPE}:ensure-ed`,
				to: `${CELL_TYPE}:dispatch-ready`,
				trigger: "ed_ready",
			},
			{
				from: `${CELL_TYPE}:dispatch-ready`,
				to: `${CELL_TYPE}:await-ws-completion`,
				trigger: "dispatched",
			},
			{
				from: `${CELL_TYPE}:dispatch-ready`,
				to: `${CELL_TYPE}:await-ws-completion`,
				trigger: "waiting",
			},
			// Merge detected
			{
				from: `${CELL_TYPE}:await-ws-completion`,
				to: `${CELL_TYPE}:update-status`,
				trigger: "ws_merged",
			},
			{
				from: `${CELL_TYPE}:update-status`,
				to: `${CELL_TYPE}:check-remaining`,
				trigger: "status_updated",
			},
			// Dispatch loop
			{
				from: `${CELL_TYPE}:check-remaining`,
				to: `${CELL_TYPE}:dispatch-ready`,
				trigger: "more_ws",
			},
			{
				from: `${CELL_TYPE}:check-remaining`,
				to: `${CELL_TYPE}:await-ws-completion`,
				trigger: "waiting",
			},
			// All done
			{
				from: `${CELL_TYPE}:check-remaining`,
				to: `${CELL_TYPE}:complete`,
				trigger: "all_done",
			},
		],
	};
}

function buildHandlers(deps: PhaseCellDeps): HandlerRegistry {
	return {
		"ensure-ed": async (ctx) => {
			const mission = ctx.getMission();
			if (mission?.executionDirectorSessionId) {
				return { trigger: "ed_ready" };
			}
			// Gate evaluator in mission-tick handles ED spawn/recovery
			return { trigger: "ed_ready" };
		},

		"dispatch-ready": async (ctx) => {
			// Gate evaluator in mission-tick calls packageHandoffs() and dispatches.
			// This handler checks checkpoint for dispatch state.
			const data = ctx.checkpoint as { dispatched?: boolean; wsIds?: string[] } | null;
			if (data?.dispatched) {
				return { trigger: "dispatched" };
			}
			// No dispatch yet — gate evaluator will handle
			return { trigger: "waiting" };
		},

		"update-status": async (_ctx) => {
			return { trigger: "status_updated" };
		},

		"check-remaining": async (ctx) => {
			const mission = ctx.getMission();
			if (!mission) return { trigger: "waiting" };

			const sessionStore = deps.sessionStore;
			if (!sessionStore) return { trigger: "waiting" };

			const edName = `execution-director-${mission.slug}`;
			const allSessions = sessionStore.getAll();
			const leadSessions = allSessions.filter(
				(s) => s.capability === "lead" && s.parentAgent === edName && s.runId === mission.runId,
			);

			// No leads dispatched yet — wait for dispatch
			if (leadSessions.length === 0) return { trigger: "waiting" };

			// Lead state semantics are ambiguous: `waiting` can mean "dispatched
			// sub-worker, dormant until they return" OR "sent merge_ready, awaiting
			// parent stop". Disambiguate using merge_ready mail: a lead with NO
			// post-dispatch merge_ready mail is still active even if state=waiting.
			const activeStates = new Set(["working", "booting", "stalled"]);
			const mailStore = deps.mailStore;
			const stillActive = leadSessions.filter((lead) => {
				if (activeStates.has(lead.state)) return true;
				if (lead.state === "waiting" && mailStore) {
					// Check if lead has sent a merge_ready signal.
					const outbox = mailStore.getAll({ from: lead.agentName });
					const hasMergeReady = outbox.some(
						(m) => m.type === "merge_ready" && m.createdAt >= lead.startedAt,
					);
					if (!hasMergeReady) return true; // truly still working
				}
				return false;
			});

			if (stillActive.length === 0) {
				return { trigger: "all_done" };
			}

			return { trigger: "waiting" };
		},
	};
}

export const executePhaseCell: PhaseCellDefinition = {
	cellType: CELL_TYPE,
	buildSubgraph,
	buildHandlers,
};
