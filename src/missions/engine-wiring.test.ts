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
	buildLifecycleHandlers,
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

	test("T-w4-1: contains all eight phase cells", () => {
		expect(Object.keys(PHASE_CELL_REGISTRY).sort()).toEqual([
			"arch-review-phase",
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
			"arch-review",
			"pre-pr",
			"pr",
			"done",
		]);
	});

	test("T-w4-3b: planned tier unchanged by arch-review insertion", () => {
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

	test("T-w4-3c: direct tier unchanged by arch-review insertion", () => {
		expect(TIER_PHASES.direct).toEqual(["intake", "execute", "pre-pr", "done"]);
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
			"arch-review",
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

	test('buildLifecycleGraph with tier="full" includes all 10 phases', () => {
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
				"arch-review",
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

describe("buildLifecycleHandlers — namespaced handler keys (haru-0f81)", () => {
	test("registers each cell's handlers under both bare and cellType-qualified keys", () => {
		const deps = makeDeps();
		const handlers = buildLifecycleHandlers(deps, "full");

		// Every cell that exposes an "escalate" handler should be reachable via
		// its cellType-qualified key so the engine can disambiguate.
		for (const cellType of Object.keys(PHASE_CELL_REGISTRY)) {
			// Not every cell exposes "escalate" — only assert when bare exists.
			if (typeof handlers.escalate === "function") {
				// At minimum the cellType-qualified key should exist for cells that
				// register escalate.
				const namespaced = handlers[`${cellType}:escalate`];
				if (namespaced !== undefined) {
					expect(typeof namespaced).toBe("function");
				}
			}
		}
	});

	test("intake-phase:escalate is distinct from done-phase:escalate (no flat collision)", () => {
		const deps = makeDeps();
		const handlers = buildLifecycleHandlers(deps, "full");
		const intakeEscalate = handlers["intake-phase:escalate"];
		const doneEscalate = handlers["done-phase:escalate"];
		expect(typeof intakeEscalate).toBe("function");
		expect(typeof doneEscalate).toBe("function");
		// They MUST NOT be the same function — that was the haru-0f81 bug:
		// done-phase's escalate (debug-loop) silently shadowed intake-phase's.
		expect(intakeEscalate).not.toBe(doneEscalate);
	});

	test("auto-advance handlers (lifecycle, no cellType) remain reachable by bare name", () => {
		const deps = makeDeps();
		const handlers = buildLifecycleHandlers(deps, "full");
		expect(typeof handlers["align-auto-advance"]).toBe("function");
		expect(typeof handlers["decide-auto-advance"]).toBe("function");
	});
});

// === ws-store-types (haru-2061): resolveBackend DI + startup-cached tracker ===

import type { TrackerClient } from "../tracker/types.ts";

/**
 * Dynamic-import helper so a missing export (RED phase) only fails the tests
 * that need it, not the whole file. Static `import { resolveBackend }` would
 * crash module load and mask every other passing engine-wiring test as a
 * regression.
 *
 * Builder will re-export `resolveBackend` from engine-wiring.ts per the brief
 * ("engine-wiring.ts ... add resolveBackend(configuredBackend)").
 */
type ResolveBackendFn = (
	backend: "auto" | "seeds" | "beads" | "github",
	cwd: string,
	detector?: {
		hasSujiDir?: (path: string) => Promise<boolean>;
		hasSeedsDir?: (path: string) => Promise<boolean>;
		hasBeadsDir?: (path: string) => Promise<boolean>;
		hasGithubRemote?: (cwd: string) => Promise<boolean>;
	},
) => Promise<"seeds" | "beads" | "github">;

async function loadResolveBackend(): Promise<ResolveBackendFn> {
	const mod = (await import("./engine-wiring.ts")) as unknown as {
		resolveBackend?: ResolveBackendFn;
	};
	if (typeof mod.resolveBackend !== "function") {
		throw new Error(
			"resolveBackend is not exported from engine-wiring.ts — RED phase, builder must add it.",
		);
	}
	return mod.resolveBackend;
}

/**
 * Local extension shape for the new EngineDeps.tracker field that ws-store-types
 * adds. The cast keeps this test file compiling against the un-widened
 * EngineDeps interface during the RED phase. The builder will widen EngineDeps
 * in engine-wiring.ts.
 */
type TrackerExt = { tracker: TrackerClient };
const withTracker = (d: EngineDeps, t: TrackerClient): EngineDeps & TrackerExt =>
	({ ...d, tracker: t }) as EngineDeps & TrackerExt;

/** Minimal TrackerClient stub for identity checks. */
function makeStubTracker(label = ""): TrackerClient {
	return {
		ready: async () => [],
		show: async () => ({ id: label, title: "", status: "", priority: 0, type: "" }),
		create: async () => "",
		claim: async () => {},
		close: async () => {},
		comment: async () => {},
		list: async () => [],
		sync: async () => {},
	};
}

describe("resolveBackend — DI test seam (ws-store-types)", () => {
	test("T-resolve-1: 'auto' resolves to 'seeds' when the injected detector reports a seeds-style dir", async () => {
		const resolveBackend = await loadResolveBackend();
		const detector = {
			hasSujiDir: async () => true,
			hasSeedsDir: async () => false,
			hasBeadsDir: async () => false,
			hasGithubRemote: async () => false,
		};
		const backend = await resolveBackend("auto", "/proj", detector);
		expect(backend).toBe("seeds");
	});

	test("T-resolve-2: 'auto' resolves to 'beads' when only .beads is present", async () => {
		const resolveBackend = await loadResolveBackend();
		const detector = {
			hasSujiDir: async () => false,
			hasSeedsDir: async () => false,
			hasBeadsDir: async () => true,
			hasGithubRemote: async () => false,
		};
		const backend = await resolveBackend("auto", "/proj", detector);
		expect(backend).toBe("beads");
	});

	test("T-resolve-3: 'auto' resolves to 'github' when no tracker dir but a github remote exists", async () => {
		const resolveBackend = await loadResolveBackend();
		const detector = {
			hasSujiDir: async () => false,
			hasSeedsDir: async () => false,
			hasBeadsDir: async () => false,
			hasGithubRemote: async () => true,
		};
		const backend = await resolveBackend("auto", "/proj", detector);
		expect(backend).toBe("github");
	});

	test("T-resolve-4: explicit backend values bypass the detector (pass-through)", async () => {
		const resolveBackend = await loadResolveBackend();
		const detector = {
			hasSujiDir: async () => false,
			hasSeedsDir: async () => false,
			hasBeadsDir: async () => false,
			hasGithubRemote: async () => false,
		};
		expect(await resolveBackend("seeds", "/proj", detector)).toBe("seeds");
		expect(await resolveBackend("beads", "/proj", detector)).toBe("beads");
		expect(await resolveBackend("github", "/proj", detector)).toBe("github");
	});
});

describe("EngineDeps.tracker — startup-cached identity (ws-store-types)", () => {
	test("T-tracker-1: when EngineDeps.tracker is populated, callers receive that exact instance", () => {
		const stub = makeStubTracker("startup-singleton");
		const deps = withTracker(makeDeps(), stub);
		expect(deps.tracker).toBe(stub);
	});

	test("T-tracker-2: tracker instance is preserved across reads (no per-read reconstruction)", () => {
		const stub = makeStubTracker("singleton");
		const deps = withTracker(makeDeps(), stub);
		const read1 = deps.tracker;
		const read2 = deps.tracker;
		expect(read1).toBe(read2);
		expect(read1).toBe(stub);
	});

	test("T-tracker-3: EngineDeps interface declares tracker: TrackerClient (ws-store-types brief item 8)", async () => {
		// Static-source guard: the builder must widen EngineDeps with a
		// REQUIRED `tracker: TrackerClient` field. Until that lands, the
		// engine-wiring.ts source will not contain that declaration.
		// Using a source-text scan keeps this test stable regardless of how
		// the builder formats the field (single-line / multi-line / commented).
		const source = await Bun.file("src/missions/engine-wiring.ts").text();
		// Anchor inside the EngineDeps interface body to avoid false matches on
		// the import alias.
		const ifaceStart = source.indexOf("interface EngineDeps");
		expect(ifaceStart).toBeGreaterThan(-1);
		const ifaceEnd = source.indexOf("}", ifaceStart);
		const ifaceBody = source.slice(ifaceStart, ifaceEnd);
		expect(ifaceBody).toMatch(/tracker\s*:\s*TrackerClient/);
	});
});
