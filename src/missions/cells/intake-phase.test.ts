import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrackerClient } from "../../tracker/types.ts";
import { PENDING_SENTINEL } from "../task-id.ts";
import type { makeMission } from "../test-mocks.ts";
import type { HandlerContext, Mission } from "../types.ts";
import { intakePhaseCell } from "./intake-phase.ts";
import type { PhaseCellDeps } from "./types.ts";

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

function makeDeps(overrides?: Partial<PhaseCellDeps>): PhaseCellDeps {
	return {
		mailSend: async () => {},
		checkpointStore: {} as unknown as PhaseCellDeps["checkpointStore"],
		missionStore: {} as unknown as PhaseCellDeps["missionStore"],
		tracker: makeStubTracker(),
		...overrides,
	};
}

function makeCtx(opts: {
	mission?: ReturnType<typeof makeMission> | null;
	checkpoint?: unknown;
	nodeId?: string;
	onSaveCheckpoint?: (data: unknown) => void;
	sendMail?: (to: string, subject: string, body: string, type: string) => Promise<void>;
}): HandlerContext {
	return {
		nodeId: opts.nodeId ?? "intake-phase:ensure-context-generate",
		checkpoint: opts.checkpoint ?? null,
		getMission: () => opts.mission ?? null,
		saveCheckpoint: async (data: unknown) => {
			opts.onSaveCheckpoint?.(data);
		},
		sendMail: opts.sendMail ?? (async () => {}),
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
		expect(nodeIds).toContain("intake-phase:await-context");
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

	test("await-context is async with 600s (10min) timeout (#236)", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const node = graph.nodes.find((n) => n.id === "intake-phase:await-context");
		expect(node?.gate).toBe("async");
		expect(node?.gateTimeout).toBe(600);
	});

	test("ensure-context-generate has both context_ready and context_generating edges (#236)", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const fromEnsure = graph.edges.filter((e) => e.from === "intake-phase:ensure-context-generate");
		const readyEdge = fromEnsure.find((e) => e.trigger === "context_ready");
		const generatingEdge = fromEnsure.find((e) => e.trigger === "context_generating");
		expect(readyEdge?.to).toBe("intake-phase:dispatch-analyst-intake");
		expect(generatingEdge?.to).toBe("intake-phase:await-context");
	});

	test("await-context → dispatch-analyst-intake on context_ready (#236)", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const edge = graph.edges.find(
			(e) => e.from === "intake-phase:await-context" && e.trigger === "context_ready",
		);
		expect(edge?.to).toBe("intake-phase:dispatch-analyst-intake");
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

	test("buildSubgraph has intake-phase:escalate node", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const nodeIds = graph.nodes.map((n) => n.id);
		expect(nodeIds).toContain("intake-phase:escalate");
	});

	test("buildSubgraph has dispatch_failed edges (3 dispatch handlers → escalate)", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const failEdges = graph.edges.filter((e) => e.trigger === "dispatch_failed");
		const failFromNodes = failEdges.map((e) => e.from);
		expect(failFromNodes).toContain("intake-phase:dispatch-clarifier");
		expect(failFromNodes).toContain("intake-phase:dispatch-tier-classifier");
		expect(failFromNodes).toContain("intake-phase:dispatch-analyst-intake");
		for (const edge of failEdges) {
			if (
				edge.from === "intake-phase:dispatch-clarifier" ||
				edge.from === "intake-phase:dispatch-tier-classifier" ||
				edge.from === "intake-phase:dispatch-analyst-intake"
			) {
				expect(edge.to).toBe("intake-phase:escalate");
			}
		}
	});

	test("buildSubgraph has spec-rejected dispatch_failed edge", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const edge = graph.edges.find(
			(e) => e.from === "intake-phase:spec-rejected" && e.trigger === "dispatch_failed",
		);
		expect(edge).toBeDefined();
		expect(edge?.to).toBe("intake-phase:escalate");
	});

	test("buildSubgraph has escalate → complete edge", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const edge = graph.edges.find(
			(e) => e.from === "intake-phase:escalate" && e.trigger === "escalated",
		);
		expect(edge).toBeDefined();
		expect(edge?.to).toBe("intake-phase:complete");
	});

	// === haru-751d: edge-map regression guards for create-tracker-issue rewire ===

	test("E-1: await-spec-ready → human-spec-review on spec_ready is unchanged", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const edge = graph.edges.find(
			(e) => e.from === "intake-phase:await-spec-ready" && e.trigger === "spec_ready",
		);
		expect(edge?.to).toBe("intake-phase:human-spec-review");
	});

	test("E-2: human-spec-review → create-tracker-issue on approved exists", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const edge = graph.edges.find(
			(e) => e.from === "intake-phase:human-spec-review" && e.trigger === "approved",
		);
		expect(edge?.to).toBe("intake-phase:create-tracker-issue");
	});

	test("E-3: human-spec-review → dispatch-tier-classifier on approved is GONE", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const stale = graph.edges.find(
			(e) =>
				e.from === "intake-phase:human-spec-review" &&
				e.to === "intake-phase:dispatch-tier-classifier" &&
				e.trigger === "approved",
		);
		expect(stale).toBeUndefined();
	});

	test("E-4: human-spec-review → spec-rejected on rejected is unchanged", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const edge = graph.edges.find(
			(e) => e.from === "intake-phase:human-spec-review" && e.trigger === "rejected",
		);
		expect(edge?.to).toBe("intake-phase:spec-rejected");
	});

	test("E-5: spec-rejected → dispatch-clarifier on retry is unchanged", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const edge = graph.edges.find(
			(e) => e.from === "intake-phase:spec-rejected" && e.trigger === "retry",
		);
		expect(edge?.to).toBe("intake-phase:dispatch-clarifier");
	});

	test("E-6: spec-rejected → human-spec-review on escalate is unchanged", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const edge = graph.edges.find(
			(e) => e.from === "intake-phase:spec-rejected" && e.trigger === "escalate",
		);
		expect(edge?.to).toBe("intake-phase:human-spec-review");
	});

	test("E-7: create-tracker-issue → dispatch-tier-classifier has 4 forward edges (one per trigger)", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const expectedTriggers = [
			"issue_created",
			"issue_already_set",
			"spec_missing",
			"issue_create_failed",
		];
		for (const trigger of expectedTriggers) {
			const edge = graph.edges.find(
				(e) => e.from === "intake-phase:create-tracker-issue" && e.trigger === trigger,
			);
			expect(edge?.to).toBe("intake-phase:dispatch-tier-classifier");
		}
		const fromCreate = graph.edges.filter((e) => e.from === "intake-phase:create-tracker-issue");
		expect(fromCreate).toHaveLength(4);
	});

	test("E-8: graph contains the intake-phase:create-tracker-issue node", () => {
		const graph = intakePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const nodeIds = graph.nodes.map((n) => n.id);
		expect(nodeIds).toContain("intake-phase:create-tracker-issue");
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
	test("emits context_ready when projectRoot/overstoryDir missing (degenerate input)", async () => {
		const handlers = intakePhaseCell.buildHandlers(makeDeps());
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers["ensure-context-generate"]!(makeCtx({}));
		expect(result.trigger).toBe("context_ready");
	});

	test("#236: emits context_ready immediately when cache file is fresh (<1h old)", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "intake-fresh-"));
		const overstoryDir = join(tmp, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
		const cachePath = join(overstoryDir, "project-context.json");
		await writeFile(cachePath, "{}");
		try {
			let spawned = false;
			const deps = makeDeps({
				projectRoot: tmp,
				overstoryDir,
				spawn: ((_cmd: unknown, _opts: unknown) => {
					spawned = true;
					return { unref: () => {}, exited: Promise.resolve(0) };
				}) as unknown as typeof Bun.spawn,
			});
			const handlers = intakePhaseCell.buildHandlers(deps);
			// biome-ignore lint/style/noNonNullAssertion: registry known
			const result = await handlers["ensure-context-generate"]!(makeCtx({}));
			expect(result.trigger).toBe("context_ready");
			expect(spawned).toBe(false);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});

	test("#236: emits context_generating and spawns background regen when cache is stale", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "intake-stale-"));
		const overstoryDir = join(tmp, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
		const cachePath = join(overstoryDir, "project-context.json");
		await writeFile(cachePath, "{}");
		// Backdate the cache to 2h ago so it falls outside the 1h fresh window.
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
		await utimes(cachePath, twoHoursAgo, twoHoursAgo);
		try {
			const spawnCalls: Array<{ cmd: unknown; opts: unknown }> = [];
			const deps = makeDeps({
				projectRoot: tmp,
				overstoryDir,
				spawn: ((cmd: unknown, opts: unknown) => {
					spawnCalls.push({ cmd, opts });
					return { unref: () => {}, exited: Promise.resolve(0) };
				}) as unknown as typeof Bun.spawn,
			});
			const handlers = intakePhaseCell.buildHandlers(deps);
			// biome-ignore lint/style/noNonNullAssertion: registry known
			const result = await handlers["ensure-context-generate"]!(makeCtx({}));
			expect(result.trigger).toBe("context_generating");
			expect(spawnCalls).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			const cmd = spawnCalls[0]!.cmd as string[];
			expect(cmd[0]).toBe("ha");
			expect(cmd[1]).toBe("--project");
			expect(cmd[2]).toBe(tmp);
			expect(cmd[3]).toBe("context");
			expect(cmd[4]).toBe("generate");
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			const opts = spawnCalls[0]!.opts as { detached?: boolean };
			expect(opts.detached).toBe(true);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});

	test("#236: emits context_generating when no cache file exists", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "intake-missing-"));
		const overstoryDir = join(tmp, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
		try {
			const deps = makeDeps({
				projectRoot: tmp,
				overstoryDir,
				spawn: ((_cmd: unknown, _opts: unknown) => ({
					unref: () => {},
					exited: Promise.resolve(0),
				})) as unknown as typeof Bun.spawn,
			});
			const handlers = intakePhaseCell.buildHandlers(deps);
			// biome-ignore lint/style/noNonNullAssertion: registry known
			const result = await handlers["ensure-context-generate"]!(makeCtx({}));
			expect(result.trigger).toBe("context_generating");
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});

	test("#236: emits context_ready when spawn fails synchronously (best-effort fallback)", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "intake-spawnfail-"));
		const overstoryDir = join(tmp, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
		try {
			const deps = makeDeps({
				projectRoot: tmp,
				overstoryDir,
				spawn: ((_cmd: unknown, _opts: unknown) => {
					throw new Error("ENOENT: ha not found");
				}) as unknown as typeof Bun.spawn,
			});
			const handlers = intakePhaseCell.buildHandlers(deps);
			// biome-ignore lint/style/noNonNullAssertion: registry known
			const result = await handlers["ensure-context-generate"]!(makeCtx({}));
			// Better stale context than a stalled mission — fall back to ready.
			expect(result.trigger).toBe("context_ready");
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});

	test("#236: handler returns within <500ms even when cache is stale (no inline analyzeProject)", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "intake-timing-"));
		const overstoryDir = join(tmp, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
		// Build a non-trivial project so the OLD inline analyzeProject path
		// would have taken multiple seconds to walk the tree.
		for (let i = 0; i < 30; i++) {
			await mkdir(join(tmp, `src/module${i}`), { recursive: true });
			for (let j = 0; j < 10; j++) {
				await writeFile(
					join(tmp, `src/module${i}/file${j}.ts`),
					`export const x${j} = ${j};\nimport { foo } from "node:path";\n`,
				);
			}
		}
		await writeFile(join(tmp, "package.json"), JSON.stringify({ name: "t", version: "1.0.0" }));
		await writeFile(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
		try {
			// Simulate a slow analyzeProject by making `spawn` itself wait — the
			// handler must NOT await the spawned process; it must return as soon
			// as the (detached) spawn call returns.
			const deps = makeDeps({
				projectRoot: tmp,
				overstoryDir,
				spawn: ((_cmd: unknown, _opts: unknown) => ({
					unref: () => {},
					// `exited` resolves after a long delay — handler must NOT await it.
					exited: new Promise<number>((resolve) => setTimeout(() => resolve(0), 30_000)),
				})) as unknown as typeof Bun.spawn,
			});
			const handlers = intakePhaseCell.buildHandlers(deps);
			const start = Date.now();
			// biome-ignore lint/style/noNonNullAssertion: registry known
			const result = await handlers["ensure-context-generate"]!(makeCtx({}));
			const elapsed = Date.now() - start;
			expect(result.trigger).toBe("context_generating");
			expect(elapsed).toBeLessThan(500);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});
});

