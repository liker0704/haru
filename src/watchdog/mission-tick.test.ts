/**
 * Tests for runMissionTick (Wave 3).
 *
 * Uses real SQLite stores (real MissionStore, SessionStore) in temp dirs —
 * consistent with project philosophy. The engine factory is injected via
 * the _startEngine DI seam to avoid spawning real AI or tmux sessions.
 *
 * tmux operations inside checkAndRecoverDeadAgents are bypassed by setting
 * no session IDs on missions (coordinatorSessionId etc. = null), so the
 * per-role loop has nothing to check.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverstoryConfig } from "../config-types.ts";
import { createEventStore } from "../events/store.ts";
import { createMailStore } from "../mail/store.ts";
import type { GraphEngine, StepResult } from "../missions/engine.ts";
import { createMissionStore } from "../missions/store.ts";
import type { SessionStore } from "../sessions/store.ts";
import { createSessionStore } from "../sessions/store.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { AgentSession, MissionStore } from "../types.ts";
import {
	__resetResumeCountersForTesting,
	type MissionTickOpts,
	runMissionTick,
} from "./mission-tick.ts";

// === Helpers ===

/** Minimal OverstoryConfig sufficient for runMissionTick. */
function makeConfig(): OverstoryConfig {
	return {
		project: {
			name: "test",
			root: "/tmp",
			canonicalBranch: "main",
		},
		agents: {
			manifestPath: "",
			baseDir: "",
			maxConcurrent: 4,
			staggerDelayMs: 0,
			maxDepth: 2,
			maxSessionsPerRun: 0,
			maxAgentsPerLead: 0,
		},
		worktrees: { baseDir: "/tmp" },
		taskTracker: { backend: "auto", enabled: false },
		mulch: { enabled: false, domains: [], primeFormat: "markdown" },
		merge: { aiResolveEnabled: false, reimagineEnabled: false },
		providers: {},
		watchdog: {
			tier0Enabled: true,
			tier0IntervalMs: 30_000,
			tier1Enabled: false,
			tier2Enabled: false,
			staleThresholdMs: 300_000,
			zombieThresholdMs: 600_000,
			nudgeIntervalMs: 60_000,
		},
		models: {},
		logging: { verbose: false, redactSecrets: true },
	};
}

/** Build a fake GraphEngine returning a fixed StepResult on step(). */
function makeEngineReturning(stepResult: StepResult): GraphEngine {
	return {
		currentNodeId: () => stepResult.fromNodeId,
		step: async () => stepResult,
		run: async () => ({
			status: "completed" as const,
			steps: [stepResult],
			currentNodeId: stepResult.toNodeId,
		}),
		advanceNode: async () => ({
			status: "completed" as const,
			steps: [],
			currentNodeId: stepResult.toNodeId,
		}),
		forceAdvance: async () => stepResult,
	};
}

/** Create a temp haru directory with sessions.db. */
async function createTempOvDir(): Promise<{ overstoryDir: string; dbPath: string }> {
	const base = await mkdtemp(join(tmpdir(), "ov-mission-tick-test-"));
	const overstoryDir = join(base, ".overstory");
	await mkdir(overstoryDir, { recursive: true });
	return { overstoryDir, dbPath: join(overstoryDir, "sessions.db") };
}

/** Build MissionTickOpts with the given stores and engine factory override. */
function makeOpts(
	overstoryDir: string,
	missionStore: MissionStore,
	sessionStore: SessionStore,
	engineFactory?: MissionTickOpts["_startEngine"],
	extras?: Partial<MissionTickOpts>,
): MissionTickOpts {
	return {
		overstoryDir,
		projectRoot: overstoryDir,
		config: makeConfig(),
		missionStore,
		sessionStore,
		mailStore: null,
		eventStore: null,
		intervalMs: 30_000,
		_startEngine: engineFactory,
		...extras,
	};
}

/** Build a complete AgentSession for test use. */
function makeSession(
	overrides: Partial<AgentSession> & {
		id: string;
		agentName: string;
		worktreePath: string;
	},
): AgentSession {
	return {
		capability: "coordinator",
		runtime: "claude",
		branchName: "main",
		taskId: "task-1",
		tmuxSession: `tmux-${overrides.agentName}`,
		state: "waiting",
		pid: null,
		parentAgent: null,
		depth: 0,
		runId: null,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		rateLimitedSince: null,
		runtimeSessionId: null,
		transcriptPath: null,
		originalRuntime: null,
		statusLine: null,
		...overrides,
	};
}

// === Test state ===

let overstoryDir: string;
let dbPath: string;
let missionStore: MissionStore;
let sessionStore: SessionStore;

