/**
 * Smoke test: drives the pr-phase subgraph through every edge path and
 * asserts that mission_state_transitions rows are written by the engine.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { CheckpointStore, MissionStore } from "../types.ts";
import { prPhaseCell } from "./cells/pr-phase.ts";
import { createGraphEngine, type GraphEngine } from "./engine.ts";
import { createMissionStore } from "./store.ts";
import type { HandlerContext } from "./types.ts";

const MISSION_ID = "m1";

const SUBGRAPH_CONFIG = {
	missionId: MISSION_ID,
	artifactRoot: "/tmp",
	projectRoot: "/tmp",
	tier: "full" as const,
	pr: { enabled: true, operatorGithubLogin: "test" },
};

const PR_PHASE_HANDLERS = [
	"preflight",
	"create",
	"classify-ci-red",
	"dispatch-debugger",
	"merge-debug-fix",
	"check-debug-attempts",
	"dispatch-triage",
	"resume-coordinator",
	"merge",
	"escalate",
] as const;

type PrPhaseHandlerName = (typeof PR_PHASE_HANDLERS)[number];
type HandlerFn = (ctx: HandlerContext) => Promise<{ trigger: string }>;
type HandlerOverrides = Partial<Record<PrPhaseHandlerName, HandlerFn>>;

// Tracks stores created per test for cleanup in afterEach
let openStores: MissionStore[] = [];

afterEach(() => {
	for (const store of openStores) store.close();
	openStores = [];
});

function buildHarness(overrides: HandlerOverrides): {
	engine: GraphEngine;
	checkpointStore: CheckpointStore;
	missionId: string;
} {
	// Real in-memory store — all migrations run, checkpoint + transition tables exist
	const realStore = createMissionStore(":memory:");
	openStores.push(realStore);
	const checkpointStore = realStore.checkpoints;

	const subgraph = prPhaseCell.buildSubgraph(SUBGRAPH_CONFIG);

	// Stub handlers: only paths exercised in a given test need real stubs
	const handlers: Record<string, HandlerFn> = {};
	for (const name of PR_PHASE_HANDLERS) {
		const override = overrides[name];
		handlers[name] =
			override ??
			(async (_ctx) => {
				throw new Error(`Handler '${name}' reached but not stubbed in this test`);
			});
	}

	// Fake MissionStore — engine only calls these three methods during traversal
	const fakeMissionStore = {
		updateCurrentNode: () => {},
		resetGateState: () => {},
		transaction: <T>(fn: () => T): T => fn(),
		getById: (_id: string) => null,
	} as unknown as MissionStore;

	const engine = createGraphEngine({
		graph: subgraph,
		handlers,
		checkpointStore,
		missionId: MISSION_ID,
		missionStore: fakeMissionStore,
	});

	return { engine, checkpointStore, missionId: MISSION_ID };
}

// ===

describe("MANDATORY: first-edge regression gate", () => {
	test("preflight→create via preflight_passed writes one mission_state_transitions row", async () => {
		const { engine, checkpointStore, missionId } = buildHarness({
			preflight: async () => ({ trigger: "preflight_passed" }),
		});
		await engine.step();
		const transitions = checkpointStore.getTransitionHistory(missionId);
		expect(transitions).toHaveLength(1);
		expect(transitions[0]).toMatchObject({
			fromNode: "pr-phase:preflight",
			toNode: "pr-phase:create",
			trigger: "preflight_passed",
		});
	});
});

describe("happy path: preflight→create→await-ci→await-comments→await-approval→merge→done", () => {
	test("traverses all 6 happy-path edges and records them", async () => {
		const { engine, checkpointStore, missionId } = buildHarness({
			preflight: async () => ({ trigger: "preflight_passed" }),
			create: async () => ({ trigger: "pr_created" }),
			merge: async () => ({ trigger: "merged" }),
		});

		// Run until await-ci gate
		const run1 = await engine.run();
		expect(run1.status).toBe("gate");
		expect(run1.currentNodeId).toBe("pr-phase:await-ci");

		// ci_passed → await-comments gate
		const run2 = await engine.advanceNode("ci_passed");
		expect(run2.status).toBe("gate");
		expect(run2.currentNodeId).toBe("pr-phase:await-comments");

		// approval_event → await-approval gate
		const run3 = await engine.advanceNode("approval_event");
		expect(run3.status).toBe("gate");
		expect(run3.currentNodeId).toBe("pr-phase:await-approval");

		// approved → merge handler → done terminal
		const run4 = await engine.advanceNode("approved");
		expect(run4.status).toBe("completed");
		expect(run4.currentNodeId).toBe("pr-phase:done");

		const transitions = checkpointStore.getTransitionHistory(missionId);
		const expectedEdges = [
			{
				fromNode: "pr-phase:preflight",
				toNode: "pr-phase:create",
				trigger: "preflight_passed",
			},
			{ fromNode: "pr-phase:create", toNode: "pr-phase:await-ci", trigger: "pr_created" },
			{
				fromNode: "pr-phase:await-ci",
				toNode: "pr-phase:await-comments",
				trigger: "ci_passed",
			},
			{
				fromNode: "pr-phase:await-comments",
				toNode: "pr-phase:await-approval",
				trigger: "approval_event",
			},
			{ fromNode: "pr-phase:await-approval", toNode: "pr-phase:merge", trigger: "approved" },
			{ fromNode: "pr-phase:merge", toNode: "pr-phase:done", trigger: "merged" },
		];
		expect(transitions).toHaveLength(expectedEdges.length);
		for (const expected of expectedEdges) {
			expect(transitions).toContainEqual(expect.objectContaining(expected));
		}
	});
});

describe("debug-loop path: ci_failed→classify→dispatch→brief→debug-complete→merge-fix→check-attempts→escalate→paused", () => {
	test("traverses all debug-loop edges and records them", async () => {
		const { engine, checkpointStore, missionId } = buildHarness({
			preflight: async () => ({ trigger: "preflight_passed" }),
			create: async () => ({ trigger: "pr_created" }),
			"classify-ci-red": async () => ({ trigger: "ci_code_fail" }),
			"dispatch-debugger": async () => ({ trigger: "debugger_dispatched" }),
			"merge-debug-fix": async () => ({ trigger: "merge_conflict" }),
			"check-debug-attempts": async () => ({ trigger: "exhausted" }),
			escalate: async () => ({ trigger: "escalated" }),
		});

		// Run until await-ci gate
		const run1 = await engine.run();
		expect(run1.status).toBe("gate");
		expect(run1.currentNodeId).toBe("pr-phase:await-ci");

		// ci_failed → classify-ci-red → dispatch-debugger → request-analyst-brief (gate)
		const run2 = await engine.advanceNode("ci_failed");
		expect(run2.status).toBe("gate");
		expect(run2.currentNodeId).toBe("pr-phase:request-analyst-brief");

		// brief_ready → await-debug-complete (gate)
		const run3 = await engine.advanceNode("brief_ready");
		expect(run3.status).toBe("gate");
		expect(run3.currentNodeId).toBe("pr-phase:await-debug-complete");

		// fix_committed → merge-debug-fix (merge_conflict) → check-debug-attempts (exhausted) → escalate (escalated) → paused
		const run4 = await engine.advanceNode("fix_committed");
		expect(run4.status).toBe("completed");
		expect(run4.currentNodeId).toBe("pr-phase:paused");

		const transitions = checkpointStore.getTransitionHistory(missionId);
		const debugEdges = [
			{
				fromNode: "pr-phase:await-ci",
				toNode: "pr-phase:classify-ci-red",
				trigger: "ci_failed",
			},
			{
				fromNode: "pr-phase:classify-ci-red",
				toNode: "pr-phase:dispatch-debugger",
				trigger: "ci_code_fail",
			},
			{
				fromNode: "pr-phase:dispatch-debugger",
				toNode: "pr-phase:request-analyst-brief",
				trigger: "debugger_dispatched",
			},
			{
				fromNode: "pr-phase:request-analyst-brief",
				toNode: "pr-phase:await-debug-complete",
				trigger: "brief_ready",
			},
			{
				fromNode: "pr-phase:await-debug-complete",
				toNode: "pr-phase:merge-debug-fix",
				trigger: "fix_committed",
			},
			{
				fromNode: "pr-phase:merge-debug-fix",
				toNode: "pr-phase:check-debug-attempts",
				trigger: "merge_conflict",
			},
			{
				fromNode: "pr-phase:check-debug-attempts",
				toNode: "pr-phase:escalate",
				trigger: "exhausted",
			},
			{ fromNode: "pr-phase:escalate", toNode: "pr-phase:paused", trigger: "escalated" },
		];
		for (const expected of debugEdges) {
			expect(transitions).toContainEqual(expect.objectContaining(expected));
		}
	});
});

describe("triage path: new_comment→dispatch-triage→resume-coordinator→back to await-comments", () => {
	test("triage cycle returns engine to await-comments gate with correct transition rows", async () => {
		const { engine, checkpointStore, missionId } = buildHarness({
			preflight: async () => ({ trigger: "preflight_passed" }),
			create: async () => ({ trigger: "pr_created" }),
			"dispatch-triage": async () => ({ trigger: "approval_event" }),
			"resume-coordinator": async () => ({ trigger: "coordinator_done" }),
		});

		// Run until await-ci gate
		const run1 = await engine.run();
		expect(run1.currentNodeId).toBe("pr-phase:await-ci");

		// ci_passed → await-comments gate
		const run2 = await engine.advanceNode("ci_passed");
		expect(run2.currentNodeId).toBe("pr-phase:await-comments");

		// new_comment → dispatch-triage (approval_event) → resume-coordinator (coordinator_done) → await-comments
		const run3 = await engine.advanceNode("new_comment");
		expect(run3.status).toBe("gate");
		expect(run3.currentNodeId).toBe("pr-phase:await-comments");

		const transitions = checkpointStore.getTransitionHistory(missionId);
		const triageEdges = [
			{
				fromNode: "pr-phase:await-comments",
				toNode: "pr-phase:dispatch-triage",
				trigger: "new_comment",
			},
			{
				fromNode: "pr-phase:dispatch-triage",
				toNode: "pr-phase:resume-coordinator",
				trigger: "approval_event",
			},
			{
				fromNode: "pr-phase:resume-coordinator",
				toNode: "pr-phase:await-comments",
				trigger: "coordinator_done",
			},
		];
		for (const expected of triageEdges) {
			expect(transitions).toContainEqual(expect.objectContaining(expected));
		}
	});
});
