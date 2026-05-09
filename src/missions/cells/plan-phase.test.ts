import { describe, expect, test } from "bun:test";
import { validateGraph } from "../graph.ts";
import { planPhaseCell } from "./plan-phase.ts";
import type { PhaseCellConfig } from "./types.ts";

const config: PhaseCellConfig = {
	missionId: "m1",
	artifactRoot: "/tmp/artifacts",
	projectRoot: "/tmp/project",
};

describe("planPhaseCell.buildSubgraph", () => {
	const graph = planPhaseCell.buildSubgraph(config);

	test("produces a valid graph", () => {
		const result = validateGraph(graph, { startNodeId: "plan-phase:dispatch-planning" });
		expect(result.valid).toBe(true);
	});

	test("all nodes prefixed with plan-phase:", () => {
		for (const node of graph.nodes) {
			expect(node.id).toStartWith("plan-phase:");
		}
	});

	test("await-plan has gate: async", () => {
		const node = graph.nodes.find((n) => n.id === "plan-phase:await-plan");
		expect(node).toBeDefined();
		expect(node?.gate).toBe("async");
	});
});

// === Tier-conditional subgraph routing (issue #209) ===

describe("planPhaseCell.buildSubgraph — tier-aware routing", () => {
	test("undefined tier defaults to full (back-compat): includes architect-design", () => {
		const graph = planPhaseCell.buildSubgraph({ ...config });
		const archNode = graph.nodes.find((n) => n.id === "plan-phase:architect-design");
		expect(archNode).toBeDefined();
	});

	test("tier=full: includes ensure-architect handler node and architect-design gate", () => {
		const graph = planPhaseCell.buildSubgraph({ ...config, tier: "full" });
		expect(graph.nodes.find((n) => n.id === "plan-phase:ensure-architect")).toBeDefined();
		expect(graph.nodes.find((n) => n.id === "plan-phase:architect-design")).toBeDefined();
	});

	test("tier=full: ensure-architect declares an ensure-architect handler key", () => {
		const graph = planPhaseCell.buildSubgraph({ ...config, tier: "full" });
		const node = graph.nodes.find((n) => n.id === "plan-phase:ensure-architect");
		expect(node).toBeDefined();
		expect(node?.kind).toBe("cell");
		if (node?.kind === "cell") {
			expect(node?.handler).toBe("ensure-architect");
			// Sync handler — must NOT be an async/human gate, otherwise the engine
			// returns gate before invoking the handler (engine.ts gate short-circuit).
			expect(node?.gate).toBeUndefined();
		}
	});

	test("tier=full: await-plan → ensure-architect → architect-design → review", () => {
		const graph = planPhaseCell.buildSubgraph({ ...config, tier: "full" });
		const fromAwaitPlan = graph.edges.find(
			(e) => e.from === "plan-phase:await-plan" && e.trigger === "plan_written",
		);
		expect(fromAwaitPlan?.to).toBe("plan-phase:ensure-architect");

		const fromEnsureArchitect = graph.edges.find(
			(e) => e.from === "plan-phase:ensure-architect" && e.trigger === "architect_spawned",
		);
		expect(fromEnsureArchitect?.to).toBe("plan-phase:architect-design");

		const fromArchitectDesign = graph.edges.find(
			(e) => e.from === "plan-phase:architect-design" && e.trigger === "architect_ready",
		);
		expect(fromArchitectDesign?.to).toBe("plan-phase:review");
	});

	test("tier=planned: omits ensure-architect and architect-design entirely", () => {
		const graph = planPhaseCell.buildSubgraph({ ...config, tier: "planned" });
		expect(graph.nodes.find((n) => n.id === "plan-phase:ensure-architect")).toBeUndefined();
		expect(graph.nodes.find((n) => n.id === "plan-phase:architect-design")).toBeUndefined();
	});

	test("tier=planned: await-plan → review directly on plan_written", () => {
		const graph = planPhaseCell.buildSubgraph({ ...config, tier: "planned" });
		const edge = graph.edges.find(
			(e) => e.from === "plan-phase:await-plan" && e.trigger === "plan_written",
		);
		expect(edge).toBeDefined();
		expect(edge?.to).toBe("plan-phase:review");
	});

	test("tier=planned: produces a valid graph", () => {
		const graph = planPhaseCell.buildSubgraph({ ...config, tier: "planned" });
		const result = validateGraph(graph, { startNodeId: "plan-phase:dispatch-planning" });
		expect(result.valid).toBe(true);
	});

	test("tier=planned: no edges reference architect-design", () => {
		const graph = planPhaseCell.buildSubgraph({ ...config, tier: "planned" });
		for (const edge of graph.edges) {
			expect(edge.from).not.toBe("plan-phase:architect-design");
			expect(edge.to).not.toBe("plan-phase:architect-design");
			expect(edge.from).not.toBe("plan-phase:ensure-architect");
			expect(edge.to).not.toBe("plan-phase:ensure-architect");
		}
	});

	test("tier=direct: defaults to full-tier behavior (architect path present)", () => {
		// Direct tier never reaches plan-phase per TIER_PHASES, but defending
		// the contract: anything not 'planned' keeps the architect path so
		// callers cannot accidentally skip it.
		const graph = planPhaseCell.buildSubgraph({ ...config, tier: "direct" });
		expect(graph.nodes.find((n) => n.id === "plan-phase:architect-design")).toBeDefined();
		expect(graph.nodes.find((n) => n.id === "plan-phase:ensure-architect")).toBeDefined();
	});
});