beforeEach(async () => {
	({ overstoryDir, dbPath } = await createTempOvDir());
	missionStore = createMissionStore(dbPath);
	sessionStore = createSessionStore(dbPath);
	__resetResumeCountersForTesting();
});

afterEach(async () => {
	missionStore.close?.();
	sessionStore.close?.();
	await cleanupTempDir(overstoryDir.replace("/.overstory", ""));
});

// === Tests ===

describe("runMissionTick", () => {
	test("does nothing and returns cleanly when there are no active missions", async () => {
		// No missions inserted — getActiveList() returns [].
		const calls: string[] = [];
		const engineFactory: MissionTickOpts["_startEngine"] = () => {
			calls.push("engine-called");
			return makeEngineReturning({
				status: "terminal",
				fromNodeId: "start",
				toNodeId: "end",
				trigger: null,
			});
		};

		await expect(
			runMissionTick(makeOpts(overstoryDir, missionStore, sessionStore, engineFactory)),
		).resolves.toBeUndefined();

		expect(calls).toHaveLength(0);
	});

	test("skips missions whose state is not 'active'", async () => {
		// Insert a mission then immediately suspend it — it won't appear in
		// getActiveList() since that filters for state IN ('active', 'frozen').
		missionStore.create({ id: "m-suspended", slug: "suspended-mission", objective: "test" });
		missionStore.updateState("m-suspended", "suspended");

		const calls: string[] = [];
		const engineFactory: MissionTickOpts["_startEngine"] = () => {
			calls.push("engine-called");
			return makeEngineReturning({
				status: "terminal",
				fromNodeId: "start",
				toNodeId: "end",
				trigger: null,
			});
		};

		await runMissionTick(makeOpts(overstoryDir, missionStore, sessionStore, engineFactory));

		// Engine must never be invoked for a suspended mission.
		expect(calls).toHaveLength(0);
	});

	test("skips mission when tick lock cannot be acquired", async () => {
		missionStore.create({ id: "m-locked", slug: "locked-mission", objective: "test" });
		// The mission state defaults to 'active' on creation.

		// Pre-acquire the lock with a long interval so the tick can't steal it.
		const locked = missionStore.acquireTickLock("m-locked", 60_000);
		expect(locked).toBe(true);

		const calls: string[] = [];
		const engineFactory: MissionTickOpts["_startEngine"] = () => {
			calls.push("engine-called");
			return makeEngineReturning({
				status: "terminal",
				fromNodeId: "start",
				toNodeId: "end",
				trigger: null,
			});
		};

		await runMissionTick(makeOpts(overstoryDir, missionStore, sessionStore, engineFactory));

		// Lock was held — engine must be skipped.
		expect(calls).toHaveLength(0);
	});

	test("calls engine step and releases lock for an active mission", async () => {
		missionStore.create({
			id: "m-active",
			slug: "active-mission",
			objective: "test",
			tier: "full",
		});
		missionStore.updateCurrentNode("m-active", "understand:active");

		const stepResults: string[] = [];
		const engineFactory: MissionTickOpts["_startEngine"] = (_mission, _deps, _opts) => {
			return {
				currentNodeId: () => "understand:active",
				step: async (): Promise<StepResult> => {
					stepResults.push("stepped");
					return {
						status: "terminal",
						fromNodeId: "understand:active",
						toNodeId: "done:completed",
						trigger: "complete",
					};
				},
				run: async () => ({
					status: "completed" as const,
					steps: [],
					currentNodeId: "done:completed",
				}),
				advanceNode: async () => ({
					status: "completed" as const,
					steps: [],
					currentNodeId: "done:completed",
				}),
				forceAdvance: async () => ({
					status: "terminal" as const,
					fromNodeId: "understand:active",
					toNodeId: "done:completed",
					trigger: "complete",
				}),
			};
		};

		await runMissionTick(makeOpts(overstoryDir, missionStore, sessionStore, engineFactory));

		// Engine step was invoked exactly once.
		expect(stepResults).toHaveLength(1);

		// Lock must be released after tick — next acquire succeeds.
		const canAcquire = missionStore.acquireTickLock("m-active", 30_000);
		expect(canAcquire).toBe(true);
	});

	describe("checkAndResumeWaitingAgents", () => {
		/** Engine factory that short-circuits immediately (status=gate). */
		function makeGateEngine(): MissionTickOpts["_startEngine"] {
			return () =>
				makeEngineReturning({
					status: "gate",
					fromNodeId: "understand:await-plan",
					toNodeId: "understand:await-plan",
					trigger: null,
				});
		}

		test("auto-resumes waiting agent with dead tmux and unread mail", async () => {
			const worktreePath = join(overstoryDir, "wt-coord");
			await mkdir(worktreePath, { recursive: true });

			const mailStore = createMailStore(join(overstoryDir, "mail.db"));
			const eventStore = createEventStore(join(overstoryDir, "sessions.db"));

			missionStore.create({ id: "m-resume", slug: "resume-mission", objective: "test" });
			missionStore.updateCurrentNode("m-resume", "understand:await-plan");

			const session = makeSession({
				id: "sess-coord",
				agentName: "coordinator-resume",
				worktreePath,
				tmuxSession: "tmux-coord",
			});
			sessionStore.upsert(session);
			missionStore.bindSessions("m-resume", { coordinatorSessionId: "sess-coord" });

			mailStore.insert({
				id: "mail-1",
				from: "worker-agent",
				to: "coordinator-resume",
				subject: "worker_done",
				body: "done",
				type: "worker_done",
				priority: "normal",
				threadId: null,
			});

			const resumeCalls: AgentSession[] = [];
			const _resumeAgent: MissionTickOpts["_resumeAgent"] = async (s) => {
				resumeCalls.push(s);
			};

			await runMissionTick(
				makeOpts(overstoryDir, missionStore, sessionStore, makeGateEngine(), {
					mailStore,
					eventStore,
					_listTmuxSessions: async () => [],
					_resumeAgent,
				}),
			);

			expect(resumeCalls).toHaveLength(1);
			expect(resumeCalls[0]?.agentName).toBe("coordinator-resume");

			const events = eventStore.getByAgent("engine");
			const resumeEvent = events.find(
				(e) => (e.eventType as string) === "engine_agent_resumed_on_mail",
			);
			expect(resumeEvent).toBeDefined();

			mailStore.close?.();
			eventStore.close?.();
		});

		test("no resume call when agent has no unread mail", async () => {
			const worktreePath = join(overstoryDir, "wt-coord2");
			await mkdir(worktreePath, { recursive: true });

			const mailStore = createMailStore(join(overstoryDir, "mail2.db"));

			missionStore.create({ id: "m-nomail", slug: "nomail-mission", objective: "test" });
			missionStore.updateCurrentNode("m-nomail", "understand:await-plan");

			const session = makeSession({
				id: "sess-coord2",
				agentName: "coordinator-nomail",
				worktreePath,
				tmuxSession: "tmux-coord2",
			});
			sessionStore.upsert(session);
			missionStore.bindSessions("m-nomail", { coordinatorSessionId: "sess-coord2" });

			const resumeCalls: AgentSession[] = [];
			const _resumeAgent: MissionTickOpts["_resumeAgent"] = async (s) => {
				resumeCalls.push(s);
			};

			await runMissionTick(
				makeOpts(overstoryDir, missionStore, sessionStore, makeGateEngine(), {
					mailStore,
					_listTmuxSessions: async () => [],
					_resumeAgent,
				}),
			);

			expect(resumeCalls).toHaveLength(0);

			mailStore.close?.();
		});

		test("no resume call when tmux is still alive", async () => {
			const worktreePath = join(overstoryDir, "wt-coord3");
			await mkdir(worktreePath, { recursive: true });

			const mailStore = createMailStore(join(overstoryDir, "mail3.db"));

			missionStore.create({ id: "m-alive", slug: "alive-mission", objective: "test" });
			missionStore.updateCurrentNode("m-alive", "understand:await-plan");

			const session = makeSession({
				id: "sess-coord3",
				agentName: "coordinator-alive",
				worktreePath,
				tmuxSession: "tmux-coord3",
			});
			sessionStore.upsert(session);
			missionStore.bindSessions("m-alive", { coordinatorSessionId: "sess-coord3" });

			mailStore.insert({
				id: "mail-alive",
				from: "worker",
				to: "coordinator-alive",
				subject: "done",
				body: "done",
				type: "worker_done",
				priority: "normal",
				threadId: null,
			});

			const resumeCalls: AgentSession[] = [];
			const _resumeAgent: MissionTickOpts["_resumeAgent"] = async (s) => {
				resumeCalls.push(s);
			};

			await runMissionTick(
				makeOpts(overstoryDir, missionStore, sessionStore, makeGateEngine(), {
					mailStore,
					_listTmuxSessions: async () => [{ name: "tmux-coord3", pid: 1234 }],
					_resumeAgent,
				}),
			);

			expect(resumeCalls).toHaveLength(0);

			mailStore.close?.();
		});

		test("no resume call when agent state is not waiting", async () => {
			const worktreePath = join(overstoryDir, "wt-coord4");
			await mkdir(worktreePath, { recursive: true });

			const mailStore = createMailStore(join(overstoryDir, "mail4.db"));

			missionStore.create({ id: "m-working", slug: "working-mission", objective: "test" });
			missionStore.updateCurrentNode("m-working", "understand:await-plan");

			const session = makeSession({
				id: "sess-coord4",
				agentName: "coordinator-working",
				worktreePath,
				tmuxSession: "tmux-coord4",
				state: "working",
			});
			sessionStore.upsert(session);
			missionStore.bindSessions("m-working", { coordinatorSessionId: "sess-coord4" });

			mailStore.insert({
				id: "mail-working",
				from: "worker",
				to: "coordinator-working",
				subject: "done",
				body: "done",
				type: "worker_done",
				priority: "normal",
				threadId: null,
			});

			const resumeCalls: AgentSession[] = [];
			const _resumeAgent: MissionTickOpts["_resumeAgent"] = async (s) => {
				resumeCalls.push(s);
			};

			await runMissionTick(
				makeOpts(overstoryDir, missionStore, sessionStore, makeGateEngine(), {
					mailStore,
					_listTmuxSessions: async () => [],
					_resumeAgent,
				}),
			);

			expect(resumeCalls).toHaveLength(0);

			mailStore.close?.();
		});

		test("no resume call when worktree path does not exist", async () => {
			const worktreePath = join(overstoryDir, "wt-missing-does-not-exist");
			// deliberately do NOT mkdir

			const mailStore = createMailStore(join(overstoryDir, "mail5.db"));

			missionStore.create({ id: "m-nowt", slug: "nowt-mission", objective: "test" });
			missionStore.updateCurrentNode("m-nowt", "understand:await-plan");

			const session = makeSession({
				id: "sess-coord5",
				agentName: "coordinator-nowt",
				worktreePath,
				tmuxSession: "tmux-coord5",
			});
			sessionStore.upsert(session);
			missionStore.bindSessions("m-nowt", { coordinatorSessionId: "sess-coord5" });

			mailStore.insert({
				id: "mail-nowt",
				from: "worker",
				to: "coordinator-nowt",
				subject: "done",
				body: "done",
				type: "worker_done",
				priority: "normal",
				threadId: null,
			});

			const resumeCalls: AgentSession[] = [];
			const _resumeAgent: MissionTickOpts["_resumeAgent"] = async (s) => {
				resumeCalls.push(s);
			};

			await runMissionTick(
				makeOpts(overstoryDir, missionStore, sessionStore, makeGateEngine(), {
					mailStore,
					_listTmuxSessions: async () => [],
					_resumeAgent,
				}),
			);

			expect(resumeCalls).toHaveLength(0);

			mailStore.close?.();
		});

		test("retry cap: 6 ticks, 5 attempts, 1 mission_finding", async () => {
			const worktreePath = join(overstoryDir, "wt-cap");
			await mkdir(worktreePath, { recursive: true });

			const mailStore = createMailStore(join(overstoryDir, "mail-cap.db"));

			missionStore.create({ id: "m-cap", slug: "cap-mission", objective: "test" });
			missionStore.updateCurrentNode("m-cap", "understand:await-plan");

			const session = makeSession({
				id: "sess-cap",
				agentName: "coordinator-cap",
				worktreePath,
				tmuxSession: "tmux-cap",
			});
			sessionStore.upsert(session);
			missionStore.bindSessions("m-cap", { coordinatorSessionId: "sess-cap" });

			mailStore.insert({
				id: "mail-cap",
				from: "worker",
				to: "coordinator-cap",
				subject: "done",
				body: "done",
				type: "worker_done",
				priority: "normal",
				threadId: null,
			});

			let resumeCallCount = 0;
			const _resumeAgent: MissionTickOpts["_resumeAgent"] = async () => {
				resumeCallCount++;
				throw new Error("tmux start failed");
			};

			const opts = makeOpts(overstoryDir, missionStore, sessionStore, makeGateEngine(), {
				mailStore,
				_listTmuxSessions: async () => [],
				_resumeAgent,
			});

			for (let i = 0; i < 6; i++) {
				await runMissionTick(opts);
			}

			expect(resumeCallCount).toBe(5);

			const findingMails = mailStore
				.getAll({ to: "coordinator-cap-mission" })
				.filter((m) => m.type === "mission_finding");
			// The coordinator name is `coordinator-${slug}` = "coordinator-cap-mission"
			expect(findingMails).toHaveLength(1);

			mailStore.close?.();
		});

		test("counter resets on success, fresh cap series after re-failure", async () => {
			const worktreePath = join(overstoryDir, "wt-reset");
			await mkdir(worktreePath, { recursive: true });

			const mailStore = createMailStore(join(overstoryDir, "mail-reset.db"));
			const eventStore = createEventStore(join(overstoryDir, "sessions-reset.db"));

			missionStore.create({ id: "m-reset", slug: "reset-mission", objective: "test" });
			missionStore.updateCurrentNode("m-reset", "understand:await-plan");

			const session = makeSession({
				id: "sess-reset",
				agentName: "coordinator-reset",
				worktreePath,
				tmuxSession: "tmux-reset",
			});
			sessionStore.upsert(session);
			missionStore.bindSessions("m-reset", { coordinatorSessionId: "sess-reset" });

			mailStore.insert({
				id: "mail-reset",
				from: "worker",
				to: "coordinator-reset",
				subject: "done",
				body: "done",
				type: "worker_done",
				priority: "normal",
				threadId: null,
			});

			let callCount = 0;
			const _resumeAgent: MissionTickOpts["_resumeAgent"] = async () => {
				callCount++;
				if (callCount < 3) throw new Error("fail");
			};

			const opts = makeOpts(overstoryDir, missionStore, sessionStore, makeGateEngine(), {
				mailStore,
				eventStore,
				_listTmuxSessions: async () => [],
				_resumeAgent,
			});

			// Run 3 ticks: fail, fail, succeed
			for (let i = 0; i < 3; i++) {
				await runMissionTick(opts);
			}

			expect(callCount).toBe(3);
			const resumeEvents = eventStore
				.getByAgent("engine")
				.filter((e) => (e.eventType as string) === "engine_agent_resumed_on_mail");
			expect(resumeEvents).toHaveLength(1);

			// Re-enter waiting state and add new mail
			sessionStore.updateState("coordinator-reset", "waiting");
			mailStore.insert({
				id: "mail-reset-2",
				from: "worker",
				to: "coordinator-reset",
				subject: "done again",
				body: "done",
				type: "worker_done",
				priority: "normal",
				threadId: null,
			});

			// Make resumeAgent throw again
			const resumeCallsPhase2: number[] = [];
			const opts2 = makeOpts(overstoryDir, missionStore, sessionStore, makeGateEngine(), {
				mailStore,
				eventStore,
				_listTmuxSessions: async () => [],
				_resumeAgent: async () => {
					resumeCallsPhase2.push(1);
					throw new Error("fail again");
				},
			});

			for (let i = 0; i < 6; i++) {
				await runMissionTick(opts2);
			}

			expect(resumeCallsPhase2).toHaveLength(5);

			const findingMails = mailStore
				.getAll({ to: "coordinator-reset-mission" })
				.filter((m) => m.type === "mission_finding");
			expect(findingMails).toHaveLength(1);

			mailStore.close?.();
			eventStore.close?.();
		});
	});

	test("does not send nudge for gate result still within grace period", async () => {
		missionStore.create({ id: "m-gate", slug: "gate-mission", objective: "test" });
		// Set currentNode so processMission can read it after step().
		missionStore.updateCurrentNode("m-gate", "understand:await-plan");

		const nudgeCalls: string[] = [];

		const engineFactory: MissionTickOpts["_startEngine"] = () => ({
			currentNodeId: () => "understand:await-plan",
			step: async (): Promise<StepResult> => ({
				status: "gate",
				fromNodeId: "understand:await-plan",
				toNodeId: "understand:await-plan",
				trigger: null,
			}),
			run: async () => ({
				status: "gate" as const,
				steps: [],
				currentNodeId: "understand:await-plan",
				gateType: "async" as const,
			}),
			advanceNode: async () => ({
				status: "completed" as const,
				steps: [],
				currentNodeId: "understand:done",
			}),
			forceAdvance: async () => ({
				status: "gate" as const,
				fromNodeId: "understand:await-plan",
				toNodeId: "understand:await-plan",
				trigger: null,
			}),
		});

		// Use a config with a very long grace period for "await-plan" so we stay within grace.
		const opts = makeOpts(overstoryDir, missionStore, sessionStore, engineFactory);
		opts.config = {
			...makeConfig(),
			mission: {
				gates: {
					gracePeriods: { "await-plan": 3_600_000 }, // 1-hour grace — tick is brand-new
				},
			},
		};

		await runMissionTick(opts);

		// No nudge should fire while within grace.
		expect(nudgeCalls).toHaveLength(0);
	});
});
