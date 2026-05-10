/**
 * Tests for mission role lifecycle (startMissionAnalyst, startExecutionDirector, stopMissionRole).
 *
 * Real tmux operations are mocked to avoid interfering with developer sessions.
 * MissionStore is mocked to verify bindSessions is called correctly without
 * needing a real SQLite database.
 */

import { describe, expect, test } from "bun:test";
import type {
	StartPersistentAgentOpts,
	StartPersistentAgentResult,
} from "../agents/persistent-root.ts";
import { AgentError } from "../errors.ts";
import type { AgentSession, Mission } from "../types.ts";
import type { MissionRoleDeps } from "./roles.ts";
import {
	ensureArchitect,
	startExecutionDirector,
	startMissionAnalyst,
	stopMissionRole,
} from "./roles.ts";

// === Shared mock builders ===

function makeSession(agentName: string): AgentSession {
	return {
		id: `session-${agentName}`,
		agentName,
		capability: agentName,
		runtime: "claude",
		worktreePath: "/proj",
		branchName: "main",
		taskId: "",
		tmuxSession: `ov-${agentName}`,
		state: "working",
		pid: 1234,
		parentAgent: null,
		depth: 0,
		runId: "run-test",
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		rateLimitedSince: null,
		runtimeSessionId: "runtime-uuid",
		transcriptPath: null,
		originalRuntime: null,
		statusLine: null,
	};
}

function makeStartResult(agentName: string): StartPersistentAgentResult {
	return { session: makeSession(agentName), runId: "run-test", pid: 1234 };
}

function makeStoreWithSpy(): {
	store: {
		getById: (id: string) => { id: string } | null;
		bindSessions: (
			id: string,
			sessions: { analystSessionId?: string; executionDirectorSessionId?: string },
		) => void;
		close: () => void;
	};
	calls: Array<{ id: string; sessions: Record<string, string | undefined> }>;
} {
	const calls: Array<{ id: string; sessions: Record<string, string | undefined> }> = [];
	function mockGetById(id: string): { id: string } | null {
		return { id };
	}
	function mockBindSessions(
		id: string,
		sessions: { analystSessionId?: string; executionDirectorSessionId?: string },
	): void {
		calls.push({ id, sessions });
	}
	const store = { getById: mockGetById, bindSessions: mockBindSessions, close: () => {} };
	return { store, calls };
}

// === startMissionAnalyst ===

describe("startMissionAnalyst", () => {
	test("calls startPersistentAgent with capability=mission-analyst and agentName=mission-analyst", async () => {
		let capturedOpts: StartPersistentAgentOpts | undefined;
		const { store } = makeStoreWithSpy();

		const deps: MissionRoleDeps = {
			startAgent: async (opts) => {
				capturedOpts = opts;
				return makeStartResult("mission-analyst");
			},
			createStore: () => store as never,
		};

		await startMissionAnalyst(
			{
				missionId: "m-001",
				projectRoot: "/proj",
				overstoryDir: "/proj/.overstory",
				existingRunId: "run-1",
			},
			deps,
		);

		expect(capturedOpts?.capability).toBe("mission-analyst");
		expect(capturedOpts?.agentName).toBe("mission-analyst");
		expect(capturedOpts?.existingRunId).toBe("run-1");
		expect(capturedOpts?.createRun).toBe(false);
	});

	test("passes prompt overrides and beacon through to persistent-root", async () => {
		let capturedOpts: StartPersistentAgentOpts | undefined;
		const { store } = makeStoreWithSpy();

		const deps: MissionRoleDeps = {
			startAgent: async (opts) => {
				capturedOpts = opts;
				return makeStartResult("mission-analyst");
			},
			createStore: () => store as never,
		};

		await startMissionAnalyst(
			{
				missionId: "m-001",
				projectRoot: "/proj",
				overstoryDir: "/proj/.overstory",
				existingRunId: "run-1",
				appendSystemPromptFile: "/proj/.overstory/agents/mission-analyst/system-prompt.md",
				beacon: "Read context and begin",
			},
			deps,
		);

		expect(capturedOpts?.appendSystemPromptFile).toBe(
			"/proj/.overstory/agents/mission-analyst/system-prompt.md",
		);
		expect(capturedOpts?.beacon).toBe("Read context and begin");
	});

	test("calls bindSessions with analystSessionId after start", async () => {
		const { store, calls } = makeStoreWithSpy();

		const deps: MissionRoleDeps = {
			startAgent: async () => makeStartResult("mission-analyst"),
			createStore: () => store as never,
		};

		await startMissionAnalyst(
			{
				missionId: "m-001",
				projectRoot: "/proj",
				overstoryDir: "/proj/.overstory",
				existingRunId: "run-1",
			},
			deps,
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.id).toBe("m-001");
		expect(calls[0]?.sessions.analystSessionId).toBe("session-mission-analyst");
	});

	test("returns the StartPersistentAgentResult from startAgent", async () => {
		const expected = makeStartResult("mission-analyst");
		const { store } = makeStoreWithSpy();

		const deps: MissionRoleDeps = {
			startAgent: async () => expected,
			createStore: () => store as never,
		};

		const result = await startMissionAnalyst(
			{
				missionId: "m-001",
				projectRoot: "/proj",
				overstoryDir: "/proj/.overstory",
				existingRunId: "run-1",
			},
			deps,
		);

		expect(result).toBe(expected);
	});
});

