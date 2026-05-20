/**
 * Tests for the graph execution engine.
 *
 * Uses in-memory mock stores — no real SQLite.
 */

import { describe, expect, test } from "bun:test";
import type { CheckpointStatusRow, CheckpointStore, MissionGraph, MissionStore } from "../types.ts";
import type { GraphEngineOpts } from "./engine.ts";
import { createGraphEngine, REPLAY_SAFE_HANDLERS } from "./engine.ts";
import type { HandlerRegistry } from "./types.ts";

// === In-memory mock stores ===

interface StoredCheckpoint {
	data: unknown;
	version: number;
	schemaVersion: number;
}

interface StoredTransition {
	fromNode: string;
	toNode: string;
	trigger: string;
	createdAt: string;
	error?: string;
}

function createMockCheckpointStore(): CheckpointStore & { transitions: StoredTransition[] } {
	const checkpoints = new Map<string, StoredCheckpoint>();
	const transitions: StoredTransition[] = [];
	let lastInsertKey: string | null = null;

	const key = (missionId: string, nodeId: string) => `${missionId}:${nodeId}`;

	return {
		transitions,

		saveCheckpoint(missionId: string, nodeId: string, data: unknown): void {
			const k = key(missionId, nodeId);
			const existing = checkpoints.get(k);
			checkpoints.set(k, {
				data,
				version: (existing?.version ?? 0) + 1,
				schemaVersion: 1,
			});
			lastInsertKey = k;
		},

		getCheckpoint(
			missionId: string,
			nodeId: string,
		): { data: unknown; version: number; schemaVersion: number } | null {
			return checkpoints.get(key(missionId, nodeId)) ?? null;
		},

		getLatestCheckpoint(
			missionId: string,
		): { nodeId: string; data: unknown; version: number } | null {
			if (!lastInsertKey) return null;
			// Find last inserted checkpoint for this mission
			const prefix = `${missionId}:`;
			let latest: { nodeId: string; data: unknown; version: number } | null = null;
			for (const [k, cp] of checkpoints) {
				if (k.startsWith(prefix)) {
					const nodeId = k.slice(prefix.length);
					if (!latest || cp.version >= latest.version) {
						latest = { nodeId, data: cp.data, version: cp.version };
					}
				}
			}
			return latest;
		},

		listCheckpoints(
			missionId: string,
		): Array<{ nodeId: string; version: number; createdAt: string }> {
			const prefix = `${missionId}:`;
			const result: Array<{ nodeId: string; version: number; createdAt: string }> = [];
			for (const [k, cp] of checkpoints) {
				if (k.startsWith(prefix)) {
					result.push({ nodeId: k.slice(prefix.length), version: cp.version, createdAt: "" });
				}
			}
			return result;
		},

		recordTransition(
			_missionId: string,
			fromNode: string,
			toNode: string,
			trigger: string,
			_data?: unknown,
			error?: string,
		): void {
			transitions.push({ fromNode, toNode, trigger, createdAt: new Date().toISOString(), error });
		},

		getTransitionHistory(_missionId: string): Array<{
			fromNode: string;
			toNode: string;
			trigger: string;
			createdAt: string;
			error?: string;
		}> {
			return [...transitions];
		},

		saveStepResult(
			missionId: string,
			fromNode: string,
			toNode: string,
			trigger: string,
			checkpointData: unknown,
		): void {
			this.saveCheckpoint(missionId, toNode, checkpointData);
			this.recordTransition(missionId, fromNode, toNode, trigger);
		},

		deleteCheckpoints(_missionId: string): void {
			checkpoints.clear();
		},

		getCheckpointStatus(_key: string, _nodeId: string): CheckpointStatusRow | null {
			return null;
		},

		markCheckpointPending(_key: string, _nodeId: string, _handlerName: string): void {},

		markCheckpointConfirmed(_key: string, _nodeId: string): void {},
	};
}

function createMockCheckpointStoreWithStatus(): ReturnType<typeof createMockCheckpointStore> & {
	pendingStatuses: Map<string, CheckpointStatusRow>;
} {
	const base = createMockCheckpointStore();
	const pendingStatuses = new Map<string, CheckpointStatusRow>();
	const key = (k: string, nodeId: string) => `${k}:${nodeId}`;

	return {
		...base,
		pendingStatuses,
		getCheckpointStatus(k: string, nodeId: string) {
			return pendingStatuses.get(key(k, nodeId)) ?? null;
		},
		markCheckpointPending(k: string, nodeId: string, handlerName: string) {
			pendingStatuses.set(key(k, nodeId), {
				status: "pending",
				pendingHandler: handlerName,
				pendingRecordedAt: new Date().toISOString(),
			});
		},
		markCheckpointConfirmed(k: string, nodeId: string) {
			pendingStatuses.set(key(k, nodeId), {
				status: "confirmed",
				pendingHandler: null,
				pendingRecordedAt: null,
			});
		},
	};
}

