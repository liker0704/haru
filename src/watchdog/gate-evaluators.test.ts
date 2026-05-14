import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MailStore } from "../mail/store.ts";
import type { MailMessage, MailMessageType } from "../mail/types.ts";
import { type GhBudget, type GhInvocationResult, setGhBudget } from "../missions/gh-budget.ts";
import { createMockMissionStore, makeMission } from "../missions/test-mocks.ts";
import type { SessionStore } from "../sessions/store.ts";
import type { MissionPrCommentRow } from "../types.ts";
// Namespace import for evaluators not yet implemented (RED phase). Named imports
// would crash module load; namespace access resolves to `undefined` at runtime
// so calling these functions throws "is not a function" inside the test (RED),
// while existing tests remain runnable.
import * as gateEvaluators from "./gate-evaluators.ts";
import {
	computeAdaptiveResearchTimeout,
	evaluateArchitectDesign,
	evaluateArchReviewDispatch,
	evaluateAwaitPlan,
	evaluateAwaitResearch,
	evaluateAwaitResearchComplete,
	evaluateAwaitSpecReady,
	evaluateAwaitTierSet,
	evaluateDispatchPlanning,
	evaluateGate,
	evaluateHoldoutGate,
	evaluateHumanSpecReview,
	evaluateUnderstandReady,
	evaluateWsCompletion,
	filterMailSinceGate,
	type GateEvalResult,
} from "./gate-evaluators.ts";

const evaluatorsAny = gateEvaluators as Record<string, unknown>;
const evaluateAwaitCI = evaluatorsAny.evaluateAwaitCI as (
	mission: ReturnType<typeof makeMission>,
	missionStore: ReturnType<typeof createMockMissionStore> | null,
	projectRoot?: string,
	gateEnteredAt?: string,
	deps?: {
		runGh?: GhBudget["runGh"];
		now?: () => number;
	},
) => Promise<GateEvalResult>;
const evaluateAwaitComments = evaluatorsAny.evaluateAwaitComments as (
	mission: ReturnType<typeof makeMission>,
	missionStore: ReturnType<typeof createMockMissionStore> | null,
	projectRoot?: string,
	gateEnteredAt?: string,
	deps?: { runGh?: GhBudget["runGh"]; now?: () => number },
) => Promise<GateEvalResult & { payload?: unknown }>;
const evaluateAwaitApproval = evaluatorsAny.evaluateAwaitApproval as (
	mission: ReturnType<typeof makeMission>,
	missionStore: ReturnType<typeof createMockMissionStore> | null,
	mailStore: MailStore | null,
	projectRoot?: string,
	gateEnteredAt?: string,
	deps?: {
		runGh?: GhBudget["runGh"];
		now?: () => number;
		config?: {
			pr?: {
				operatorGithubLogin?: string;
				approvalTimeoutMs?: number;
				commentsTimeoutMs?: number;
				ciTimeoutMs?: number;
				requireOperatorPermission?: boolean;
			};
		};
		addMail?: (msg: {
			to: string;
			from: string;
			type: string;
			subject: string;
			body: string;
		}) => void;
	},
) => Promise<GateEvalResult>;
const evaluateAwaitDebugComplete = evaluatorsAny.evaluateAwaitDebugComplete as (
	mission: ReturnType<typeof makeMission>,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
	deps?: { now?: () => number; debugTimeoutMs?: number },
) => GateEvalResult;

type TestMessage = {
	from: string;
	to: string;
	type: MailMessage["type"];
	subject: string;
	body?: string;
	createdAt?: string;
};

function toMailMessage(m: TestMessage, i: number): MailMessage {
	return {
		id: `msg-${i}`,
		from: m.from,
		to: m.to,
		subject: m.subject,
		body: m.body ?? "",
		type: m.type,
		priority: "normal",
		threadId: null,
		payload: null,
		read: false,
		createdAt: m.createdAt ?? new Date().toISOString(),
		state: "acked",
		claimedAt: null,
		attempt: 0,
		nextRetryAt: null,
		failReason: null,
		missionId: null,
	};
}

function createTestMailStore(messages: TestMessage[]): MailStore {
	const store = {
		getAll(filters?: { to?: string; from?: string }): MailMessage[] {
			const to = filters?.to;
			const from = filters?.from;
			return messages
				.filter((m) => (!to || m.to === to) && (!from || m.from === from))
				.map((m, i) => toMailMessage(m, i));
		},
	};
	return store as unknown as MailStore;
}

function createTestSessionStore(): SessionStore {
	return {
		getByName: () => null,
		getById: () => null,
		getActive: () => [],
		getAll: () => [],
		count: () => 0,
		getByRun: () => [],
		upsert: () => {},
		updateState: () => {},
		updateLastActivity: () => {},
		updateEscalation: () => {},
		updateTranscriptPath: () => {},
		updateRuntimeSessionId: () => {},
		updateRateLimitedSince: () => {},
		updateRateLimitResumesAt: () => {},
		updateOriginalRuntime: () => {},
		updateStatusLine: () => {},
		getResumable: () => [],
		remove: () => {},
		purge: () => 0,
		close: () => {},
	} as unknown as SessionStore;
}