describe("intake-phase dispatch-clarifier handler", () => {
	const fakeMission = {
		id: "m1",
		slug: "test-slug",
	} as unknown as ReturnType<typeof makeMission>;

	test("failure routes to dispatch_failed and persists dispatchFailureReason", async () => {
		const saved: unknown[] = [];
		const deps = makeDeps({
			spawn: ((_cmd: unknown, _opts: unknown) => {
				throw new Error("ENOENT: ha not found");
			}) as unknown as typeof Bun.spawn,
		});
		const handlers = intakePhaseCell.buildHandlers(deps);
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers["dispatch-clarifier"]!(
			makeCtx({
				mission: fakeMission,
				onSaveCheckpoint: (data) => saved.push(data),
			}),
		);
		// bug_demo: under HEAD~1, returns clarifier_dispatched regardless of spawn failure
		expect(result.trigger).toBe("dispatch_failed");
		expect(saved).toHaveLength(1);
		const cp = saved[0] as { dispatchFailureReason?: string };
		expect(typeof cp.dispatchFailureReason).toBe("string");
		expect((cp.dispatchFailureReason ?? "").length).toBeGreaterThan(0);
	});

	test("success routes to clarifier_dispatched", async () => {
		const deps = makeDeps({
			spawn: ((_cmd: unknown, _opts: unknown) => ({
				unref: () => {},
				exited: Promise.resolve(0),
			})) as unknown as typeof Bun.spawn,
		});
		const handlers = intakePhaseCell.buildHandlers(deps);
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers["dispatch-clarifier"]!(makeCtx({ mission: fakeMission }));
		expect(result.trigger).toBe("clarifier_dispatched");
	});
});

