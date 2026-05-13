/**
 * PR-phase subgraph cell.
 *
 * TODO(w3-builder): implement the 17-node subgraph per architecture §4.1
 * and handlers per §4.2. Tester stub returns an empty graph so the
 * RED-phase tests fail at runtime while the file imports compile.
 */

import type { MissionGraph } from "../../types.ts";
import type { HandlerRegistry } from "../types.ts";
import type { PhaseCellConfig, PhaseCellDefinition, PhaseCellDeps } from "./types.ts";

const CELL_TYPE = "pr-phase";

function buildSubgraph(_config: PhaseCellConfig): MissionGraph {
	// TODO(w3-builder): implement 17-node subgraph.
	return { version: 1, nodes: [], edges: [] };
}

function buildHandlers(_deps: PhaseCellDeps): HandlerRegistry {
	// TODO(w3-builder): implement handlers (preflight, create, classify-ci-red,
	// dispatch-triage, resume-coordinator, merge, plus debug-loop factory).
	return {};
}

export const prPhaseCell: PhaseCellDefinition = {
	cellType: CELL_TYPE,
	buildSubgraph,
	buildHandlers,
};
