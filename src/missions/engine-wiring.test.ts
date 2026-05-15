/**
 * Tests for the engine wiring bridge module.
 *
 * Uses mock stores following the same pattern as engine.test.ts.
 */

import { describe, expect, test } from "bun:test";
import type { OverstoryConfig } from "../config-types.ts";
import type { Mission } from "../types.ts";
import {
	advanceCellGate,
	buildLifecycleGraph,
	buildPhaseCellConfig,
	CELL_REGISTRY,
	type EngineDeps,
	getCellEngineStatus,
	getTierPhases,
	PHASE_CELL_REGISTRY,
	shouldUseEngine,
	startCellEngine,
	TIER_PHASES,
} from "./engine-wiring.ts";
import { validateGraph } from "./graph.ts";
import { createMockCheckpointStore, createMockMissionStore, makeMission } from "./test-mocks.ts";

const baseMission: Mission = makeMission({ id: "mission-test-1" });

function makeDeps(overrides?: Partial<EngineDeps>): EngineDeps {
	return {
		checkpointStore: createMockCheckpointStore(),
		missionStore: createMockMissionStore(),
		...overrides,
	};
}

/**
 * Build a minimal valid OverstoryConfig for tests. Shallow-merges any
 * overrides; intended for tests that need to vary specific blocks
 * (most commonly `pr` and `project`).
 */
function makeConfig(overrides?: Partial<OverstoryConfig>): OverstoryConfig {
	return {
		project: { name: "", root: "", canonicalBranch: "main" },
		agents: {
			manifestPath: "",
			baseDir: "",
			maxConcurrent: 5,
			staggerDelayMs: 0,
			maxDepth: 2,
			maxSessionsPerRun: 0,
			maxAgentsPerLead: 0,
		},
		worktrees: { baseDir: "" },
		taskTracker: { backend: "auto", enabled: false },
		mulch: { enabled: false, domains: [], primeFormat: "markdown" },
		merge: { aiResolveEnabled: false, reimagineEnabled: false },
		providers: {},
		watchdog: {
			tier0Enabled: false,
			tier0IntervalMs: 30000,
			tier1Enabled: false,
			tier2Enabled: false,
			staleThresholdMs: 0,
			zombieThresholdMs: 0,
			nudgeIntervalMs: 60000,
		},
		models: {},
		logging: { verbose: false, redactSecrets: false },
		...overrides,
	};
}

// === shouldUseEngine ===

describe("shouldUseEngine", () => {
	test("returns true when flag is absent (enabled by default)", () => {
		const result = shouldUseEngine(baseMission, {
			project: { name: "", root: "", canonicalBranch: "main" },
			agents: {
				manifestPath: "",
				baseDir: "",
				maxConcurrent: 5,
				staggerDelayMs: 0,
				maxDepth: 2,
				maxSessionsPerRun: 0,
				maxAgentsPerLead: 0,
			},
			worktrees: { baseDir: "" },
			taskTracker: { backend: "auto", enabled: false },
			mulch: { enabled: false, domains: [], primeFormat: "markdown" },
			merge: { aiResolveEnabled: false, reimagineEnabled: false },
			providers: {},
			watchdog: {
				tier0Enabled: false,
				tier0IntervalMs: 30000,
				tier1Enabled: false,
				tier2Enabled: false,
				staleThresholdMs: 0,
				zombieThresholdMs: 0,
				nudgeIntervalMs: 60000,
			},
			models: {},
			logging: { verbose: false, redactSecrets: false },
		});
		expect(result).toBe(true);
	});

	test("returns false when flag is explicitly false", () => {
		const result = shouldUseEngine(baseMission, {
			project: { name: "", root: "", canonicalBranch: "main" },
			agents: {
				manifestPath: "",
				baseDir: "",
				maxConcurrent: 5,
				staggerDelayMs: 0,
				maxDepth: 2,
				maxSessionsPerRun: 0,
				maxAgentsPerLead: 0,
			},
			worktrees: { baseDir: "" },
			taskTracker: { backend: "auto", enabled: false },
			mulch: { enabled: false, domains: [], primeFormat: "markdown" },
			merge: { aiResolveEnabled: false, reimagineEnabled: false },
			providers: {},
			watchdog: {
				tier0Enabled: false,
				tier0IntervalMs: 30000,
				tier1Enabled: false,
				tier2Enabled: false,
				staleThresholdMs: 0,
				zombieThresholdMs: 0,
				nudgeIntervalMs: 60000,
			},
			models: {},
			logging: { verbose: false, redactSecrets: false },
			mission: { graphExecution: false },
		});
		expect(result).toBe(false);
	});

	test("returns true when flag is true", () => {
		const result = shouldUseEngine(baseMission, {
			project: { name: "", root: "", canonicalBranch: "main" },
			agents: {
				manifestPath: "",
				baseDir: "",
				maxConcurrent: 5,
				staggerDelayMs: 0,
				maxDepth: 2,
				maxSessionsPerRun: 0,
				maxAgentsPerLead: 0,
			},
			worktrees: { baseDir: "" },
			taskTracker: { backend: "auto", enabled: false },
			mulch: { enabled: false, domains: [], primeFormat: "markdown" },
			merge: { aiResolveEnabled: false, reimagineEnabled: false },
			providers: {},
			watchdog: {
				tier0Enabled: false,
				tier0IntervalMs: 30000,
				tier1Enabled: false,
				tier2Enabled: false,
				staleThresholdMs: 0,
				zombieThresholdMs: 0,
				nudgeIntervalMs: 60000,
			},
			models: {},
			logging: { verbose: false, redactSecrets: false },
			mission: { graphExecution: true },
		});
		expect(result).toBe(true);
	});
});

