import { describe, expect, test } from "bun:test";
import type { makeMission } from "../test-mocks.ts";
import type { HandlerContext } from "../types.ts";
import { intakePhaseCell } from "./intake-phase.ts";
import type { PhaseCellDeps } from "./types.ts";

function makeDeps(overrides?: Partial<PhaseCellDeps>): PhaseCellDeps {
	return {
		mailSend: async () => {},
		checkpointStore: {} as unknown as PhaseCellDeps["checkpointStore"],
		missionStore: {} as unknown as PhaseCellDeps["missionStore"],
		...overrides,
	};
}

function makeCtx(opts: {
	mission?: ReturnType<typeof makeMission> | null;
	checkpoint?: unknown;
	nodeId?: string;
	onSaveCheckpoint?: (data: unknown) => void;
}): HandlerContext {
	return {
		nodeId: opts.nodeId ?? "intake-phase:ensure-context-generate",
		checkpoint: opts.checkpoint ?? null,
		getMission: () => opts.mission ?? null,
		saveCheckpoint: async (data: unknown) => {
			opts.onSaveCheckpoint?.(data);
		},
	} as HandlerContext;
}

describe("intake-phase subgraph", () => {
	test("buildSubgraph emits expected nodes and edges", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const nodeIds = graph.nodes.map((n) => n.id);
		expect(nodeIds).toContain("intake-phase:ensure-context-generate");
		expect(nodeIds).toContain("intake-phase:dispatch-analyst-intake");
		expect(nodeIds).toContain("intake-phase:await-research-complete");
		expect(nodeIds).toContain("intake-phase:dispatch-clarifier");
		expect(nodeIds).toContain("intake-phase:await-spec-ready");
		expect(nodeIds).toContain("intake-phase:human-spec-review");
		expect(nodeIds).toContain("intake-phase:spec-rejected");
		expect(nodeIds).toContain("intake-phase:dispatch-tier-classifier");
		expect(nodeIds).toContain("intake-phase:await-tier-set");
		expect(nodeIds).toContain("intake-phase:complete");
	});

	test("await-research-complete is async with 1500s (5min × 5 scouts cap) timeout", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const node = graph.nodes.find((n) => n.id === "intake-phase:await-research-complete");
		expect(node?.gate).toBe("async");
		expect(node?.gateTimeout).toBe(1500);
	});

	test("await-spec-ready is async with 3600s (1h) timeout", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const node = graph.nodes.find((n) => n.id === "intake-phase:await-spec-ready");
		expect(node?.gate).toBe("async");
		expect(node?.gateTimeout).toBe(3600);
	});

	test("await-tier-set is async with 300s (5min) timeout", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const node = graph.nodes.find((n) => n.id === "intake-phase:await-tier-set");
		expect(node?.gate).toBe("async");
		expect(node?.gateTimeout).toBe(300);
	});

	test("human-spec-review is a human gate", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const node = graph.nodes.find((n) => n.id === "intake-phase:human-spec-review");
		expect(node?.gate).toBe("human");
	});

	test("complete is terminal", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const node = graph.nodes.find((n) => n.id === "intake-phase:complete");
		expect(node?.terminal).toBe(true);
	});

	test("rejection edge loops back to clarifier", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const retryEdge = graph.edges.find(
			(e) => e.from === "intake-phase:spec-rejected" && e.trigger === "retry",
		);
		expect(retryEdge?.to).toBe("intake-phase:dispatch-clarifier");
	});
});

describe("intake-phase human-spec-review handler", () => {
	// NOTE: production short-circuit + supervised approve/reject wiring lives in
	// `evaluateHumanSpecReview` (src/watchdog/gate-evaluators.ts). The handler
	// itself is unreachable from the engine — `gate:"human"` returns
	// gate-result before handler invocation. Tests below verify defensive
	// fallback behavior only; real autonomy + verdict tests are in
	// `gate-evaluators.test.ts`.
	const handlers = intakePhaseCell.buildHandlers(makeDeps());

	test("defensive default: returns approved regardless of autonomy", async () => {
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers["human-spec-review"]!(makeCtx({ mission: null }));
		expect(result.trigger).toBe("approved");
	});
});

describe("intake-phase spec-rejected handler", () => {
	const handlers = intakePhaseCell.buildHandlers(makeDeps());

	test("first rejection → retry (count was 0)", async () => {
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers["spec-rejected"]!(makeCtx({ checkpoint: { rejectionCount: 0 } }));
		expect(result.trigger).toBe("retry");
	});

	test("second rejection → retry (count was 1)", async () => {
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers["spec-rejected"]!(makeCtx({ checkpoint: { rejectionCount: 1 } }));
		expect(result.trigger).toBe("retry");
	});

	test("third rejection → escalate (count reaches MAX_SPEC_REJECTIONS=3)", async () => {
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers["spec-rejected"]!(makeCtx({ checkpoint: { rejectionCount: 2 } }));
		expect(result.trigger).toBe("escalate");
	});

	test("no checkpoint → retry (treats as first rejection)", async () => {
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers["spec-rejected"]!(makeCtx({ checkpoint: null }));
		expect(result.trigger).toBe("retry");
	});

	test("persists incremented rejectionCount via saveCheckpoint", async () => {
		let saved: unknown = null;
		// biome-ignore lint/style/noNonNullAssertion: registry known
		await handlers["spec-rejected"]!(
			makeCtx({
				checkpoint: { rejectionCount: 1 },
				onSaveCheckpoint: (data) => {
					saved = data;
				},
			}),
		);
		expect(saved).toEqual({ rejectionCount: 2 });
	});
});

describe("intake-phase ensure-context-generate handler", () => {
	const handlers = intakePhaseCell.buildHandlers(makeDeps());

	test("always emits context_ready (regen logic deferred)", async () => {
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers["ensure-context-generate"]!(makeCtx({}));
		expect(result.trigger).toBe("context_ready");
	});
});