describe("evaluateAwaitResearch", () => {
	it("no analyst session → met:false without nudge (spawn in progress)", () => {
		const mission = makeMission({ analystSessionId: null });
		const mailStore = createTestMailStore([]);
		const result = evaluateAwaitResearch(mission, mailStore);
		expect(result.met).toBe(false);
		expect(result.nudgeTarget).toBeUndefined();
	});

	it("result mail present from analyst → met:true with research_complete trigger", () => {
		const mission = makeMission({ analystSessionId: "sess-1", slug: "test" });
		const mailStore = createTestMailStore([
			{
				from: "mission-analyst-test",
				to: "coordinator-test",
				type: "result",
				subject: "Research done",
			},
		]);
		const result = evaluateAwaitResearch(mission, mailStore);
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("research_complete");
	});

	it("all dispatched scouts returned but analyst hasn't aggregated → specific nudge to analyst", () => {
		const mission = makeMission({ analystSessionId: "sess-1", slug: "test" });
		const mailStore = createTestMailStore([
			{
				from: "mission-analyst-test",
				to: "scout-a",
				type: "dispatch",
				subject: "Dispatch: task-a",
				createdAt: "2026-04-14T20:00:00.000Z",
			},
			{
				from: "mission-analyst-test",
				to: "scout-b",
				type: "dispatch",
				subject: "Dispatch: task-b",
				createdAt: "2026-04-14T20:00:05.000Z",
			},
			{
				from: "scout-a",
				to: "mission-analyst-test",
				type: "result",
				subject: "Done a",
				createdAt: "2026-04-14T20:05:00.000Z",
			},
			{
				from: "scout-b",
				to: "mission-analyst-test",
				type: "result",
				subject: "Done b",
				createdAt: "2026-04-14T20:06:00.000Z",
			},
		]);
		const result = evaluateAwaitResearch(mission, mailStore, "2026-04-14T19:59:00.000Z");
		expect(result.met).toBe(false);
		expect(result.nudgeTarget).toBe("mission-analyst-test");
		expect(result.nudgeMessage).toContain("2 dispatched scouts");
		expect(result.nudgeMessage).toContain("coordinator-test");
	});

	it("partial scout completion → met:false, nudge analyst", () => {
		const mission = makeMission({ analystSessionId: "sess-1", slug: "test" });
		const mailStore = createTestMailStore([
			{
				from: "mission-analyst-test",
				to: "scout-a",
				type: "dispatch",
				subject: "Dispatch: task-a",
				createdAt: "2026-04-14T20:00:00.000Z",
			},
			{
				from: "mission-analyst-test",
				to: "scout-b",
				type: "dispatch",
				subject: "Dispatch: task-b",
				createdAt: "2026-04-14T20:00:05.000Z",
			},
			{
				from: "scout-a",
				to: "mission-analyst-test",
				type: "result",
				subject: "Done a",
				createdAt: "2026-04-14T20:05:00.000Z",
			},
		]);
		const result = evaluateAwaitResearch(mission, mailStore, "2026-04-14T19:59:00.000Z");
		expect(result.met).toBe(false);
		expect(result.nudgeTarget).toBe("mission-analyst-test");
	});

	it("stale dispatches before gateEnteredAt are ignored", () => {
		const mission = makeMission({ analystSessionId: "sess-1", slug: "test" });
		const mailStore = createTestMailStore([
			{
				from: "mission-analyst-test",
				to: "scout-a",
				type: "dispatch",
				subject: "Dispatch: old",
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			{
				from: "scout-a",
				to: "mission-analyst-test",
				type: "result",
				subject: "Done old",
				createdAt: "2026-01-01T00:05:00.000Z",
			},
		]);
		const result = evaluateAwaitResearch(mission, mailStore, "2026-04-14T00:00:00.000Z");
		expect(result.met).toBe(false);
	});
});

describe("evaluateUnderstandReady", () => {
	it("mission frozen → met:true", () => {
		const mission = makeMission({ state: "frozen" });
		const result = evaluateUnderstandReady(mission);
		expect(result.met).toBe(true);
	});

	it("phase unchanged and not frozen → met:false", () => {
		const mission = makeMission({ state: "active", phase: "understand" });
		const result = evaluateUnderstandReady(mission);
		expect(result.met).toBe(false);
	});

	it("ignores stale Plan complete mail before gateEnteredAt", () => {
		const mission = makeMission({ state: "active", phase: "understand", slug: "test" });
		const mailStore = createTestMailStore([
			{
				from: "mission-analyst-test",
				to: "coordinator-test",
				type: "result",
				subject: "Plan complete",
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		]);
		const result = evaluateUnderstandReady(mission, mailStore, "2026-04-01T00:00:00.000Z");
		expect(result.met).toBe(false);
	});

	it("accepts fresh Plan complete mail after gateEnteredAt", () => {
		const mission = makeMission({ state: "active", phase: "understand", slug: "test" });
		const mailStore = createTestMailStore([
			{
				from: "mission-analyst-test",
				to: "coordinator-test",
				type: "result",
				subject: "Plan complete",
				createdAt: "2026-04-02T00:00:00.000Z",
			},
		]);
		const result = evaluateUnderstandReady(mission, mailStore, "2026-04-01T00:00:00.000Z");
		expect(result.met).toBe(true);
	});

	it("planning dispatch resolves gate (coordinator evaluated research)", () => {
		const mission = makeMission({ state: "active", phase: "understand", slug: "test" });
		const mailStore = createTestMailStore([
			{
				from: "coordinator-test",
				to: "mission-analyst-test",
				type: "dispatch",
				subject: "Planning phase: create workstream plan",
				createdAt: "2026-04-02T00:00:00.000Z",
			},
		]);
		const result = evaluateUnderstandReady(mission, mailStore, "2026-04-01T00:00:00.000Z");
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("ready");
	});

	it("ignores stale planning dispatch before gateEnteredAt", () => {
		const mission = makeMission({ state: "active", phase: "understand", slug: "test" });
		const mailStore = createTestMailStore([
			{
				from: "coordinator-test",
				to: "mission-analyst-test",
				type: "dispatch",
				subject: "Planning phase: create workstream plan",
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		]);
		const result = evaluateUnderstandReady(mission, mailStore, "2026-04-01T00:00:00.000Z");
		expect(result.met).toBe(false);
	});
});

describe("evaluateArchitectDesign", () => {
	it("no architect session → met:false without nudge", async () => {
		const mission = makeMission({ architectSessionId: null, slug: "test" });
		const mailStore = createTestMailStore([]);
		const result = await evaluateArchitectDesign(mission, "/tmp/nonexistent", mailStore);
		expect(result.met).toBe(false);
		expect(result.nudgeTarget).toBeUndefined();
	});
});

describe("evaluateAwaitPlan", () => {
	it("valid workstreams.json → met:true", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "gate-eval-test-"));
		try {
			await mkdir(join(tempDir, "plan"), { recursive: true });
			await writeFile(
				join(tempDir, "plan", "workstreams.json"),
				JSON.stringify({ workstreams: [{ id: "ws-1" }] }),
			);
			const mission = makeMission({});
			const result = await evaluateAwaitPlan(mission, tempDir);
			expect(result.met).toBe(true);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("evaluateWsCompletion", () => {
	// Legacy path is triggered via HARU_LEGACY_WS_COMPLETION=true (opt-out flag).
	// The default (SSOT-based) path requires artifactRoot + missionStore + workstreams.json.

	it("legacy: ignores merged mail before gateEnteredAt", async () => {
		process.env.HARU_LEGACY_WS_COMPLETION = "true";
		try {
			const mission = makeMission({ slug: "test" });
			const mailStore = createTestMailStore([
				{
					from: "merger-test",
					to: "execution-director-test",
					type: "merged",
					subject: "Merged ws-1",
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			]);
			const result = await evaluateWsCompletion(
				mission,
				mailStore,
				"/tmp/nope",
				null,
				"2026-04-01T00:00:00.000Z",
			);
			expect(result.met).toBe(false);
		} finally {
			process.env.HARU_LEGACY_WS_COMPLETION = undefined;
		}
	});

	it("legacy: accepts merged mail after gateEnteredAt", async () => {
		process.env.HARU_LEGACY_WS_COMPLETION = "true";
		try {
			const mission = makeMission({ slug: "test" });
			const mailStore = createTestMailStore([
				{
					from: "merger-test",
					to: "execution-director-test",
					type: "merged",
					subject: "Merged ws-1",
					body: "ws-1 merged",
					createdAt: "2026-04-02T00:00:00.000Z",
				},
			]);
			const result = await evaluateWsCompletion(
				mission,
				mailStore,
				"/tmp/nope",
				null,
				"2026-04-01T00:00:00.000Z",
			);
			expect(result.met).toBe(true);
		} finally {
			process.env.HARU_LEGACY_WS_COMPLETION = undefined;
		}
	});

	it("SSOT: pre-handoff (no workstreams.json) → not met", async () => {
		const mission = makeMission({ slug: "test" });
		const mailStore = createTestMailStore([]);
		const result = await evaluateWsCompletion(mission, mailStore, "/tmp/nope-missing", null);
		expect(result.met).toBe(false);
	});

	it("SSOT sticky fallback: no producer write yet + merged mail → advance with warning", async () => {
		// hasEmittedWsProducerWrite=false (default on makeMission) triggers fallback
		const mission = makeMission({ slug: "test", hasEmittedWsProducerWrite: false });
		// workstreams.json write + existing merged mail
		const tempDir = await mkdtemp(join(tmpdir(), "ws-completion-sticky-"));
		try {
			await mkdir(join(tempDir, "plan"), { recursive: true });
			await writeFile(
				join(tempDir, "plan", "workstreams.json"),
				JSON.stringify({ workstreams: [{ id: "ws-1" }] }),
			);
			const mailStore = createTestMailStore([
				{
					from: "coord-test",
					to: "execution-director-test",
					type: "merged",
					subject: "Merged ws-1",
					body: "ok",
					createdAt: "2026-04-10T00:00:00.000Z",
				},
			]);
			// missionStore returns false for areAllWorkstreamsDone (no status table entries).
			const missionStore = {
				areAllWorkstreamsDone: () => false,
			} as unknown as import("../missions/types.ts").MissionStore;
			const result = await evaluateWsCompletion(
				mission,
				mailStore,
				tempDir,
				missionStore,
				"2026-04-01T00:00:00.000Z",
			);
			expect(result.met).toBe(true);
			expect(result.nudgeMessage?.startsWith("[ws_status_not_populated]")).toBe(true);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("evaluateDispatchPlanning", () => {
	it("coordinator dispatch to analyst after gate entry → met:true", () => {
		const mission = makeMission({ slug: "test" });
		const mailStore = createTestMailStore([
			{
				from: "coordinator-test",
				to: "mission-analyst-test",
				type: "dispatch",
				subject: "Planning phase",
				createdAt: "2026-04-18T10:05:00.000Z",
			},
		]);
		const result = evaluateDispatchPlanning(mission, mailStore, "2026-04-18T10:00:00.000Z");
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("planning_started");
	});

	it("analyst dispatched plan-review-lead → met:true (self-transition)", () => {
		const mission = makeMission({ slug: "test" });
		const mailStore = createTestMailStore([
			{
				from: "mission-analyst-test",
				to: "plan-review-lead",
				type: "dispatch",
				subject: "Plan review request: test",
				createdAt: "2026-04-18T10:01:00.000Z",
			},
		]);
		const result = evaluateDispatchPlanning(mission, mailStore, "2026-04-18T10:03:00.000Z");
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("planning_started");
	});

	it("analyst sent Plan complete result → met:true", () => {
		const mission = makeMission({ slug: "test" });
		const mailStore = createTestMailStore([
			{
				from: "mission-analyst-test",
				to: "coordinator-test",
				type: "result",
				subject: "Plan complete: 2 workstreams",
			},
		]);
		const result = evaluateDispatchPlanning(mission, mailStore);
		expect(result.met).toBe(true);
	});

	it("no signals → met:false, nudge coordinator", () => {
		const mission = makeMission({ slug: "test" });
		const mailStore = createTestMailStore([]);
		const result = evaluateDispatchPlanning(mission, mailStore);
		expect(result.met).toBe(false);
		expect(result.nudgeTarget).toBe("coordinator-test");
	});
});

describe("evaluateGate", () => {
	it("dispatches to evaluateAwaitResearch for understand-phase:await-research", async () => {
		const mission = makeMission({ analystSessionId: null });
		const stores = {
			mailStore: createTestMailStore([]),
			sessionStore: createTestSessionStore(),
		};
		const result = await evaluateGate("understand-phase:await-research", mission, stores, "/tmp");
		// analystSessionId is null → no nudge (spawn in progress)
		expect(result.met).toBe(false);
		expect(result.nudgeTarget).toBeUndefined();
	});

	it("unknown node → met:false with unknown:true", async () => {
		const mission = makeMission({});
		const stores = {
			mailStore: null,
			sessionStore: createTestSessionStore(),
		};
		const result = await evaluateGate("nonexistent:bogus-node", mission, stores, "/tmp");
		expect(result.met).toBe(false);
		expect(result.unknown).toBe(true);
	});
});

describe("evaluateAwaitResearchComplete", () => {
	const mission = makeMission({ slug: "test", analystSessionId: "analyst-1" });

	it("research_complete mail from analyst → met:true, trigger=research_ready", () => {
		const mailStore = createTestMailStore([
			{
				from: "mission-analyst-test",
				to: "coordinator-test",
				type: "research_complete",
				subject: "Research done",
			},
		]);
		const result = evaluateAwaitResearchComplete(mission, mailStore);
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("research_ready");
	});

	it("no mail → nudges analyst", () => {
		const mailStore = createTestMailStore([]);
		const result = evaluateAwaitResearchComplete(mission, mailStore);
		expect(result.met).toBe(false);
		expect(result.nudgeTarget).toBe("mission-analyst-test");
	});

	it("filters by gateEnteredAt", () => {
		const mailStore = createTestMailStore([
			{
				from: "mission-analyst-test",
				to: "coordinator-test",
				type: "research_complete",
				subject: "stale",
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		]);
		const result = evaluateAwaitResearchComplete(mission, mailStore, "2026-04-01T00:00:00.000Z");
		expect(result.met).toBe(false);
	});
});

describe("evaluateAwaitSpecReady", () => {
	const mission = makeMission({ slug: "test" });

	it("spec_ready mail from clarifier → met:true, trigger=spec_ready", () => {
		const mailStore = createTestMailStore([
			{
				from: "product-clarifier-test",
				to: "coordinator-test",
				type: "spec_ready",
				subject: "Spec done",
			},
		]);
		const result = evaluateAwaitSpecReady(mission, mailStore);
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("spec_ready");
	});

	it("no spec_ready → nudges clarifier", () => {
		const mailStore = createTestMailStore([]);
		const result = evaluateAwaitSpecReady(mission, mailStore);
		expect(result.met).toBe(false);
		expect(result.nudgeTarget).toBe("product-clarifier-test");
	});
});

describe("evaluateAwaitTierSet", () => {
	it("tier=null → met:false, nudges tier-classifier", () => {
		const mission = makeMission({ slug: "test", tier: null });
		const result = evaluateAwaitTierSet(mission);
		expect(result.met).toBe(false);
		expect(result.nudgeTarget).toBe("tier-classifier-test");
	});

	it("tier=planned → met:true, trigger=tier_set", () => {
		const mission = makeMission({ slug: "test", tier: "planned" });
		const result = evaluateAwaitTierSet(mission);
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("tier_set");
	});

	it("tier=direct → met:true", () => {
		const mission = makeMission({ slug: "test", tier: "direct" });
		const result = evaluateAwaitTierSet(mission);
		expect(result.met).toBe(true);
	});
});

describe("computeAdaptiveResearchTimeout", () => {
	it("returns 25min cap when no scout dispatches yet", () => {
		expect(computeAdaptiveResearchTimeout([])).toBe(1_500_000);
	});

	it("returns scout_count × 5min for partial fleets", () => {
		expect(
			computeAdaptiveResearchTimeout([
				{ type: "dispatch", to: "scout-a" },
				{ type: "dispatch", to: "scout-b" },
			]),
		).toBe(600_000);

		expect(
			computeAdaptiveResearchTimeout([
				{ type: "dispatch", to: "scout-a" },
				{ type: "dispatch", to: "scout-b" },
				{ type: "dispatch", to: "scout-c" },
			]),
		).toBe(900_000);
	});

	it("caps at 25min for 5+ scouts", () => {
		const dispatches = Array.from({ length: 6 }, (_, i) => ({
			type: "dispatch",
			to: `scout-${i}`,
		}));
		expect(computeAdaptiveResearchTimeout(dispatches)).toBe(1_500_000);
	});

	it("ignores non-scout dispatches and non-dispatch mail", () => {
		const mixed = [
			{ type: "dispatch", to: "scout-a" },
			{ type: "dispatch", to: "lead-foo" }, // not a scout
			{ type: "status", to: "scout-b" }, // not a dispatch
			{ type: "dispatch", to: "scout-b" },
		];
		expect(computeAdaptiveResearchTimeout(mixed)).toBe(600_000);
	});
});

describe("evaluateHumanSpecReview", () => {
	it("autonomy=auto-spec → auto-approves without consulting mail", () => {
		const mission = makeMission({ slug: "test", autonomy: "auto-spec" });
		const result = evaluateHumanSpecReview(mission, null);
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("approved");
	});

	it("autonomy=auto-all → auto-approves", () => {
		const mission = makeMission({ slug: "test", autonomy: "auto-all" });
		const result = evaluateHumanSpecReview(mission, null);
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("approved");
	});

	it("supervised + spec_approved mail → met:true, trigger=approved", () => {
		const mission = makeMission({ slug: "test", autonomy: "supervised" });
		const mailStore = createTestMailStore([
			{
				from: "operator",
				to: "operator-decision-test",
				type: "spec_approved",
				subject: "Spec approved",
			},
		]);
		const result = evaluateHumanSpecReview(mission, mailStore);
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("approved");
	});

	it("supervised + spec_rejected mail → met:true, trigger=rejected", () => {
		const mission = makeMission({ slug: "test", autonomy: "supervised" });
		const mailStore = createTestMailStore([
			{
				from: "operator",
				to: "operator-decision-test",
				type: "spec_rejected",
				subject: "Spec rejected",
			},
		]);
		const result = evaluateHumanSpecReview(mission, mailStore);
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("rejected");
	});

	it("supervised + no verdict mail → met:false, no nudge target", () => {
		const mission = makeMission({ slug: "test", autonomy: "supervised" });
		const mailStore = createTestMailStore([]);
		const result = evaluateHumanSpecReview(mission, mailStore);
		expect(result.met).toBe(false);
		expect(result.nudgeTarget).toBeUndefined();
	});

	it("supervised + verdict before gateEnteredAt is ignored", () => {
		const mission = makeMission({ slug: "test", autonomy: "supervised" });
		const mailStore = createTestMailStore([
			{
				from: "operator",
				to: "operator-decision-test",
				type: "spec_approved",
				subject: "old",
				createdAt: "2025-01-01T00:00:00Z",
			},
		]);
		const result = evaluateHumanSpecReview(mission, mailStore, "2026-01-01T00:00:00Z");
		expect(result.met).toBe(false);
	});
});

describe("filterMailSinceGate", () => {
	const msgs = [
		{ createdAt: "2026-01-01T00:00:00.000Z", body: "old" },
		{ createdAt: "2026-04-01T00:00:00.000Z", body: "gate" },
		{ createdAt: "2026-05-01T00:00:00.000Z", body: "new" },
	];

	it("returns same array reference when gateFilterTime is undefined", () => {
		expect(filterMailSinceGate(msgs, undefined)).toBe(msgs);
	});

	it("drops messages with createdAt before gateFilterTime", () => {
		const result = filterMailSinceGate(msgs, "2026-04-01T00:00:00.000Z");
		expect(result.map((m) => m.body)).toEqual(["gate", "new"]);
	});

	it("inclusive boundary: keeps message whose createdAt equals gateFilterTime", () => {
		const single = [{ createdAt: "2026-04-01T00:00:00.000Z" }];
		expect(filterMailSinceGate(single, "2026-04-01T00:00:00.000Z")).toHaveLength(1);
	});

	it("dispatchedAt evaluators still use raw inlined comparison — not filterMailSinceGate", async () => {
		const src = await Bun.file(new URL("./gate-evaluators.ts", import.meta.url)).text();
		const dispatchedAtMatches = (src.match(/m\.createdAt >= dispatchedAt/g) ?? []).length;
		const gateEnteredAtMatches = (src.match(/m\.createdAt >= gateEnteredAt/g) ?? []).length;
		expect(dispatchedAtMatches).toBe(2);
		expect(gateEnteredAtMatches).toBe(0);
	});

	it("end-to-end via evaluateAwaitResearch: inclusive at T, exclusive at T+1ms", () => {
		const T = "2026-04-01T12:00:00.000Z";
		const Tplus1 = new Date(new Date(T).getTime() + 1).toISOString();
		const mission = makeMission({ analystSessionId: "sess-1", slug: "test" });
		const mailStore = createTestMailStore([
			{
				from: "mission-analyst-test",
				to: "coordinator-test",
				type: "result",
				subject: "Research done",
				createdAt: T,
			},
		]);
		expect(evaluateAwaitResearch(mission, mailStore, T).met).toBe(true);
		expect(evaluateAwaitResearch(mission, mailStore, Tplus1).met).toBe(false);
	});
});

// =============================================================================
// w5: PR-phase + holdout-snapshot gate evaluators (T-w5-1..T-w5-27)
// Architecture refs: §4.2, §5.5, §5.6, §5.8, §5.9, §5.10, §5.11
// =============================================================================

type GhResponder = (args: readonly string[]) => GhInvocationResult;

function makeGhResult(stdout: string, stderr = "", exitCode = 0): GhInvocationResult {
	return { stdout, stderr, exitCode, durationMs: 0 };
}

function fakeBudget(responder: GhResponder): GhBudget & { calls: Array<readonly string[]> } {
	const calls: Array<readonly string[]> = [];
	const budget = {
		runGh: async (args: readonly string[]) => {
			calls.push(args);
			return responder(args);
		},
		snapshot: () => ({ tokensAvailable: 100, queuedCount: 0, lastRateLimitResetAt: null }),
		calls,
	};
	return budget as unknown as GhBudget & { calls: Array<readonly string[]> };
}

function trackingMissionStore(
	prNumber = 42,
	preexistingComments: MissionPrCommentRow[] = [],
): {
	store: ReturnType<typeof createMockMissionStore>;
	calls: {
		updatePrCiStatus: string[];
		setApprovedHeadSha: Array<[string, string]>;
		recordPrComment: MissionPrCommentRow[];
	};
} {
	const calls = {
		updatePrCiStatus: [] as string[],
		setApprovedHeadSha: [] as Array<[string, string]>,
		recordPrComment: [] as MissionPrCommentRow[],
	};
	const store = createMockMissionStore();
	store.getPrState = (id: string) => ({
		missionId: id,
		prNumber,
		prUrl: `https://github.com/o/r/pull/${prNumber}`,
		branch: "feat/x",
		createdAt: "2026-01-01T00:00:00Z",
		lastCiStatus: null,
		lastReviewDecision: null,
		approvedHeadSha: null,
		mergedAt: null,
	});
	store.updatePrCiStatus = (_id: string, status: string) => {
		calls.updatePrCiStatus.push(status);
	};
	store.setApprovedHeadSha = (id: string, sha: string) => {
		calls.setApprovedHeadSha.push([id, sha]);
	};
	store.recordPrComment = (row: MissionPrCommentRow) => {
		calls.recordPrComment.push(row);
	};
	store.listPrComments = () => preexistingComments;
	return { store, calls };
}

function createSimpleMailStore(messages: MailMessage[]): MailStore {
	const store = {
		getAll(filters?: { to?: string; from?: string }): MailMessage[] {
			const to = filters?.to;
			const from = filters?.from;
			return messages.filter((m) => (!to || m.to === to) && (!from || m.from === from));
		},
	};
	return store as unknown as MailStore;
}

function buildMailMessage(
	overrides: Partial<MailMessage> & { type: MailMessageType },
): MailMessage {
	return {
		id: overrides.id ?? "msg-1",
		from: overrides.from ?? "sender",
		to: overrides.to ?? "recipient",
		subject: overrides.subject ?? "",
		body: overrides.body ?? "",
		type: overrides.type,
		priority: overrides.priority ?? "normal",
		threadId: overrides.threadId ?? null,
		payload: overrides.payload ?? null,
		read: overrides.read ?? false,
		createdAt: overrides.createdAt ?? new Date().toISOString(),
		state: overrides.state ?? "acked",
		claimedAt: overrides.claimedAt ?? null,
		attempt: overrides.attempt ?? 0,
		nextRetryAt: overrides.nextRetryAt ?? null,
		failReason: overrides.failReason ?? null,
		missionId: overrides.missionId ?? null,
	};
}

describe("evaluateAwaitCI [T-w5-1..T-w5-6]", () => {
	afterEach(() => setGhBudget(null));

	it("T-w5-1: all checks SUCCESS → met:true, trigger=ci_passed [arch §5.5]", async () => {
		const { store } = trackingMissionStore(42);
		const checksJson = JSON.stringify([
			{
				name: "build",
				status: "COMPLETED",
				conclusion: "SUCCESS",
				detailsUrl: "https://x",
				startedAt: "2026-01-01T00:00:00Z",
				completedAt: "2026-01-01T00:05:00Z",
			},
			{
				name: "lint",
				status: "COMPLETED",
				conclusion: "SUCCESS",
				detailsUrl: "https://y",
				startedAt: "2026-01-01T00:00:00Z",
				completedAt: "2026-01-01T00:04:00Z",
			},
		]);
		const budget = fakeBudget(() => makeGhResult(checksJson));
		const mission = makeMission({ id: "m1", slug: "test" });
		const result = await evaluateAwaitCI(mission, store, undefined, undefined, {
			runGh: budget.runGh,
		});
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("ci_passed");
	});

	it("T-w5-2: one FAILURE check → met:true, trigger=ci_failed; updatePrCiStatus called [arch §5.5]", async () => {
		const { store, calls } = trackingMissionStore(42);
		const checksJson = JSON.stringify([
			{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
			{ name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
		]);
		const budget = fakeBudget(() => makeGhResult(checksJson));
		const mission = makeMission({ id: "m1", slug: "test" });
		const result = await evaluateAwaitCI(mission, store, undefined, undefined, {
			runGh: budget.runGh,
		});
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("ci_failed");
		expect(calls.updatePrCiStatus).toContain("FAILURE");
	});

	it("T-w5-3: all IN_PROGRESS → met:false [arch §5.5]", async () => {
		const { store } = trackingMissionStore(42);
		const checksJson = JSON.stringify([
			{ name: "build", status: "IN_PROGRESS", conclusion: null },
			{ name: "lint", status: "IN_PROGRESS", conclusion: null },
		]);
		const budget = fakeBudget(() => makeGhResult(checksJson));
		const mission = makeMission({ id: "m1", slug: "test" });
		const result = await evaluateAwaitCI(mission, store, undefined, undefined, {
			runGh: budget.runGh,
		});
		expect(result.met).toBe(false);
	});

	it("T-w5-4: elapsed > ciTimeoutMs (4h default) → met:true, trigger=ci_timeout [arch §5.5]", async () => {
		const { store } = trackingMissionStore(42);
		const nowMs = Date.parse("2026-02-01T05:00:00Z");
		const gateEnteredAt = "2026-02-01T00:00:00Z"; // 5h before now (> 4h cap)
		const checksJson = JSON.stringify([{ name: "build", status: "IN_PROGRESS", conclusion: null }]);
		const budget = fakeBudget(() => makeGhResult(checksJson));
		const mission = makeMission({ id: "m1", slug: "test" });
		const result = await evaluateAwaitCI(mission, store, undefined, gateEnteredAt, {
			runGh: budget.runGh,
			now: () => nowMs,
		});
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("ci_timeout");
	});

	it("T-w5-5: stderr 'Bad credentials' → met:true, trigger=gh_auth_missing [arch §5.10]", async () => {
		const { store } = trackingMissionStore(42);
		const budget = fakeBudget(() => makeGhResult("", "HTTP 401: Bad credentials\n", 1));
		const mission = makeMission({ id: "m1", slug: "test" });
		const result = await evaluateAwaitCI(mission, store, undefined, undefined, {
			runGh: budget.runGh,
		});
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("gh_auth_missing");
	});

	it("T-w5-6: stderr rate-limit headers → met:true, trigger=pr_rate_limited [arch §5.10]", async () => {
		const { store } = trackingMissionStore(42);
		const budget = fakeBudget(() =>
			makeGhResult("", "Retry-After: 60\nX-RateLimit-Remaining: 0\n", 1),
		);
		const mission = makeMission({ id: "m1", slug: "test" });
		const result = await evaluateAwaitCI(mission, store, undefined, undefined, {
			runGh: budget.runGh,
		});
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("pr_rate_limited");
	});
});

describe("evaluateAwaitComments [T-w5-7..T-w5-9]", () => {
	afterEach(() => setGhBudget(null));

	it("T-w5-7: new comment not in listPrComments → met:true, trigger=new_comment; recordPrComment called [arch §5.6]", async () => {
		const { store, calls } = trackingMissionStore(42, []);
		const prViewJson = JSON.stringify({
			comments: [{ id: "c1", author: { login: "reviewerA" }, body: "looks good?" }],
			reviews: [],
		});
		const budget = fakeBudget(() => makeGhResult(prViewJson));
		const mission = makeMission({ id: "m1", slug: "test" });
		const result = await evaluateAwaitComments(mission, store, undefined, undefined, {
			runGh: budget.runGh,
		});
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("new_comment");
		expect(calls.recordPrComment.length).toBe(1);
		expect(calls.recordPrComment[0]?.status).toBe("pending");
		const payload = result.payload as { commentId?: string; author?: string; body?: string };
		expect(payload?.commentId).toBe("c1");
		expect(payload?.author).toBe("reviewerA");
		expect(payload?.body).toBe("looks good?");
	});

	it("T-w5-8: comment already in listPrComments → met:false; recordPrComment NOT called [arch §5.6]", async () => {
		const preexisting: MissionPrCommentRow = {
			missionId: "m1",
			prNumber: 42,
			commentId: "c1",
			author: "reviewerA",
			body: "looks good?",
			action: null,
			status: "pending",
			fixCycles: 0,
			detectedAt: "2026-01-01T00:00:00Z",
			resolvedAt: null,
		};
		const { store, calls } = trackingMissionStore(42, [preexisting]);
		const prViewJson = JSON.stringify({
			comments: [{ id: "c1", author: { login: "reviewerA" }, body: "looks good?" }],
			reviews: [],
		});
		const budget = fakeBudget(() => makeGhResult(prViewJson));
		const mission = makeMission({ id: "m1", slug: "test" });
		const result = await evaluateAwaitComments(mission, store, undefined, undefined, {
			runGh: budget.runGh,
		});
		expect(result.met).toBe(false);
		expect(calls.recordPrComment.length).toBe(0);
	});

	it("T-w5-9: elapsed > commentsTimeoutMs (7d default) → met:true, trigger=comments_stale [arch §5.6]", async () => {
		const { store } = trackingMissionStore(42);
		const nowMs = Date.parse("2026-02-08T00:00:00Z");
		const gateEnteredAt = "2026-02-01T00:00:00Z"; // 7d before now
		const budget = fakeBudget(() => makeGhResult(JSON.stringify({ comments: [], reviews: [] })));
		const mission = makeMission({ id: "m1", slug: "test" });
		const result = await evaluateAwaitComments(mission, store, undefined, gateEnteredAt, {
			runGh: budget.runGh,
			now: () => nowMs,
		});
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("comments_stale");
	});
});

describe("evaluateAwaitApproval [T-w5-10..T-w5-18]", () => {
	afterEach(() => setGhBudget(null));

	it("T-w5-10: one APPROVED review → captures headRefOid, met:true, trigger=approved [arch §5.8]", async () => {
		const { store, calls } = trackingMissionStore(42);
		const prViewJson = JSON.stringify({
			reviewDecision: "APPROVED",
			headRefOid: "abc123def",
			reviews: [
				{ state: "APPROVED", author: { login: "reviewerA" }, submittedAt: "2026-02-01T00:00:00Z" },
			],
			comments: [],
		});
		const budget = fakeBudget(() => makeGhResult(prViewJson));
		const mission = makeMission({ id: "m1", slug: "test" });
		const mailStore = createSimpleMailStore([]);
		const result = await evaluateAwaitApproval(mission, store, mailStore, undefined, undefined, {
			runGh: budget.runGh,
		});
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("approved");
		expect(calls.setApprovedHeadSha).toEqual([["m1", "abc123def"]]);
	});

	it("T-w5-11: RESTRICTIVE-WINS — single reviewer CHANGES_REQUESTED + LGTM comment (non-operator) → trigger=changes_requested [arch §5.8]", async () => {
		const { store } = trackingMissionStore(42);
		const prViewJson = JSON.stringify({
			reviewDecision: "CHANGES_REQUESTED",
			headRefOid: "sha1",
			reviews: [
				{
					state: "CHANGES_REQUESTED",
					author: { login: "reviewerA" },
					submittedAt: "2026-02-01T00:00:00Z",
				},
			],
			comments: [{ id: "c1", author: { login: "reviewerA" }, body: "LGTM" }],
		});
		const budget = fakeBudget(() => makeGhResult(prViewJson));
		const mission = makeMission({ id: "m1", slug: "test" });
		const result = await evaluateAwaitApproval(mission, store, null, undefined, undefined, {
			runGh: budget.runGh,
			config: { pr: { operatorGithubLogin: "opuser" } },
		});
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("changes_requested");
	});

	it("T-w5-12: RESTRICTIVE-WINS multi-reviewer — A:CHANGES_REQUESTED + B:APPROVED → trigger=changes_requested [arch §5.8]", async () => {
		const { store } = trackingMissionStore(42);
		const prViewJson = JSON.stringify({
			reviewDecision: null,
			headRefOid: "sha1",
			reviews: [
				{
					state: "CHANGES_REQUESTED",
					author: { login: "reviewerA" },
					submittedAt: "2026-02-01T00:00:00Z",
				},
				{
					state: "APPROVED",
					author: { login: "reviewerB" },
					submittedAt: "2026-02-01T00:05:00Z",
				},
			],
			comments: [],
		});
		const budget = fakeBudget(() => makeGhResult(prViewJson));
		const mission = makeMission({ id: "m1", slug: "test" });
		const result = await evaluateAwaitApproval(mission, store, null, undefined, undefined, {
			runGh: budget.runGh,
		});
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("changes_requested");
	});

	it("T-w5-13: same-reviewer flip — A:CHANGES_REQUESTED@t1 then A:APPROVED@t2 → trigger=approved [arch §5.8]", async () => {
		const { store } = trackingMissionStore(42);
		const prViewJson = JSON.stringify({
			reviewDecision: "APPROVED",
			headRefOid: "sha1",
			reviews: [
				{
					state: "CHANGES_REQUESTED",
					author: { login: "reviewerA" },
					submittedAt: "2026-02-01T00:00:00Z",
				},
				{
					state: "APPROVED",
					author: { login: "reviewerA" },
					submittedAt: "2026-02-01T01:00:00Z",
				},
			],
			comments: [],
		});
		const budget = fakeBudget(() => makeGhResult(prViewJson));
		const mission = makeMission({ id: "m1", slug: "test" });
		const result = await evaluateAwaitApproval(mission, store, null, undefined, undefined, {
			runGh: budget.runGh,
		});
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("approved");
	});

	it("T-w5-14: OPERATOR OVERRIDE — CHANGES_REQUESTED + operator LGTM (admin perm) → trigger=approved [arch §5.8, §5.9]", async () => {
		const { store } = trackingMissionStore(42);
		const prViewJson = JSON.stringify({
			reviewDecision: "CHANGES_REQUESTED",
			headRefOid: "sha1",
			reviews: [
				{
					state: "CHANGES_REQUESTED",
					author: { login: "reviewerA" },
					submittedAt: "2026-02-01T00:00:00Z",
				},
			],
			comments: [{ id: "c1", author: { login: "opuser" }, body: "LGTM" }],
		});
		const responder: GhResponder = (args) => {
			if (args[0] === "api" && args.some((a) => a.includes("collaborators"))) {
				return makeGhResult(JSON.stringify({ permission: "admin" }));
			}
			return makeGhResult(prViewJson);
		};
		const budget = fakeBudget(responder);
		const mission = makeMission({ id: "m1", slug: "test" });
		const result = await evaluateAwaitApproval(mission, store, null, undefined, undefined, {
			runGh: budget.runGh,
			config: { pr: { operatorGithubLogin: "opuser" } },
		});
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("approved");
	});

	it("T-w5-15: COMMENT-APPROVAL — null reviewDecision + operator 'lgtm.' + admin → trigger=approved [arch §5.8]", async () => {
		const { store } = trackingMissionStore(42);
		const prViewJson = JSON.stringify({
			reviewDecision: null,
			headRefOid: "sha1",
			reviews: [],
			comments: [{ id: "c1", author: { login: "opuser" }, body: "lgtm." }],
		});
		const responder: GhResponder = (args) => {
			if (args[0] === "api" && args.some((a) => a.includes("collaborators"))) {
				return makeGhResult(JSON.stringify({ permission: "admin" }));
			}
			return makeGhResult(prViewJson);
		};
		const budget = fakeBudget(responder);
		const mission = makeMission({ id: "m1", slug: "test" });
		const result = await evaluateAwaitApproval(mission, store, null, undefined, undefined, {
			runGh: budget.runGh,
			config: { pr: { operatorGithubLogin: "opuser" } },
		});
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("approved");
	});

	it("T-w5-16: COMMENT-APPROVAL regex strict — operator 'LGTM with caveats' → met:false [arch §5.8]", async () => {
		const { store } = trackingMissionStore(42);
		const prViewJson = JSON.stringify({
			reviewDecision: null,
			headRefOid: "sha1",
			reviews: [],
			comments: [{ id: "c1", author: { login: "opuser" }, body: "LGTM with caveats" }],
		});
		const responder: GhResponder = (args) => {
			if (args[0] === "api" && args.some((a) => a.includes("collaborators"))) {
				return makeGhResult(JSON.stringify({ permission: "admin" }));
			}
			return makeGhResult(prViewJson);
		};
		const budget = fakeBudget(responder);
		const mission = makeMission({ id: "m1", slug: "test" });
		const result = await evaluateAwaitApproval(mission, store, null, undefined, undefined, {
			runGh: budget.runGh,
			config: { pr: { operatorGithubLogin: "opuser" } },
		});
		expect(result.met).toBe(false);
	});

	it("T-w5-17: COMMENT-APPROVAL — 'LGTM' from non-operator → met:false [arch §5.8]", async () => {
		const { store } = trackingMissionStore(42);
		const prViewJson = JSON.stringify({
			reviewDecision: null,
			headRefOid: "sha1",
			reviews: [],
			comments: [{ id: "c1", author: { login: "randomdev" }, body: "LGTM" }],
		});
		const budget = fakeBudget(() => makeGhResult(prViewJson));
		const mission = makeMission({ id: "m1", slug: "test" });
		const result = await evaluateAwaitApproval(mission, store, null, undefined, undefined, {
			runGh: budget.runGh,
			config: { pr: { operatorGithubLogin: "opuser" } },
		});
		expect(result.met).toBe(false);
	});

	it("T-w5-18: elapsed > approvalTimeoutMs (48h) → emits reminder via addMail, returns trigger=approval_pending_long [arch §5.8]", async () => {
		const { store } = trackingMissionStore(42);
		const nowMs = Date.parse("2026-02-03T01:00:00Z");
		const gateEnteredAt = "2026-02-01T00:00:00Z"; // 49h before now (> 48h)
		const prViewJson = JSON.stringify({
			reviewDecision: null,
			headRefOid: "sha1",
			reviews: [],
			comments: [],
		});
		const budget = fakeBudget(() => makeGhResult(prViewJson));
		const sentMails: Array<{
			to: string;
			from: string;
			type: string;
			subject: string;
			body: string;
		}> = [];
		const mission = makeMission({ id: "m1", slug: "test" });
		const result = await evaluateAwaitApproval(mission, store, null, undefined, gateEnteredAt, {
			runGh: budget.runGh,
			now: () => nowMs,
			addMail: (msg) => sentMails.push(msg),
		});
		expect(sentMails.length).toBe(1);
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("approval_pending_long");
	});
});

describe("evaluateAwaitDebugComplete [T-w5-19..T-w5-20]", () => {
	it("T-w5-19: fix_committed mail after gateEnteredAt → met:true, trigger=fix_committed [arch §5.11]", () => {
		const gateEnteredAt = "2026-02-01T00:00:00Z";
		const after = new Date(Date.parse(gateEnteredAt) + 1000).toISOString();
		const mailStore = createSimpleMailStore([
			buildMailMessage({
				id: "msg-fix",
				from: "debugger-test",
				to: "coordinator-test",
				type: "fix_committed" as MailMessageType,
				subject: "Fix committed",
				createdAt: after,
			}),
		]);
		const mission = makeMission({ id: "m1", slug: "test" });
		const result = evaluateAwaitDebugComplete(mission, mailStore, gateEnteredAt);
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("fix_committed");
	});

	it("T-w5-20: empty mailStore + elapsed > debugTimeoutMs (1h default) → met:true, trigger=debug_timeout [arch §5.11]", () => {
		const gateEnteredAt = "2026-02-01T00:00:00Z";
		const nowMs = Date.parse("2026-02-01T02:00:00Z"); // 2h > 1h timeout
		const mailStore = createSimpleMailStore([]);
		const mission = makeMission({ id: "m1", slug: "test" });
		const result = evaluateAwaitDebugComplete(mission, mailStore, gateEnteredAt, {
			now: () => nowMs,
		});
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("debug_timeout");
	});
});

describe("evaluateGate (PR-phase dispatch wiring) [T-w5-21]", () => {
	afterEach(() => setGhBudget(null));

	it("T-w5-21: routes pr-phase:await-{ci,comments,approval,debug-complete,debug-fix} by suffix [arch §4.2]", async () => {
		// await-ci: routes to evaluateAwaitCI with `gh pr checks` call
		const ciBudget = fakeBudget(() => makeGhResult(JSON.stringify([])));
		setGhBudget(ciBudget);
		const { store } = trackingMissionStore(42);
		const mission = makeMission({ id: "m1", slug: "test" });
		const mailStore = createSimpleMailStore([]);
		const ciResult = await evaluateGate(
			"pr-phase:await-ci",
			mission,
			{ mailStore, sessionStore: createTestSessionStore(), missionStore: store },
			"/tmp",
		);
		expect(ciResult.unknown).toBeUndefined();
		expect(ciBudget.calls.length).toBeGreaterThan(0);
		const ciArgs = ciBudget.calls[0] ?? [];
		expect(ciArgs[0]).toBe("pr");
		expect(ciArgs[1]).toBe("checks");

		// await-comments: routes to evaluateAwaitComments with `gh pr view --json comments,reviews`
		const commentsBudget = fakeBudget(() =>
			makeGhResult(JSON.stringify({ comments: [], reviews: [] })),
		);
		setGhBudget(commentsBudget);
		const commentsResult = await evaluateGate(
			"pr-phase:await-comments",
			mission,
			{ mailStore, sessionStore: createTestSessionStore(), missionStore: store },
			"/tmp",
		);
		expect(commentsResult.unknown).toBeUndefined();
		expect(commentsBudget.calls.length).toBeGreaterThan(0);
		const commentsArgs = commentsBudget.calls[0] ?? [];
		expect(commentsArgs[0]).toBe("pr");
		expect(commentsArgs[1]).toBe("view");
		expect(commentsArgs.includes("comments,reviews")).toBe(true);

		// await-approval: routes to evaluateAwaitApproval with reviewDecision,reviews,headRefOid
		const approvalBudget = fakeBudget(() =>
			makeGhResult(
				JSON.stringify({ reviewDecision: null, headRefOid: "sha", reviews: [], comments: [] }),
			),
		);
		setGhBudget(approvalBudget);
		const approvalResult = await evaluateGate(
			"pr-phase:await-approval",
			mission,
			{ mailStore, sessionStore: createTestSessionStore(), missionStore: store },
			"/tmp",
		);
		expect(approvalResult.unknown).toBeUndefined();
		expect(approvalBudget.calls.length).toBeGreaterThan(0);
		const approvalArgs = approvalBudget.calls[0] ?? [];
		expect(approvalArgs[0]).toBe("pr");
		expect(approvalArgs[1]).toBe("view");
		expect(approvalArgs.includes("reviewDecision,reviews,headRefOid")).toBe(true);

		// await-debug-complete: routes to evaluateAwaitDebugComplete (no gh)
		const debugCompleteBudget = fakeBudget(() => makeGhResult(""));
		setGhBudget(debugCompleteBudget);
		const debugCompleteResult = await evaluateGate(
			"pr-phase:await-debug-complete",
			mission,
			{ mailStore, sessionStore: createTestSessionStore(), missionStore: store },
			"/tmp",
		);
		expect(debugCompleteResult.unknown).toBeUndefined();
		expect(debugCompleteBudget.calls.length).toBe(0);

		// await-debug-fix: existing DONE-phase evaluator; prefix is ignored — dispatch is by suffix.
		const debugFixBudget = fakeBudget(() => makeGhResult(""));
		setGhBudget(debugFixBudget);
		const debugFixResult = await evaluateGate(
			"pr-phase:await-debug-fix",
			mission,
			{ mailStore, sessionStore: createTestSessionStore(), missionStore: store },
			"/tmp",
		);
		expect(debugFixResult.unknown).toBeUndefined();
	});
});

describe("evaluateHoldoutGate (snapshot-diff rewrite) [T-w5-22..T-w5-26]", () => {
	let artifactRoot: string;

	const setup = async (): Promise<void> => {
		artifactRoot = await mkdtemp(join(tmpdir(), "w5-holdout-"));
		await mkdir(join(artifactRoot, "results"), { recursive: true });
		await mkdir(join(artifactRoot, "debug"), { recursive: true });
	};

	afterEach(async () => {
		if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
	});

	it("T-w5-22: NO baseline.json AND NO sentinels → trigger=holdout_baseline_missing [arch §5.11]", async () => {
		await setup();
		const mission = makeMission({ id: "mission-test", slug: "test", featureBranch: "feat/x" });
		const missionStore = createMockMissionStore();
		const result = await evaluateHoldoutGate(mission, missionStore, artifactRoot, artifactRoot);
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("holdout_baseline_missing");
	});

	it("T-w5-23: baseline.json corrupt + .baseline-captured sentinel → trigger=holdout_baseline_corrupt [arch §5.11]", async () => {
		await setup();
		await writeFile(join(artifactRoot, "results", "baseline.json"), "{not json");
		await writeFile(join(artifactRoot, "results", ".baseline-captured"), "");
		const mission = makeMission({ id: "mission-test", slug: "test", featureBranch: "feat/x" });
		const missionStore = createMockMissionStore();
		const result = await evaluateHoldoutGate(mission, missionStore, artifactRoot, artifactRoot);
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("holdout_baseline_corrupt");
	});

	it("T-w5-24: baseline+current both tsc fail (no new failures) → trigger=holdout_pass [arch §5.11]", async () => {
		await setup();
		const baseline = [{ id: "tsc", level: 1, name: "tsc", status: "fail", message: "" }];
		const current = {
			checks: [{ id: "tsc", level: 1, name: "tsc", status: "fail", message: "" }],
		};
		await writeFile(join(artifactRoot, "results", "baseline.json"), JSON.stringify(baseline));
		await writeFile(join(artifactRoot, "results", ".baseline-captured"), "");
		await writeFile(join(artifactRoot, "debug", "holdout-result-0.json"), JSON.stringify(current));
		const mission = makeMission({ id: "mission-test", slug: "test", featureBranch: "feat/x" });
		const missionStore = createMockMissionStore();
		const result = await evaluateHoldoutGate(mission, missionStore, artifactRoot, artifactRoot);
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("holdout_pass");
	});

	it("T-w5-25: baseline tsc pass → current tsc fail → trigger=holdout_fail with newFailures payload [arch §5.11]", async () => {
		await setup();
		const baseline = [{ id: "tsc", level: 1, name: "tsc", status: "pass", message: "" }];
		const current = {
			checks: [{ id: "tsc", level: 1, name: "tsc", status: "fail", message: "" }],
		};
		await writeFile(join(artifactRoot, "results", "baseline.json"), JSON.stringify(baseline));
		await writeFile(join(artifactRoot, "results", ".baseline-captured"), "");
		await writeFile(join(artifactRoot, "debug", "holdout-result-0.json"), JSON.stringify(current));
		const mission = makeMission({ id: "mission-test", slug: "test", featureBranch: "feat/x" });
		const missionStore = createMockMissionStore();
		const result = await evaluateHoldoutGate(mission, missionStore, artifactRoot, artifactRoot);
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("holdout_fail");
		const payload = (result as unknown as { payload?: unknown }).payload as
			| { newFailures?: Array<{ id: string; status: string }> }
			| undefined;
		expect(payload?.newFailures?.length).toBe(1);
		expect(payload?.newFailures?.[0]?.id).toBe("tsc");
		expect(payload?.newFailures?.[0]?.status).toBe("fail");
	});

	it("T-w5-26: baseline tsc fail → current tsc pass → trigger=holdout_pass (resolved failures) [arch §5.11]", async () => {
		await setup();
		const baseline = [{ id: "tsc", level: 1, name: "tsc", status: "fail", message: "" }];
		const current = {
			checks: [{ id: "tsc", level: 1, name: "tsc", status: "pass", message: "" }],
		};
		await writeFile(join(artifactRoot, "results", "baseline.json"), JSON.stringify(baseline));
		await writeFile(join(artifactRoot, "results", ".baseline-captured"), "");
		await writeFile(join(artifactRoot, "debug", "holdout-result-0.json"), JSON.stringify(current));
		const mission = makeMission({ id: "mission-test", slug: "test", featureBranch: "feat/x" });
		const missionStore = createMockMissionStore();
		const result = await evaluateHoldoutGate(mission, missionStore, artifactRoot, artifactRoot);
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("holdout_pass");
		// Snapshot-diff rewrite MUST expose newFailures payload (empty here — tsc was already failing in baseline, now resolved).
		const payload = (result as unknown as { payload?: unknown }).payload as
			| { newFailures?: unknown[]; resolvedFailures?: unknown[] }
			| undefined;
		expect(payload).toBeDefined();
		expect(payload?.newFailures).toEqual([]);
	});
});

describe("evaluateArchReviewDispatch", () => {
	// evaluateArchReviewDispatch must not branch on autonomy — test all valid modes.
	const autonomyModes = ["supervised", "auto-spec", "auto-all"] as const;

	for (const autonomy of autonomyModes) {
		it(`dispatch mail observed → met:true (autonomy=${autonomy})`, () => {
			const mission = makeMission({ slug: "test", autonomy });
			const mailStore = createTestMailStore([
				{
					from: "coordinator-test",
					to: "architect-test",
					type: "dispatch",
					subject: "Architecture Review: post-merge reconciliation",
				},
			]);
			const result = evaluateArchReviewDispatch(mission, mailStore);
			expect(result.met).toBe(true);
			expect(result.trigger).toBe("review_dispatched");
		});
	}

	it("null/undefined autonomy (unchecked by evaluator) — dispatch observed → met:true", () => {
		// The evaluator ignores mission.autonomy entirely; null/undefined autonomy is irrelevant.
		// Verify by building a mission object with autonomy coerced to null.
		const base = makeMission({ slug: "test" });
		const mission = { ...base, autonomy: null } as unknown as typeof base;
		const mailStore = createTestMailStore([
			{
				from: "coordinator-test",
				to: "architect-test",
				type: "dispatch",
				subject: "Architecture Review: post-merge reconciliation",
			},
		]);
		const result = evaluateArchReviewDispatch(mission, mailStore);
		expect(result.met).toBe(true);
		expect(result.trigger).toBe("review_dispatched");
	});

	it("no dispatch observed → met:false with arch-review-stall payload", () => {
		const mission = makeMission({ slug: "test" });
		const mailStore = createTestMailStore([]);
		const result = evaluateArchReviewDispatch(mission, mailStore);
		expect(result.met).toBe(false);
		expect(result.nudgeTarget).toBe("coordinator-test");
		expect(result.nudgeMessage).toContain("architect");
		expect(result.payload).toEqual({
			kind: "arch-review-stall",
			reason: "no architect dispatch observed within grace period",
		});
	});

	it("null mailStore → met:false, no payload", () => {
		const mission = makeMission({ slug: "test" });
		const result = evaluateArchReviewDispatch(mission, null);
		expect(result.met).toBe(false);
		expect(result.payload).toBeUndefined();
	});
});

describe("gh-budget singleton routing [T-w5-27]", () => {
	afterEach(() => setGhBudget(null));

	it("T-w5-27: evaluateAwaitCI without _deps falls back to getGhBudget singleton [arch §5.5, §5.10]", async () => {
		const checksJson = JSON.stringify([
			{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
		]);
		const budget = fakeBudget(() => makeGhResult(checksJson));
		setGhBudget(budget);
		const { store } = trackingMissionStore(42);
		const mission = makeMission({ id: "m1", slug: "test" });
		await evaluateAwaitCI(mission, store, undefined);
		expect(budget.calls.length).toBe(1);
		const args = budget.calls[0] ?? [];
		expect(args).toEqual([
			"pr",
			"checks",
			"42",
			"--json",
			"name,status,conclusion,detailsUrl,startedAt,completedAt",
		]);
	});
});
