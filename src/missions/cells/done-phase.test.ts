import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "../../sessions/store.ts";
import { cleanupTempDir, createTempGitRepo, getDefaultBranch } from "../../test-helpers.ts";
import type { TrackerClient } from "../../tracker/types.ts";
import type { AgentSession, Mission, MissionState } from "../../types.ts";
import { createWorktree } from "../../worktree/manager.ts";
import { createGraphEngine } from "../engine.ts";
import { validateGraph } from "../graph.ts";
import { PENDING_SENTINEL } from "../task-id.ts";
import { createMockCheckpointStore } from "../test-mocks.ts";
import type { HandlerContext } from "../types.ts";
import { donePhaseCell } from "./done-phase.ts";
import type { PhaseCellConfig, PhaseCellDeps } from "./types.ts";

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

	test("summary node is a handler not a gate", () => {
		const node = graph.nodes.find((n) => n.id === "done-phase:summary");
		expect(node).toBeDefined();
		expect(node?.handler).toBe("summary");
		expect(node?.gate).toBeUndefined();
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
			tracker: makeStubTracker(),
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

describe("donePhaseCell dispatch-debugger worktree probe", () => {
	let tempDir: string;
	let agentBaseDir: string;
	let origSpawn: typeof Bun.spawn;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "haru-done-wt-probe-"));
		agentBaseDir = join(tempDir, "agent-defs");
		await mkdir(agentBaseDir, { recursive: true });
		origSpawn = Bun.spawn;

		// Write debugger manifest so preflight passes.
		await Bun.write(
			join(tempDir, "agent-manifest.json"),
			JSON.stringify({
				version: "1.0",
				agents: {
					debugger: {
						file: "debugger.md",
						model: "sonnet",
						tools: ["Read", "Edit"],
						capabilities: ["debugger"],
						canSpawn: false,
						constraints: [],
					},
				},
			}),
		);
		await Bun.write(join(agentBaseDir, "debugger.md"), "# debugger\n");
	});

	afterEach(async () => {
		// biome-ignore lint/suspicious/noExplicitAny: restoring Bun.spawn after test
		(Bun as any).spawn = origSpawn;
		await cleanupTempDir(tempDir);
	});

	test("existing worktree → skip git worktree add", async () => {
		const spawnArgs: string[][] = [];
		// Compute expected worktreePath (slug=test-mission, attempt=1)
		const expectedWorktreePath = join(tempDir, "worktrees", "debug", "test-mission-attempt-1");

		// biome-ignore lint/suspicious/noExplicitAny: Bun.spawn overloads require any cast for test stubs
		(Bun as any).spawn = (cmd: string[], opts?: unknown): ReturnType<typeof Bun.spawn> => {
			spawnArgs.push([...cmd]);
			const encoder = new TextEncoder();

			if (cmd[0] === "git" && cmd[1] === "worktree" && cmd[2] === "list") {
				// Return output with the expected worktreePath so probe detects it.
				const output = `worktree ${expectedWorktreePath}\nHEAD abc123\nbranch refs/heads/feature/x\n`;
				return {
					stdout: new ReadableStream({
						start(controller) {
							controller.enqueue(encoder.encode(output));
							controller.close();
						},
					}),
					stderr: new ReadableStream({
						start(c) {
							c.close();
						},
					}),
					exited: Promise.resolve(0),
					unref: () => {},
				} as unknown as ReturnType<typeof Bun.spawn>;
			}

			if (cmd[0] === "git" && cmd[1] === "rev-parse") {
				return {
					stdout: new ReadableStream({
						start(controller) {
							controller.enqueue(encoder.encode("abc123sha\n"));
							controller.close();
						},
					}),
					stderr: new ReadableStream({
						start(c) {
							c.close();
						},
					}),
					exited: Promise.resolve(0),
					unref: () => {},
				} as unknown as ReturnType<typeof Bun.spawn>;
			}

			if (cmd[0] === "ha" && cmd[1] === "sling") {
				return {
					stdout: new ReadableStream({
						start(c) {
							c.close();
						},
					}),
					stderr: new ReadableStream({
						start(c) {
							c.close();
						},
					}),
					exited: new Promise<number>(() => {}),
					unref: () => {},
				} as unknown as ReturnType<typeof Bun.spawn>;
			}

			// Any other spawn (unexpected)
			return origSpawn(cmd as [string, ...string[]], opts as Parameters<typeof Bun.spawn>[1]);
		};

		const checkpointData: Record<string, unknown> = {};
		const deps: PhaseCellDeps = {
			mailSend: async () => {},
			checkpointStore: {} as PhaseCellDeps["checkpointStore"],
			missionStore: {
				checkpoints: {
					saveCheckpoint: (_missionId: string, nodeId: string, data: unknown) => {
						checkpointData[nodeId] = data;
					},
					getCheckpoint: () => null,
				},
			} as unknown as PhaseCellDeps["missionStore"],
			tracker: makeStubTracker(),
			overstoryDir: tempDir,
			projectRoot: "/tmp/worktree-probe-test",
		};

		const ctx: HandlerContext = {
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

		const handlers = donePhaseCell.buildHandlers(deps);
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers["dispatch-debugger"]!(ctx);

		// Probe found existing worktree — skips add, proceeds to sling spawn.
		// bug_demo: under HEAD~1, probe absent → worktree add always called → fails → dispatch_failed.
		expect(result.trigger).not.toBe("dispatch_failed");

		// Verify git worktree add was NOT called.
		const addCalls = spawnArgs.filter(
			(args) => args[0] === "git" && args[1] === "worktree" && args[2] === "add",
		);
		expect(addCalls).toHaveLength(0);
	});
});