function createMockMissionStore(): MissionStore & { currentNode: string | null } {
	let currentNode: string | null = null;

	const noop = () => {};

	return {
		get currentNode() {
			return currentNode;
		},
		getById: (id: string) => ({
			id,
			slug: "test",
			objective: "test",
			runId: null,
			state: "active" as const,
			phase: "understand" as const,
			firstFreezeAt: null,
			pendingUserInput: false,
			pendingInputKind: null,
			pendingInputThreadId: null,
			reopenCount: 0,
			artifactRoot: null,
			pausedWorkstreamIds: [],
			analystSessionId: null,
			executionDirectorSessionId: null,
			coordinatorSessionId: null,
			architectSessionId: null,
			pausedLeadNames: [],
			pauseReason: null,
			currentNode,
			startedAt: null,
			completedAt: null,
			createdAt: "",
			updatedAt: "",
			learningsExtracted: false,
			hasEmittedWsProducerWrite: false,
			tier: null,
			autonomy: "supervised",
		}),
		getBySlug: () => null,
		getByRunId: () => null,
		getActive: () => null,
		getActiveList: () => [],
		create: (m) => ({
			...m,
			runId: m.runId ?? null,
			state: "active" as const,
			phase: "understand" as const,
			firstFreezeAt: null,
			pendingUserInput: false,
			pendingInputKind: null,
			pendingInputThreadId: null,
			reopenCount: 0,
			artifactRoot: m.artifactRoot ?? null,
			pausedWorkstreamIds: [],
			analystSessionId: null,
			executionDirectorSessionId: null,
			coordinatorSessionId: null,
			architectSessionId: null,
			pausedLeadNames: [],
			pauseReason: null,
			currentNode: null,
			startedAt: m.startedAt ?? null,
			completedAt: null,
			createdAt: "",
			updatedAt: "",
			learningsExtracted: false,
			hasEmittedWsProducerWrite: false,
			tier: null,
			autonomy: "supervised",
		}),
		list: () => [],
		delete: noop,
		updateState: noop,
		updatePhase: noop,
		freeze: noop,
		unfreeze: noop,
		updatePausedWorkstreams: noop,
		updateArtifactRoot: noop,
		bindSessions: noop,
		bindCoordinatorSession: noop,
		updatePausedLeads: noop,
		updatePauseReason: noop,
		start: noop,
		completeMission: noop,
		updateSlug: noop,
		updateObjective: noop,
		updateCurrentNode: (_id: string, nodeId: string) => {
			currentNode = nodeId;
		},
		markLearningsExtracted: noop,
		markProducerWritten: noop,
		areAllWorkstreamsDone: () => false,
		checkpoints: createMockCheckpointStore(),
		acquireTickLock: () => true,
		releaseTickLock: noop,
		withTickLock: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn(),
		ensureGateState: () => ({
			entered_at: new Date().toISOString(),
			nudge_count: 0,
			last_nudge_at: null,
			respawn_count: 0,
			grace_ms: 120_000,
			nudge_interval_ms: 60_000,
			max_nudges: 3,
			max_total_wait_ms: 3_600_000,
			resolved_at: null,
			ceiling_emitted_at: null,
		}),
		incrementNudgeCount: noop,
		markCeilingEmitted: noop,
		resolveGate: noop,
		resetGateState: noop,
		updateWorkstreamStatus: noop,
		transaction: <T>(fn: () => T): T => fn(),
		updateTier: noop,
		clearGateStates: noop,
		clearCheckpoints: noop,

		// === PR phase state (Stage E) — stub implementations ===
		getPrState: () => null,
		upsertPrState: noop,
		updatePrCiStatus: noop,
		updatePrReviewDecision: noop,
		setApprovedHeadSha: noop,
		markPrMerged: noop,
		listPrComments: () => [],
		countTriageSpawnsSince: () => 0,
		countTriagePerAuthorSince: () => 0,
		recordPrComment: noop,
		updatePrCommentAction: noop,
		tryClaimTriageSlot: () => true,
		markPrCommentResolved: noop,

		setParentMissionId: noop,
		setSuperseded: noop,
		setTaskId: noop,

		close: noop,
	};
}

// === Minimal test graphs ===

/** Simple two-node graph: start → terminal */
const linearGraph: MissionGraph = {
	version: 1,
	nodes: [
		{ kind: "lifecycle", id: "start", phase: "understand", state: "active" },
		{ kind: "lifecycle", id: "end", phase: "done", state: "completed", terminal: true },
	],
	edges: [{ from: "start", to: "end", trigger: "next" }],
};

/** Three-node chain: A → B → C (terminal) */
const chainGraph: MissionGraph = {
	version: 1,
	nodes: [
		{ kind: "lifecycle", id: "a", phase: "understand", state: "active" },
		{ kind: "lifecycle", id: "b", phase: "align", state: "active" },
		{ kind: "lifecycle", id: "c", phase: "done", state: "completed", terminal: true },
	],
	edges: [
		{ from: "a", to: "b", trigger: "step1" },
		{ from: "b", to: "c", trigger: "step2" },
	],
};