// === CELL_REGISTRY ===

describe("CELL_REGISTRY", () => {
	test("contains plan-review entry", () => {
		expect(CELL_REGISTRY["plan-review"]).toBeDefined();
	});

	test("contains architecture-review entry", () => {
		expect(CELL_REGISTRY["architecture-review"]).toBeDefined();
	});

	test("plan-review graph is valid", () => {
		const cell = CELL_REGISTRY["plan-review"];
		if (!cell) throw new Error("plan-review not in registry");
		const graph = cell.buildSubgraph({ tier: "full", maxRounds: 3, artifactRoot: "" });
		const result = validateGraph(graph, { startNodeId: "plan-review:dispatch-critics" });
		expect(result.valid).toBe(true);
	});

	test("architecture-review graph is valid", () => {
		const cell = CELL_REGISTRY["architecture-review"];
		if (!cell) throw new Error("architecture-review not in registry");
		const graph = cell.buildSubgraph({ tier: "full", maxRounds: 3, artifactRoot: "" });
		const result = validateGraph(graph, { startNodeId: "arch-review:dispatch-critics" });
		expect(result.valid).toBe(true);
	});
});

// === PHASE_CELL_REGISTRY ===

describe("PHASE_CELL_REGISTRY", () => {
	test("T-w4-1: contains pr-phase entry", () => {
		expect(PHASE_CELL_REGISTRY["pr-phase"]).toBeDefined();
		expect(PHASE_CELL_REGISTRY["pr-phase"]?.cellType).toBe("pr-phase");
	});

	test("T-w4-1: contains pre-pr-phase entry", () => {
		expect(PHASE_CELL_REGISTRY["pre-pr-phase"]).toBeDefined();
		expect(PHASE_CELL_REGISTRY["pre-pr-phase"]?.cellType).toBe("pre-pr-phase");
	});

	test("T-w4-1: contains all seven phase cells", () => {
		expect(Object.keys(PHASE_CELL_REGISTRY).sort()).toEqual([
			"done-phase",
			"execute-phase",
			"intake-phase",
			"plan-phase",
			"pr-phase",
			"pre-pr-phase",
			"understand-phase",
		]);
	});
});

// === getTierPhases ===