// === startExecutionDirector ===

describe("startExecutionDirector", () => {
	test("calls startPersistentAgent with capability=execution-director and agentName=execution-director", async () => {
		let capturedOpts: StartPersistentAgentOpts | undefined;
		const { store } = makeStoreWithSpy();

		const deps: MissionRoleDeps = {
			startAgent: async (opts) => {
				capturedOpts = opts;
				return makeStartResult("execution-director");
			},
			createStore: () => store as never,
		};

		await startExecutionDirector(
			{
				missionId: "m-002",
				projectRoot: "/proj",
				overstoryDir: "/proj/.overstory",
				existingRunId: "run-2",
			},
			deps,
		);

		expect(capturedOpts?.capability).toBe("execution-director");
		expect(capturedOpts?.agentName).toBe("execution-director");
		expect(capturedOpts?.existingRunId).toBe("run-2");
		expect(capturedOpts?.createRun).toBe(false);
	});

	test("calls bindSessions with executionDirectorSessionId after start", async () => {
		const { store, calls } = makeStoreWithSpy();

		const deps: MissionRoleDeps = {
			startAgent: async () => makeStartResult("execution-director"),
			createStore: () => store as never,
		};

		await startExecutionDirector(
			{
				missionId: "m-002",
				projectRoot: "/proj",
				overstoryDir: "/proj/.overstory",
				existingRunId: "run-2",
			},
			deps,
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.id).toBe("m-002");
		expect(calls[0]?.sessions.executionDirectorSessionId).toBe("session-execution-director");
	});
});

// === startMissionAnalyst edge cases ===

describe("startMissionAnalyst edge cases", () => {
	test("throws AgentError when missionId does not exist (getById returns null)", async () => {
		// getById returns null to simulate a missing mission — validation throws before bindSessions.
		const deps: MissionRoleDeps = {
			startAgent: async () => makeStartResult("mission-analyst"),
			createStore: () =>
				({
					getById: (_id: string) => null,
					bindSessions: () => {},
					close: () => {},
				}) as never,
		};

		await expect(
			startMissionAnalyst(
				{
					missionId: "nonexistent-mission",
					projectRoot: "/proj",
					overstoryDir: "/proj/.overstory",
					existingRunId: "run-1",
				},
				deps,
			),
		).rejects.toThrow(AgentError);
	});
});

// === startExecutionDirector edge cases ===

describe("startExecutionDirector edge cases", () => {
	test("throws AgentError when missionId does not exist (getById returns null)", async () => {
		// getById returns null to simulate a missing mission — validation throws before bindSessions.
		const deps: MissionRoleDeps = {
			startAgent: async () => makeStartResult("execution-director"),
			createStore: () =>
				({
					getById: (_id: string) => null,
					bindSessions: () => {},
					close: () => {},
				}) as never,
		};

		await expect(
			startExecutionDirector(
				{
					missionId: "nonexistent-mission",
					projectRoot: "/proj",
					overstoryDir: "/proj/.overstory",
					existingRunId: "run-2",
				},
				deps,
			),
		).rejects.toThrow(AgentError);
	});
});