/** Graph with a human gate node */
const gatedGraph: MissionGraph = {
	version: 1,
	nodes: [
		{ kind: "lifecycle", id: "start", phase: "understand", state: "active" },
		{ kind: "lifecycle", id: "gate", phase: "understand", state: "frozen", gate: "human" },
		{ kind: "lifecycle", id: "end", phase: "done", state: "completed", terminal: true },
	],
	edges: [
		{ from: "start", to: "gate", trigger: "freeze" },
		{ from: "gate", to: "end", trigger: "answer" },
	],
};

/** Graph with an async gate cell node */
const asyncGateGraph: MissionGraph = {
	version: 1,
	nodes: [
		{ kind: "lifecycle", id: "start", phase: "understand", state: "active" },
		{ kind: "cell", id: "review:dispatch", cellType: "review", gate: "async" },
		{ kind: "lifecycle", id: "end", phase: "done", state: "completed", terminal: true },
	],
	edges: [
		{ from: "start", to: "review:dispatch", trigger: "dispatch" },
		{ from: "review:dispatch", to: "end", trigger: "done" },
	],
};

function makeOpts(
	graph: MissionGraph,
	handlers: HandlerRegistry = {},
	extra?: Partial<GraphEngineOpts>,
): GraphEngineOpts {
	return {
		graph,
		handlers,
		checkpointStore: createMockCheckpointStore(),
		missionId: "mission-1",
		...extra,
	};
}

// === currentNodeId ===

describe("currentNodeId", () => {
	test("returns startNodeId when specified", () => {
		const engine = createGraphEngine(makeOpts(linearGraph, {}, { startNodeId: "end" }));
		expect(engine.currentNodeId()).toBe("end");
	});

	test("defaults to first node when no checkpoint", () => {
		const engine = createGraphEngine(makeOpts(linearGraph));
		expect(engine.currentNodeId()).toBe("start");
	});

	test("resumes from checkpoint when no startNodeId", () => {
		const checkpointStore = createMockCheckpointStore();
		// Simulate prior run that reached node 'b'
		checkpointStore.saveCheckpoint("mission-1", "b", { done: true });
		const engine = createGraphEngine(makeOpts(chainGraph, {}, { checkpointStore }));
		expect(engine.currentNodeId()).toBe("b");
	});
});

// === step() ===

describe("step() — terminal", () => {
	test("returns terminal status on terminal node", async () => {
		const engine = createGraphEngine(makeOpts(linearGraph, {}, { startNodeId: "end" }));
		const result = await engine.step();
		expect(result.status).toBe("terminal");
		expect(result.fromNodeId).toBe("end");
		expect(result.toNodeId).toBe("end");
		expect(result.trigger).toBeNull();
	});
});

describe("step() — gate", () => {
	test("returns gate status on human gate node", async () => {
		const engine = createGraphEngine(makeOpts(gatedGraph, {}, { startNodeId: "gate" }));
		const result = await engine.step();
		expect(result.status).toBe("gate");
		expect(result.fromNodeId).toBe("gate");
		expect(result.toNodeId).toBe("gate");
		expect(result.trigger).toBeNull();
	});

	test("returns gate status on async gate cell node", async () => {
		const engine = createGraphEngine(
			makeOpts(asyncGateGraph, {}, { startNodeId: "review:dispatch" }),
		);
		const result = await engine.step();
		expect(result.status).toBe("gate");
	});
});

