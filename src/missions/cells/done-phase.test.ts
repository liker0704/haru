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