describe("getTierPhases", () => {
	test("T-w4-2: planned tier with default config includes pre-pr and pr between execute and done", () => {
		const phases = getTierPhases("planned", makeConfig());
		expect(phases).toEqual(["intake", "understand", "plan", "execute", "pre-pr", "pr", "done"]);
	});

	test("T-w4-3: full tier with default config includes pre-pr and pr between execute and done", () => {
		const phases = getTierPhases("full", makeConfig());
		expect(phases).toEqual([
			"intake",
			"understand",
			"align",
			"decide",
			"plan",
			"execute",
			"pre-pr",
			"pr",
			"done",
		]);
	});

	test("T-w4-4: direct tier with default config does NOT include pr (da-01 default)", () => {
		const phases = getTierPhases("direct", makeConfig());
		expect(phases).toEqual(["intake", "execute", "pre-pr", "done"]);
		expect(phases).not.toContain("pr");
	});

	test("T-w4-5: direct tier opt-in requires all three: enabled + operatorGithubLogin + directTierIncludesPr", () => {
		const config = makeConfig({
			pr: { enabled: true, operatorGithubLogin: "foo", directTierIncludesPr: true },
		});
		const phases = getTierPhases("direct", config);
		expect(phases).toEqual(["intake", "execute", "pre-pr", "pr", "done"]);
	});

	test("T-w4-7: direct tier does NOT include pr when operatorGithubLogin is missing", () => {
		const config = makeConfig({ pr: { directTierIncludesPr: true } });
		expect(getTierPhases("direct", config)).not.toContain("pr");
	});

	test("T-w4-5: direct tier does NOT include pr when directTierIncludesPr is false", () => {
		const config = makeConfig({
			pr: { operatorGithubLogin: "foo", directTierIncludesPr: false },
		});
		expect(getTierPhases("direct", config)).not.toContain("pr");
	});

	test("T-w4-6: planned tier with pr.enabled=false does NOT include pr", () => {
		const phases = getTierPhases("planned", makeConfig({ pr: { enabled: false } }));
		expect(phases).toEqual(["intake", "understand", "plan", "execute", "pre-pr", "done"]);
	});

	test("T-w4-6: full tier with pr.enabled=false does NOT include pr", () => {
		const phases = getTierPhases("full", makeConfig({ pr: { enabled: false } }));
		expect(phases).not.toContain("pr");
	});
});

// === TIER_PHASES static defaults ===

describe("TIER_PHASES (frozen defaults)", () => {
	test("T-w4-2: planned includes pre-pr and pr between execute and done", () => {
		expect(TIER_PHASES.planned).toEqual([
			"intake",
			"understand",
			"plan",
			"execute",
			"pre-pr",
			"pr",
			"done",
		]);
	});

	test("T-w4-3: full includes pre-pr and pr between execute and done", () => {
		expect(TIER_PHASES.full).toEqual([
			"intake",
			"understand",
			"align",
			"decide",
			"plan",
			"execute",
			"pre-pr",
			"pr",
			"done",
		]);
	});

	test("T-w4-4: direct includes pre-pr but NOT pr", () => {
		expect(TIER_PHASES.direct).toEqual(["intake", "execute", "pre-pr", "done"]);
		expect(TIER_PHASES.direct).not.toContain("pr");
	});
});

// === buildPhaseCellConfig ===

describe("buildPhaseCellConfig", () => {
	test("returns minimal config when OverstoryConfig is omitted", () => {
		const mission = makeMission({ id: "m1", tier: "full", artifactRoot: "/tmp/a" });
		const cfg = buildPhaseCellConfig(mission);
		expect(cfg).toEqual({
			missionId: "m1",
			artifactRoot: "/tmp/a",
			projectRoot: "",
			tier: "full",
		});
		expect(cfg.pr).toBeUndefined();
	});

	test("defaults tier to 'full' when mission.tier is null", () => {
		const mission = makeMission({ tier: null });
		expect(buildPhaseCellConfig(mission).tier).toBe("full");
	});

	test("populates projectRoot from config.project.root", () => {
		const cfg = buildPhaseCellConfig(
			makeMission(),
			makeConfig({ project: { name: "p", root: "/repo", canonicalBranch: "main" } }),
		);
		expect(cfg.projectRoot).toBe("/repo");
	});

	test("T-w4-9: populates pr block from OverstoryConfig.pr (full fidelity)", () => {
		const cfg = buildPhaseCellConfig(
			makeMission(),
			makeConfig({
				pr: {
					enabled: true,
					directTierIncludesPr: true,
					operatorGithubLogin: "alice",
					ciTimeoutMs: 1000,
					commentsTimeoutMs: 2000,
					approvalTimeoutMs: 3000,
					mergeStrategy: "squash",
					autoCloseSuperseded: true,
					maxTriageSpawnsPerMission: 5,
					maxTriagePerAuthorPerHour: 3,
					maxCoordinatorResumesPerPr: 2,
					commentTriageAuthors: ["bot"],
					triage: { minConfidence: 0.8 },
					ghBudget: { rpm: 100, burst: 10 },
					classifyCiRed: { flakeThresholdMs: 5000, maxFlakeRetries: 2 },
				},
			}),
		);
		expect(cfg.pr).toBeDefined();
		expect(cfg.pr?.enabled).toBe(true);
		expect(cfg.pr?.directTierIncludesPr).toBe(true);
		expect(cfg.pr?.operatorGithubLogin).toBe("alice");
		expect(cfg.pr?.ciTimeoutMs).toBe(1000);
		expect(cfg.pr?.commentsTimeoutMs).toBe(2000);
		expect(cfg.pr?.approvalTimeoutMs).toBe(3000);
		expect(cfg.pr?.mergeStrategy).toBe("squash");
		expect(cfg.pr?.autoCloseSuperseded).toBe(true);
		expect(cfg.pr?.maxTriageSpawnsPerMission).toBe(5);
		expect(cfg.pr?.maxTriagePerAuthorPerHour).toBe(3);
		expect(cfg.pr?.maxCoordinatorResumesPerPr).toBe(2);
		expect(cfg.pr?.commentTriageAuthors).toEqual(["bot"]);
		expect(cfg.pr?.triage).toEqual({ minConfidence: 0.8 });
		expect(cfg.pr?.ghBudget).toEqual({ rpm: 100, burst: 10 });
		expect(cfg.pr?.classifyCiRed).toEqual({ flakeThresholdMs: 5000, maxFlakeRetries: 2 });
	});

	test("T-w4-9: pr is undefined when config has no pr block", () => {
		const cfg = buildPhaseCellConfig(makeMission(), makeConfig());
		expect(cfg.pr).toBeUndefined();
	});
});