describe("step() — handler invocation", () => {
	test("invokes handler and advances via returned trigger", async () => {
		const graph: MissionGraph = {
			version: 1,
			nodes: [
				{ kind: "lifecycle", id: "start", phase: "understand", state: "active", handler: "doStep" },
				{ kind: "lifecycle", id: "end", phase: "done", state: "completed", terminal: true },
			],
			edges: [{ from: "start", to: "end", trigger: "next" }],
		};

		const handlers: HandlerRegistry = {
			doStep: async () => ({ trigger: "next" }),
		};

		const engine = createGraphEngine(makeOpts(graph, handlers));
		const result = await engine.step();

		expect(result.status).toBe("advanced");
		expect(result.fromNodeId).toBe("start");
		expect(result.toNodeId).toBe("end");
		expect(result.trigger).toBe("next");
		expect(engine.currentNodeId()).toBe("end");
	});

	test("handler receives checkpoint data from prior run", async () => {
		const checkpointStore = createMockCheckpointStore();
		checkpointStore.saveCheckpoint("mission-1", "start", { count: 5 });

		let capturedCheckpoint: unknown;

		const handlers: HandlerRegistry = {
			doStep: async (ctx) => {
				capturedCheckpoint = ctx.checkpoint;
				return { trigger: "next" };
			},
		};

		const graph: MissionGraph = {
			version: 1,
			nodes: [
				{ kind: "lifecycle", id: "start", phase: "understand", state: "active", handler: "doStep" },
				{ kind: "lifecycle", id: "end", phase: "done", state: "completed", terminal: true },
			],
			edges: [{ from: "start", to: "end", trigger: "next" }],
		};

		const engine = createGraphEngine(
			makeOpts(graph, handlers, { checkpointStore, startNodeId: "start" }),
		);
		await engine.step();

		expect(capturedCheckpoint).toEqual({ count: 5 });
	});

	test("handler can save checkpoint via ctx.saveCheckpoint", async () => {
		const checkpointStore = createMockCheckpointStore();

		const handlers: HandlerRegistry = {
			doStep: async (ctx) => {
				await ctx.saveCheckpoint({ progress: 42 });
				return { trigger: "next" };
			},
		};

		const graph: MissionGraph = {
			version: 1,
			nodes: [
				{ kind: "lifecycle", id: "start", phase: "understand", state: "active", handler: "doStep" },
				{ kind: "lifecycle", id: "end", phase: "done", state: "completed", terminal: true },
			],
			edges: [{ from: "start", to: "end", trigger: "next" }],
		};

		const engine = createGraphEngine(
			makeOpts(graph, handlers, { checkpointStore, startNodeId: "start" }),
		);
		await engine.step();

		const saved = checkpointStore.getCheckpoint("mission-1", "start");
		expect(saved?.data).toEqual({ progress: 42 });
	});

	test("returns error status when handler throws", async () => {
		const graph: MissionGraph = {
			version: 1,
			nodes: [
				{
					kind: "lifecycle",
					id: "start",
					phase: "understand",
					state: "active",
					handler: "failHandler",
				},
				{ kind: "lifecycle", id: "end", phase: "done", state: "completed", terminal: true },
			],
			edges: [{ from: "start", to: "end", trigger: "next" }],
		};

		const handlers: HandlerRegistry = {
			failHandler: async () => {
				throw new Error("handler crash");
			},
		};

		const engine = createGraphEngine(makeOpts(graph, handlers));
		const result = await engine.step();

		expect(result.status).toBe("error");
		expect(result.error).toContain("handler crash");
	});

	test("returns error when handler not registered", async () => {
		const graph: MissionGraph = {
			version: 1,
			nodes: [
				{
					kind: "lifecycle",
					id: "start",
					phase: "understand",
					state: "active",
					handler: "missingHandler",
				},
				{ kind: "lifecycle", id: "end", phase: "done", state: "completed", terminal: true },
			],
			edges: [{ from: "start", to: "end", trigger: "next" }],
		};

		const engine = createGraphEngine(makeOpts(graph, {}));
		const result = await engine.step();

		expect(result.status).toBe("error");
		expect(result.error).toContain("missingHandler");
	});
});

describe("step() — auto-trigger", () => {
	test("auto-triggers when single outgoing edge and no handler", async () => {
		const engine = createGraphEngine(makeOpts(linearGraph));
		const result = await engine.step();

		expect(result.status).toBe("advanced");
		expect(result.fromNodeId).toBe("start");
		expect(result.toNodeId).toBe("end");
		expect(result.trigger).toBe("next");
	});

	test("gates when multiple outgoing edges and no handler", async () => {
		const graph: MissionGraph = {
			version: 1,
			nodes: [
				{ kind: "lifecycle", id: "start", phase: "understand", state: "active" },
				{ kind: "lifecycle", id: "a", phase: "align", state: "active" },
				{ kind: "lifecycle", id: "b", phase: "decide", state: "active" },
			],
			edges: [
				{ from: "start", to: "a", trigger: "go-a" },
				{ from: "start", to: "b", trigger: "go-b" },
			],
		};

		const engine = createGraphEngine(makeOpts(graph));
		const result = await engine.step();

		expect(result.status).toBe("gate");
		expect(result.fromNodeId).toBe("start");
	});

	test("treats node with no outgoing edges as terminal", async () => {
		const graph: MissionGraph = {
			version: 1,
			nodes: [{ kind: "lifecycle", id: "lone", phase: "understand", state: "active" }],
			edges: [],
		};

		const engine = createGraphEngine(makeOpts(graph));
		const result = await engine.step();

		expect(result.status).toBe("terminal");
	});
});

// === advanceNode() ===