describe("donePhaseCell escalate placeholder-checkpoint", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "haru-done-escalate-"));
		await mkdir(join(tempDir, "debug"), { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	function makeCheckpointStore(initialData?: Record<string, unknown>) {
		const store: Record<string, unknown> = { ...initialData };
		const saved: Array<{ missionId: string; nodeId: string; data: unknown }> = [];
		return {
			saved,
			checkpoints: {
				saveCheckpoint: (missionId: string, nodeId: string, data: unknown) => {
					store[nodeId] = data;
					saved.push({ missionId, nodeId, data });
				},
				getCheckpoint: (_missionId: string, nodeId: string) => {
					const data = store[nodeId];
					return data !== undefined ? { data } : null;
				},
			},
		};
	}

	function makeMailStore(returnId = "msg-fake") {
		let sendCount = 0;
		return {
			sendCount: { get: () => sendCount },
			store: {
				insert: (msg: unknown): { id: string } & Record<string, unknown> => {
					sendCount++;
					// Spread msg first, then override id so we return the fake id (not the empty string from input).
					return { ...(msg as object), id: returnId };
				},
			},
		};
	}

	function makeEscalateCtx(
		opts: {
			sendMail?: (to: string, subject: string, body: string, type: string) => Promise<void>;
		} = {},
	): HandlerContext {
		return {
			missionId: "m1",
			nodeId: "done-phase:escalate",
			checkpoint: null,
			saveCheckpoint: async () => {},
			sendMail: opts.sendMail ?? (async () => {}),
			getMission: () =>
				({
					id: "m1",
					slug: "test-mission",
					featureBranch: "feature/x",
					artifactRoot: tempDir,
				}) as unknown as Mission,
		} as HandlerContext;
	}

	test("fresh path: saves escalationPending, sends mail, saves escalationThreadId", async () => {
		const { checkpoints, saved } = makeCheckpointStore();
		const { store: mailStore, sendCount } = makeMailStore("msg-fake");

		const deps: PhaseCellDeps = {
			mailSend: async () => {},
			checkpointStore: {} as PhaseCellDeps["checkpointStore"],
			missionStore: {
				checkpoints,
				freeze: () => {},
				updatePauseReason: () => {},
			} as unknown as PhaseCellDeps["missionStore"],
			tracker: makeStubTracker(),
			mailStore: mailStore as unknown as PhaseCellDeps["mailStore"],
		};

		const handlers = donePhaseCell.buildHandlers(deps);
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers.escalate!(makeEscalateCtx());

		expect(result.trigger).toBe("escalated");
		expect(sendCount.get()).toBe(1);

		const escalateSaved = saved.filter((s) => s.nodeId === "done-phase:escalate");
		expect(escalateSaved).toHaveLength(2);
		const first = escalateSaved[0]?.data as { escalationPending?: boolean };
		const second = escalateSaved[1]?.data as {
			escalationPending?: boolean;
			escalationThreadId?: string;
		};
		expect(first?.escalationPending).toBe(true);
		expect(second?.escalationPending).toBe(false);
		expect(second?.escalationThreadId).toBe("msg-fake");
	});

	test("replay with prior threadId: no mail sent, freeze uses prior threadId", async () => {
		const { checkpoints } = makeCheckpointStore({
			"done-phase:escalate": { escalationThreadId: "msg-prev" },
		});
		const { store: mailStore, sendCount } = makeMailStore();

		const freezeCalls: { threadId: string | null }[] = [];
		const deps: PhaseCellDeps = {
			mailSend: async () => {},
			checkpointStore: {} as PhaseCellDeps["checkpointStore"],
			missionStore: {
				checkpoints,
				freeze: (_id: unknown, _kind: unknown, threadId: string | null) => {
					freezeCalls.push({ threadId });
				},
				updatePauseReason: () => {},
			} as unknown as PhaseCellDeps["missionStore"],
			tracker: makeStubTracker(),
			mailStore: mailStore as unknown as PhaseCellDeps["mailStore"],
		};

		const handlers = donePhaseCell.buildHandlers(deps);
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers.escalate!(makeEscalateCtx());

		expect(result.trigger).toBe("escalated");
		// mailClient.send must NOT be called on replay
		expect(sendCount.get()).toBe(0);
		expect(freezeCalls).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: length checked above
		expect(freezeCalls[0]!.threadId).toBe("msg-prev");
	});

	test("crash-recovery (escalationPending=true, no threadId): returns pending_replay_aborted", async () => {
		const { checkpoints } = makeCheckpointStore({
			"done-phase:escalate": { escalationPending: true },
		});
		const { store: mailStore, sendCount } = makeMailStore();
		const sentMails: Array<{ to: string; subject: string; type: string }> = [];

		const deps: PhaseCellDeps = {
			mailSend: async () => {},
			checkpointStore: {} as PhaseCellDeps["checkpointStore"],
			missionStore: {
				checkpoints,
				freeze: () => {},
				updatePauseReason: () => {},
			} as unknown as PhaseCellDeps["missionStore"],
			tracker: makeStubTracker(),
			mailStore: mailStore as unknown as PhaseCellDeps["mailStore"],
		};

		const handlers = donePhaseCell.buildHandlers(deps);
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers.escalate!(
			makeEscalateCtx({
				sendMail: async (to, subject, _body, type) => {
					sentMails.push({ to, subject, type });
				},
			}),
		);

		expect(result.trigger).toBe("pending_replay_aborted");
		// Main escalation mail must NOT be sent
		expect(sendCount.get()).toBe(0);
		// Interrupt notification mail must be sent to operator
		expect(sentMails).toHaveLength(1);
		expect(sentMails[0]?.to).toBe("operator");
		expect(sentMails[0]?.subject).toContain("Escalation interrupted");
		expect(sentMails[0]?.type).toBe("mission_finding");
	});

	test("done-phase escalate has pending_replay_aborted edge to debug-paused", () => {
		const graph = donePhaseCell.buildSubgraph(config);
		const edge = graph.edges.find(
			(e) => e.from === "done-phase:escalate" && e.trigger === "pending_replay_aborted",
		);
		expect(edge).toBeDefined();
		expect(edge?.to).toBe("done-phase:debug-paused");
	});
});

