import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../../test-helpers.ts";
import type { Mission } from "../../types.ts";
import { validateGraph } from "../graph.ts";
import type { HandlerContext } from "../types.ts";
import { donePhaseCell } from "./done-phase.ts";
import type { PhaseCellConfig, PhaseCellDeps } from "./types.ts";

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

	test("Stage C: dispatch-debugger has capability_missing edge to escalate", () => {
		const edge = graph.edges.find(
			(e) => e.from === "done-phase:dispatch-debugger" && e.trigger === "capability_missing",
		);
		expect(edge?.to).toBe("done-phase:escalate");
	});
});

describe("donePhaseCell dispatch-debugger preflight", () => {
	let tempDir: string;
	let agentBaseDir: string;
	let saved: Array<{ missionId: string; nodeId: string; data: unknown }>;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "haru-done-preflight-"));
		agentBaseDir = join(tempDir, "agent-defs");
		await mkdir(agentBaseDir, { recursive: true });
		saved = [];
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	async function writeManifest(agents: Record<string, unknown>): Promise<void> {
		await Bun.write(
			join(tempDir, "agent-manifest.json"),
			JSON.stringify({ version: "1.0", agents }),
		);
		for (const [, def] of Object.entries(agents)) {
			const file = (def as { file?: string }).file;
			if (typeof file === "string" && file.length > 0) {
				await Bun.write(join(agentBaseDir, file), `# ${file}\n`);
			}
		}
	}

	function makeDeps(): PhaseCellDeps {
		return {
			mailSend: async () => {},
			checkpointStore: {} as PhaseCellDeps["checkpointStore"],
			missionStore: {
				checkpoints: {
					saveCheckpoint: (missionId: string, nodeId: string, data: unknown) => {
						saved.push({ missionId, nodeId, data });
					},
					getCheckpoint: () => null,
				},
			} as unknown as PhaseCellDeps["missionStore"],
			overstoryDir: tempDir,
			projectRoot: "/tmp/project-not-used",
		};
	}

	function makeCtx(): HandlerContext {
		return {
			missionId: "m1",
			nodeId: "done-phase:dispatch-debugger",
			checkpoint: null,
			saveCheckpoint: async () => {},
			sendMail: async () => {},
			getMission: () =>
				({
					id: "m1",
					slug: "test-mission",
					featureBranch: "feature/x",
					artifactRoot: "/tmp/artifacts",
				}) as unknown as Mission,
		} as HandlerContext;
	}

	test("capability missing -> returns capability_missing and persists reason", async () => {
		await writeManifest({
			scout: {
				file: "scout.md",
				model: "sonnet",
				tools: ["Read"],
				capabilities: ["explore"],
				canSpawn: false,
				constraints: [],
			},
		});
		const handlers = donePhaseCell.buildHandlers(makeDeps());
		// biome-ignore lint/style/noNonNullAssertion: registry known to contain dispatch-debugger
		const result = await handlers["dispatch-debugger"]!(makeCtx());

		expect(result.trigger).toBe("capability_missing");
		expect(saved).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: toHaveLength(1) guard above
		const cp = saved[0]!;
		expect(cp.nodeId).toBe("done-phase:dispatch-debugger");
		const data = cp.data as { capabilityMissing?: boolean; dispatchFailureReason?: string };
		expect(data.capabilityMissing).toBe(true);
		expect(data.dispatchFailureReason).toContain("debugger capability not registered");
	});

	test("capability present -> preflight passes (trigger is not capability_missing)", async () => {
		await writeManifest({
			debugger: {
				file: "debugger.md",
				model: "sonnet",
				tools: ["Read", "Edit"],
				capabilities: ["debugger"],
				canSpawn: false,
				constraints: [],
			},
		});
		const handlers = donePhaseCell.buildHandlers(makeDeps());
		// biome-ignore lint/style/noNonNullAssertion: registry known to contain dispatch-debugger
		const result = await handlers["dispatch-debugger"]!(makeCtx());

		// Preflight passes. Downstream steps (git worktree add) may fail in this
		// test env and return dispatch_failed — but crucially NOT capability_missing.
		expect(result.trigger).not.toBe("capability_missing");
	});

	test("manifest file missing -> still returns capability_missing", async () => {
		// No manifest written. loader.load() throws; preflight catches.
		const handlers = donePhaseCell.buildHandlers(makeDeps());
		// biome-ignore lint/style/noNonNullAssertion: registry known to contain dispatch-debugger
		const result = await handlers["dispatch-debugger"]!(makeCtx());

		expect(result.trigger).toBe("capability_missing");
		expect(saved).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: toHaveLength(1) guard above
		const data = saved[0]!.data as { dispatchFailureReason?: string };
		expect(data.dispatchFailureReason).toContain("debugger capability not registered");
	});
});