describe("advanceNode()", () => {
	test("advances gate node via valid trigger and continues to terminal", async () => {
		// gatedGraph: start → gate(human) → end(terminal)
		// Start at gate node, fire "answer" → should run to terminal
		const engine = createGraphEngine(makeOpts(gatedGraph, {}, { startNodeId: "gate" }));
		const result = await engine.advanceNode("answer");

		expect(result.status).toBe("completed");
		expect(result.currentNodeId).toBe("end");
		expect(engine.currentNodeId()).toBe("end");
	});

	test("returns error for unknown trigger on gate node", async () => {
		const engine = createGraphEngine(makeOpts(gatedGraph, {}, { startNodeId: "gate" }));
		const result = await engine.advanceNode("bogus");

		expect(result.status).toBe("error");
		expect(result.error).toContain("bogus");
		expect(engine.currentNodeId()).toBe("gate");
	});

	test("returns error on non-gate node", async () => {
		// linearGraph starts at "start" which has no gate property
		const engine = createGraphEngine(makeOpts(linearGraph));
		const result = await engine.advanceNode("next");

		expect(result.status).toBe("error");
		expect(result.error).toContain("not a gate node");
		expect(engine.currentNodeId()).toBe("start");
	});

	test("records transition in checkpoint store", async () => {
		const checkpointStore = createMockCheckpointStore();
		const engine = createGraphEngine(
			makeOpts(gatedGraph, {}, { checkpointStore, startNodeId: "gate" }),
		);
		await engine.advanceNode("answer");

		expect(checkpointStore.transitions.length).toBeGreaterThanOrEqual(1);
		expect(checkpointStore.transitions[0]?.fromNode).toBe("gate");
		expect(checkpointStore.transitions[0]?.toNode).toBe("end");
		expect(checkpointStore.transitions[0]?.trigger).toBe("answer");
	});

	test("updates missionStore.currentNode when provided", async () => {
		const missionStore = createMockMissionStore();
		const engine = createGraphEngine(
			makeOpts(gatedGraph, {}, { missionStore, startNodeId: "gate" }),
		);
		await engine.advanceNode("answer");

		expect(missionStore.currentNode).toBe("end");
	});

	test("advances async gate node via valid trigger", async () => {
		// asyncGateGraph: start → review:dispatch(async) → end(terminal)
		const engine = createGraphEngine(
			makeOpts(asyncGateGraph, {}, { startNodeId: "review:dispatch" }),
		);
		const result = await engine.advanceNode("done");

		expect(result.status).toBe("completed");
		expect(result.currentNodeId).toBe("end");
	});
});

// === run() ===

describe("run() — full traversal", () => {
	test("runs to terminal and returns completed", async () => {
		const handlers: HandlerRegistry = {
			stepA: async () => ({ trigger: "step1" }),
			stepB: async () => ({ trigger: "step2" }),
		};

		const graph: MissionGraph = {
			version: 1,
			nodes: [
				{ kind: "lifecycle", id: "a", phase: "understand", state: "active", handler: "stepA" },
				{ kind: "lifecycle", id: "b", phase: "align", state: "active", handler: "stepB" },
				{ kind: "lifecycle", id: "c", phase: "done", state: "completed", terminal: true },
			],
			edges: [
				{ from: "a", to: "b", trigger: "step1" },
				{ from: "b", to: "c", trigger: "step2" },
			],
		};

		const engine = createGraphEngine(makeOpts(graph, handlers));
		const result = await engine.run();

		expect(result.status).toBe("completed");
		expect(result.steps).toHaveLength(3); // advance, advance, terminal
		expect(result.currentNodeId).toBe("c");
	});

	test("stops at human gate and returns gate status", async () => {
		const engine = createGraphEngine(makeOpts(gatedGraph));
		const result = await engine.run();

		expect(result.status).toBe("gate");
		// start auto-advances via single edge 'freeze' to 'gate', which is human-gated
		expect(result.currentNodeId).toBe("gate");
		expect(result.steps.length).toBeGreaterThan(0);
	});

	test("reports gateType for human gate", async () => {
		const engine = createGraphEngine(makeOpts(gatedGraph, {}, { startNodeId: "gate" }));
		const result = await engine.run();

		expect(result.status).toBe("gate");
		expect(result.gateType).toBe("human");
	});

	test("reports gateType for async gate", async () => {
		const engine = createGraphEngine(
			makeOpts(asyncGateGraph, {}, { startNodeId: "review:dispatch" }),
		);
		const result = await engine.run();

		expect(result.status).toBe("gate");
		expect(result.gateType).toBe("async");
	});

	test("collects all steps in run result", async () => {
		const engine = createGraphEngine(makeOpts(linearGraph));
		const result = await engine.run();

		// auto-advance 'start' → 'end', then terminal step at 'end'
		expect(result.steps).toHaveLength(2);
		expect(result.steps[0]?.status).toBe("advanced");
		expect(result.steps[1]?.status).toBe("terminal");
	});

	test("returns error status when step errors", async () => {
		const graph: MissionGraph = {
			version: 1,
			nodes: [
				{
					kind: "lifecycle",
					id: "start",
					phase: "understand",
					state: "active",
					handler: "badHandler",
				},
			],
			edges: [],
		};
		const handlers: HandlerRegistry = {
			badHandler: async () => {
				throw new Error("boom");
			},
		};

		const engine = createGraphEngine(makeOpts(graph, handlers));
		const result = await engine.run();

		expect(result.status).toBe("error");
		expect(result.error).toContain("boom");
	});
});

// === subgraph support ===

