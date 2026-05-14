/**
 * RED-phase tests for pr-phase cell (T-w3-1 .. T-w3-23).
 *
 * Imports `prPhaseCell` from a stub that currently returns an empty graph
 * and no handlers — every assertion below intentionally fails at runtime
 * until the w3 builder implements pr-phase.ts. Tests compile under TS
 * strict mode because the stub satisfies PhaseCellDefinition.
 *
 * FIXME(w3-builder): once the builder lands:
 *   - PhaseCellConfig must accept a `pr?: PrConfig` block (see makeConfig
 *     below). Today we cast through `unknown` because the field isn't on
 *     the interface yet.
 *   - Handlers will read budget via getGhBudget() — tests inject a fake
 *     budget via setGhBudget() and restore in afterEach.
 *   - DebugBriefRequestPayload becomes a discriminated union with
 *     `failureSource: 'ci'|'holdout'`; for now this file does not import
 *     that type (see pr-phase-triggers.test.ts T-w3-26).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Mission, MissionStore } from "../../types.ts";
import type { GhBudget, GhInvocationResult } from "../gh-budget.ts";
import { getGhBudget, setGhBudget } from "../gh-budget.ts";
import { createMockMissionStore, makeMission } from "../test-mocks.ts";
import type { HandlerContext } from "../types.ts";
import { prPhaseCell } from "./pr-phase.ts";
import type { PhaseCellConfig, PhaseCellDeps } from "./types.ts";

// FIXME(w3-builder): drop the cast once PhaseCellConfig has a `pr` field.
type ConfigOverrides = Partial<PhaseCellConfig> & { pr?: Record<string, unknown> };

function makeConfig(overrides?: ConfigOverrides): PhaseCellConfig {
	const base = {
		missionId: "m1",
		artifactRoot: "/tmp/a",
		projectRoot: "/tmp/p",
		tier: "planned" as const,
		pr: {
			enabled: true,
			ciTimeoutMs: 14_400_000,
			commentsTimeoutMs: 604_800_000,
			approvalTimeoutMs: 172_800_000,
			mergeStrategy: "squash",
			maxTriageSpawnsPerMission: 50,
			maxTriagePerAuthorPerHour: 5,
			maxCoordinatorResumesPerPr: 3,
			commentTriageAuthors: ["op", "reviewer1"],
			operatorGithubLogin: "op",
			triage: { minConfidence: 0.7 },
			classifyCiRed: { flakeThresholdMs: 30_000, maxFlakeRetries: 3 },
			...(overrides?.pr ?? {}),
		},
		...(overrides ?? {}),
	};
	return base as unknown as PhaseCellConfig;
}

function makeBaseDeps(overrides?: Partial<PhaseCellDeps>): PhaseCellDeps {
	return {
		mailSend: async () => {},
		checkpointStore: {} as PhaseCellDeps["checkpointStore"],
		missionStore: createMockMissionStore() as unknown as PhaseCellDeps["missionStore"],
		overstoryDir: "/tmp/overstory",
		projectRoot: "/tmp/p",
		...(overrides ?? {}),
	};
}

function makeCtx(opts: {
	mission?: Mission | null;
	checkpoint?: unknown;
	nodeId?: string;
	saveCheckpoint?: (data: unknown) => Promise<void>;
	sendMail?: (to: string, subject: string, body: string, type: string) => Promise<void>;
}): HandlerContext {
	return {
		missionId: "m1",
		nodeId: opts.nodeId ?? "pr-phase:preflight",
		checkpoint: opts.checkpoint ?? null,
		saveCheckpoint: opts.saveCheckpoint ?? (async () => {}),
		sendMail: opts.sendMail ?? (async () => {}),
		getMission: () => opts.mission ?? null,
	} as HandlerContext;
}

interface GhCall {
	args: readonly string[];
	opts?: { cwd?: string; env?: Record<string, string> };
}

function makeFakeGhBudget(responder: (call: GhCall) => Partial<GhInvocationResult>): {
	budget: GhBudget;
	calls: GhCall[];
} {
	const calls: GhCall[] = [];
	const budget: GhBudget = {
		runGh: async (args, opts) => {
			calls.push({ args, opts });
			const r = responder({ args, opts });
			return {
				stdout: r.stdout ?? "",
				stderr: r.stderr ?? "",
				exitCode: r.exitCode ?? 0,
				durationMs: r.durationMs ?? 1,
			};
		},
		snapshot: () => ({ tokensAvailable: 100, queuedCount: 0, lastRateLimitResetAt: null }),
	};
	return { budget, calls };
}

// =============================================================================
// Subgraph integrity: T-w3-1 .. T-w3-5
// =============================================================================

describe("prPhaseCell.buildSubgraph — subgraph integrity", () => {
	test("T-w3-1: returns exactly 17 nodes, all kind:cell + cellType:pr-phase", () => {
		const graph = prPhaseCell.buildSubgraph(makeConfig());
		expect(graph.nodes).toHaveLength(17);
		for (const node of graph.nodes) {
			expect(node.kind).toBe("cell");
			if (node.kind === "cell") {
				expect(node.cellType).toBe("pr-phase");
			}
		}
	});

	test("T-w3-2: every node id starts with 'pr-phase:' (graph must be non-empty)", () => {
		const graph = prPhaseCell.buildSubgraph(makeConfig());
		// Guard against vacuous pass on an empty subgraph during RED phase.
		expect(graph.nodes.length).toBeGreaterThanOrEqual(17);
		for (const node of graph.nodes) {
			expect(node.id).toStartWith("pr-phase:");
		}
	});

	test("T-w3-3: every async-gate node has its onTimeout edge", () => {
		const graph = prPhaseCell.buildSubgraph(makeConfig());

		// await-ci → escalate via ci_timeout
		const awaitCi = graph.nodes.find((n) => n.id === "pr-phase:await-ci");
		expect(awaitCi?.gate).toBe("async");
		const ciTimeoutEdge = graph.edges.find(
			(e) => e.from === "pr-phase:await-ci" && e.trigger === "ci_timeout",
		);
		expect(ciTimeoutEdge?.to).toBe("pr-phase:escalate");

		// await-comments → escalate via comments_stale
		const awaitComments = graph.nodes.find((n) => n.id === "pr-phase:await-comments");
		expect(awaitComments?.gate).toBe("async");
		const commentsStaleEdge = graph.edges.find(
			(e) => e.from === "pr-phase:await-comments" && e.trigger === "comments_stale",
		);
		expect(commentsStaleEdge?.to).toBe("pr-phase:escalate");

		// await-approval → escalate via approval_pending_long
		const awaitApproval = graph.nodes.find((n) => n.id === "pr-phase:await-approval");
		expect(awaitApproval?.gate).toBe("async");
		const approvalLongEdge = graph.edges.find(
			(e) => e.from === "pr-phase:await-approval" && e.trigger === "approval_pending_long",
		);
		expect(approvalLongEdge?.to).toBe("pr-phase:escalate");

		// await-debug-complete → check-debug-attempts via debug_timeout
		const awaitDebug = graph.nodes.find((n) => n.id === "pr-phase:await-debug-complete");
		expect(awaitDebug?.gate).toBe("async");
		const debugTimeoutEdge = graph.edges.find(
			(e) => e.from === "pr-phase:await-debug-complete" && e.trigger === "debug_timeout",
		);
		expect(debugTimeoutEdge?.to).toBe("pr-phase:check-debug-attempts");
	});

	test("T-w3-4: nine S8 failure triggers each have ≥1 outbound edge", () => {
		const graph = prPhaseCell.buildSubgraph(makeConfig());
		const failureTriggers = [
			"gh_auth_missing",
			"pr_create_network_fail",
			"pr_already_exists",
			"pr_rate_limited",
			"pr_branch_protected",
			"pr_no_commits",
			"ci_timeout",
			"capability_missing",
			"pr_merge_conflict",
		];
		const triggers = new Set(graph.edges.map((e) => e.trigger));
		for (const t of failureTriggers) {
			expect(triggers.has(t)).toBe(true);
		}
	});

	test("T-w3-5: preflight with pr.enabled=false → {trigger: pr_phase_disabled}", async () => {
		const handlers = prPhaseCell.buildHandlers(
			makeBaseDeps(),
			makeConfig({ pr: { enabled: false } }),
		);
		const preflight = handlers.preflight;
		expect(preflight).toBeDefined();
		if (!preflight) return;
		const result = await preflight(
			makeCtx({ mission: makeMission({ slug: "m1" }) as unknown as Mission }),
		);
		expect(result.trigger).toBe("pr_phase_disabled");
	});
});

// =============================================================================
// preflight / create: T-w3-6, T-w3-7
// =============================================================================

describe("prPhaseCell preflight + create handlers", () => {
	let savedBudget: GhBudget | null;

	beforeEach(() => {
		// Snapshot the current budget so we can restore in afterEach.
		// getGhBudget() lazily initializes a default if none is set.
		savedBudget = null;
		try {
			savedBudget = getGhBudget();
		} catch {
			savedBudget = null;
		}
	});

	afterEach(() => {
		setGhBudget(savedBudget);
	});

	test("T-w3-6: gh auth status exit=1 → preflight returns {trigger: gh_auth_missing}", async () => {
		const { budget, calls } = makeFakeGhBudget(({ args }) => {
			if (args[0] === "auth" && args[1] === "status") {
				return { exitCode: 1, stderr: "not authenticated" };
			}
			return { exitCode: 0 };
		});
		setGhBudget(budget);

		const handlers = prPhaseCell.buildHandlers(makeBaseDeps());
		const preflight = handlers.preflight;
		expect(preflight).toBeDefined();
		if (!preflight) return;

		const result = await preflight(
			makeCtx({ mission: makeMission({ slug: "m1" }) as unknown as Mission }),
		);
		expect(result.trigger).toBe("gh_auth_missing");
		expect(calls.some((c) => c.args[0] === "auth" && c.args[1] === "status")).toBe(true);
	});

	test("T-w3-308: stderr '429' no longer fires pr_rate_limited — falls through to pr_create_network_fail (#308)", async () => {
		const { budget } = makeFakeGhBudget(({ args }) => {
			if (args[0] === "pr" && args[1] === "create") {
				return { exitCode: 1, stderr: "error 429 too many requests" };
			}
			return { exitCode: 0 };
		});
		setGhBudget(budget);

		const handlers = prPhaseCell.buildHandlers(makeBaseDeps());
		const create = handlers.create;
		expect(create).toBeDefined();
		if (!create) return;

		const result = await create(
			makeCtx({
				mission: makeMission({ featureBranch: "feature/x" }) as unknown as Mission,
			}),
		);
		expect(result.trigger).toBe("pr_create_network_fail");
	});

	test("T-w3-308b: stderr 'rate limit' no longer fires pr_rate_limited — falls through to pr_create_network_fail (#308)", async () => {
		const { budget } = makeFakeGhBudget(({ args }) => {
			if (args[0] === "pr" && args[1] === "create") {
				return { exitCode: 1, stderr: "rate limit exceeded" };
			}
			return { exitCode: 0 };
		});
		setGhBudget(budget);

		const handlers = prPhaseCell.buildHandlers(makeBaseDeps());
		const create = handlers.create;
		expect(create).toBeDefined();
		if (!create) return;

		const result = await create(
			makeCtx({
				mission: makeMission({ featureBranch: "feature/x" }) as unknown as Mission,
			}),
		);
		expect(result.trigger).toBe("pr_create_network_fail");
	});

	test("T-w3-7: gh pr create 'already exists' → looks up existing PR and returns pr_already_exists", async () => {
		const upsertCalls: Array<{ missionId: string; prNumber: number; prUrl: string }> = [];
		const missionStore = createMockMissionStore();
		missionStore.upsertPrState = (row) => {
			upsertCalls.push({ missionId: row.missionId, prNumber: row.prNumber, prUrl: row.prUrl });
		};

		const { budget } = makeFakeGhBudget(({ args }) => {
			if (args[0] === "auth" && args[1] === "status") return { exitCode: 0 };
			if (args[0] === "pr" && args[1] === "create") {
				return {
					exitCode: 1,
					stderr: "a pull request for branch 'x' into 'main' already exists: #42",
				};
			}
			if (args[0] === "pr" && args[1] === "view") {
				return {
					exitCode: 0,
					stdout: JSON.stringify({
						number: 42,
						url: "https://github.com/x/y/pull/42",
						headRefOid: "abc123",
					}),
				};
			}
			return { exitCode: 0 };
		});
		setGhBudget(budget);

		const handlers = prPhaseCell.buildHandlers(
			makeBaseDeps({
				missionStore: missionStore as unknown as PhaseCellDeps["missionStore"],
			}),
		);
		const create = handlers.create;
		expect(create).toBeDefined();
		if (!create) return;

		const result = await create(
			makeCtx({
				nodeId: "pr-phase:create",
				mission: makeMission({
					slug: "m1",
					featureBranch: "feature/x",
				}) as unknown as Mission,
			}),
		);
		expect(result.trigger).toBe("pr_already_exists");
		const payload = (result as { payload?: { prNumber?: number; prUrl?: string } }).payload ?? {};
		expect(payload.prNumber).toBe(42);
		expect(payload.prUrl).toBe("https://github.com/x/y/pull/42");
		expect(upsertCalls).toHaveLength(1);
		expect(upsertCalls[0]?.prNumber).toBe(42);
	});
});

// =============================================================================
// classify-ci-red: T-w3-8 .. T-w3-11
// =============================================================================

describe("prPhaseCell classify-ci-red handler", () => {
	function callClassify(opts: {
		checks: Array<{ conclusion: string; durationMs: number }>;
		checkpoint?: unknown;
		onSaveCheckpoint?: (data: unknown) => void;
	}) {
		const handlers = prPhaseCell.buildHandlers(makeBaseDeps());
		const classify = handlers["classify-ci-red"];
		expect(classify).toBeDefined();
		if (!classify) throw new Error("missing handler");
		const ctx = makeCtx({
			nodeId: "pr-phase:classify-ci-red",
			mission: makeMission() as unknown as Mission,
			checkpoint: { checks: opts.checks, ...(opts.checkpoint as object | undefined) },
			saveCheckpoint: async (data: unknown) => {
				opts.onSaveCheckpoint?.(data);
			},
		});
		return classify(ctx);
	}

	test("T-w3-8: CANCELLED check → ci_infra_fail", async () => {
		const result = await callClassify({
			checks: [{ conclusion: "CANCELLED", durationMs: 1000 }],
		});
		expect(result.trigger).toBe("ci_infra_fail");
	});

	test("T-w3-9: all FAILURE checks under 30s → ci_flake_retry + checkpoint records nextPollAfter", async () => {
		let saved: unknown = null;
		const result = await callClassify({
			checks: [
				{ conclusion: "FAILURE", durationMs: 5_000 },
				{ conclusion: "FAILURE", durationMs: 5_000 },
			],
			onSaveCheckpoint: (data) => {
				saved = data;
			},
		});
		expect(result.trigger).toBe("ci_flake_retry");
		const cp = saved as { flakeRetryCount?: number; nextPollAfter?: string } | null;
		expect(cp?.flakeRetryCount).toBe(1);
		expect(cp?.nextPollAfter).toBeDefined();
	});

	test("T-w3-10: FAILURE with durationMs=60000 → ci_code_fail", async () => {
		const result = await callClassify({
			checks: [{ conclusion: "FAILURE", durationMs: 60_000 }],
		});
		expect(result.trigger).toBe("ci_code_fail");
	});

	test("T-w3-11: pre-existing flakeRetryCount=3 + FAILURE under threshold → ci_code_fail", async () => {
		const result = await callClassify({
			checks: [{ conclusion: "FAILURE", durationMs: 5_000 }],
			checkpoint: { flakeRetryCount: 3 },
		});
		expect(result.trigger).toBe("ci_code_fail");
	});
});

// =============================================================================
// dispatch-triage: T-w3-12 .. T-w3-14
// =============================================================================

describe("prPhaseCell dispatch-triage handler", () => {
	function makeStoreWithCounts(opts: {
		spawnsSince?: number;
		perAuthor?: number;
		onUpdateAction?: (commentId: string, action: string, status: string) => void;
	}): MissionStore {
		const store = createMockMissionStore();
		store.countTriageSpawnsSince = () => opts.spawnsSince ?? 0;
		store.countTriagePerAuthorSince = () => opts.perAuthor ?? 0;
		if (opts.onUpdateAction) {
			store.updatePrCommentAction = opts.onUpdateAction;
		}
		return store as unknown as MissionStore;
	}

	test("T-w3-12: author NOT in allowlist → updatePrCommentAction(reply_only) + no spawn", async () => {
		let spawnCalled = 0;
		const fakeSpawn = ((..._args: unknown[]) => {
			spawnCalled++;
			throw new Error("spawn must not be called for unauthorized author");
		}) as unknown as typeof Bun.spawn;

		const updates: Array<{ commentId: string; action: string; status: string }> = [];
		const missionStore = makeStoreWithCounts({
			onUpdateAction: (commentId, action, status) => {
				updates.push({ commentId, action, status });
			},
		});

		const handlers = prPhaseCell.buildHandlers(
			makeBaseDeps({
				missionStore: missionStore as unknown as PhaseCellDeps["missionStore"],
				spawn: fakeSpawn,
			}),
		);
		const dispatch = handlers["dispatch-triage"];
		expect(dispatch).toBeDefined();
		if (!dispatch) return;

		const result = await dispatch(
			makeCtx({
				nodeId: "pr-phase:dispatch-triage",
				mission: makeMission() as unknown as Mission,
				checkpoint: {
					comment: {
						commentId: "c1",
						author: "stranger",
						body: "drive-by comment",
					},
				},
			}),
		);
		// Builder may emit reply_only directly or via another trigger string —
		// the contract is updatePrCommentAction recorded reply_only/responded
		// and spawn was not invoked.
		expect(spawnCalled).toBe(0);
		expect(updates).toHaveLength(1);
		expect(updates[0]?.action).toBe("reply_only");
		expect(updates[0]?.status).toBe("responded");
		expect(result.trigger).toBe("reply_only");
	});

	test("T-w3-13: spawnsThisMission=50 → pr_triage_flood {kind: per_mission, limit: 50}", async () => {
		const missionStore = makeStoreWithCounts({ spawnsSince: 50 });
		const handlers = prPhaseCell.buildHandlers(
			makeBaseDeps({
				missionStore: missionStore as unknown as PhaseCellDeps["missionStore"],
			}),
			makeConfig(),
		);
		const dispatch = handlers["dispatch-triage"];
		expect(dispatch).toBeDefined();
		if (!dispatch) return;

		const result = await dispatch(
			makeCtx({
				nodeId: "pr-phase:dispatch-triage",
				mission: makeMission() as unknown as Mission,
				checkpoint: {
					comment: { commentId: "c2", author: "op", body: "fix this" },
				},
			}),
		);
		expect(result.trigger).toBe("pr_triage_flood");
		const payload = (result as { payload?: { kind?: string; limit?: number } }).payload ?? {};
		expect(payload.kind).toBe("per_mission");
		expect(payload.limit).toBe(50);
	});

	test("T-w3-14: per-author count=5 → pr_triage_flood {kind: per_author, limit: 5}", async () => {
		const missionStore = makeStoreWithCounts({ spawnsSince: 0, perAuthor: 5 });
		const handlers = prPhaseCell.buildHandlers(
			makeBaseDeps({
				missionStore: missionStore as unknown as PhaseCellDeps["missionStore"],
			}),
			makeConfig(),
		);
		const dispatch = handlers["dispatch-triage"];
		expect(dispatch).toBeDefined();
		if (!dispatch) return;

		const result = await dispatch(
			makeCtx({
				nodeId: "pr-phase:dispatch-triage",
				mission: makeMission() as unknown as Mission,
				checkpoint: {
					comment: { commentId: "c3", author: "op", body: "fix this" },
				},
			}),
		);
		expect(result.trigger).toBe("pr_triage_flood");
		const payload = (result as { payload?: { kind?: string; limit?: number } }).payload ?? {};
		expect(payload.kind).toBe("per_author");
		expect(payload.limit).toBe(5);
	});
});

// =============================================================================
// Confidence override: T-w3-15, T-w3-16
// =============================================================================

describe("prPhaseCell triage classification confidence override", () => {
	test("T-w3-15: classification.confidence=0.5 → human_triage_request", async () => {
		const handlers = prPhaseCell.buildHandlers(makeBaseDeps());
		const dispatch = handlers["dispatch-triage"];
		expect(dispatch).toBeDefined();
		if (!dispatch) return;

		const result = await dispatch(
			makeCtx({
				nodeId: "pr-phase:dispatch-triage",
				mission: makeMission() as unknown as Mission,
				checkpoint: {
					comment: { commentId: "c4", author: "op", body: "fix this" },
					classification: { action: "trivial_fix", confidence: 0.5 },
				},
			}),
		);
		expect(result.trigger).toBe("human_triage_request");
	});

	test("T-w3-16: trivial_fix + confidence=0.80 < 0.85 → human_triage_request", async () => {
		const handlers = prPhaseCell.buildHandlers(makeBaseDeps());
		const dispatch = handlers["dispatch-triage"];
		expect(dispatch).toBeDefined();
		if (!dispatch) return;

		const result = await dispatch(
			makeCtx({
				nodeId: "pr-phase:dispatch-triage",
				mission: makeMission() as unknown as Mission,
				checkpoint: {
					comment: { commentId: "c5", author: "op", body: "fix this" },
					classification: { action: "trivial_fix", confidence: 0.8 },
				},
			}),
		);
		expect(result.trigger).toBe("human_triage_request");
	});
});

// =============================================================================
// resume-coordinator: T-w3-17 .. T-w3-19
// =============================================================================

describe("prPhaseCell resume-coordinator handler", () => {
	test("T-w3-17: coordinatorSessionId=null → coordinator_session_unavailable, no spawn", async () => {
		let spawnCalled = 0;
		const fakeSpawn = (() => {
			spawnCalled++;
			throw new Error("spawn must not be called when coordinatorSessionId is null");
		}) as unknown as typeof Bun.spawn;

		const handlers = prPhaseCell.buildHandlers(makeBaseDeps({ spawn: fakeSpawn }));
		const resume = handlers["resume-coordinator"];
		expect(resume).toBeDefined();
		if (!resume) return;

		const mission = makeMission() as Mission;
		(mission as { coordinatorSessionId: string | null }).coordinatorSessionId = null;

		const result = await resume(makeCtx({ nodeId: "pr-phase:resume-coordinator", mission }));
		expect(result.trigger).toBe("coordinator_session_unavailable");
		expect(spawnCalled).toBe(0);
	});

	test("T-w3-18: valid coordinatorSessionId → spec includes pr-comments/<id>.json, no raw body", async () => {
		const spawnArgsLog: string[][] = [];
		const fakeSpawn = ((cmd: string[]) => {
			spawnArgsLog.push([...cmd]);
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
		}) as unknown as typeof Bun.spawn;

		const handlers = prPhaseCell.buildHandlers(makeBaseDeps({ spawn: fakeSpawn }));
		const resume = handlers["resume-coordinator"];
		expect(resume).toBeDefined();
		if (!resume) return;

		const mission = makeMission() as Mission;
		(mission as { coordinatorSessionId: string | null }).coordinatorSessionId = "sess-abc";
		(mission as { artifactRoot: string | null }).artifactRoot = "/tmp/a";

		const rawBody = "please refactor this scary function";
		await resume(
			makeCtx({
				nodeId: "pr-phase:resume-coordinator",
				mission,
				checkpoint: {
					comment: { commentId: "c6", author: "op", body: rawBody },
					classification: { action: "refactor_request", confidence: 0.95 },
				},
			}),
		);

		const flatArgs = spawnArgsLog.flat().join(" ");
		expect(flatArgs).toContain("pr-comments/c6.json");
		expect(flatArgs).not.toContain(rawBody);
	});

	test("T-w3-19: pre-existing coordinatorResumeCount=3 (cap) → pr_triage_flood {kind: coordinator_resume_cap}", async () => {
		const handlers = prPhaseCell.buildHandlers(makeBaseDeps());
		const resume = handlers["resume-coordinator"];
		expect(resume).toBeDefined();
		if (!resume) return;

		const mission = makeMission() as Mission;
		(mission as { coordinatorSessionId: string | null }).coordinatorSessionId = "sess-abc";

		const result = await resume(
			makeCtx({
				nodeId: "pr-phase:resume-coordinator",
				mission,
				checkpoint: {
					coordinatorResumeCount: 3,
					comment: { commentId: "c7", author: "op", body: "again" },
					classification: { action: "refactor_request", confidence: 0.95 },
				},
			}),
		);
		expect(result.trigger).toBe("pr_triage_flood");
		const payload = (result as { payload?: { kind?: string } }).payload ?? {};
		expect(payload.kind).toBe("coordinator_resume_cap");
	});
});

// =============================================================================
// merge: T-w3-20 .. T-w3-23
// =============================================================================

describe("prPhaseCell merge handler", () => {
	let savedBudget: GhBudget | null;

	beforeEach(() => {
		savedBudget = null;
		try {
			savedBudget = getGhBudget();
		} catch {
			savedBudget = null;
		}
	});

	afterEach(() => {
		setGhBudget(savedBudget);
	});

	test("T-w3-20: getPrState approvedHeadSha=null → pr_head_changed; graphql NOT called", async () => {
		const missionStore = createMockMissionStore();
		missionStore.getPrState = () => ({
			missionId: "m1",
			prNumber: 1,
			prUrl: "url",
			branch: "feature/x",
			createdAt: "",
			lastCiStatus: null,
			lastReviewDecision: null,
			approvedHeadSha: null,
			mergedAt: null,
		});

		const { budget, calls } = makeFakeGhBudget(() => ({ exitCode: 0 }));
		setGhBudget(budget);

		const handlers = prPhaseCell.buildHandlers(
			makeBaseDeps({ missionStore: missionStore as unknown as PhaseCellDeps["missionStore"] }),
		);
		const merge = handlers.merge;
		expect(merge).toBeDefined();
		if (!merge) return;

		const result = await merge(
			makeCtx({ nodeId: "pr-phase:merge", mission: makeMission() as unknown as Mission }),
		);
		expect(result.trigger).toBe("pr_head_changed");
		const payload = (result as { payload?: { reason?: string } }).payload ?? {};
		expect(payload.reason).toContain("approved_head_sha");
		const graphqlCalls = calls.filter((c) => c.args[0] === "api" && c.args[1] === "graphql");
		expect(graphqlCalls).toHaveLength(0);
	});

	test("T-w3-21: approvedSha=sha-approved but current=sha-current → pr_head_changed; graphql NOT called", async () => {
		const missionStore = createMockMissionStore();
		missionStore.getPrState = () => ({
			missionId: "m1",
			prNumber: 1,
			prUrl: "url",
			branch: "feature/x",
			createdAt: "",
			lastCiStatus: null,
			lastReviewDecision: null,
			approvedHeadSha: "sha-approved",
			mergedAt: null,
		});

		const { budget, calls } = makeFakeGhBudget(({ args }) => {
			if (args[0] === "pr" && args[1] === "view") {
				return { exitCode: 0, stdout: JSON.stringify({ headRefOid: "sha-current" }) };
			}
			return { exitCode: 0 };
		});
		setGhBudget(budget);

		const handlers = prPhaseCell.buildHandlers(
			makeBaseDeps({ missionStore: missionStore as unknown as PhaseCellDeps["missionStore"] }),
		);
		const merge = handlers.merge;
		expect(merge).toBeDefined();
		if (!merge) return;

		const result = await merge(
			makeCtx({ nodeId: "pr-phase:merge", mission: makeMission() as unknown as Mission }),
		);
		expect(result.trigger).toBe("pr_head_changed");
		const payload =
			(result as { payload?: { approvedSha?: string; currentSha?: string } }).payload ?? {};
		expect(payload.approvedSha).toBe("sha-approved");
		expect(payload.currentSha).toBe("sha-current");
		const graphqlCalls = calls.filter((c) => c.args[0] === "api" && c.args[1] === "graphql");
		expect(graphqlCalls).toHaveLength(0);
	});

	test("T-w3-22: matching SHA → graphql mergePullRequest invoked, markPrMerged called", async () => {
		const missionStore = createMockMissionStore();
		missionStore.getPrState = () => ({
			missionId: "m1",
			prNumber: 1,
			prUrl: "url",
			branch: "feature/x",
			createdAt: "",
			lastCiStatus: null,
			lastReviewDecision: null,
			approvedHeadSha: "sha1",
			mergedAt: null,
		});
		const merged: Array<{ missionId: string; mergedAt: string }> = [];
		missionStore.markPrMerged = (missionId: string, mergedAt: string) => {
			merged.push({ missionId, mergedAt });
		};

		const { budget, calls } = makeFakeGhBudget(({ args }) => {
			if (args[0] === "pr" && args[1] === "view") {
				return { exitCode: 0, stdout: JSON.stringify({ headRefOid: "sha1" }) };
			}
			if (args[0] === "api" && args[1] === "graphql") {
				return { exitCode: 0, stdout: JSON.stringify({ data: { mergePullRequest: {} } }) };
			}
			return { exitCode: 0 };
		});
		setGhBudget(budget);

		const handlers = prPhaseCell.buildHandlers(
			makeBaseDeps({ missionStore: missionStore as unknown as PhaseCellDeps["missionStore"] }),
		);
		const merge = handlers.merge;
		expect(merge).toBeDefined();
		if (!merge) return;

		const result = await merge(
			makeCtx({ nodeId: "pr-phase:merge", mission: makeMission() as unknown as Mission }),
		);
		expect(result.trigger).toBe("merged");

		expect(merged).toHaveLength(1);
		expect(merged[0]?.missionId).toBe("m1");
		// ISO timestamp shape (cheap regex)
		expect(merged[0]?.mergedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);

		const graphqlCalls = calls.filter((c) => c.args[0] === "api" && c.args[1] === "graphql");
		expect(graphqlCalls.length).toBeGreaterThanOrEqual(1);
		const flat = graphqlCalls.map((c) => c.args.join(" ")).join(" ");
		expect(flat).toContain("mergePullRequest");
		expect(flat).toContain("sha1");
		expect(flat).toContain("SQUASH");
	});

	test("T-w3-307-vars: typed variables — pullRequestId and expectedHeadOid as separate -f flags, not in query= (#307)", async () => {
		const missionStore = createMockMissionStore();
		missionStore.getPrState = () => ({
			missionId: "m1",
			prNumber: 1,
			prUrl: "url",
			branch: "feature/x",
			createdAt: "",
			lastCiStatus: null,
			lastReviewDecision: null,
			approvedHeadSha: "sha-test",
			mergedAt: null,
		});

		const { budget, calls } = makeFakeGhBudget(({ args }) => {
			if (args[0] === "pr" && args[1] === "view") {
				return {
					exitCode: 0,
					stdout: JSON.stringify({ headRefOid: "sha-test", id: "PR_ID_123" }),
				};
			}
			if (args[0] === "api" && args[1] === "graphql") {
				return { exitCode: 0, stdout: JSON.stringify({ data: { mergePullRequest: {} } }) };
			}
			return { exitCode: 0 };
		});
		setGhBudget(budget);

		const handlers = prPhaseCell.buildHandlers(
			makeBaseDeps({ missionStore: missionStore as unknown as PhaseCellDeps["missionStore"] }),
		);
		const merge = handlers.merge;
		expect(merge).toBeDefined();
		if (!merge) return;

		await merge(
			makeCtx({ nodeId: "pr-phase:merge", mission: makeMission() as unknown as Mission }),
		);

		const graphqlCalls = calls.filter((c) => c.args[0] === "api" && c.args[1] === "graphql");
		expect(graphqlCalls).toHaveLength(1);
		const gqlArgs = graphqlCalls[0]?.args ?? ([] as readonly string[]);

		// id and sha must appear as separate -f values, not interpolated into query=
		expect(gqlArgs.some((a) => a.startsWith("pullRequestId="))).toBe(true);
		expect(gqlArgs.some((a) => a.startsWith("expectedHeadOid="))).toBe(true);

		const queryArg = gqlArgs.find((a) => a.startsWith("query=")) ?? "";
		expect(queryArg).not.toContain("PR_ID_123");
		expect(queryArg).not.toContain("sha-test");
	});

	test("T-w3-307-allowlist: invalid mergeStrategy → pr_merge_conflict, no graphql call (#307)", async () => {
		const missionStore = createMockMissionStore();
		missionStore.getPrState = () => ({
			missionId: "m1",
			prNumber: 1,
			prUrl: "url",
			branch: "feature/x",
			createdAt: "",
			lastCiStatus: null,
			lastReviewDecision: null,
			approvedHeadSha: "sha1",
			mergedAt: null,
		});

		const { budget, calls } = makeFakeGhBudget(({ args }) => {
			if (args[0] === "pr" && args[1] === "view") {
				return { exitCode: 0, stdout: JSON.stringify({ headRefOid: "sha1", id: "PR_1" }) };
			}
			return { exitCode: 0 };
		});
		setGhBudget(budget);

		const config = makeConfig({ pr: { mergeStrategy: "DROP TABLE" as unknown as "squash" } });
		const handlers = prPhaseCell.buildHandlers(
			makeBaseDeps({ missionStore: missionStore as unknown as PhaseCellDeps["missionStore"] }),
			config,
		);
		const merge = handlers.merge;
		expect(merge).toBeDefined();
		if (!merge) return;

		const result = await merge(
			makeCtx({ nodeId: "pr-phase:merge", mission: makeMission() as unknown as Mission }),
		);

		expect(result.trigger).toBe("pr_merge_conflict");
		const payload = (result as { payload?: { reason?: string } }).payload ?? {};
		expect(payload.reason).toMatch(/invalid mergeMethod/);

		const graphqlCalls = calls.filter((c) => c.args[0] === "api" && c.args[1] === "graphql");
		expect(graphqlCalls).toHaveLength(0);
	});

	test("T-w3-23: matching SHA but graphql staleData error → pr_head_changed", async () => {
		const missionStore = createMockMissionStore();
		missionStore.getPrState = () => ({
			missionId: "m1",
			prNumber: 1,
			prUrl: "url",
			branch: "feature/x",
			createdAt: "",
			lastCiStatus: null,
			lastReviewDecision: null,
			approvedHeadSha: "sha1",
			mergedAt: null,
		});

		const { budget } = makeFakeGhBudget(({ args }) => {
			if (args[0] === "pr" && args[1] === "view") {
				return { exitCode: 0, stdout: JSON.stringify({ headRefOid: "sha1" }) };
			}
			if (args[0] === "api" && args[1] === "graphql") {
				return {
					exitCode: 1,
					stderr: "GraphQL: Refusing to merge: staleData (mergePullRequest)",
				};
			}
			return { exitCode: 0 };
		});
		setGhBudget(budget);

		const handlers = prPhaseCell.buildHandlers(
			makeBaseDeps({ missionStore: missionStore as unknown as PhaseCellDeps["missionStore"] }),
		);
		const merge = handlers.merge;
		expect(merge).toBeDefined();
		if (!merge) return;

		const result = await merge(
			makeCtx({ nodeId: "pr-phase:merge", mission: makeMission() as unknown as Mission }),
		);
		expect(result.trigger).toBe("pr_head_changed");
	});
});

// =============================================================================
// #302 — coordinatorResumeCount increment: T-w3-24 .. T-w3-25
// =============================================================================

describe("prPhaseCell resume-coordinator #302 — coordinatorResumeCount increment", () => {
	test("T-w3-24: coordinator storm — 10 sequential events cap=3 → exactly 3 spawns, 4th floods (#302)", async () => {
		let spawnCount = 0;
		const fakeSpawn = ((_args: string[], _opts?: unknown) => {
			spawnCount++;
			return {
				unref: () => {},
				exited: Promise.resolve(0),
				stdout: null,
				stderr: null,
			} as unknown as ReturnType<typeof Bun.spawn>;
		}) as unknown as typeof Bun.spawn;

		const config = makeConfig({ pr: { maxCoordinatorResumesPerPr: 3 } });
		const handlers = prPhaseCell.buildHandlers(makeBaseDeps({ spawn: fakeSpawn }), config);
		const resume = handlers["resume-coordinator"];
		expect(resume).toBeDefined();
		if (!resume) throw new Error("missing handler");

		const mission = makeMission() as Mission;
		(mission as { coordinatorSessionId: string | null }).coordinatorSessionId = "sess-abc";
		(mission as { artifactRoot: string | null }).artifactRoot = "/tmp/a";

		let persistedCount = 0;
		let fourthResult: { trigger?: string; payload?: { kind?: string } } | null = null;

		for (let i = 0; i < 10; i++) {
			const capturedCount = persistedCount;
			const result = await resume(
				makeCtx({
					nodeId: "pr-phase:resume-coordinator",
					mission,
					checkpoint: {
						coordinatorResumeCount: capturedCount,
						comment: { commentId: `cs${i}`, author: "op", body: "msg" },
						classification: { action: "refactor_request", confidence: 0.95 },
					},
					saveCheckpoint: async (data: unknown) => {
						const cp = data as { coordinatorResumeCount?: number };
						if (cp?.coordinatorResumeCount !== undefined) {
							persistedCount = cp.coordinatorResumeCount;
						}
					},
				}),
			);
			if (i === 3) {
				fourthResult = result as { trigger?: string; payload?: { kind?: string } };
			}
		}

		expect(spawnCount).toBe(3);
		expect(fourthResult?.trigger).toBe("pr_triage_flood");
		expect(fourthResult?.payload?.kind).toBe("coordinator_resume_cap");
	});

	test("T-w3-25: saveCheckpoint called with coordinatorResumeCount+1 before spawn (#302)", async () => {
		const callOrder: string[] = [];
		let savedData: unknown = null;

		const fakeSpawn = ((_args: string[], _opts?: unknown) => {
			callOrder.push("spawn");
			return {
				unref: () => {},
				exited: Promise.resolve(0),
				stdout: null,
				stderr: null,
			} as unknown as ReturnType<typeof Bun.spawn>;
		}) as unknown as typeof Bun.spawn;

		const config = makeConfig({ pr: { maxCoordinatorResumesPerPr: 3 } });
		const handlers = prPhaseCell.buildHandlers(makeBaseDeps({ spawn: fakeSpawn }), config);
		const resume = handlers["resume-coordinator"];
		expect(resume).toBeDefined();
		if (!resume) throw new Error("missing handler");

		const mission = makeMission() as Mission;
		(mission as { coordinatorSessionId: string | null }).coordinatorSessionId = "sess-abc";
		(mission as { artifactRoot: string | null }).artifactRoot = "/tmp/a";

		await resume(
			makeCtx({
				nodeId: "pr-phase:resume-coordinator",
				mission,
				checkpoint: {
					coordinatorResumeCount: 2,
					comment: { commentId: "cs-inc", author: "op", body: "msg" },
					classification: { action: "refactor_request", confidence: 0.95 },
				},
				saveCheckpoint: async (data: unknown) => {
					callOrder.push("saveCheckpoint");
					savedData = data;
				},
			}),
		);

		// saveCheckpoint must fire before spawn
		expect(callOrder.indexOf("saveCheckpoint")).toBeLessThan(callOrder.indexOf("spawn"));
		const cp = savedData as { coordinatorResumeCount?: number } | null;
		expect(cp?.coordinatorResumeCount).toBe(3);
	});
});

// =============================================================================
// #304 — Detached spawn structural verification: T-w3-304-dispatch, T-w3-304-resume
// =============================================================================

describe("prPhaseCell #304 — detached spawn structural verification", () => {
	test("T-w3-304-dispatch: dispatch-triage spawn receives detached:true and calls unref() (#304)", async () => {
		// NOTE (da-r1-09): structural verification only — proves we pass the right
		// flags. A true functional deadlock-prevention test requires a real
		// subprocess emitting stdout until the pipe buffer fills; out of scope.
		let unrefCalled = 0;
		const capturedOpts: unknown[] = [];

		const fakeSpawn = ((_args: string[], opts?: unknown) => {
			capturedOpts.push(opts);
			return {
				unref: () => {
					unrefCalled++;
				},
				exited: Promise.resolve(0),
				stdout: null,
				stderr: null,
			} as unknown as ReturnType<typeof Bun.spawn>;
		}) as unknown as typeof Bun.spawn;

		const missionStore = createMockMissionStore();
		missionStore.countTriageSpawnsSince = () => 0;
		missionStore.countTriagePerAuthorSince = () => 0;

		const handlers = prPhaseCell.buildHandlers(
			makeBaseDeps({
				spawn: fakeSpawn,
				missionStore: missionStore as unknown as PhaseCellDeps["missionStore"],
			}),
			makeConfig(),
		);
		const dispatch = handlers["dispatch-triage"];
		expect(dispatch).toBeDefined();
		if (!dispatch) throw new Error("missing handler");

		await dispatch(
			makeCtx({
				nodeId: "pr-phase:dispatch-triage",
				mission: makeMission() as unknown as Mission,
				checkpoint: {
					comment: { commentId: "d304", author: "op", body: "fix this" },
				},
			}),
		);

		expect(capturedOpts).toHaveLength(1);
		const opts = capturedOpts[0] as { detached?: boolean } | undefined;
		expect(opts?.detached).toBe(true);
		expect(unrefCalled).toBe(1);
	});

	test("T-w3-304-resume: resume-coordinator spawn receives detached:true and calls unref() (#304)", async () => {
		// NOTE (da-r1-09): structural verification only — proves we pass the right
		// flags. A true functional deadlock-prevention test requires a real
		// subprocess emitting stdout until the pipe buffer fills; out of scope.
		let unrefCalled = 0;
		const capturedOpts: unknown[] = [];

		const fakeSpawn = ((_args: string[], opts?: unknown) => {
			capturedOpts.push(opts);
			return {
				unref: () => {
					unrefCalled++;
				},
				exited: Promise.resolve(0),
				stdout: null,
				stderr: null,
			} as unknown as ReturnType<typeof Bun.spawn>;
		}) as unknown as typeof Bun.spawn;

		const config = makeConfig({ pr: { maxCoordinatorResumesPerPr: 3 } });
		const handlers = prPhaseCell.buildHandlers(makeBaseDeps({ spawn: fakeSpawn }), config);
		const resume = handlers["resume-coordinator"];
		expect(resume).toBeDefined();
		if (!resume) throw new Error("missing handler");

		const mission = makeMission() as Mission;
		(mission as { coordinatorSessionId: string | null }).coordinatorSessionId = "sess-abc";
		(mission as { artifactRoot: string | null }).artifactRoot = "/tmp/a";

		await resume(
			makeCtx({
				nodeId: "pr-phase:resume-coordinator",
				mission,
				checkpoint: {
					coordinatorResumeCount: 0,
					comment: { commentId: "r304", author: "op", body: "msg" },
					classification: { action: "refactor_request", confidence: 0.95 },
				},
			}),
		);

		expect(capturedOpts).toHaveLength(1);
		const opts = capturedOpts[0] as { detached?: boolean } | undefined;
		expect(opts?.detached).toBe(true);
		expect(unrefCalled).toBe(1);
	});
});

// =============================================================================
// #305 — Per-mission spawn-cap race: skipped pending ws-store-schema
// =============================================================================

// TODO(blocked on ws-store-schema #305 helper): unskip once MissionStore exposes
// tryClaimTriageSlot(missionId, commentId, prStart, cap): boolean.
test.skip("T-w3-305: concurrent dispatch fuzz — 10 parallel events cap=3 → exactly 3 spawns (blocked on ws-store-schema tryClaimTriageSlot)", async () => {
	// Stub tryClaimTriageSlot on the mock to return true exactly 3 times
	// and false thereafter (simulating the real atomic SQL).
	// Run 10 parallel new_comment events.
	// Assert exactly 3 spawn invocations regardless of arrival order.
});
