import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createEventStore } from "../events/store.ts";
import type { MulchClient } from "../mulch/client.ts";
import type { AgentSession, EventStore } from "../types.ts";
import { recordSessionInsights } from "./insights-recorder.ts";

function makeMulchClient(
	recordImpl?: (domain: string, options: unknown) => Promise<void>,
): MulchClient {
	return {
		async prime() {
			return "";
		},
		async status() {
			return { domains: [] };
		},
		async record(domain: string, options: unknown) {
			if (recordImpl) {
				return recordImpl(domain, options);
			}
		},
		async query() {
			return "";
		},
		async search() {
			return "";
		},
		async diff() {
			return { success: true, command: "diff", since: "HEAD", domains: [], message: "" };
		},
		async learn() {
			return {
				success: true,
				command: "learn",
				changedFiles: [],
				suggestedDomains: [],
				unmatchedFiles: [],
			};
		},
		async prune() {
			return { success: true, command: "prune", dryRun: false, totalPruned: 0, results: [] };
		},
		async doctor() {
			return {
				success: true,
				command: "doctor",
				checks: [],
				summary: { pass: 0, warn: 0, fail: 0 },
			};
		},
		async ready() {
			return { success: true, command: "ready", count: 0, entries: [] };
		},
		async compact() {
			return { success: true, command: "compact", action: "none" };
		},
		async appendOutcome() {},
	};
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "s-1",
		agentName: "test-agent",
		capability: "builder",
		runtime: "claude",
		worktreePath: "/tmp/wt",
		branchName: "b",
		taskId: "t",
		tmuxSession: "tm",
		state: "completed",
		pid: null,
		parentAgent: null,
		depth: 0,
		runId: null,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		rateLimitedSince: null,
		rateLimitResumesAt: null,
		runtimeSessionId: null,
		transcriptPath: null,
		originalRuntime: null,
		statusLine: null,
		toolInFlightStartedAt: null,
		toolInFlightName: null,
		...overrides,
	};
}

function insertStandardEvents(eventStore: EventStore, agentName: string): void {
	for (let i = 0; i < 12; i++) {
		eventStore.insert({
			runId: null,
			agentName,
			sessionId: null,
			eventType: "tool_start",
			toolName: "Read",
			toolArgs: JSON.stringify({ file_path: "src/foo.ts" }),
			toolDurationMs: 10,
			level: "info",
			data: null,
		});
	}
	for (let i = 0; i < 3; i++) {
		eventStore.insert({
			runId: null,
			agentName,
			sessionId: null,
			eventType: "tool_start",
			toolName: "Edit",
			toolArgs: JSON.stringify({ file_path: "src/foo.ts" }),
			toolDurationMs: 20,
			level: "info",
			data: null,
		});
	}
}

describe("recordSessionInsights", () => {
	let eventStore: EventStore;

	beforeEach(() => {
		eventStore = createEventStore(":memory:");
	});

	afterEach(() => {
		eventStore.close();
	});

	test("completed session emits one record per insight", async () => {
		insertStandardEvents(eventStore, "test-agent");

		const calls: Array<{ domain: string; options: unknown }> = [];
		const mulchClient = makeMulchClient(async (domain, options) => {
			calls.push({ domain, options });
		});

		const session = makeSession({ state: "completed" });
		await recordSessionInsights({ session, eventStore, mulchClient });

		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			const opts = call.options as { outcomeStatus: string; outcomeAgent: string };
			expect(opts.outcomeStatus).toBe("success");
			expect(opts.outcomeAgent).toBe("test-agent");
		}
	});

	test("zombie session maps to failure", async () => {
		insertStandardEvents(eventStore, "test-agent");

		const calls: Array<{ domain: string; options: unknown }> = [];
		const mulchClient = makeMulchClient(async (domain, options) => {
			calls.push({ domain, options });
		});

		const session = makeSession({ state: "zombie" });
		await recordSessionInsights({ session, eventStore, mulchClient });

		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			const opts = call.options as { outcomeStatus: string };
			expect(opts.outcomeStatus).toBe("failure");
		}
	});

	test("escalated session maps to failure", async () => {
		insertStandardEvents(eventStore, "test-agent");

		const calls: Array<{ domain: string; options: unknown }> = [];
		const mulchClient = makeMulchClient(async (domain, options) => {
			calls.push({ domain, options });
		});

		const session = makeSession({
			state: "escalated" as unknown as AgentSession["state"],
		});
		await recordSessionInsights({ session, eventStore, mulchClient });

		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			const opts = call.options as { outcomeStatus: string };
			expect(opts.outcomeStatus).toBe("failure");
		}
	});

	test("working session → early return, no record calls", async () => {
		insertStandardEvents(eventStore, "test-agent");

		let callCount = 0;
		const mulchClient = makeMulchClient(async () => {
			callCount++;
		});

		const session = makeSession({ state: "working" });
		await recordSessionInsights({ session, eventStore, mulchClient });

		expect(callCount).toBe(0);
	});

	test("waiting session → early return, no record calls", async () => {
		insertStandardEvents(eventStore, "test-agent");

		let callCount = 0;
		const mulchClient = makeMulchClient(async () => {
			callCount++;
		});

		const session = makeSession({ state: "waiting" });
		await recordSessionInsights({ session, eventStore, mulchClient });

		expect(callCount).toBe(0);
	});

	test("booting session → early return, no record calls", async () => {
		insertStandardEvents(eventStore, "test-agent");

		let callCount = 0;
		const mulchClient = makeMulchClient(async () => {
			callCount++;
		});

		const session = makeSession({ state: "booting" });
		await recordSessionInsights({ session, eventStore, mulchClient });

		expect(callCount).toBe(0);
	});

	test("stalled session → early return, no record calls", async () => {
		insertStandardEvents(eventStore, "test-agent");

		let callCount = 0;
		const mulchClient = makeMulchClient(async () => {
			callCount++;
		});

		const session = makeSession({ state: "stalled" });
		await recordSessionInsights({ session, eventStore, mulchClient });

		expect(callCount).toBe(0);
	});

	test("mulch.record throwing does NOT propagate", async () => {
		insertStandardEvents(eventStore, "test-agent");

		const mulchClient = makeMulchClient(async () => {
			throw new Error("boom");
		});

		const warnCalls: string[] = [];
		const logger = {
			warn: (msg: string) => {
				warnCalls.push(msg);
			},
		};

		const session = makeSession({ state: "completed" });
		await expect(
			recordSessionInsights({ session, eventStore, mulchClient, logger }),
		).resolves.toBeUndefined();

		expect(warnCalls.length).toBeGreaterThan(0);
	});

	test("mulch.record per-insight failure is isolated", async () => {
		insertStandardEvents(eventStore, "test-agent");

		let callCount = 0;
		const mulchClient = makeMulchClient(async () => {
			callCount++;
			if (callCount === 1) {
				throw new Error("first call fails");
			}
		});

		const session = makeSession({ state: "completed" });
		await recordSessionInsights({ session, eventStore, mulchClient });

		expect(callCount).toBeGreaterThanOrEqual(2);
	});
});