describe("donePhaseCell summary handler", () => {
	let tempDir: string;
	let artifactRoot: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "haru-done-summary-"));
		artifactRoot = join(tempDir, "artifacts");
		await mkdir(join(artifactRoot, "results"), { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	function makeFakeMission(overrides: Partial<Mission> = {}): Mission {
		return {
			id: "m1",
			slug: "test",
			objective: "test obj",
			runId: null,
			state: "active",
			phase: "done",
			firstFreezeAt: null,
			pendingUserInput: false,
			pendingInputKind: null,
			pendingInputThreadId: null,
			reopenCount: 0,
			artifactRoot,
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
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			learningsExtracted: false,
			tier: "planned",
			hasEmittedWsProducerWrite: false,
			autonomy: "supervised",
			featureBranch: null,
			frozenAt: null,
			...overrides,
		} as unknown as Mission;
	}

	function makeDeps(): PhaseCellDeps {
		const mission = makeFakeMission();
		return {
			mailSend: async () => {},
			checkpointStore: {} as PhaseCellDeps["checkpointStore"],
			missionStore: {
				getById: (_id: string) => mission,
				checkpoints: {
					saveCheckpoint: () => {},
					getCheckpoint: () => null,
				},
			} as unknown as PhaseCellDeps["missionStore"],
			tracker: makeStubTracker(),
		};
	}

	test("summary node is a handler not a gate (graph-level)", () => {
		const graph = donePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot,
			projectRoot: "/tmp/p",
		});
		const node = graph.nodes.find((n) => n.id === "done-phase:summary");
		expect(node).toBeDefined();
		expect(node?.handler).toBe("summary");
		expect(node?.gate).toBeUndefined();
	});

	test("done-phase mission advances past summary node (engine-level)", async () => {
		// bug_demo (structural): under HEAD~1 the same setup leaves currentNode pinned
		// at done-phase:summary (status="gate") because the node was a gate, not a handler.
		const graph = donePhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot,
			projectRoot: "/tmp/p",
		});
		const mission = makeFakeMission();
		const fakeMissionStore = {
			getById: (_id: string) => mission,
			checkpoints: { saveCheckpoint: () => {}, getCheckpoint: () => null },
			updateCurrentNode: () => {},
			resetGateState: () => {},
			transaction: <T>(fn: () => T): T => fn(),
		} as unknown as import("../../types.ts").MissionStore;
		const deps: PhaseCellDeps = {
			mailSend: async () => {},
			checkpointStore: {} as PhaseCellDeps["checkpointStore"],
			missionStore: fakeMissionStore,
			tracker: makeStubTracker(),
		};
		const handlers = donePhaseCell.buildHandlers(deps);
		const checkpointStore = createMockCheckpointStore();

		const engine = createGraphEngine({
			graph,
			handlers,
			checkpointStore,
			missionId: "m1",
			startNodeId: "done-phase:summary",
			missionStore: fakeMissionStore,
		});

		const result = await engine.step();

		expect(result.status).toBe("advanced");
		expect(result.toNodeId).toBe("done-phase:holdout");
		expect(result.trigger).toBe("summary_ready");
		expect(await Bun.file(join(artifactRoot, "results", "summary.md")).exists()).toBe(true);

		const content = await Bun.file(join(artifactRoot, "results", "summary.md")).text();
		expect(content).toContain("m1");
		expect(content).toContain("# Mission Summary");
	});

	test("summary handler is idempotent", async () => {
		const deps = makeDeps();
		const handlers = donePhaseCell.buildHandlers(deps);
		const summaryHandler = handlers.summary;
		if (!summaryHandler) throw new Error("summary handler not registered");

		const ctx = {
			missionId: "m1",
			nodeId: "done-phase:summary",
			checkpoint: null,
			saveCheckpoint: async () => {},
			sendMail: async () => {},
			getMission: () => makeFakeMission(),
		} as HandlerContext;

		const r1 = await summaryHandler(ctx);
		expect(r1.trigger).toBe("summary_ready");
		const content1 = await Bun.file(join(artifactRoot, "results", "summary.md")).text();

		const r2 = await summaryHandler(ctx);
		expect(r2.trigger).toBe("summary_ready");
		const content2 = await Bun.file(join(artifactRoot, "results", "summary.md")).text();

		// Strip the non-deterministic Generated: line before comparing
		const strip = (s: string) => s.replace(/^- Generated:.*$/m, "");
		expect(strip(content1)).toBe(strip(content2));
	});
});

