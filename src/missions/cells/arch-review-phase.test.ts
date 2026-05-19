import { describe, expect, test } from "bun:test";
import type { TrackerClient } from "../../tracker/types.ts";
import { validateGraph } from "../graph.ts";
import type { HandlerContext } from "../types.ts";
import { archReviewPhaseCell } from "./arch-review-phase.ts";
import type { PhaseCellConfig, PhaseCellDeps } from "./types.ts";

const config: PhaseCellConfig = {
	missionId: "m1",
	artifactRoot: "/tmp/artifacts",
	projectRoot: "/tmp/project",
};

/** No-op TrackerClient stub — REQUIRED on PhaseCellDeps after ws-store-types lands. */
function makeStubTracker(): TrackerClient {
	return {
		ready: async () => [],
		show: async () => ({ id: "", title: "", status: "", priority: 0, type: "" }),
		create: async () => "",
		claim: async () => {},
		close: async () => {},
		comment: async () => {},
		list: async () => [],
		sync: async () => {},
	};
}

function makeDeps(): PhaseCellDeps {
	return {
		mailSend: async () => {},
		checkpointStore: {} as unknown as PhaseCellDeps["checkpointStore"],
		missionStore: {} as unknown as PhaseCellDeps["missionStore"],
		tracker: makeStubTracker(),
	};
}

function makeCtx(opts: { checkpoint?: unknown; nodeId?: string }): HandlerContext {
	return {
		missionId: "m1",
		nodeId: opts.nodeId ?? "arch-review-phase:check-refactor",
		checkpoint: opts.checkpoint ?? null,
		getMission: () => null,
		saveCheckpoint: async () => {},
		sendMail: async () => {},
	} as unknown as HandlerContext;
}

describe("archReviewPhaseCell.buildSubgraph", () => {
	const graph = archReviewPhaseCell.buildSubgraph(config);

	test("buildSubgraph produces a valid graph", () => {
		const result = validateGraph(graph, {
			startNodeId: "arch-review-phase:dispatch-architect",
		});
		expect(result.valid).toBe(true);
	});

	test("all nodes prefixed with arch-review-phase:", () => {
		for (const node of graph.nodes) {
			expect(node.id).toStartWith("arch-review-phase:");
		}
	});

	test("dispatch-architect has gate: async and gateTimeout: 900", () => {
		const node = graph.nodes.find((n) => n.id === "arch-review-phase:dispatch-architect");
		expect(node).toBeDefined();
		expect(node?.gate).toBe("async");
		expect(node?.gateTimeout).toBe(900);
	});

	test("await-arch-review has gate: async and gateTimeout: 3600", () => {
		const node = graph.nodes.find((n) => n.id === "arch-review-phase:await-arch-review");
		expect(node).toBeDefined();
		expect(node?.gate).toBe("async");
		expect(node?.gateTimeout).toBe(3600);
	});

	test("await-refactor has gateTimeout: 14400", () => {
		const node = graph.nodes.find((n) => n.id === "arch-review-phase:await-refactor");
		expect(node).toBeDefined();
		expect(node?.gateTimeout).toBe(14400);
	});

	test("complete is the only terminal node", () => {
		const terminals = graph.nodes.filter((n) => n.terminal);
		expect(terminals).toHaveLength(1);
		expect(terminals[0]?.id).toBe("arch-review-phase:complete");
	});
});

describe("archReviewPhaseCell.buildHandlers", () => {
	test("check-refactor returns refactor_needed when checkpoint.hasRefactorSpecs is true", async () => {
		const handlers = archReviewPhaseCell.buildHandlers(makeDeps());
		const result = await handlers["check-refactor"]!(
			makeCtx({ checkpoint: { hasRefactorSpecs: true } }),
		);
		expect(result.trigger).toBe("refactor_needed");
	});

	test("check-refactor returns no_refactor when checkpoint is null", async () => {
		const handlers = archReviewPhaseCell.buildHandlers(makeDeps());
		const result = await handlers["check-refactor"]!(makeCtx({ checkpoint: null }));
		expect(result.trigger).toBe("no_refactor");
	});

	test("check-refactor returns no_refactor when hasRefactorSpecs is falsy", async () => {
		const handlers = archReviewPhaseCell.buildHandlers(makeDeps());
		const result = await handlers["check-refactor"]!(
			makeCtx({ checkpoint: { hasRefactorSpecs: false } }),
		);
		expect(result.trigger).toBe("no_refactor");
	});

	test('buildHandlers registers exactly one handler key ("check-refactor")', () => {
		const handlers = archReviewPhaseCell.buildHandlers(makeDeps());
		expect(Object.keys(handlers)).toEqual(["check-refactor"]);
	});
});