describe("intake-phase dispatch-tier-classifier handler", () => {
	const fakeMission = {
		id: "m1",
		slug: "test-slug",
	} as unknown as ReturnType<typeof makeMission>;

	test("failure routes to dispatch_failed", async () => {
		const saved: unknown[] = [];
		const deps = makeDeps({
			spawn: ((_cmd: unknown, _opts: unknown) => {
				throw new Error("spawn error");
			}) as unknown as typeof Bun.spawn,
		});
		const handlers = intakePhaseCell.buildHandlers(deps);
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers["dispatch-tier-classifier"]!(
			makeCtx({
				mission: fakeMission,
				onSaveCheckpoint: (data) => saved.push(data),
			}),
		);
		// bug_demo: under HEAD~1, returns classifier_dispatched regardless of spawn failure
		expect(result.trigger).toBe("dispatch_failed");
		expect(saved).toHaveLength(1);
		const cp = saved[0] as { dispatchFailureReason?: string };
		expect(typeof cp.dispatchFailureReason).toBe("string");
	});
});

describe("intake-phase dispatch-analyst-intake handler", () => {
	const fakeMission = {
		id: "m1",
		slug: "test-slug",
	} as unknown as ReturnType<typeof makeMission>;

	test("failure routes to dispatch_failed and persists reason", async () => {
		const saved: unknown[] = [];
		const deps = makeDeps({
			overstoryDir: "/tmp/ov",
			projectRoot: "/tmp/project",
			ensureMissionAnalyst: async () => {
				throw new Error("analyst spawn failed");
			},
		});
		const handlers = intakePhaseCell.buildHandlers(deps);
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers["dispatch-analyst-intake"]!(
			makeCtx({
				mission: fakeMission,
				onSaveCheckpoint: (data) => saved.push(data),
			}),
		);
		expect(result.trigger).toBe("dispatch_failed");
		expect(saved).toHaveLength(1);
		const cp = saved[0] as { dispatchFailureReason?: string };
		expect(typeof cp.dispatchFailureReason).toBe("string");
		expect((cp.dispatchFailureReason ?? "").length).toBeGreaterThan(0);
	});

	test("success routes to analyst_dispatched", async () => {
		const deps = makeDeps({
			overstoryDir: "/tmp/ov",
			projectRoot: "/tmp/project",
			ensureMissionAnalyst: async () => {},
		});
		const handlers = intakePhaseCell.buildHandlers(deps);
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers["dispatch-analyst-intake"]!(makeCtx({ mission: fakeMission }));
		expect(result.trigger).toBe("analyst_dispatched");
	});
});