describe("subgraph execution", () => {
	test("executes subgraph before advancing parent node", async () => {
		const executed: string[] = [];

		const subgraph: MissionGraph = {
			version: 1,
			nodes: [
				{
					kind: "lifecycle",
					id: "sub-start",
					phase: "understand",
					state: "active",
					handler: "subHandler",
				},
				{
					kind: "lifecycle",
					id: "sub-end",
					phase: "done",
					state: "completed",
					terminal: true,
				},
			],
			edges: [{ from: "sub-start", to: "sub-end", trigger: "sub-next" }],
		};

		const graph: MissionGraph = {
			version: 1,
			nodes: [
				{
					kind: "lifecycle",
					id: "parent",
					phase: "understand",
					state: "active",
					subgraph,
					handler: "parentHandler",
				},
				{ kind: "lifecycle", id: "final", phase: "done", state: "completed", terminal: true },
			],
			edges: [{ from: "parent", to: "final", trigger: "done" }],
		};

		const handlers: HandlerRegistry = {
			subHandler: async () => {
				executed.push("sub");
				return { trigger: "sub-next" };
			},
			parentHandler: async () => {
				executed.push("parent");
				return { trigger: "done" };
			},
		};

		const engine = createGraphEngine(makeOpts(graph, handlers));
		const result = await engine.run();

		expect(result.status).toBe("completed");
		expect(executed).toEqual(["sub", "parent"]);
	});

	test("subgraph checkpoints are isolated from parent via prefixed key", async () => {
		const checkpointStore = createMockCheckpointStore();

		// Pre-seed a parent checkpoint at node "parent"
		checkpointStore.saveCheckpoint("mission-1", "parent", { parentData: true });

		const subgraph: MissionGraph = {
			version: 1,
			nodes: [
				{
					kind: "lifecycle",
					id: "sub-start",
					phase: "understand",
					state: "active",
					handler: "subHandler",
				},
				{ kind: "lifecycle", id: "sub-end", phase: "done", state: "completed", terminal: true },
			],
			edges: [{ from: "sub-start", to: "sub-end", trigger: "sub-next" }],
		};

		const graph: MissionGraph = {
			version: 1,
			nodes: [
				{
					kind: "lifecycle",
					id: "parent",
					phase: "understand",
					state: "active",
					subgraph,
				},
				{ kind: "lifecycle", id: "final", phase: "done", state: "completed", terminal: true },
			],
			edges: [{ from: "parent", to: "final", trigger: "done" }],
		};

		const handlers: HandlerRegistry = {
			subHandler: async () => ({ trigger: "sub-next" }),
		};

		const engine = createGraphEngine(makeOpts(graph, handlers, { checkpointStore }));
		await engine.run();

		// Parent checkpoint should still have original data
		const parentCp = checkpointStore.getCheckpoint("mission-1", "parent");
		expect(parentCp?.data).toEqual({ parentData: true });

		// Subgraph checkpoints stored under prefixed key "parent:mission-1", not "mission-1"
		const subCpUnprefixed = checkpointStore.getCheckpoint("mission-1", "sub-start");
		expect(subCpUnprefixed).toBeNull();

		// getLatestCheckpoint for prefixed key should find the subgraph's checkpoint
		const subLatest = checkpointStore.getLatestCheckpoint("parent:mission-1");
		expect(subLatest).not.toBeNull();
		expect(subLatest?.nodeId).toBe("sub-end");
	});

	test("propagates subgraph error with status error and error message", async () => {
		const subgraph: MissionGraph = {
			version: 1,
			nodes: [
				{
					kind: "lifecycle",
					id: "sub-fail",
					phase: "understand",
					state: "active",
					handler: "failHandler",
				},
				{ kind: "lifecycle", id: "sub-end", phase: "done", state: "completed", terminal: true },
			],
			edges: [{ from: "sub-fail", to: "sub-end", trigger: "next" }],
		};

		const graph: MissionGraph = {
			version: 1,
			nodes: [
				{
					kind: "lifecycle",
					id: "parent",
					phase: "understand",
					state: "active",
					subgraph,
				},
				{ kind: "lifecycle", id: "final", phase: "done", state: "completed", terminal: true },
			],
			edges: [{ from: "parent", to: "final", trigger: "done" }],
		};

		const handlers: HandlerRegistry = {
			failHandler: async () => {
				throw new Error("subgraph crash");
			},
		};

		const engine = createGraphEngine(makeOpts(graph, handlers));
		const result = await engine.step();

		expect(result.status).toBe("error");
		expect(result.error).toContain("subgraph crash");
	});

	test("subgraph error does not become gate", async () => {
		const subgraph: MissionGraph = {
			version: 1,
			nodes: [
				{
					kind: "lifecycle",
					id: "sub-fail",
					phase: "understand",
					state: "active",
					handler: "failHandler",
				},
				{ kind: "lifecycle", id: "sub-end", phase: "done", state: "completed", terminal: true },
			],
			edges: [{ from: "sub-fail", to: "sub-end", trigger: "next" }],
		};

		const graph: MissionGraph = {
			version: 1,
			nodes: [
				{
					kind: "lifecycle",
					id: "parent",
					phase: "understand",
					state: "active",
					subgraph,
				},
				{ kind: "lifecycle", id: "final", phase: "done", state: "completed", terminal: true },
			],
			edges: [{ from: "parent", to: "final", trigger: "done" }],
		};

		const handlers: HandlerRegistry = {
			failHandler: async () => {
				throw new Error("subgraph crash");
			},
		};

		const engine = createGraphEngine(makeOpts(graph, handlers));
		const result = await engine.step();

		expect(result.status).not.toBe("gate");
		expect(result.status).toBe("error");
	});

	test("gates when subgraph is gated", async () => {
		const subgraph: MissionGraph = {
			version: 1,
			nodes: [
				{ kind: "lifecycle", id: "sub-gate", phase: "understand", state: "frozen", gate: "human" },
			],
			edges: [],
		};

		const graph: MissionGraph = {
			version: 1,
			nodes: [
				{
					kind: "lifecycle",
					id: "parent",
					phase: "understand",
					state: "active",
					subgraph,
				},
				{ kind: "lifecycle", id: "final", phase: "done", state: "completed", terminal: true },
			],
			edges: [{ from: "parent", to: "final", trigger: "done" }],
		};

		const engine = createGraphEngine(makeOpts(graph));
		const result = await engine.step();

		expect(result.status).toBe("gate");
		expect(result.fromNodeId).toBe("parent");
	});
});