// === stopMissionRole ===

describe("stopMissionRole", () => {
	test("calls stopPersistentAgent with the given agentName", async () => {
		let capturedName: string | undefined;
		let capturedOpts: { projectRoot: string; overstoryDir: string } | undefined;

		const deps: MissionRoleDeps = {
			stopAgent: async (name, opts) => {
				capturedName = name;
				capturedOpts = opts;
				return { sessionKilled: true, sessionId: "session-1", runCompleted: false };
			},
		};

		await stopMissionRole(
			"mission-analyst",
			{ projectRoot: "/proj", overstoryDir: "/proj/.overstory" },
			deps,
		);

		expect(capturedName).toBe("mission-analyst");
		expect(capturedOpts?.projectRoot).toBe("/proj");
		expect(capturedOpts?.overstoryDir).toBe("/proj/.overstory");
	});

	test("passes completeRun=false through for shared mission run shutdown", async () => {
		let capturedOpts:
			| {
					projectRoot: string;
					overstoryDir: string;
					runStatus?: "completed" | "stopped";
					completeRun?: boolean;
			  }
			| undefined;

		const deps: MissionRoleDeps = {
			stopAgent: async (_name, opts) => {
				capturedOpts = opts;
				return { sessionKilled: true, sessionId: "session-1", runCompleted: false };
			},
		};

		await stopMissionRole(
			"mission-analyst",
			{ projectRoot: "/proj", overstoryDir: "/proj/.overstory", completeRun: false },
			deps,
		);

		expect(capturedOpts?.completeRun).toBe(false);
		expect(capturedOpts?.runStatus).toBe("stopped");
	});

	test("returns the StopPersistentAgentResult from stopAgent", async () => {
		const expected = { sessionKilled: true, sessionId: "session-abc", runCompleted: true };

		const deps: MissionRoleDeps = {
			stopAgent: async () => expected,
		};

		const result = await stopMissionRole(
			"execution-director",
			{ projectRoot: "/proj", overstoryDir: "/proj/.overstory" },
			deps,
		);

		expect(result).toBe(expected);
	});

	test("works with execution-director agent name", async () => {
		let capturedName: string | undefined;

		const deps: MissionRoleDeps = {
			stopAgent: async (name) => {
				capturedName = name;
				return { sessionKilled: false, sessionId: "session-2", runCompleted: false };
			},
		};

		await stopMissionRole(
			"execution-director",
			{ projectRoot: "/proj", overstoryDir: "/proj/.overstory" },
			deps,
		);

		expect(capturedName).toBe("execution-director");
	});
});

// === ensureArchitect ===

function makeMission(overrides?: Partial<Mission>): Mission {
	return {
		id: "m-arch-001",
		slug: "arch-test",
		objective: "test mission",
		runId: "run-arch",
		state: "active",
		phase: "plan",
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
		tier: "full",
		autonomy: "supervised",
		...overrides,
	};
}

function makeArchitectStoreSpy(): {
	store: {
		getById: (id: string) => { id: string } | null;
		bindSessions: (id: string, sessions: { architectSessionId?: string }) => void;
		close: () => void;
	};
	calls: Array<{ id: string; sessions: Record<string, string | undefined> }>;
} {
	const calls: Array<{ id: string; sessions: Record<string, string | undefined> }> = [];
	const store = {
		getById: (id: string) => ({ id }),
		bindSessions: (id: string, sessions: { architectSessionId?: string }) => {
			calls.push({ id, sessions });
		},
		close: () => {},
	};
	return { store, calls };
}