describe("intake-phase escalate handler", () => {
	const fakeMission = {
		id: "m1",
		slug: "test-slug",
	} as unknown as ReturnType<typeof makeMission>;

	test("sends mission_finding mail and returns escalated", async () => {
		const mails: Array<{ to: string; subject: string; body: string; type: string }> = [];
		const handlers = intakePhaseCell.buildHandlers(makeDeps());
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers.escalate!(
			makeCtx({
				mission: fakeMission,
				checkpoint: { dispatchFailureReason: "spawn blew up" },
				sendMail: async (to, subject, body, type) => {
					mails.push({ to, subject, body, type });
				},
			}),
		);
		expect(result.trigger).toBe("escalated");
		expect(mails).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: length checked above
		const mail = mails[0]!;
		expect(mail.to).toBe("operator");
		expect(mail.type).toBe("mission_finding");
		expect(mail.body).toContain("spawn blew up");
	});
});

// === haru-751d: create-tracker-issue handler tests ===

interface CreateCall {
	title: string;
	options?: { type?: string; priority?: number; description?: string };
}

function makeMissionForHandler(overrides: Partial<Mission> & { id: string }): Mission {
	const base: Mission = {
		id: overrides.id,
		slug: "test-slug",
		objective: "test objective",
		runId: null,
		state: "active",
		phase: "understand",
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
		currentNode: null,
		startedAt: null,
		completedAt: null,
		createdAt: "",
		updatedAt: "",
		learningsExtracted: false,
		hasEmittedWsProducerWrite: false,
		tier: null,
		autonomy: "supervised",
		parentMissionId: null,
		taskId: null,
	};
	return { ...base, ...overrides };
}