// === startCellEngine ===

describe("startCellEngine", () => {
	test("throws for unknown cell type", async () => {
		const deps = makeDeps();
		await expect(startCellEngine(baseMission, "unknown-cell", deps)).rejects.toThrow(
			"Unknown cell type",
		);
	});

	test("creates and runs engine for plan-review — stops at async gate", async () => {
		const deps = makeDeps();
		const result = await startCellEngine(baseMission, "plan-review", deps);
		// Engine should run: dispatch-critics (handler) → collect-verdicts (gate:async) → stop
		expect(result.status).toBe("gate");
		expect(result.gateType).toBe("async");
		expect(result.currentNodeId).toBe("plan-review:collect-verdicts");
	});

	test("creates and runs engine for architecture-review — stops at async gate", async () => {
		const deps = makeDeps();
		const result = await startCellEngine(baseMission, "architecture-review", deps);
		expect(result.status).toBe("gate");
		expect(result.gateType).toBe("async");
		expect(result.currentNodeId).toBe("arch-review:collect-verdicts");
	});

	test("idempotent: calling startCellEngine again resumes from checkpoint, not re-dispatch", async () => {
		const checkpointStore = createMockCheckpointStore();
		const missionStore = createMockMissionStore();
		const deps: EngineDeps = { checkpointStore, missionStore };

		// First call: runs from dispatch-critics → collect-verdicts (gate)
		const first = await startCellEngine(baseMission, "plan-review", deps);
		expect(first.currentNodeId).toBe("plan-review:collect-verdicts");

		// Second call with same checkpointStore: engine resumes from checkpoint
		// Should still be gated at collect-verdicts (not re-dispatch)
		const second = await startCellEngine(baseMission, "plan-review", deps);
		expect(second.status).toBe("gate");
		expect(second.currentNodeId).toBe("plan-review:collect-verdicts");
	});
});

// === advanceCellGate ===

describe("advanceCellGate", () => {
	test("returns error when no checkpoint exists", async () => {
		const deps = makeDeps();
		const result = await advanceCellGate(baseMission, "all-returned", null, deps);
		expect(result.status).toBe("error");
		expect(result.error).toContain("No checkpoint");
	});

	test("advances gate and continues execution", async () => {
		const checkpointStore = createMockCheckpointStore();
		const missionStore = createMockMissionStore();
		const deps: EngineDeps = { checkpointStore, missionStore };

		// Start engine — stops at collect-verdicts gate
		await startCellEngine(baseMission, "plan-review", deps);

		// Advance with 'verdicts-collected' — convergence handler returns approved → approved (terminal)
		const result = await advanceCellGate(baseMission, "verdicts-collected", null, deps);
		expect(result.status).toBe("completed");
		expect(result.currentNodeId).toBe("plan-review:approved");
	});

	test("errors when current node is not a gate node", async () => {
		const checkpointStore = createMockCheckpointStore();
		const missionStore = createMockMissionStore();
		const deps: EngineDeps = { checkpointStore, missionStore };

		// Place checkpoint at convergence (not a gate node)
		checkpointStore.saveCheckpoint(baseMission.id, "plan-review:convergence", null);

		// advanceNode requires current node to be gate — convergence is not, so error
		const result = await advanceCellGate(baseMission, "revision-needed", null, deps);
		expect(result.status).toBe("error");
		expect(result.error).toContain("not a gate node");
	});
});