// === Issue #322: cleanup terminates mission-owned agents + worktrees ===

function makeMissionOwnedSession(overrides: Partial<AgentSession>): AgentSession {
	return {
		id: "sess",
		agentName: "agent",
		capability: "scout",
		runtime: "claude",
		worktreePath: "/tmp/wt",
		branchName: "haru/agent/task",
		taskId: "task",
		tmuxSession: "",
		state: "waiting",
		pid: null,
		parentAgent: null,
		depth: 0,
		runId: null,
		startedAt: "2026-01-01T00:00:00.000Z",
		lastActivity: "2026-01-01T00:00:00.000Z",
		escalationLevel: 0,
		stalledSince: null,
		rateLimitedSince: null,
		rateLimitResumesAt: null,
		runtimeSessionId: null,
		transcriptPath: null,
		originalRuntime: null,
		statusLine: null,
		...overrides,
	};
}

describe("donePhaseCell cleanup handler (issue #322)", () => {
	test("stops mission-owned intake agents and removes their worktrees", async () => {
		const projectRoot = await createTempGitRepo();
		const overstoryDir = join(projectRoot, ".overstory");
		const slug = "demo-mission";
		await mkdir(join(overstoryDir, "worktrees", slug), { recursive: true });

		const baseBranch = await getDefaultBranch(projectRoot);

		// Create real worktrees + branches for the three intake-phase agents that
		// the bug report observed leaking (product-clarifier, tier-classifier,
		// coordinator). Each one gets a row in the session store with no live
		// tmux/pid so the cleanup path falls straight to the state update.
		const wt1 = await createWorktree({
			repoRoot: projectRoot,
			baseDir: join(overstoryDir, "worktrees"),
			agentName: `product-clarifier-${slug}`,
			baseBranch,
			taskId: "t1",
			missionSlug: slug,
		});
		const wt2 = await createWorktree({
			repoRoot: projectRoot,
			baseDir: join(overstoryDir, "worktrees"),
			agentName: `tier-classifier-${slug}`,
			baseBranch,
			taskId: "t2",
			missionSlug: slug,
		});
		const wt3 = await createWorktree({
			repoRoot: projectRoot,
			baseDir: join(overstoryDir, "worktrees"),
			agentName: `coordinator-${slug}`,
			baseBranch,
			taskId: "t3",
			missionSlug: slug,
		});

		const sessionStore = createSessionStore(":memory:");
		try {
			sessionStore.upsert(
				makeMissionOwnedSession({
					id: "s-clar",
					agentName: `product-clarifier-${slug}`,
					capability: "product-clarifier",
					worktreePath: wt1.path,
					branchName: wt1.branch,
					taskId: "t1",
					runId: "run-322",
					state: "waiting",
				}),
			);
			sessionStore.upsert(
				makeMissionOwnedSession({
					id: "s-tier",
					agentName: `tier-classifier-${slug}`,
					capability: "tier-classifier",
					worktreePath: wt2.path,
					branchName: wt2.branch,
					taskId: "t2",
					runId: "run-322",
					state: "waiting",
				}),
			);
			sessionStore.upsert(
				makeMissionOwnedSession({
					id: "s-coord",
					agentName: `coordinator-${slug}`,
					capability: "coordinator-mission-planned",
					worktreePath: wt3.path,
					branchName: wt3.branch,
					taskId: "t3",
					runId: "run-322",
					state: "waiting",
				}),
			);

			// An unrelated agent from another mission must NOT be touched.
			sessionStore.upsert(
				makeMissionOwnedSession({
					id: "s-other",
					agentName: "builder-unrelated",
					capability: "builder",
					worktreePath: "/tmp/unrelated",
					branchName: "haru/other/x",
					taskId: "tx",
					runId: "run-other",
					state: "waiting",
				}),
			);

			const deps: PhaseCellDeps = {
				mailSend: async () => {},
				checkpointStore: {} as PhaseCellDeps["checkpointStore"],
				missionStore: {
					checkpoints: {
						saveCheckpoint: () => {},
						getCheckpoint: () => null,
					},
				} as unknown as PhaseCellDeps["missionStore"],
				tracker: makeStubTracker(),
				sessionStore,
				overstoryDir,
				projectRoot,
			};

			const ctx: HandlerContext = {
				missionId: "m1",
				nodeId: "done-phase:cleanup",
				checkpoint: null,
				saveCheckpoint: async () => {},
				sendMail: async () => {},
				getMission: () =>
					({
						id: "m1",
						slug,
						runId: "run-322",
						state: "active",
						phase: "done",
					}) as unknown as Mission,
			} as HandlerContext;

			const handlers = donePhaseCell.buildHandlers(deps);
			// biome-ignore lint/style/noNonNullAssertion: cleanup handler is registered
			const result = await handlers.cleanup!(ctx);

			expect(result.trigger).toBe("cleanup_done");

			// All three mission-owned sessions are now marked completed.
			expect(sessionStore.getByName(`product-clarifier-${slug}`)?.state).toBe("completed");
			expect(sessionStore.getByName(`tier-classifier-${slug}`)?.state).toBe("completed");
			expect(sessionStore.getByName(`coordinator-${slug}`)?.state).toBe("completed");

			// The unrelated agent is untouched.
			expect(sessionStore.getByName("builder-unrelated")?.state).toBe("waiting");

			// All three mission worktrees are removed from disk.
			expect(existsSync(wt1.path)).toBe(false);
			expect(existsSync(wt2.path)).toBe(false);
			expect(existsSync(wt3.path)).toBe(false);
		} finally {
			sessionStore.close();
			await cleanupTempDir(projectRoot);
		}
	});

	test("no-op when mission has no slug and no runId", async () => {
		const sessionStore = createSessionStore(":memory:");
		try {
			sessionStore.upsert(
				makeMissionOwnedSession({
					id: "s-x",
					agentName: "some-agent",
					worktreePath: "/tmp/some-agent",
					state: "waiting",
				}),
			);

			const deps: PhaseCellDeps = {
				mailSend: async () => {},
				checkpointStore: {} as PhaseCellDeps["checkpointStore"],
				missionStore: {
					checkpoints: { saveCheckpoint: () => {}, getCheckpoint: () => null },
				} as unknown as PhaseCellDeps["missionStore"],
				tracker: makeStubTracker(),
				sessionStore,
				overstoryDir: "/tmp/does-not-matter",
				projectRoot: "/tmp/does-not-matter",
			};

			const ctx: HandlerContext = {
				missionId: "m1",
				nodeId: "done-phase:cleanup",
				checkpoint: null,
				saveCheckpoint: async () => {},
				sendMail: async () => {},
				getMission: () =>
					({
						id: "m1",
						slug: null,
						runId: null,
						state: "active",
						phase: "done",
					}) as unknown as Mission,
			} as HandlerContext;

			const handlers = donePhaseCell.buildHandlers(deps);
			// biome-ignore lint/style/noNonNullAssertion: cleanup handler is registered
			const result = await handlers.cleanup!(ctx);
			expect(result.trigger).toBe("cleanup_done");

			// No slug + no runId → no candidates → untouched.
			expect(sessionStore.getByName("some-agent")?.state).toBe("waiting");
		} finally {
			sessionStore.close();
		}
	});
});