describe("intake-phase create-tracker-issue handler", () => {
	test("T-1: happy path → tracker.create called, setTaskId called, trigger issue_created", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "create-tracker-happy-"));
		try {
			const specBody = "# canonical-slug\n\n## Intent\n\nDo the thing\n\n## Goal\n\nGoal text\n";
			await writeFile(join(tmp, "product-spec.md"), specBody);

			const createCalls: CreateCall[] = [];
			const tracker: TrackerClient = {
				...makeStubTracker(),
				create: async (title, options) => {
					createCalls.push({ title, options });
					return "haru-1234";
				},
			};
			const setTaskIdCalls: Array<[string, string | null]> = [];
			const missionStore = {
				setTaskId: (missionId: string, taskId: string | null) => {
					setTaskIdCalls.push([missionId, taskId]);
				},
			} as unknown as PhaseCellDeps["missionStore"];

			const mission = makeMissionForHandler({
				id: "m-happy",
				artifactRoot: tmp,
				taskId: null,
				objective: "make a thing",
			});
			const handlers = intakePhaseCell.buildHandlers(makeDeps({ tracker, missionStore }));
			// biome-ignore lint/style/noNonNullAssertion: registry known after impl lands
			const result = await handlers["create-tracker-issue"]!(makeCtx({ mission }));

			expect(result.trigger).toBe("issue_created");
			expect(createCalls).toHaveLength(1);
			expect(setTaskIdCalls).toEqual([["m-happy", "haru-1234"]]);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});

	test("T-2: idempotency — real taskId already set → issue_already_set, tracker NOT called", async () => {
		let createCalled = false;
		const tracker: TrackerClient = {
			...makeStubTracker(),
			create: async () => {
				createCalled = true;
				return "should-not-happen";
			},
		};
		const mission = makeMissionForHandler({
			id: "m-idem",
			taskId: "haru-1234",
			artifactRoot: "/tmp/never-read",
		});
		const handlers = intakePhaseCell.buildHandlers(makeDeps({ tracker }));
		// biome-ignore lint/style/noNonNullAssertion: registry known after impl lands
		const result = await handlers["create-tracker-issue"]!(makeCtx({ mission }));

		expect(result.trigger).toBe("issue_already_set");
		expect(createCalled).toBe(false);
	});

	test("T-3: PENDING_SENTINEL is treated as not-yet-set (handler proceeds past idempotency)", async () => {
		// With artifactRoot=null, the handler proceeds past idempotency and falls
		// through to spec_missing. That confirms PENDING_SENTINEL does NOT trigger
		// the issue_already_set short-circuit.
		let createCalled = false;
		const tracker: TrackerClient = {
			...makeStubTracker(),
			create: async () => {
				createCalled = true;
				return "haru-zzz";
			},
		};
		const mission = makeMissionForHandler({
			id: "m-pending",
			taskId: PENDING_SENTINEL,
			artifactRoot: null,
		});
		const handlers = intakePhaseCell.buildHandlers(makeDeps({ tracker }));
		// biome-ignore lint/style/noNonNullAssertion: registry known after impl lands
		const result = await handlers["create-tracker-issue"]!(makeCtx({ mission }));

		expect(result.trigger).not.toBe("issue_already_set");
		expect(result.trigger).toBe("spec_missing");
		expect(createCalled).toBe(false);
	});

	test("T-4: artifactRoot null → trigger spec_missing, no tracker call", async () => {
		let createCalled = false;
		const tracker: TrackerClient = {
			...makeStubTracker(),
			create: async () => {
				createCalled = true;
				return "haru-zzz";
			},
		};
		const mission = makeMissionForHandler({
			id: "m-no-root",
			artifactRoot: null,
		});
		const handlers = intakePhaseCell.buildHandlers(makeDeps({ tracker }));
		// biome-ignore lint/style/noNonNullAssertion: registry known after impl lands
		const result = await handlers["create-tracker-issue"]!(makeCtx({ mission }));

		expect(result.trigger).toBe("spec_missing");
		expect(createCalled).toBe(false);
	});

	test("T-5: spec file missing → trigger spec_missing, no tracker call", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "create-tracker-no-spec-"));
		try {
			let createCalled = false;
			const tracker: TrackerClient = {
				...makeStubTracker(),
				create: async () => {
					createCalled = true;
					return "haru-zzz";
				},
			};
			const mission = makeMissionForHandler({
				id: "m-no-spec",
				artifactRoot: tmp,
			});
			const handlers = intakePhaseCell.buildHandlers(makeDeps({ tracker }));
			// biome-ignore lint/style/noNonNullAssertion: registry known after impl lands
			const result = await handlers["create-tracker-issue"]!(makeCtx({ mission }));

			expect(result.trigger).toBe("spec_missing");
			expect(createCalled).toBe(false);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});

	test("T-6: tracker rejection → issue_create_failed, setTaskId NOT called", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "create-tracker-reject-"));
		try {
			await writeFile(join(tmp, "product-spec.md"), "# slug\n\n## Intent\n\nbody\n");
			const tracker: TrackerClient = {
				...makeStubTracker(),
				create: async () => {
					throw new Error("tracker offline");
				},
			};
			let setTaskIdCalled = false;
			const missionStore = {
				setTaskId: () => {
					setTaskIdCalled = true;
				},
			} as unknown as PhaseCellDeps["missionStore"];
			const mission = makeMissionForHandler({
				id: "m-reject",
				artifactRoot: tmp,
			});
			const handlers = intakePhaseCell.buildHandlers(makeDeps({ tracker, missionStore }));
			// biome-ignore lint/style/noNonNullAssertion: registry known after impl lands
			const result = await handlers["create-tracker-issue"]!(makeCtx({ mission }));

			expect(result.trigger).toBe("issue_create_failed");
			expect(setTaskIdCalled).toBe(false);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});

	test("T-7: invalid tracker return (empty string) → issue_create_failed, setTaskId NOT called", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "create-tracker-empty-"));
		try {
			await writeFile(join(tmp, "product-spec.md"), "# slug\n\n## Intent\n\nbody\n");
			const tracker: TrackerClient = {
				...makeStubTracker(),
				create: async () => "",
			};
			let setTaskIdCalled = false;
			const missionStore = {
				setTaskId: () => {
					setTaskIdCalled = true;
				},
			} as unknown as PhaseCellDeps["missionStore"];
			const mission = makeMissionForHandler({
				id: "m-empty",
				artifactRoot: tmp,
			});
			const handlers = intakePhaseCell.buildHandlers(makeDeps({ tracker, missionStore }));
			// biome-ignore lint/style/noNonNullAssertion: registry known after impl lands
			const result = await handlers["create-tracker-issue"]!(makeCtx({ mission }));

			expect(result.trigger).toBe("issue_create_failed");
			expect(setTaskIdCalled).toBe(false);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});

	test("T-8: split failure (orphan) — tracker succeeds but setTaskId throws → issue_create_failed", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "create-tracker-split-"));
		try {
			await writeFile(join(tmp, "product-spec.md"), "# slug\n\n## Intent\n\nbody\n");
			const tracker: TrackerClient = {
				...makeStubTracker(),
				create: async () => "haru-1234",
			};
			let setTaskIdCalled = false;
			const missionStore = {
				setTaskId: () => {
					setTaskIdCalled = true;
					throw new Error("db is locked");
				},
			} as unknown as PhaseCellDeps["missionStore"];
			const mission = makeMissionForHandler({
				id: "m-split",
				artifactRoot: tmp,
			});
			const handlers = intakePhaseCell.buildHandlers(makeDeps({ tracker, missionStore }));
			// biome-ignore lint/style/noNonNullAssertion: registry known after impl lands
			const result = await handlers["create-tracker-issue"]!(makeCtx({ mission }));

			expect(result.trigger).toBe("issue_create_failed");
			expect(setTaskIdCalled).toBe(true);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});

	test("T-9: description cap — 100 KiB spec body truncated to 32 KiB + footer", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "create-tracker-cap-"));
		try {
			const oversized = `# slug\n\n## Intent\n\nx\n\n${"y".repeat(100 * 1024)}`;
			await writeFile(join(tmp, "product-spec.md"), oversized);

			const createCalls: CreateCall[] = [];
			const tracker: TrackerClient = {
				...makeStubTracker(),
				create: async (title, options) => {
					createCalls.push({ title, options });
					return "haru-cap";
				},
			};
			const missionStore = {
				setTaskId: () => {},
			} as unknown as PhaseCellDeps["missionStore"];
			const mission = makeMissionForHandler({
				id: "m-cap",
				artifactRoot: tmp,
			});
			const handlers = intakePhaseCell.buildHandlers(makeDeps({ tracker, missionStore }));
			// biome-ignore lint/style/noNonNullAssertion: registry known after impl lands
			const result = await handlers["create-tracker-issue"]!(makeCtx({ mission }));

			expect(result.trigger).toBe("issue_created");
			expect(createCalls).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: length checked above
			const desc = createCalls[0]!.options?.description ?? "";

			// Builder may emit the truncation footer with either the literal
			// `<artifactRoot>` placeholder (matching brief code verbatim) OR the
			// substituted mission.artifactRoot path. Accept either.
			const literalFooter = `\n\n[truncated at 32 KiB — see <artifactRoot>/product-spec.md for full content]`;
			const substitutedFooter = `\n\n[truncated at 32 KiB — see ${tmp}/product-spec.md for full content]`;
			const expectedLens = [32 * 1024 + literalFooter.length, 32 * 1024 + substitutedFooter.length];
			expect(expectedLens).toContain(desc.length);
			expect(desc.startsWith(oversized.slice(0, 32 * 1024))).toBe(true);
			expect(desc).toContain("[truncated at 32 KiB");
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});

	test("T-10: null mission → issue_create_failed, no tracker call", async () => {
		let createCalled = false;
		const tracker: TrackerClient = {
			...makeStubTracker(),
			create: async () => {
				createCalled = true;
				return "haru-zzz";
			},
		};
		const handlers = intakePhaseCell.buildHandlers(makeDeps({ tracker }));
		// biome-ignore lint/style/noNonNullAssertion: registry known after impl lands
		const result = await handlers["create-tracker-issue"]!(makeCtx({ mission: null }));

		expect(result.trigger).toBe("issue_create_failed");
		expect(createCalled).toBe(false);
	});
});