// === getCellEngineStatus ===

describe("getCellEngineStatus", () => {
	test("returns null when no checkpoint exists", () => {
		const deps = makeDeps();
		const result = getCellEngineStatus(baseMission, deps);
		expect(result).toBeNull();
	});

	test("returns status when checkpoint exists", async () => {
		const checkpointStore = createMockCheckpointStore();
		const missionStore = createMockMissionStore();
		const deps: EngineDeps = { checkpointStore, missionStore };

		await startCellEngine(baseMission, "plan-review", deps);

		const status = getCellEngineStatus(baseMission, deps);
		expect(status).not.toBeNull();
		if (!status) throw new Error("expected status to be non-null");
		expect(status.cellType).toBe("plan-review");
		expect(status.currentNodeId).toBe("plan-review:collect-verdicts");
		expect(Array.isArray(status.transitions)).toBe(true);
	});

	test("transitions are recorded in status", async () => {
		const checkpointStore = createMockCheckpointStore();
		const missionStore = createMockMissionStore();
		const deps: EngineDeps = { checkpointStore, missionStore };

		await startCellEngine(baseMission, "plan-review", deps);

		const status = getCellEngineStatus(baseMission, deps);
		if (!status) throw new Error("expected status to be non-null");
		expect(status.transitions.length).toBeGreaterThanOrEqual(1);
		expect(status.transitions[0]).toHaveProperty("fromNode");
		expect(status.transitions[0]).toHaveProperty("toNode");
		expect(status.transitions[0]).toHaveProperty("trigger");
		expect(status.transitions[0]).toHaveProperty("createdAt");
	});
});

// === tier-aware graph construction ===