describe("ensureArchitect", () => {
	test("first call (no architectSessionId) spawns architect and binds sessionId", async () => {
		const mission = makeMission({ architectSessionId: null });
		const { store, calls } = makeArchitectStoreSpy();

		let materializeCalled = false;
		let drainCalled = false;
		let startCaptured: StartPersistentAgentOpts | undefined;

		const deps: MissionRoleDeps = {
			startAgent: async (opts) => {
				startCaptured = opts;
				return makeStartResult("architect-arch-test");
			},
			createStore: () => store as never,
			materializePrompt: async () => {
				materializeCalled = true;
				return { promptPath: "/fake/prompt.md", contextPath: "/fake/ctx.md" };
			},
			drainInbox: () => {
				drainCalled = true;
			},
		};

		await ensureArchitect(mission, "/proj/.overstory", "/proj", deps);

		expect(materializeCalled).toBe(true);
		expect(drainCalled).toBe(true);
		expect(startCaptured?.capability).toBe("architect");
		expect(startCaptured?.agentName).toBe("architect-arch-test");
		expect(startCaptured?.appendSystemPromptFile).toBe("/fake/prompt.md");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.id).toBe("m-arch-001");
		expect(calls[0]?.sessions.architectSessionId).toBe("session-architect-arch-test");
	});

	test("second call (architect bound and alive) is a no-op — does not spawn", async () => {
		const mission = makeMission({ architectSessionId: "session-architect-arch-test" });
		const { store, calls } = makeArchitectStoreSpy();

		let startCalled = false;
		let materializeCalled = false;

		const deps: MissionRoleDeps = {
			startAgent: async () => {
				startCalled = true;
				return makeStartResult("architect-arch-test");
			},
			createStore: () => store as never,
			isRoleSessionAlive: () => true,
			materializePrompt: async () => {
				materializeCalled = true;
				return { promptPath: "", contextPath: "" };
			},
			drainInbox: () => {},
		};

		await ensureArchitect(mission, "/proj/.overstory", "/proj", deps);

		expect(startCalled).toBe(false);
		expect(materializeCalled).toBe(false);
		expect(calls).toHaveLength(0);
	});

	test("architect bound but dead: respawns and rebinds", async () => {
		const mission = makeMission({ architectSessionId: "session-stale" });
		const { store, calls } = makeArchitectStoreSpy();

		let startCalled = false;

		const deps: MissionRoleDeps = {
			startAgent: async () => {
				startCalled = true;
				return makeStartResult("architect-arch-test");
			},
			createStore: () => store as never,
			isRoleSessionAlive: () => false,
			materializePrompt: async () => ({ promptPath: "", contextPath: "" }),
			drainInbox: () => {},
		};

		await ensureArchitect(mission, "/proj/.overstory", "/proj", deps);

		expect(startCalled).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.sessions.architectSessionId).toBe("session-architect-arch-test");
	});

	test("startArchitectRole failure propagates (no partial state)", async () => {
		const mission = makeMission({ architectSessionId: null });
		const { store, calls } = makeArchitectStoreSpy();

		const deps: MissionRoleDeps = {
			startAgent: async () => {
				throw new Error("spawn failed");
			},
			createStore: () => store as never,
			materializePrompt: async () => ({ promptPath: "", contextPath: "" }),
			drainInbox: () => {},
		};

		await expect(ensureArchitect(mission, "/proj/.overstory", "/proj", deps)).rejects.toThrow(
			"spawn failed",
		);

		// No bindSessions write happened — startArchitectRole runs bindSessions
		// only after startAgent succeeds.
		expect(calls).toHaveLength(0);
	});

	test("uses unscoped 'architect' name when mission has no slug", async () => {
		const mission = makeMission({ slug: "", architectSessionId: null });
		const { store } = makeArchitectStoreSpy();

		let startCaptured: StartPersistentAgentOpts | undefined;

		const deps: MissionRoleDeps = {
			startAgent: async (opts) => {
				startCaptured = opts;
				return makeStartResult("architect");
			},
			createStore: () => store as never,
			materializePrompt: async () => ({ promptPath: "", contextPath: "" }),
			drainInbox: () => {},
		};

		await ensureArchitect(mission, "/proj/.overstory", "/proj", deps);

		expect(startCaptured?.agentName).toBe("architect");
	});
});
