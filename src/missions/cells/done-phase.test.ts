import { describe, expect, test } from "bun:test";
import { validateGraph } from "../graph.ts";
import { donePhaseCell } from "./done-phase.ts";
import type { PhaseCellConfig } from "./types.ts";

const config: PhaseCellConfig = {
	missionId: "m1",
	artifactRoot: "/tmp/artifacts",
	projectRoot: "/tmp/project",
};

describe("donePhaseCell.buildSubgraph", () => {
	const graph = donePhaseCell.buildSubgraph(config);

	test("produces a valid graph", () => {
		const result = validateGraph(graph, { startNodeId: "done-phase:summary" });
		expect(result.valid).toBe(true);
	});

	test("all nodes prefixed with done-phase:", () => {
		for (const node of graph.nodes) {
			expect(node.id).toStartWith("done-phase:");
		}
	});

	test("summary has gate: async", () => {
		const node = graph.nodes.find((n) => n.id === "done-phase:summary");
		expect(node).toBeDefined();
		expect(node?.gate).toBe("async");
	});

	// === Stage C subgraph extension ===

	test("Stage C: holdout node retains original id (backward compat)", () => {
		const node = graph.nodes.find((n) => n.id === "done-phase:holdout");
		expect(node).toBeDefined();
		// Pre-Stage-C: handler-only (always returned "skip"). Stage C: async gate.
		expect(node?.gate).toBe("async");
	});

	test("Stage C: holdout has three outgoing triggers (pass/skip/fail)", () => {
		const triggers = graph.edges
			.filter((e) => e.from === "done-phase:holdout")
			.map((e) => e.trigger);
		expect(triggers).toContain("holdout_pass");
		expect(triggers).toContain("holdout_skip");
		expect(triggers).toContain("holdout_fail");
	});

	test("Stage C: holdout_pass and holdout_skip both route to cleanup (legacy graceful path)", () => {
		const passEdge = graph.edges.find(
			(e) => e.from === "done-phase:holdout" && e.trigger === "holdout_pass",
		);
		const skipEdge = graph.edges.find(
			(e) => e.from === "done-phase:holdout" && e.trigger === "holdout_skip",
		);
		expect(passEdge?.to).toBe("done-phase:cleanup");
		expect(skipEdge?.to).toBe("done-phase:cleanup");
	});

	test("Stage C: debug-loop nodes present", () => {
		const expectedNodes = [
			"done-phase:dispatch-debugger",
			"done-phase:request-analyst-brief",
			"done-phase:await-debug-fix",
			"done-phase:merge-debug-fix",
			"done-phase:check-debug-attempts",
			"done-phase:escalate",
			"done-phase:debug-paused",
		];
		const nodeIds = graph.nodes.map((n) => n.id);
		for (const expected of expectedNodes) {
			expect(nodeIds).toContain(expected);
		}
	});

	test("Stage C: debug-paused is terminal", () => {
		const node = graph.nodes.find((n) => n.id === "done-phase:debug-paused");
		expect(node?.terminal).toBe(true);
	});

	test("Stage C: merge-debug-fix loops back to holdout on success", () => {
		const edge = graph.edges.find(
			(e) => e.from === "done-phase:merge-debug-fix" && e.trigger === "merged",
		);
		expect(edge?.to).toBe("done-phase:holdout");
	});

	test("Stage C: check-debug-attempts has retry and exhausted edges", () => {
		const retryEdge = graph.edges.find(
			(e) => e.from === "done-phase:check-debug-attempts" && e.trigger === "retry",
		);
		const exhaustedEdge = graph.edges.find(
			(e) => e.from === "done-phase:check-debug-attempts" && e.trigger === "exhausted",
		);
		expect(retryEdge?.to).toBe("done-phase:dispatch-debugger");
		expect(exhaustedEdge?.to).toBe("done-phase:escalate");
	});

	test("Stage C: request-analyst-brief timeout routes to check-debug-attempts (graceful)", () => {
		// N3 fix from review: analyst contention → fix_failed (NOT mission suspend)
		const edge = graph.edges.find(
			(e) => e.from === "done-phase:request-analyst-brief" && e.trigger === "timeout",
		);
		expect(edge?.to).toBe("done-phase:check-debug-attempts");
	});

	test("Stage C: await-debug-fix timeout also routes to check-debug-attempts", () => {
		const edge = graph.edges.find(
			(e) => e.from === "done-phase:await-debug-fix" && e.trigger === "timeout",
		);
		expect(edge?.to).toBe("done-phase:check-debug-attempts");
	});

	test("Stage C: escalate routes to debug-paused terminal", () => {
		const edge = graph.edges.find(
			(e) => e.from === "done-phase:escalate" && e.trigger === "escalated",
		);
		expect(edge?.to).toBe("done-phase:debug-paused");
	});

	test("Stage C: graph still valid with debug-loop additions", () => {
		const result = validateGraph(graph, { startNodeId: "done-phase:summary" });
		expect(result.valid).toBe(true);
	});
});