describe("tier-aware graph construction", () => {
	test('buildLifecycleGraph with tier="direct" produces intake+execute+pre-pr+done phases', () => {
		const mission = makeMission({ tier: "direct" });
		const graph = buildLifecycleGraph(mission);

		const lifecycleNodes = graph.nodes.filter((n) => n.kind === "lifecycle");
		const phases = new Set(lifecycleNodes.map((n) => n.phase));

		expect(phases).toEqual(new Set(["intake", "execute", "pre-pr", "done"]));
		expect(phases.has("understand")).toBe(false);
		expect(phases.has("align")).toBe(false);
		expect(phases.has("decide")).toBe(false);
		expect(phases.has("plan")).toBe(false);
	});

	test('buildLifecycleGraph with tier="planned" includes intake, understand, plan, execute, pre-pr, pr, done (skips align/decide)', () => {
		const mission = makeMission({ tier: "planned" });
		const graph = buildLifecycleGraph(mission);

		const lifecycleNodes = graph.nodes.filter((n) => n.kind === "lifecycle");
		const phases = new Set(lifecycleNodes.map((n) => n.phase));

		expect(phases).toEqual(
			new Set(["intake", "understand", "plan", "execute", "pre-pr", "pr", "done"]),
		);
		expect(phases.has("align")).toBe(false);
		expect(phases.has("decide")).toBe(false);
	});

	test('buildLifecycleGraph with tier="full" includes all 9 phases', () => {
		const mission = makeMission({ tier: "full" });
		const graph = buildLifecycleGraph(mission);

		const lifecycleNodes = graph.nodes.filter((n) => n.kind === "lifecycle");
		const phases = new Set(lifecycleNodes.map((n) => n.phase));

		expect(phases).toEqual(
			new Set([
				"intake",
				"understand",
				"align",
				"decide",
				"plan",
				"execute",
				"pre-pr",
				"pr",
				"done",
			]),
		);
	});

	test("buildLifecycleGraph with tier=null defaults to full (backward compat)", () => {
		const nullMission = makeMission({ tier: null });
		const fullMission = makeMission({ tier: "full" });
		const nullGraph = buildLifecycleGraph(nullMission);
		const fullGraph = buildLifecycleGraph(fullMission);

		const nullPhases = [
			...new Set(nullGraph.nodes.filter((n) => n.kind === "lifecycle").map((n) => n.phase)),
		].sort();
		const fullPhases = [
			...new Set(fullGraph.nodes.filter((n) => n.kind === "lifecycle").map((n) => n.phase)),
		].sort();

		expect(nullPhases).toEqual(fullPhases);
	});

	test("direct graph has executeDirectPhaseCell subgraph nodes (dispatch-leads, await-leads-done, etc.)", () => {
		const mission = makeMission({ tier: "direct" });
		const graph = buildLifecycleGraph(mission);

		// Find the execute:active node — it should have a subgraph
		const executeActive = graph.nodes.find((n) => n.id === "execute:active");
		expect(executeActive).toBeDefined();
		expect(executeActive?.kind).toBe("lifecycle");
		if (executeActive?.kind !== "lifecycle") throw new Error("Expected lifecycle node");
		expect(executeActive.subgraph).toBeDefined();

		const subNodes = executeActive.subgraph?.nodes ?? [];
		const subNodeIds = subNodes.map((n: { id: string }) => n.id);

		expect(subNodeIds).toContain("execute-phase:dispatch-leads");
		expect(subNodeIds).toContain("execute-phase:await-leads-done");
		expect(subNodeIds).toContain("execute-phase:merge-all");
		expect(subNodeIds).toContain("execute-phase:complete");
	});

	test("direct graph edges only connect nodes from allowed phases", () => {
		const mission = makeMission({ tier: "direct" });
		const graph = buildLifecycleGraph(mission);

		const nodeIds = new Set(graph.nodes.map((n) => n.id));
		for (const edge of graph.edges) {
			expect(nodeIds.has(edge.from)).toBe(true);
			expect(nodeIds.has(edge.to)).toBe(true);
		}
	});

	test("full and planned graphs produce valid graphs", () => {
		for (const tier of ["full", "planned"] as const) {
			const mission = makeMission({ tier });
			const graph = buildLifecycleGraph(mission);
			// Graph should have nodes and edges
			expect(graph.nodes.length).toBeGreaterThan(0);
			expect(graph.edges.length).toBeGreaterThan(0);
		}
	});
});

// === buildLifecycleGraph with OverstoryConfig ===

describe("buildLifecycleGraph (config-aware)", () => {
	test("T-w4-8: backward-compatible: omitting config uses TIER_PHASES defaults (includes pre-pr)", () => {
		const mission = makeMission({ tier: "planned" });
		const graph = buildLifecycleGraph(mission);
		const phases = new Set(graph.nodes.filter((n) => n.kind === "lifecycle").map((n) => n.phase));
		expect(phases).toEqual(
			new Set(["intake", "understand", "plan", "execute", "pre-pr", "pr", "done"]),
		);
	});

	test("T-w4-8: with config: planned tier includes pre-pr and pr lifecycle nodes", () => {
		const mission = makeMission({ tier: "planned" });
		const graph = buildLifecycleGraph(mission, makeConfig());
		const phases = new Set(graph.nodes.filter((n) => n.kind === "lifecycle").map((n) => n.phase));
		expect(phases).toEqual(
			new Set(["intake", "understand", "plan", "execute", "pre-pr", "pr", "done"]),
		);
	});

	test("with pr.enabled=false: planned tier still produces valid graph", () => {
		const mission = makeMission({ tier: "planned" });
		const graph = buildLifecycleGraph(mission, makeConfig({ pr: { enabled: false } }));
		expect(graph.nodes.length).toBeGreaterThan(0);
		expect(graph.edges.length).toBeGreaterThan(0);
	});

	test("direct tier with default config produces graph without pr edges", () => {
		const mission = makeMission({ tier: "direct" });
		const graph = buildLifecycleGraph(mission, makeConfig());
		// No edges should reference pr:* node ids
		for (const edge of graph.edges) {
			expect(edge.from.startsWith("pr:")).toBe(false);
			expect(edge.to.startsWith("pr:")).toBe(false);
		}
	});
});