// === 2PC + replay ===

const handlerGraph = (handlerName: string): MissionGraph => ({
	version: 1,
	nodes: [
		{
			kind: "lifecycle",
			id: "work",
			phase: "understand",
			state: "active",
			handler: handlerName,
		},
		{
			kind: "lifecycle",
			id: "done",
			phase: "done",
			state: "completed",
			terminal: true,
		},
		{
			kind: "lifecycle",
			id: "failed",
			phase: "done",
			state: "completed",
			terminal: true,
		},
	],
	edges: [
		{ from: "work", to: "done", trigger: "next" },
		{ from: "work", to: "failed", trigger: "dispatch_failed" },
	],
});

describe("2PC + replay", () => {
	test("markCheckpointPending is called before handler invocation", async () => {
		const checkpointStore = createMockCheckpointStoreWithStatus();
		let pendingAtInvocation: CheckpointStatusRow | null = null;

		const handlers: HandlerRegistry = {
			myHandler: async () => {
				pendingAtInvocation = checkpointStore.getCheckpointStatus("mission-1", "work");
				return { trigger: "next" };
			},
		};

		const engine = createGraphEngine(
			makeOpts(handlerGraph("myHandler"), handlers, { checkpointStore }),
		);
		await engine.step();

		expect((pendingAtInvocation as CheckpointStatusRow | null)?.status).toBe("pending");
		expect((pendingAtInvocation as CheckpointStatusRow | null)?.pendingHandler).toBe("myHandler");
	});

	test("markCheckpointConfirmed is called inside performAdvance after handler completes", async () => {
		const checkpointStore = createMockCheckpointStoreWithStatus();

		const handlers: HandlerRegistry = {
			myHandler: async () => ({ trigger: "next" }),
		};

		const engine = createGraphEngine(
			makeOpts(handlerGraph("myHandler"), handlers, { checkpointStore }),
		);
		await engine.step();

		const status = checkpointStore.getCheckpointStatus("mission-1", "work");
		expect(status?.status).toBe("confirmed");
	});

	test("handler crash leaves pending status (pending stays on throw)", async () => {
		const checkpointStore = createMockCheckpointStoreWithStatus();

		const handlers: HandlerRegistry = {
			myHandler: async () => {
				throw new Error("crash");
			},
		};

		const engine = createGraphEngine(
			makeOpts(handlerGraph("myHandler"), handlers, { checkpointStore }),
		);
		await engine.step();

		const status = checkpointStore.getCheckpointStatus("mission-1", "work");
		expect(status?.status).toBe("pending");
	});

	test("replay-safe handler with pending status falls through to re-invocation", async () => {
		const checkpointStore = createMockCheckpointStoreWithStatus();
		// Pre-seed a pending status for a replay-safe handler
		checkpointStore.markCheckpointPending("mission-1", "work", "summary");

		let invoked = false;
		const handlers: HandlerRegistry = {
			summary: async () => {
				invoked = true;
				return { trigger: "next" };
			},
		};

		const graph = handlerGraph("summary");
		const engine = createGraphEngine(makeOpts(graph, handlers, { checkpointStore }));
		const result = await engine.step();

		expect(invoked).toBe(true);
		expect(result.status).toBe("advanced");
	});

	test("non-replay-safe handler with pending status routes to dispatch_failed", async () => {
		const checkpointStore = createMockCheckpointStoreWithStatus();
		// Pre-seed a pending status for a non-safe handler
		checkpointStore.markCheckpointPending("mission-1", "work", "spec-rejected");

		let invoked = false;
		const handlers: HandlerRegistry = {
			"spec-rejected": async () => {
				invoked = true;
				return { trigger: "next" };
			},
		};

		const graph = handlerGraph("spec-rejected");
		const engine = createGraphEngine(makeOpts(graph, handlers, { checkpointStore }));
		const result = await engine.step();

		expect(invoked).toBe(false);
		expect(result.status).toBe("advanced");
		expect(result.toNodeId).toBe("failed");
		expect(result.trigger).toBe("dispatch_failed");
	});

	test("ctx.saveCheckpoint during pending does not affect checkpoint status table", async () => {
		const checkpointStore = createMockCheckpointStoreWithStatus();

		const handlers: HandlerRegistry = {
			myHandler: async (ctx) => {
				// Simulate handler-inner data mutation
				await ctx.saveCheckpoint({ count: 99 });
				return { trigger: "next" };
			},
		};

		const engine = createGraphEngine(
			makeOpts(handlerGraph("myHandler"), handlers, { checkpointStore }),
		);

		// Pre-seed pending status
		checkpointStore.markCheckpointPending("mission-1", "work", "myHandler");

		// Now drive handler — the saveCheckpoint inside handler must not clear pending
		const saveOriginal = checkpointStore.saveCheckpoint.bind(checkpointStore);
		let pendingAfterSave: CheckpointStatusRow | null = null;
		checkpointStore.saveCheckpoint = (key, nodeId, data) => {
			saveOriginal(key, nodeId, data);
			pendingAfterSave = checkpointStore.getCheckpointStatus("mission-1", "work");
		};

		await engine.step();

		// After saveCheckpoint call inside handler, status was still pending (not overwritten)
		expect((pendingAfterSave as CheckpointStatusRow | null)?.status).toBe("pending");
	});

	test("performAdvance transaction wraps all writes atomically when missionStore provided", async () => {
		const checkpointStore = createMockCheckpointStoreWithStatus();
		const missionStore = createMockMissionStore();
		const transactionCalls: string[] = [];

		const origTransaction = missionStore.transaction.bind(missionStore);
		missionStore.transaction = <T>(fn: () => T): T => {
			transactionCalls.push("tx");
			return origTransaction(fn);
		};

		const handlers: HandlerRegistry = {
			myHandler: async () => ({ trigger: "next" }),
		};

		const graph = handlerGraph("myHandler");
		const engine = createGraphEngine(makeOpts(graph, handlers, { checkpointStore, missionStore }));
		await engine.step();

		expect(transactionCalls.length).toBeGreaterThanOrEqual(1);
		expect(missionStore.currentNode).toBe("done");
	});

	test("performAdvance without missionStore falls back to direct calls (test-only path)", async () => {
		const checkpointStore = createMockCheckpointStoreWithStatus();

		const handlers: HandlerRegistry = {
			myHandler: async () => ({ trigger: "next" }),
		};

		const engine = createGraphEngine(
			makeOpts(handlerGraph("myHandler"), handlers, { checkpointStore }),
		);
		const result = await engine.step();

		// No missionStore — must still advance and confirm
		expect(result.status).toBe("advanced");
		const status = checkpointStore.getCheckpointStatus("mission-1", "work");
		expect(status?.status).toBe("confirmed");
	});

	test("REPLAY_SAFE_HANDLERS contains exactly the specified 7 members", () => {
		const expected = new Set([
			"dispatch-clarifier",
			"dispatch-tier-classifier",
			"dispatch-analyst-intake",
			"summary",
			"check-debug-attempts",
			"merge-debug-fix",
			"cleanup",
		]);

		expect(REPLAY_SAFE_HANDLERS.size).toBe(7);
		for (const name of expected) {
			expect(REPLAY_SAFE_HANDLERS.has(name)).toBe(true);
		}
		// Non-safe handlers must NOT be in the set
		expect(REPLAY_SAFE_HANDLERS.has("spec-rejected")).toBe(false);
		expect(REPLAY_SAFE_HANDLERS.has("dispatch-debugger")).toBe(false);
		expect(REPLAY_SAFE_HANDLERS.has("escalate")).toBe(false);
	});
});

// === checkpoint persistence ===

describe("checkpoint persistence", () => {
	test("saveStepResult called on each advance", async () => {
		const checkpointStore = createMockCheckpointStore();
		const engine = createGraphEngine(makeOpts(chainGraph, {}, { checkpointStore }));
		await engine.run();

		// Two advances: a→b and b→c
		expect(checkpointStore.transitions).toHaveLength(2);
	});

	test("engine resumes from checkpoint after restart", async () => {
		const checkpointStore = createMockCheckpointStore();

		// First run: step once (auto-advances "a" → "b" via single outgoing edge)
		const engine1 = createGraphEngine(makeOpts(chainGraph, {}, { checkpointStore }));
		await engine1.step();
		expect(engine1.currentNodeId()).toBe("b");

		// New engine instance with same checkpointStore — should resume at 'b'
		const engine2 = createGraphEngine(makeOpts(chainGraph, {}, { checkpointStore }));
		expect(engine2.currentNodeId()).toBe("b");

		// Continue from 'b' to terminal
		const result = await engine2.run();
		expect(result.status).toBe("completed");
		expect(result.currentNodeId).toBe("c");
	});
});
