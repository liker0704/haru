import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../../test-helpers.ts";
import type { Mission } from "../../types.ts";
import type { HandlerContext } from "../types.ts";
import type { DebugLoopDeps } from "./debug-loop-handlers.ts";
import { makeDebugLoopHandlers } from "./debug-loop-handlers.ts";
import type { PhaseCellDeps } from "./types.ts";

// Shared fake checkpoint store backed by a Map.
function makeCheckpointStore(initial: Record<string, unknown> = {}) {
	const store: Record<string, unknown> = { ...initial };
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
				return { ...(msg as object), id: returnId };
			},
		},
	};
}

function makeMission(overrides: Partial<Mission> = {}): Mission {
	return {
		id: "m1",
		slug: "test-mission",
		featureBranch: "feature/x",
		artifactRoot: "/tmp/artifacts",
		objective: "test",
		runId: null,
		state: "active",
		phase: "done",
		firstFreezeAt: null,
		pendingUserInput: false,
		pendingInputKind: null,
		pendingInputThreadId: null,
		reopenCount: 0,
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
		frozenAt: null,
		...overrides,
	} as unknown as Mission;
}

function makeCtx(
	overrides: Partial<HandlerContext> & { mission?: Partial<Mission> } = {},
): HandlerContext {
	const { mission: missionOverrides, ...ctxOverrides } = overrides;
	return {
		missionId: "m1",
		nodeId: "done-phase:dispatch-debugger",
		checkpoint: null,
		saveCheckpoint: async () => {},
		sendMail: async () => {},
		getMission: () => makeMission(missionOverrides ?? {}),
		...ctxOverrides,
	} as HandlerContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// Checkpoint namespacing
// ─────────────────────────────────────────────────────────────────────────────

describe("makeDebugLoopHandlers checkpoint namespacing", () => {
	let tempDir: string;
	let agentBaseDir: string;
	let origSpawn: typeof Bun.spawn;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "haru-dlh-ns-"));
		agentBaseDir = join(tempDir, "agent-defs");
		await mkdir(agentBaseDir, { recursive: true });
		origSpawn = Bun.spawn;

		// Manifest that passes preflight for both factories.
		await Bun.write(
			join(tempDir, "agent-manifest.json"),
			JSON.stringify({
				version: "1.0",
				agents: {
					debugger: {
						file: "debugger.md",
						model: "sonnet",
						tools: ["Read"],
						capabilities: ["debugger"],
						canSpawn: false,
						constraints: [],
					},
				},
			}),
		);
		await Bun.write(join(agentBaseDir, "debugger.md"), "# debugger\n");

		// Minimal spawn stub so dispatch-debugger doesn't fail on git calls.
		const encoder = new TextEncoder();
		// biome-ignore lint/suspicious/noExplicitAny: Bun.spawn overloads require any cast
		(Bun as any).spawn = (cmd: string[]): ReturnType<typeof Bun.spawn> => {
			if (cmd[0] === "git" && cmd[1] === "rev-parse") {
				return {
					stdout: new ReadableStream({
						start(c) {
							c.enqueue(encoder.encode("abc123\n"));
							c.close();
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
			if (cmd[0] === "git" && cmd[1] === "worktree" && cmd[2] === "list") {
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
					exited: Promise.resolve(0),
					unref: () => {},
				} as unknown as ReturnType<typeof Bun.spawn>;
			}
			if (cmd[0] === "git" && cmd[1] === "worktree" && cmd[2] === "add") {
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
			return origSpawn(cmd as [string, ...string[]]);
		};
	});

	afterEach(async () => {
		// biome-ignore lint/suspicious/noExplicitAny: restoring Bun.spawn
		(Bun as any).spawn = origSpawn;
		await cleanupTempDir(tempDir);
	});

	test("two factories write to distinct checkpoint keys", async () => {
		const tuples: Array<{ missionId: string; nodeId: string }> = [];

		function makeDepsForCell(_cellType: string): DebugLoopDeps {
			return {
				mailSend: async () => {},
				checkpointStore: {} as PhaseCellDeps["checkpointStore"],
				missionStore: {
					checkpoints: {
						saveCheckpoint: (missionId: string, nodeId: string, _data: unknown) => {
							tuples.push({ missionId, nodeId });
						},
						getCheckpoint: () => null,
					},
				} as unknown as PhaseCellDeps["missionStore"],
				overstoryDir: tempDir,
				projectRoot: "/tmp/ns-test",
			};
		}

		const doneHandlers = makeDebugLoopHandlers(
			{ cellType: "done-phase", failureSource: "holdout" },
			makeDepsForCell("done-phase"),
		);
		const prHandlers = makeDebugLoopHandlers(
			{ cellType: "pr-phase", failureSource: "ci" },
			makeDepsForCell("pr-phase"),
		);

		// Invoke dispatch-debugger for both. featureBranch is set so it passes
		// the null-check and tries git + sling (both stubbed above).
		// biome-ignore lint/style/noNonNullAssertion: registry known
		await doneHandlers["dispatch-debugger"]!(makeCtx());
		// biome-ignore lint/style/noNonNullAssertion: registry known
		await prHandlers["dispatch-debugger"]!(makeCtx());

		const nodeIds = tuples.map((t) => t.nodeId);
		expect(nodeIds).toContain("done-phase:dispatch-debugger");
		expect(nodeIds).toContain("pr-phase:dispatch-debugger");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// dispatch-debugger preflight
// ─────────────────────────────────────────────────────────────────────────────

describe("makeDebugLoopHandlers dispatch-debugger preflight", () => {
	let tempDir: string;
	let agentBaseDir: string;
	let saved: Array<{ missionId: string; nodeId: string; data: unknown }>;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "haru-dlh-preflight-"));
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

	function makeDeps(): DebugLoopDeps {
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

	test("capability missing → returns capability_missing, persists reason", async () => {
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
		const handlers = makeDebugLoopHandlers(
			{ cellType: "done-phase", failureSource: "holdout" },
			makeDeps(),
		);
		// biome-ignore lint/style/noNonNullAssertion: registry known
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

	test("capability present → preflight passes (not capability_missing)", async () => {
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
		const handlers = makeDebugLoopHandlers(
			{ cellType: "done-phase", failureSource: "holdout" },
			makeDeps(),
		);
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers["dispatch-debugger"]!(makeCtx());

		// Preflight passes. Downstream steps may fail in test env (dispatch_failed),
		// but crucially NOT capability_missing.
		expect(result.trigger).not.toBe("capability_missing");
	});

	test("manifest file missing → still returns capability_missing", async () => {
		// No manifest written — loader.load() throws; preflight catches.
		const handlers = makeDebugLoopHandlers(
			{ cellType: "done-phase", failureSource: "holdout" },
			makeDeps(),
		);
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers["dispatch-debugger"]!(makeCtx());

		expect(result.trigger).toBe("capability_missing");
		expect(saved).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: toHaveLength(1) guard above
		const data = saved[0]!.data as { dispatchFailureReason?: string };
		expect(data.dispatchFailureReason).toContain("debugger capability not registered");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// dispatch-debugger worktree probe
// ─────────────────────────────────────────────────────────────────────────────

describe("makeDebugLoopHandlers worktree probe", () => {
	let tempDir: string;
	let agentBaseDir: string;
	let origSpawn: typeof Bun.spawn;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "haru-dlh-wt-"));
		agentBaseDir = join(tempDir, "agent-defs");
		await mkdir(agentBaseDir, { recursive: true });
		origSpawn = Bun.spawn;

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
		const expectedWorktreePath = join(tempDir, "worktrees", "debug", "test-mission-attempt-1");
		const encoder = new TextEncoder();

		// biome-ignore lint/suspicious/noExplicitAny: Bun.spawn overloads require any cast
		(Bun as any).spawn = (cmd: string[], opts?: unknown): ReturnType<typeof Bun.spawn> => {
			spawnArgs.push([...cmd]);

			if (cmd[0] === "git" && cmd[1] === "worktree" && cmd[2] === "list") {
				const output = `worktree ${expectedWorktreePath}\nHEAD abc123\nbranch refs/heads/feature/x\n`;
				return {
					stdout: new ReadableStream({
						start(c) {
							c.enqueue(encoder.encode(output));
							c.close();
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
						start(c) {
							c.enqueue(encoder.encode("abc123sha\n"));
							c.close();
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

			return origSpawn(cmd as [string, ...string[]], opts as Parameters<typeof Bun.spawn>[1]);
		};

		const deps: DebugLoopDeps = {
			mailSend: async () => {},
			checkpointStore: {} as PhaseCellDeps["checkpointStore"],
			missionStore: {
				checkpoints: {
					saveCheckpoint: () => {},
					getCheckpoint: () => null,
				},
			} as unknown as PhaseCellDeps["missionStore"],
			overstoryDir: tempDir,
			projectRoot: "/tmp/wt-probe-test",
		};

		const handlers = makeDebugLoopHandlers(
			{ cellType: "done-phase", failureSource: "holdout" },
			deps,
		);
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers["dispatch-debugger"]!(makeCtx());

		expect(result.trigger).not.toBe("dispatch_failed");

		const addCalls = spawnArgs.filter(
			(args) => args[0] === "git" && args[1] === "worktree" && args[2] === "add",
		);
		expect(addCalls).toHaveLength(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// dispatch-debugger sling spawn args (issue #337 regression)
// ─────────────────────────────────────────────────────────────────────────────

describe("makeDebugLoopHandlers sling spawn args (issue #337)", () => {
	let tempDir: string;
	let agentBaseDir: string;
	let origSpawn: typeof Bun.spawn;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "haru-dlh-sling-args-"));
		agentBaseDir = join(tempDir, "agent-defs");
		await mkdir(agentBaseDir, { recursive: true });
		origSpawn = Bun.spawn;
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

	test("ha sling invocation uses --base-branch (not --branch) and --skip-task-check with attempt-suffixed name", async () => {
		const spawnArgs: string[][] = [];
		const encoder = new TextEncoder();
		const expectedWorktreePath = join(tempDir, "worktrees", "debug", "test-mission-attempt-1");

		// biome-ignore lint/suspicious/noExplicitAny: Bun.spawn overloads require any cast
		(Bun as any).spawn = (cmd: string[], opts?: unknown): ReturnType<typeof Bun.spawn> => {
			spawnArgs.push([...cmd]);
			if (cmd[0] === "git" && cmd[1] === "worktree" && cmd[2] === "list") {
				const output = `worktree ${expectedWorktreePath}\nHEAD abc\nbranch refs/heads/feature/x\n`;
				return {
					stdout: new ReadableStream({
						start(c) {
							c.enqueue(encoder.encode(output));
							c.close();
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
						start(c) {
							c.enqueue(encoder.encode("abc\n"));
							c.close();
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
			return origSpawn(cmd as [string, ...string[]], opts as Parameters<typeof Bun.spawn>[1]);
		};

		const saved: Array<{ missionId: string; nodeId: string; data: unknown }> = [];
		const deps: DebugLoopDeps = {
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
			projectRoot: "/tmp/sling-args-test",
		};

		const handlers = makeDebugLoopHandlers(
			{ cellType: "done-phase", failureSource: "holdout" },
			deps,
		);
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers["dispatch-debugger"]!(makeCtx());

		expect(result.trigger).toBe("debugger_dispatched");

		const slingCall = spawnArgs.find((a) => a[0] === "ha" && a[1] === "sling");
		expect(slingCall).toBeDefined();
		if (!slingCall) throw new Error("sling not invoked");

		// Regression: bad `--branch` flag must not be present (Commander rejects it).
		expect(slingCall).not.toContain("--branch");

		// The valid `--base-branch` flag must be passed with the feature branch.
		const baseBranchIdx = slingCall.indexOf("--base-branch");
		expect(baseBranchIdx).toBeGreaterThan(-1);
		expect(slingCall[baseBranchIdx + 1]).toBe("feature/x");

		// `--skip-task-check` must be set (debug attempt task is not in tracker).
		expect(slingCall).toContain("--skip-task-check");

		// The `--name` must include the attempt suffix, matching the address that
		// mail is sent to and the nudge target computed by evaluateAwaitDebugFix.
		const nameIdx = slingCall.indexOf("--name");
		expect(nameIdx).toBeGreaterThan(-1);
		expect(slingCall[nameIdx + 1]).toBe("debugger-test-mission-attempt-1");

		// Checkpoint records the same suffixed name so the gate evaluator's
		// readDebugAttempts → `debugger-<slug>-attempt-<N>` derivation aligns.
		const dispatchCp = saved.find((s) => s.nodeId === "done-phase:dispatch-debugger");
		const cpData = dispatchCp?.data as { debuggerName?: string; debugAttempts?: number };
		expect(cpData?.debuggerName).toBe("debugger-test-mission-attempt-1");
		expect(cpData?.debugAttempts).toBe(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// check-debug-attempts
// ─────────────────────────────────────────────────────────────────────────────

describe("makeDebugLoopHandlers check-debug-attempts", () => {
	function makeDeps(checkpointData: Record<string, unknown> = {}): DebugLoopDeps {
		return {
			mailSend: async () => {},
			checkpointStore: {} as PhaseCellDeps["checkpointStore"],
			missionStore: {
				checkpoints: {
					saveCheckpoint: () => {},
					getCheckpoint: (_missionId: string, nodeId: string) => {
						const data = checkpointData[nodeId];
						return data !== undefined ? { data } : null;
					},
				},
			} as unknown as PhaseCellDeps["missionStore"],
		};
	}

	test("attempts < maxAttempts → returns retry", async () => {
		const deps = makeDeps({ "done-phase:dispatch-debugger": { debugAttempts: 2 } });
		const handlers = makeDebugLoopHandlers(
			{ cellType: "done-phase", maxAttempts: 3, failureSource: "holdout" },
			deps,
		);
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers["check-debug-attempts"]!(makeCtx());
		expect(result.trigger).toBe("retry");
	});

	test("attempts >= maxAttempts → returns exhausted", async () => {
		const deps = makeDeps({ "done-phase:dispatch-debugger": { debugAttempts: 3 } });
		const handlers = makeDebugLoopHandlers(
			{ cellType: "done-phase", maxAttempts: 3, failureSource: "holdout" },
			deps,
		);
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers["check-debug-attempts"]!(makeCtx());
		expect(result.trigger).toBe("exhausted");
	});

	test("custom maxAttempts: 5 is respected (attempts=4 → retry)", async () => {
		const deps = makeDeps({ "done-phase:dispatch-debugger": { debugAttempts: 4 } });
		const handlers = makeDebugLoopHandlers(
			{ cellType: "done-phase", maxAttempts: 5, failureSource: "holdout" },
			deps,
		);
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers["check-debug-attempts"]!(makeCtx());
		expect(result.trigger).toBe("retry");
	});

	test("custom maxAttempts: 5 is respected (attempts=5 → exhausted)", async () => {
		const deps = makeDeps({ "done-phase:dispatch-debugger": { debugAttempts: 5 } });
		const handlers = makeDebugLoopHandlers(
			{ cellType: "done-phase", maxAttempts: 5, failureSource: "holdout" },
			deps,
		);
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers["check-debug-attempts"]!(makeCtx());
		expect(result.trigger).toBe("exhausted");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// escalate placeholder-checkpoint
// ─────────────────────────────────────────────────────────────────────────────

describe("makeDebugLoopHandlers escalate placeholder-checkpoint", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "haru-dlh-escalate-"));
		await mkdir(join(tempDir, "debug"), { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

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
			getMission: () => makeMission({ artifactRoot: tempDir }),
		} as HandlerContext;
	}

	test("fresh path: saves escalationPending, sends mail, saves escalationThreadId", async () => {
		const { checkpoints, saved } = makeCheckpointStore();
		const { store: mailStore, sendCount } = makeMailStore("msg-fake");

		const deps: DebugLoopDeps = {
			mailSend: async () => {},
			checkpointStore: {} as PhaseCellDeps["checkpointStore"],
			missionStore: {
				checkpoints,
				freeze: () => {},
				updatePauseReason: () => {},
				transaction: <T>(fn: () => T): T => fn(),
			} as unknown as PhaseCellDeps["missionStore"],
			mailStore: mailStore as unknown as PhaseCellDeps["mailStore"],
		};

		const handlers = makeDebugLoopHandlers(
			{ cellType: "done-phase", failureSource: "holdout" },
			deps,
		);
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
		const deps: DebugLoopDeps = {
			mailSend: async () => {},
			checkpointStore: {} as PhaseCellDeps["checkpointStore"],
			missionStore: {
				checkpoints,
				freeze: (_id: unknown, _kind: unknown, threadId: string | null) => {
					freezeCalls.push({ threadId });
				},
				updatePauseReason: () => {},
				transaction: <T>(fn: () => T): T => fn(),
			} as unknown as PhaseCellDeps["missionStore"],
			mailStore: mailStore as unknown as PhaseCellDeps["mailStore"],
		};

		const handlers = makeDebugLoopHandlers(
			{ cellType: "done-phase", failureSource: "holdout" },
			deps,
		);
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers.escalate!(makeEscalateCtx());

		expect(result.trigger).toBe("escalated");
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

		const deps: DebugLoopDeps = {
			mailSend: async () => {},
			checkpointStore: {} as PhaseCellDeps["checkpointStore"],
			missionStore: {
				checkpoints,
				freeze: () => {},
				updatePauseReason: () => {},
				transaction: <T>(fn: () => T): T => fn(),
			} as unknown as PhaseCellDeps["missionStore"],
			mailStore: mailStore as unknown as PhaseCellDeps["mailStore"],
		};

		const handlers = makeDebugLoopHandlers(
			{ cellType: "done-phase", failureSource: "holdout" },
			deps,
		);
		// biome-ignore lint/style/noNonNullAssertion: registry known
		const result = await handlers.escalate!(
			makeEscalateCtx({
				sendMail: async (to, subject, _body, type) => {
					sentMails.push({ to, subject, type });
				},
			}),
		);

		expect(result.trigger).toBe("pending_replay_aborted");
		expect(sendCount.get()).toBe(0);
		expect(sentMails).toHaveLength(1);
		expect(sentMails[0]?.to).toBe("operator");
		expect(sentMails[0]?.subject).toContain("Escalation interrupted");
		expect(sentMails[0]?.type).toBe("mission_finding");
	});
});