// === ws-done-close-issue: state-aware tracker.close in cleanup ===

describe("donePhaseCell cleanup tracker.close behavior", () => {
	type CloseCall = { id: string; reason: string | undefined };

	function makeRecordingTracker(opts: { rejectWith?: Error; log?: string[] } = {}): {
		tracker: TrackerClient;
		closeCalls: CloseCall[];
	} {
		const closeCalls: CloseCall[] = [];
		const tracker: TrackerClient = {
			...makeStubTracker(),
			close: async (id: string, reason?: string) => {
				opts.log?.push("tracker.close");
				closeCalls.push({ id, reason });
				if (opts.rejectWith) throw opts.rejectWith;
			},
		};
		return { tracker, closeCalls };
	}

	function makeCleanupDeps(tracker: TrackerClient): PhaseCellDeps {
		return {
			mailSend: async () => {},
			checkpointStore: {} as PhaseCellDeps["checkpointStore"],
			missionStore: {
				checkpoints: { saveCheckpoint: () => {}, getCheckpoint: () => null },
			} as unknown as PhaseCellDeps["missionStore"],
			tracker,
		};
	}

	function makeMission(opts: {
		taskId: string | null;
		state: MissionState;
		slug?: string;
	}): Mission {
		return {
			id: "m1",
			slug: opts.slug ?? "test-mission",
			taskId: opts.taskId,
			state: opts.state,
			phase: "done",
		} as unknown as Mission;
	}

	function makeCleanupCtx(mission: Mission | null): HandlerContext {
		return {
			missionId: "m1",
			nodeId: "done-phase:cleanup",
			checkpoint: null,
			saveCheckpoint: async () => {},
			sendMail: async () => {},
			getMission: () => mission,
		} as HandlerContext;
	}

	test("T-1: happy close (state=completed) calls tracker.close once with completed reason", async () => {
		const { tracker, closeCalls } = makeRecordingTracker();
		const deps = makeCleanupDeps(tracker);
		const ctx = makeCleanupCtx(makeMission({ taskId: "haru-1234", state: "completed" }));

		const handlers = donePhaseCell.buildHandlers(deps);
		// biome-ignore lint/style/noNonNullAssertion: cleanup handler is registered
		const result = await handlers.cleanup!(ctx);

		expect(result.trigger).toBe("cleanup_done");
		expect(closeCalls).toHaveLength(1);
		expect(closeCalls[0]?.id).toBe("haru-1234");
		expect(closeCalls[0]?.reason).toMatch(/Mission .* completed at .*/);
	});

	test("T-2: state=active uses neutral 'done-phase cleanup' phrasing (no false completed)", async () => {
		const { tracker, closeCalls } = makeRecordingTracker();
		const deps = makeCleanupDeps(tracker);
		const ctx = makeCleanupCtx(makeMission({ taskId: "haru-1234", state: "active" }));

		const handlers = donePhaseCell.buildHandlers(deps);
		// biome-ignore lint/style/noNonNullAssertion: cleanup handler is registered
		const result = await handlers.cleanup!(ctx);

		expect(result.trigger).toBe("cleanup_done");
		expect(closeCalls).toHaveLength(1);
		expect(closeCalls[0]?.reason).toMatch(/Mission .* done-phase cleanup at .*/);
		expect(closeCalls[0]?.reason).not.toContain("completed");
	});

	test("T-3: state=failed uses 'failed' reason", async () => {
		const { tracker, closeCalls } = makeRecordingTracker();
		const deps = makeCleanupDeps(tracker);
		const ctx = makeCleanupCtx(makeMission({ taskId: "haru-1234", state: "failed" }));

		const handlers = donePhaseCell.buildHandlers(deps);
		// biome-ignore lint/style/noNonNullAssertion: cleanup handler is registered
		const result = await handlers.cleanup!(ctx);

		expect(result.trigger).toBe("cleanup_done");
		expect(closeCalls).toHaveLength(1);
		expect(closeCalls[0]?.reason).toMatch(/Mission .* failed at .*/);
	});

	test("T-4: state=stopped uses 'stopped' reason", async () => {
		const { tracker, closeCalls } = makeRecordingTracker();
		const deps = makeCleanupDeps(tracker);
		const ctx = makeCleanupCtx(makeMission({ taskId: "haru-1234", state: "stopped" }));

		const handlers = donePhaseCell.buildHandlers(deps);
		// biome-ignore lint/style/noNonNullAssertion: cleanup handler is registered
		const result = await handlers.cleanup!(ctx);

		expect(result.trigger).toBe("cleanup_done");
		expect(closeCalls).toHaveLength(1);
		expect(closeCalls[0]?.reason).toMatch(/Mission .* stopped at .*/);
	});

	test("T-5: state=superseded uses 'superseded' reason", async () => {
		const { tracker, closeCalls } = makeRecordingTracker();
		const deps = makeCleanupDeps(tracker);
		const ctx = makeCleanupCtx(makeMission({ taskId: "haru-1234", state: "superseded" }));

		const handlers = donePhaseCell.buildHandlers(deps);
		// biome-ignore lint/style/noNonNullAssertion: cleanup handler is registered
		const result = await handlers.cleanup!(ctx);

		expect(result.trigger).toBe("cleanup_done");
		expect(closeCalls).toHaveLength(1);
		expect(closeCalls[0]?.reason).toMatch(/Mission .* superseded at .*/);
	});

	test("T-6: state=suspended uses 'suspended' reason", async () => {
		const { tracker, closeCalls } = makeRecordingTracker();
		const deps = makeCleanupDeps(tracker);
		const ctx = makeCleanupCtx(makeMission({ taskId: "haru-1234", state: "suspended" }));

		const handlers = donePhaseCell.buildHandlers(deps);
		// biome-ignore lint/style/noNonNullAssertion: cleanup handler is registered
		const result = await handlers.cleanup!(ctx);

		expect(result.trigger).toBe("cleanup_done");
		expect(closeCalls).toHaveLength(1);
		expect(closeCalls[0]?.reason).toMatch(/Mission .* suspended at .*/);
	});

	test("T-7: state=frozen uses 'frozen' reason", async () => {
		const { tracker, closeCalls } = makeRecordingTracker();
		const deps = makeCleanupDeps(tracker);
		const ctx = makeCleanupCtx(makeMission({ taskId: "haru-1234", state: "frozen" }));

		const handlers = donePhaseCell.buildHandlers(deps);
		// biome-ignore lint/style/noNonNullAssertion: cleanup handler is registered
		const result = await handlers.cleanup!(ctx);

		expect(result.trigger).toBe("cleanup_done");
		expect(closeCalls).toHaveLength(1);
		expect(closeCalls[0]?.reason).toMatch(/Mission .* frozen at .*/);
	});

	test("T-8: idempotent — null taskId does NOT call tracker.close", async () => {
		const { tracker, closeCalls } = makeRecordingTracker();
		const deps = makeCleanupDeps(tracker);
		const ctx = makeCleanupCtx(makeMission({ taskId: null, state: "completed" }));

		const handlers = donePhaseCell.buildHandlers(deps);
		// biome-ignore lint/style/noNonNullAssertion: cleanup handler is registered
		const result = await handlers.cleanup!(ctx);

		expect(result.trigger).toBe("cleanup_done");
		expect(closeCalls).toHaveLength(0);
	});

	test("T-9: sentinel taskId is filtered — tracker.close NOT called", async () => {
		const { tracker, closeCalls } = makeRecordingTracker();
		const deps = makeCleanupDeps(tracker);
		const ctx = makeCleanupCtx(makeMission({ taskId: PENDING_SENTINEL, state: "completed" }));

		const handlers = donePhaseCell.buildHandlers(deps);
		// biome-ignore lint/style/noNonNullAssertion: cleanup handler is registered
		const result = await handlers.cleanup!(ctx);

		expect(result.trigger).toBe("cleanup_done");
		expect(closeCalls).toHaveLength(0);
	});

	test("T-10: best-effort — tracker.close rejection does NOT throw, warning logged", async () => {
		const origWarn = console.warn;
		const warnCalls: string[] = [];
		console.warn = (msg: unknown) => {
			warnCalls.push(typeof msg === "string" ? msg : String(msg));
		};
		try {
			const rejectError = new Error("issue already closed");
			const { tracker, closeCalls } = makeRecordingTracker({ rejectWith: rejectError });
			const deps = makeCleanupDeps(tracker);
			const ctx = makeCleanupCtx(makeMission({ taskId: "haru-1234", state: "completed" }));

			const handlers = donePhaseCell.buildHandlers(deps);
			// biome-ignore lint/style/noNonNullAssertion: cleanup handler is registered
			const result = await handlers.cleanup!(ctx);

			expect(result.trigger).toBe("cleanup_done");
			// close was attempted before throwing
			expect(closeCalls).toHaveLength(1);
			// A warning was logged containing "tracker.close failed" + the error message
			const matched = warnCalls.find(
				(m) => m.includes("tracker.close failed") && m.includes("issue already closed"),
			);
			expect(matched).toBeDefined();
		} finally {
			console.warn = origWarn;
		}
	});

	test("T-11: getMission returns null — tracker.close NOT called", async () => {
		const { tracker, closeCalls } = makeRecordingTracker();
		const deps = makeCleanupDeps(tracker);
		const ctx = makeCleanupCtx(null);

		const handlers = donePhaseCell.buildHandlers(deps);
		// biome-ignore lint/style/noNonNullAssertion: cleanup handler is registered
		const result = await handlers.cleanup!(ctx);

		expect(result.trigger).toBe("cleanup_done");
		expect(closeCalls).toHaveLength(0);
	});

	test("T-12: order invariant — tracker.close awaits BEFORE worktree teardown", async () => {
		const projectRoot = await createTempGitRepo();
		const overstoryDir = join(projectRoot, ".overstory");
		const slug = "order-mission";
		await mkdir(join(overstoryDir, "worktrees", slug), { recursive: true });

		const sessionStore = createSessionStore(":memory:");
		try {
			sessionStore.upsert(
				makeMissionOwnedSession({
					id: "s-order",
					agentName: `builder-${slug}`,
					capability: "builder",
					worktreePath: join(overstoryDir, "worktrees", slug, "builder"),
					branchName: `haru/builder/${slug}`,
					taskId: "tx",
					runId: "run-order",
					state: "waiting",
				}),
			);

			const log: string[] = [];
			const { tracker } = makeRecordingTracker({ log });

			// Wrap updateState so it appends to the shared log before delegating.
			const origUpdateState = sessionStore.updateState.bind(sessionStore);
			sessionStore.updateState = (agentName, state) => {
				log.push("session.updateState");
				origUpdateState(agentName, state);
			};

			const deps: PhaseCellDeps = {
				mailSend: async () => {},
				checkpointStore: {} as PhaseCellDeps["checkpointStore"],
				missionStore: {
					checkpoints: { saveCheckpoint: () => {}, getCheckpoint: () => null },
				} as unknown as PhaseCellDeps["missionStore"],
				tracker,
				sessionStore,
				overstoryDir,
				projectRoot,
			};

			const ctx: HandlerContext = {
				missionId: "m1",
				nodeId: "done-phase:cleanup",
				checkpoint: null,
				saveCheckpoint: async () => {},
				sendMail: async () => {},
				getMission: () =>
					({
						id: "m1",
						slug,
						taskId: "haru-1234",
						state: "completed",
						phase: "done",
						runId: "run-order",
					}) as unknown as Mission,
			} as HandlerContext;

			const handlers = donePhaseCell.buildHandlers(deps);
			// biome-ignore lint/style/noNonNullAssertion: cleanup handler is registered
			const result = await handlers.cleanup!(ctx);

			expect(result.trigger).toBe("cleanup_done");
			expect(log[0]).toBe("tracker.close");
			const firstUpdateIdx = log.indexOf("session.updateState");
			expect(firstUpdateIdx).toBeGreaterThan(-1);
			expect(log.indexOf("tracker.close")).toBeLessThan(firstUpdateIdx);
		} finally {
			sessionStore.close();
			await cleanupTempDir(projectRoot);
		}
	});
});
