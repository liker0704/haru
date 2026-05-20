/**
 * Gate evaluators for mission lifecycle engine.
 *
 * Pure functions that check whether an async gate's resolution condition is met.
 * Each evaluator returns whether the condition is met, the trigger to fire,
 * and optionally a nudge target/message if the condition is not met.
 */

import { copyFileSync, existsSync, statSync as statSyncFn } from "node:fs";
import { join as joinPath } from "node:path";
import { detectHaruDir } from "../config.ts";
import type { MailStore } from "../mail/store.ts";
import { baselineExists, compareSnapshotDiff } from "../missions/baseline-snapshot.ts";
import { type GhBudget, getGhBudget } from "../missions/gh-budget.ts";
import type { MissionStore } from "../missions/types.ts";
import { isProcessRunning } from "../process/util.ts";
import type { SessionStore } from "../sessions/store.ts";
import type { HoldoutCheck, Mission, MissionPrCommentRow } from "../types.ts";

export interface GateEvalResult {
	met: boolean;
	trigger?: string;
	nudgeTarget?: string;
	nudgeMessage?: string;
	unknown?: boolean;
	payload?: Record<string, unknown>;
}

/**
 * Curated subset of OverstoryConfig.pr threaded to PR-phase gate evaluators.
 * Kept local to this module (per #303) to avoid pulling the full OverstoryConfig
 * type. Mirrors the corresponding fields on OverstoryConfig.pr — undefined
 * fields fall back to the DEFAULT_*_TIMEOUT_MS constants below.
 */
export type PrConfig = {
	operatorGithubLogin?: string;
	approvalTimeoutMs?: number;
	commentsTimeoutMs?: number;
	ciTimeoutMs?: number;
	requireOperatorPermission?: boolean;
};

const DEFAULT_CI_TIMEOUT_MS = 14_400_000; // 4h
const DEFAULT_COMMENTS_TIMEOUT_MS = 604_800_000; // 7d
const DEFAULT_APPROVAL_TIMEOUT_MS = 172_800_000; // 48h
const DEFAULT_DEBUG_TIMEOUT_MS = 3_600_000; // 1h

// TODO(w3): when src/missions/cells/pr-phase-triggers.ts merges, type trigger as PrPhaseTrigger

/** Check GitHub CI status for the mission's PR. */
// TODO(w3): when src/missions/cells/pr-phase-triggers.ts merges, type trigger as PrPhaseTrigger
export async function evaluateAwaitCI(
	mission: Mission,
	missionStore: MissionStore | null,
	projectRoot?: string,
	gateEnteredAt?: string,
	_deps?: { runGh?: GhBudget["runGh"]; now?: () => number; prConfig?: PrConfig },
): Promise<GateEvalResult> {
	if (!missionStore) return { met: false };
	const pr = missionStore.getPrState(mission.id);
	if (!pr) return { met: false };

	const runGh = _deps?.runGh ?? getGhBudget().runGh;
	const now = _deps?.now ?? (() => Date.now());

	const result = await runGh(
		[
			"pr",
			"checks",
			String(pr.prNumber),
			"--json",
			"name,status,conclusion,detailsUrl,startedAt,completedAt",
		],
		{ cwd: projectRoot },
	);

	if (result.stderr.includes("Bad credentials") || result.stderr.includes("gh: not logged in")) {
		return { met: true, trigger: "gh_auth_missing" };
	}

	let checks: Array<{ name: string; status: string; conclusion: string | null }> = [];
	try {
		const parsed = JSON.parse(result.stdout) as unknown;
		if (Array.isArray(parsed) && parsed.length > 0) {
			checks = parsed as typeof checks;
		}
	} catch {
		// parse failure — fall through to elapsed check
	}

	if (checks.length > 0) {
		const anyCompletedFailure = checks.some(
			(c) => c.status === "COMPLETED" && c.conclusion !== null && c.conclusion !== "SUCCESS",
		);
		const anyInProgress = checks.some((c) => c.status !== "COMPLETED");
		const allCompletedSuccess = !anyCompletedFailure && !anyInProgress;

		const worstStatus = anyCompletedFailure ? "FAILURE" : anyInProgress ? "IN_PROGRESS" : "SUCCESS";
		missionStore.updatePrCiStatus(mission.id, worstStatus);

		if (allCompletedSuccess) return { met: true, trigger: "ci_passed" };
		if (anyCompletedFailure) return { met: true, trigger: "ci_failed" };
		// some IN_PROGRESS — fall through to elapsed check
	}

	const ciTimeoutMs = _deps?.prConfig?.ciTimeoutMs ?? DEFAULT_CI_TIMEOUT_MS;
	if (gateEnteredAt && now() - new Date(gateEnteredAt).getTime() >= ciTimeoutMs) {
		return { met: true, trigger: "ci_timeout" };
	}
	return { met: false };
}

/** Check for new review comments on the mission's PR. */
// TODO(w3): when src/missions/cells/pr-phase-triggers.ts merges, type trigger as PrPhaseTrigger
export async function evaluateAwaitComments(
	mission: Mission,
	missionStore: MissionStore | null,
	projectRoot?: string,
	gateEnteredAt?: string,
	_deps?: { runGh?: GhBudget["runGh"]; now?: () => number; prConfig?: PrConfig },
): Promise<GateEvalResult> {
	if (!missionStore) return { met: false };
	const pr = missionStore.getPrState(mission.id);
	if (!pr) return { met: false };

	const runGh = _deps?.runGh ?? getGhBudget().runGh;
	const now = _deps?.now ?? (() => Date.now());

	const result = await runGh(["pr", "view", String(pr.prNumber), "--json", "comments,reviews"], {
		cwd: projectRoot,
	});

	if (result.stderr.includes("Bad credentials") || result.stderr.includes("gh: not logged in")) {
		return { met: true, trigger: "gh_auth_missing" };
	}

	type PrViewCommentsResult = {
		comments: Array<{ id: string; author: { login: string }; body: string }>;
		reviews: Array<{ state: string; author: { login: string } }>;
	};
	let parsed: PrViewCommentsResult | null = null;
	try {
		parsed = JSON.parse(result.stdout) as PrViewCommentsResult;
	} catch {
		// parse failure — fall through to elapsed check
	}

	if (parsed) {
		const existing = new Set(missionStore.listPrComments(mission.id).map((c) => c.commentId));
		const newComment = parsed.comments.find((c) => !existing.has(c.id));
		if (newComment) {
			const row: MissionPrCommentRow = {
				missionId: mission.id,
				prNumber: pr.prNumber,
				commentId: newComment.id,
				author: newComment.author.login,
				body: newComment.body,
				action: null,
				status: "pending",
				fixCycles: 0,
				detectedAt: new Date(now()).toISOString(),
				resolvedAt: null,
			};
			missionStore.recordPrComment(row);
			return {
				met: true,
				trigger: "new_comment",
				payload: {
					commentId: newComment.id,
					author: newComment.author.login,
					body: newComment.body,
				},
			};
		}

		const hasApproval = parsed.reviews.some((r) => r.state === "APPROVED");
		const pendingComments = missionStore
			.listPrComments(mission.id)
			.filter((c) => c.status === "pending");
		if (hasApproval && pendingComments.length === 0) {
			return { met: true, trigger: "approval_event" };
		}
	}

	const commentsTimeoutMs = _deps?.prConfig?.commentsTimeoutMs ?? DEFAULT_COMMENTS_TIMEOUT_MS;
	if (gateEnteredAt && now() - new Date(gateEnteredAt).getTime() >= commentsTimeoutMs) {
		return { met: true, trigger: "comments_stale" };
	}
	return { met: false };
}

const OPERATOR_APPROVAL_REGEX = /^(approved?|lgtm|✅)\s*\.?\s*$/i;

/** Check for PR approval, handling restrictive-wins and operator-override semantics. */
// TODO(w3): when src/missions/cells/pr-phase-triggers.ts merges, type trigger as PrPhaseTrigger
export async function evaluateAwaitApproval(
	mission: Mission,
	missionStore: MissionStore | null,
	_mailStore: MailStore | null,
	projectRoot?: string,
	gateEnteredAt?: string,
	_deps?: {
		runGh?: GhBudget["runGh"];
		now?: () => number;
		prConfig?: PrConfig;
		addMail?: (msg: {
			to: string;
			from: string;
			type: string;
			subject: string;
			body: string;
		}) => void;
	},
): Promise<GateEvalResult> {
	if (!missionStore) return { met: false };
	const pr = missionStore.getPrState(mission.id);
	if (!pr) return { met: false };

	const runGh = _deps?.runGh ?? getGhBudget().runGh;
	const now = _deps?.now ?? (() => Date.now());
	const prConfig = _deps?.prConfig;

	const result = await runGh(
		["pr", "view", String(pr.prNumber), "--json", "reviewDecision,reviews,headRefOid"],
		{ cwd: projectRoot },
	);

	if (result.stderr.includes("Bad credentials") || result.stderr.includes("gh: not logged in")) {
		return { met: true, trigger: "gh_auth_missing" };
	}

	type PrViewApprovalResult = {
		reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | null;
		reviews: Array<{ state: string; author: { login: string }; submittedAt: string }>;
		headRefOid: string;
		comments?: Array<{ id: string; author: { login: string }; body: string }>;
	};
	let parsed: PrViewApprovalResult | null = null;
	try {
		parsed = JSON.parse(result.stdout) as PrViewApprovalResult;
	} catch {
		return { met: false };
	}
	if (!parsed) return { met: false };

	// Build chronological latestByReviewer map (last state per reviewer)
	const relevantReviews = parsed.reviews
		.filter((r) => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED")
		.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
	const latestByReviewer = new Map<string, string>();
	for (const r of relevantReviews) {
		latestByReviewer.set(r.author.login, r.state);
	}

	const hasOutstandingChangesRequested = [...latestByReviewer.values()].some(
		(s) => s === "CHANGES_REQUESTED",
	);
	const hasAnyApproval = [...latestByReviewer.values()].some((s) => s === "APPROVED");

	const operatorLogin = prConfig?.operatorGithubLogin;
	const comments = parsed.comments ?? [];
	const prUrl = pr.prUrl;

	/** Try operator comment-approval: find matching comment, optionally check permission. */
	async function tryOperatorOverride(): Promise<boolean> {
		if (!operatorLogin) return false;
		const matchingComment = comments.find(
			(c) => c.author.login === operatorLogin && OPERATOR_APPROVAL_REGEX.test(c.body),
		);
		if (!matchingComment) return false;
		if (prConfig?.requireOperatorPermission === false) return true;
		// Check permission via gh api
		try {
			const urlParts = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\//);
			if (!urlParts) return false;
			const owner = urlParts[1];
			const repo = urlParts[2];
			const permResult = await runGh(
				["api", `repos/${owner}/${repo}/collaborators/${operatorLogin}/permission`],
				{ cwd: projectRoot },
			);
			const permParsed = JSON.parse(permResult.stdout) as { permission?: string };
			return permParsed.permission === "admin" || permParsed.permission === "maintain";
		} catch {
			return false;
		}
	}

	if (hasOutstandingChangesRequested) {
		const overrideApproved = await tryOperatorOverride();
		if (overrideApproved) {
			missionStore.setApprovedHeadSha(mission.id, parsed.headRefOid);
			return { met: true, trigger: "approved" };
		}
		return { met: true, trigger: "changes_requested" };
	}

	if (hasAnyApproval) {
		missionStore.setApprovedHeadSha(mission.id, parsed.headRefOid);
		return { met: true, trigger: "approved" };
	}

	// Comment-approval path: reviewDecision===null + operator LGTM comment + permission
	if (parsed.reviewDecision === null && operatorLogin) {
		const overrideApproved = await tryOperatorOverride();
		if (overrideApproved) {
			missionStore.setApprovedHeadSha(mission.id, parsed.headRefOid);
			return { met: true, trigger: "approved" };
		}
	}

	// Elapsed > approvalTimeoutMs → emit reminder + trigger
	const approvalTimeoutMs = prConfig?.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
	if (gateEnteredAt && now() - new Date(gateEnteredAt).getTime() > approvalTimeoutMs) {
		_deps?.addMail?.({
			to: `coordinator-${mission.slug}`,
			from: "gate-evaluator",
			type: "status",
			subject: "PR approval pending — operator nudge",
			body: `PR #${pr.prNumber} has been awaiting approval for over ${Math.round(approvalTimeoutMs / 3_600_000)}h.`,
		});
		return { met: true, trigger: "approval_pending_long" };
	}

	return { met: false };
}

/** Check if debug fix has been committed for the current PR debug cycle. */
// TODO(w3): when src/missions/cells/pr-phase-triggers.ts merges, type trigger as PrPhaseTrigger
export function evaluateAwaitDebugComplete(
	_mission: Mission,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
	_deps?: { now?: () => number; debugTimeoutMs?: number },
): GateEvalResult {
	if (!mailStore) return { met: false };

	const msgs = filterMailSinceGate(mailStore.getAll({}), gateEnteredAt);
	if (msgs.some((m) => (m.type as string) === "fix_committed")) {
		return { met: true, trigger: "fix_committed" };
	}

	const now = _deps?.now ?? (() => Date.now());
	const debugTimeoutMs = _deps?.debugTimeoutMs ?? DEFAULT_DEBUG_TIMEOUT_MS;
	if (gateEnteredAt && now() - new Date(gateEnteredAt).getTime() > debugTimeoutMs) {
		return { met: true, trigger: "debug_timeout" };
	}

	return { met: false };
}

/**
 * Filter mail messages to those created at or after the gate sticky filter time.
 * `gateFilterTime` is typically `mission_gate_state.resolved_at ?? entered_at`
 * (the sticky-timestamp pattern the watchdog already uses).
 *
 * Do NOT use this for `dispatchedAt`-scoped evaluators (debug-loop):
 * `evaluateAwaitDebugBriefReady` and `evaluateAwaitDebugFix` intentionally
 * filter from dispatch time, not gate entry.
 */
export function filterMailSinceGate<M extends { createdAt: string }>(
	messages: M[],
	gateFilterTime: string | undefined,
): M[] {
	if (!gateFilterTime) return messages;
	return messages.filter((m) => m.createdAt >= gateFilterTime);
}

/** Check if research phase has completed: analyst sent result mail to coordinator.
 * If all scouts dispatched by analyst have returned results but analyst hasn't
 * aggregated yet, escalate with a specific nudge telling analyst exactly what
 * to do. The scout content lives in analyst's inbox — only analyst can aggregate. */
export function evaluateAwaitResearch(
	mission: Mission,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };

	const analystName = mission.analystSessionId ? `mission-analyst-${mission.slug}` : null;
	if (!analystName) {
		// Analyst spawn may be in progress (tierSetCommand spawns after DB transaction).
		// Suppress nudge — grace period handles timing naturally.
		return { met: false };
	}

	// Path 1: analyst explicitly sent aggregated result to coordinator.
	const coordinatorName = `coordinator-${mission.slug}`;
	const coordInbox = filterMailSinceGate(mailStore.getAll({ to: coordinatorName }), gateEnteredAt);
	const hasResult = coordInbox.some((m) => m.type === "result" && m.from.includes("analyst"));
	if (hasResult) {
		return { met: true, trigger: "research_complete" };
	}

	// Path 2: graph-level scout aggregation detection.
	// If analyst dispatched scouts and all replied but analyst didn't aggregate,
	// send a specific nudge (not auto-advance — scout content is in analyst's
	// inbox, only analyst can meaningfully summarize for coordinator).
	// Scope to scout-prefixed recipients; analyst may also dispatch non-scout
	// agents (e.g. plan-review-lead) which must not poison this detection.
	const analystOutbox = mailStore.getAll({ from: analystName });
	const scoutDispatches = filterMailSinceGate(analystOutbox, gateEnteredAt).filter(
		(m) => m.type === "dispatch" && m.to.startsWith("scout-"),
	);
	if (scoutDispatches.length > 0) {
		const analystInbox = mailStore.getAll({ to: analystName });
		const completedCount = scoutDispatches.filter((dispatch) =>
			analystInbox.some(
				(reply) =>
					reply.from === dispatch.to &&
					reply.type === "result" &&
					reply.createdAt >= dispatch.createdAt,
			),
		).length;
		if (completedCount === scoutDispatches.length) {
			return {
				met: false,
				nudgeTarget: analystName,
				nudgeMessage: `All ${scoutDispatches.length} dispatched scouts have returned results. Aggregate their findings and send a result-type mail to ${coordinatorName} now.`,
			};
		}
	}

	return {
		met: false,
		nudgeTarget: analystName,
		nudgeMessage: "Complete research and send result mail to coordinator",
	};
}

/** Check if coordinator has evaluated research and is ready to advance. */
export function evaluateUnderstandReady(
	mission: Mission,
	mailStore?: MailStore | null,
	gateEnteredAt?: string,
): GateEvalResult {
	// Coordinator freezes mission → "frozen" trigger
	if (mission.state === "frozen") {
		return { met: true, trigger: "frozen" };
	}
	// Coordinator advanced phase → "ready" trigger
	if (mission.phase !== "understand") {
		return { met: true, trigger: "ready" };
	}
	if (mailStore) {
		const coordName = mission.slug ? `coordinator-${mission.slug}` : "coordinator";
		const msgs = filterMailSinceGate(mailStore.getAll({ to: coordName }), gateEnteredAt);

		// Auto-resolve if "Plan complete" mail arrived (analyst finished planning)
		const planComplete = msgs.find(
			(m) => m.type === "result" && m.subject?.toLowerCase().includes("plan complete"),
		);
		if (planComplete) {
			return { met: true, trigger: "ready" };
		}

		// If analyst has been dispatched for planning, understand phase is complete — advance.
		// The coordinator dispatching planning IS the signal that research has been evaluated.
		//
		// Apply a 60s grace window BEFORE gateEnteredAt: the coordinator often sends
		// the planning dispatch in the same Claude turn as research evaluation, and
		// that mail can land a few hundred ms BEFORE the engine officially writes
		// gateEnteredAt for understand-phase:evaluate. Hard-cutoff filtering misses
		// the dispatch and the gate sits until ceiling. The grace window covers the
		// race without permitting arbitrarily stale dispatches from previous freeze
		// cycles to re-trigger advance.
		const analystName = mission.slug ? `mission-analyst-${mission.slug}` : "mission-analyst";
		const graceWindowMs = 60_000;
		const cutoffMs = gateEnteredAt
			? new Date(gateEnteredAt).getTime() - graceWindowMs
			: Number.NEGATIVE_INFINITY;
		const allMsgs = mailStore
			.getAll({ to: analystName })
			.filter((m) => new Date(m.createdAt).getTime() >= cutoffMs);
		const planningDispatched = allMsgs.find(
			(m) =>
				m.type === "dispatch" &&
				(m.subject?.toLowerCase().includes("planning phase") ||
					m.subject?.toLowerCase().startsWith("planning:")),
		);
		if (planningDispatched) {
			return { met: true, trigger: "ready" };
		}
	}
	return {
		met: false,
		nudgeTarget: `coordinator-${mission.slug}`,
		nudgeMessage: "Research complete. Evaluate findings and advance to plan when ready.",
	};
}

/** Check if workstreams.json has been populated by analyst. */
export async function evaluateAwaitPlan(
	mission: Mission,
	artifactRoot: string,
): Promise<GateEvalResult> {
	try {
		const path = `${artifactRoot}/plan/workstreams.json`;
		const file = Bun.file(path);
		if (!(await file.exists())) return { met: false };
		const content = await file.json();
		const ws = content?.workstreams;
		if (Array.isArray(ws) && ws.length > 0) {
			return { met: true, trigger: "plan_written" };
		}
	} catch {
		// File doesn't exist or invalid JSON — not ready
	}
	return {
		met: false,
		nudgeTarget: `mission-analyst-${mission.slug}`,
		nudgeMessage: "Write workstream plan to workstreams.json",
	};
}

/**
 * Check if any workstream in the mission has TDD mode active (full or light).
 * Reads workstreams.json from the mission artifact root.
 */
async function isTddActive(artifactRoot: string): Promise<boolean> {
	try {
		const path = `${artifactRoot}/plan/workstreams.json`;
		const file = Bun.file(path);
		if (!(await file.exists())) return false;
		const content = await file.json();
		const ws = content?.workstreams;
		if (!Array.isArray(ws)) return false;
		return ws.some((w: { tddMode?: string }) => w.tddMode !== undefined && w.tddMode !== "skip");
	} catch {
		return false;
	}
}

/**
 * Check if architect has completed design: architect_ready mail + required files exist.
 * Adapts artifact requirements based on TDD mode:
 *   - TDD active: architecture.md + test-plan.yaml required
 *   - TDD inactive: architecture.md only (no test-plan.yaml)
 */
export async function evaluateArchitectDesign(
	mission: Mission,
	artifactRoot: string,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
): Promise<GateEvalResult> {
	if (!mailStore) return { met: false };

	// Guard: architect session must exist before nudging
	if (!mission.architectSessionId) {
		return { met: false };
	}

	const tddActive = await isTddActive(artifactRoot);

	// Required artifact: architecture.md (always)
	const archPath = `${artifactRoot}/plan/architecture.md`;
	const archExists = await Bun.file(archPath).exists();

	if (!archExists) {
		const artifacts = tddActive ? "architecture.md and test-plan.yaml" : "architecture.md";
		return {
			met: false,
			nudgeTarget: `architect-${mission.slug}`,
			nudgeMessage: `Complete ${artifacts}, then send architect_ready`,
		};
	}

	// Conditional artifact: test-plan.yaml (only when TDD active)
	if (tddActive) {
		const testPlanPath = `${artifactRoot}/plan/test-plan.yaml`;
		const testPlanExists = await Bun.file(testPlanPath).exists();
		if (!testPlanExists) {
			return {
				met: false,
				nudgeTarget: `architect-${mission.slug}`,
				nudgeMessage: "architecture.md exists but test-plan.yaml is missing. TDD mode is active.",
			};
		}
	}

	// Check for architect_ready mail
	const coordinatorName = `coordinator-${mission.slug}`;
	const msgs = filterMailSinceGate(mailStore.getAll({ to: coordinatorName }), gateEnteredAt);
	const hasArchitectReady = msgs.some(
		(m) => m.type === "status" && m.subject.includes("architect_ready"),
	);
	if (hasArchitectReady) {
		return { met: true, trigger: "architect_ready" };
	}

	return {
		met: false,
		nudgeTarget: `architect-${mission.slug}`,
		nudgeMessage: "Architecture artifacts exist. Send architect_ready mail to coordinator.",
	};
}

/** Check if coordinator has called ha mission handoff (phase changed to execute). */
export function evaluateAwaitHandoff(mission: Mission): GateEvalResult {
	if (mission.phase === "execute" || mission.phase === "done") {
		return { met: true, trigger: "handoff_complete" };
	}
	return {
		met: false,
		nudgeTarget: `coordinator-${mission.slug}`,
		nudgeMessage: "All prerequisites met. Call 'ha mission handoff' to start execution.",
	};
}

/**
 * Check if any active workstream has been merged since the gate was entered.
 *
 * Note: `mailStore.getAll` does not support type filtering — the fetch-all + find pattern
 * is intentional and bounded by the store's default limit (1000 messages).
 */
export async function evaluateWsCompletion(
	mission: Mission,
	mailStore: MailStore | null,
	artifactRoot: string,
	missionStore: MissionStore | null,
	gateEnteredAt?: string,
): Promise<GateEvalResult> {
	if (!mailStore) return { met: false };

	const edName = `execution-director-${mission.slug}`;

	// Legacy path (opt-out via env var) — advance on first `merged` mail to ED.
	// Default is the new SSOT path below.
	if (process.env.HARU_LEGACY_WS_COMPLETION === "true") {
		const msgs = filterMailSinceGate(mailStore.getAll({ to: edName }), gateEnteredAt);
		const mergedMail = msgs.find((m) => m.type === "merged");
		if (mergedMail) {
			return { met: true, trigger: "ws_merged", nudgeMessage: mergedMail.body };
		}
		return { met: false };
	}

	// New SSOT path — consult workstream_status table.
	// 1. Load planned workstream ids (lenient: only need ids, ignore other fields).
	const plannedIds: string[] = [];
	try {
		const wsPath = `${artifactRoot}/plan/workstreams.json`;
		const file = Bun.file(wsPath);
		if (await file.exists()) {
			const parsed = (await file.json()) as { workstreams?: Array<{ id?: string }> };
			for (const ws of parsed.workstreams ?? []) {
				if (typeof ws.id === "string" && ws.id.length > 0) plannedIds.push(ws.id);
			}
		}
	} catch (err) {
		// Malformed workstreams.json is not pre-handoff — it means plan is corrupted.
		// Surface to stderr so watchdog/operator notice; still return met:false so the
		// mission doesn't auto-advance on bad data.
		process.stderr.write(
			`[evaluateWsCompletion] malformed workstreams.json at ${artifactRoot}/plan/workstreams.json: ${String(err)}\n`,
		);
	}

	// 2. Pre-handoff (no plan yet) → not met.
	if (plannedIds.length === 0) return { met: false };

	// 3. Query status table.
	if (missionStore?.areAllWorkstreamsDone(mission.id, plannedIds)) {
		return { met: true, trigger: "ws_merged" };
	}

	// 4. Sticky-flag fallback: if producer has never fired AND at least one
	//    `merged` mail exists, honor the old behavior once — this keeps
	//    pre-PR-2 in-flight missions from hanging if migration v8 backfill
	//    missed them. After the first producer write per mission, this
	//    fallback is permanently disabled.
	if (!mission.hasEmittedWsProducerWrite) {
		const msgs = filterMailSinceGate(mailStore.getAll({ to: edName }), gateEnteredAt);
		const mergedMail = msgs.find((m) => m.type === "merged");
		if (mergedMail) {
			return {
				met: true,
				trigger: "ws_merged",
				nudgeMessage: `[ws_status_not_populated] ${mergedMail.body}`,
			};
		}
	}

	return { met: false };
}

/** Check if architecture_final mail has been received. */
export function evaluateArchFinal(
	mission: Mission,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };

	const coordinatorName = `coordinator-${mission.slug}`;
	const msgs = filterMailSinceGate(mailStore.getAll({ to: coordinatorName }), gateEnteredAt);
	const architectName = `architect-${mission.slug}`;
	const hasFinal = msgs.some(
		(m) =>
			m.from.includes(architectName) &&
			(m.subject.includes("architecture_final") || m.subject.includes("Architecture Finalization")),
	);

	if (hasFinal) {
		return { met: true, trigger: "architecture_final" };
	}

	return {
		met: false,
		nudgeTarget: `architect-${mission.slug}`,
		nudgeMessage: "Finalize architecture.md and send architecture_final mail.",
	};
}

/** Check if planning has started — either coordinator dispatched analyst, or
 * analyst self-transitioned (spawned plan-review-lead or delivered the plan). */
export function evaluateDispatchPlanning(
	mission: Mission,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };

	const analystName = `mission-analyst-${mission.slug}`;

	// Path 1: coordinator explicitly dispatched planning to analyst after gate entry.
	const analystInbox = filterMailSinceGate(mailStore.getAll({ to: analystName }), gateEnteredAt);
	const hasDispatch = analystInbox.some((m) => m.type === "dispatch");
	if (hasDispatch) {
		return { met: true, trigger: "planning_started" };
	}

	// Path 2: analyst already in planning — spawned plan-review-lead or delivered
	// a plan-complete result. No explicit coordinator dispatch is needed when
	// the analyst auto-transitions after research. gateEnteredAt filter deliberately
	// skipped: if these signals exist at all, planning is underway.
	// Subject match is strict ("plan complete" prefix) to avoid false-positive
	// advances on noisy subjects like "Plan obsolete" or "Planning canceled".
	const analystOutbox = mailStore.getAll({ from: analystName });
	const planningActive = analystOutbox.some(
		(m) =>
			m.to === "plan-review-lead" ||
			(m.type === "result" && (m.subject ?? "").toLowerCase().startsWith("plan complete")),
	);
	if (planningActive) {
		return { met: true, trigger: "planning_started" };
	}

	return {
		met: false,
		nudgeTarget: `coordinator-${mission.slug}`,
		nudgeMessage: "Dispatch analyst for planning phase",
	};
}

/** Check if architect has been dispatched for architecture review (post-merge). */
export function evaluateArchReviewDispatch(
	mission: Mission,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };

	const architectName = `architect-${mission.slug}`;
	const msgs = filterMailSinceGate(mailStore.getAll({ to: architectName }), gateEnteredAt);
	const hasDispatch = msgs.some(
		(m) => m.type === "dispatch" && m.subject.toLowerCase().includes("architecture review"),
	);
	if (hasDispatch) {
		return { met: true, trigger: "review_dispatched" };
	}
	return {
		met: false,
		nudgeTarget: `coordinator-${mission.slug}`,
		nudgeMessage: "Dispatch architect for post-merge architecture review",
		payload: {
			kind: "arch-review-stall",
			reason: "no architect dispatch observed within grace period",
		},
	};
}

/** Check if refactor builders have completed. */
export function evaluateRefactorCompletion(
	mission: Mission,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };

	const edName = `execution-director-${mission.slug}`;
	const msgs = filterMailSinceGate(mailStore.getAll({ to: edName }), gateEnteredAt);
	const hasDone = msgs.some((m) => m.type === "worker_done" || m.type === "merged");
	if (hasDone) {
		return { met: true, trigger: "refactor_done" };
	}
	return {
		met: false,
		nudgeTarget: edName,
		nudgeMessage: "Check refactor builder progress",
	};
}

/** Check if summary artifact has been produced. */
export async function evaluateSummaryReady(
	mission: Mission,
	artifactRoot: string,
): Promise<GateEvalResult> {
	try {
		const summaryPath = `${artifactRoot}/results/summary.md`;
		const exists = await Bun.file(summaryPath).exists();
		if (exists) {
			return { met: true, trigger: "summary_ready" };
		}
	} catch {
		// File check failed
	}
	return {
		met: false,
		nudgeTarget: `mission-analyst-${mission.slug}`,
		nudgeMessage: `[DONE PHASE] Write final mission summary to ${artifactRoot}/results/summary.md. Cover: objective, outcomes, shipped workstreams, known issues. Verify mission.phase === "done" before writing.`,
	};
}

/** Check if architecture review has completed (approved or stuck). */
export function evaluateArchReviewComplete(
	mission: Mission,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };

	const coordinatorName = `coordinator-${mission.slug}`;
	const msgs = filterMailSinceGate(mailStore.getAll({ to: coordinatorName }), gateEnteredAt);

	// Check for architecture review completion signals
	const hasApproved = msgs.some(
		(m) =>
			m.subject.toLowerCase().includes("architecture review") &&
			(m.type === "result" || m.subject.toLowerCase().includes("approved")),
	);
	if (hasApproved) {
		return { met: true, trigger: "approved" };
	}

	return {
		met: false,
		nudgeTarget: `architect-${mission.slug}`,
		nudgeMessage: "Complete architecture review and report results",
	};
}

// === Intake-phase gate evaluators (Stage A) ===

/**
 * Wait for `research_complete` mail from mission-analyst-intake.
 *
 * Fired by analyst once research/_summary.md materializes. Until then,
 * nudge the analyst with the standard "still working" message.
 *
 * Stage A locked-in decision (#228): the effective deadline is
 * `min(scout_count × 5min, 25min)`. The subgraph node carries the upper
 * bound (1500s) as `gateTimeout`; this evaluator surfaces an early stuck
 * signal when the analyst has been silent for longer than the adaptive
 * window allows. Scout count is derived from the analyst's outbound
 * `dispatch` mail (one per scout spawn).
 */
export function evaluateAwaitResearchComplete(
	mission: Mission,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };

	const analystName = `mission-analyst-${mission.slug}`;
	// Look for research_complete signal in any inbox tied to this mission
	// (analyst may address it to a coordinator or the mission system).
	const fromAnalyst = mailStore.getAll({ from: analystName });
	const ready = filterMailSinceGate(fromAnalyst, gateEnteredAt).find(
		(m) => m.type === "research_complete",
	);
	if (ready) {
		return { met: true, trigger: "research_ready" };
	}

	// Adaptive deadline: count scout dispatches the analyst has emitted, then
	// compute `min(scout_count × 5min, 25min)`. If the analyst hasn't
	// dispatched anyone yet (scout_count=0), fall back to the upper bound.
	const adaptiveBudgetMs = computeAdaptiveResearchTimeout(fromAnalyst);
	const stuckBeyondAdaptive =
		gateEnteredAt &&
		Date.now() - new Date(gateEnteredAt).getTime() > adaptiveBudgetMs &&
		// Don't out-shout the engine timeout: engine handles the hard cap.
		adaptiveBudgetMs < ADAPTIVE_RESEARCH_CAP_MS;

	return {
		met: false,
		nudgeTarget: analystName,
		nudgeMessage: stuckBeyondAdaptive
			? `Research has exceeded the adaptive ${Math.round(adaptiveBudgetMs / 60_000)}min budget — emit \`research_complete\` now or escalate via mail.`
			: "Research summary not yet emitted — finish synthesizing scout findings and send `research_complete` mail.",
	};
}

const ADAPTIVE_RESEARCH_PER_SCOUT_MS = 300_000; // 5 min/scout
const ADAPTIVE_RESEARCH_CAP_MS = 1_500_000; // 25 min hard cap

/**
 * Compute `min(scout_count × 300_000, 1_500_000)` ms based on the analyst's
 * outbound dispatch mail. Each scout spawn emits exactly one `dispatch` mail
 * from `mission-analyst-${slug}` to `scout-...`. Returns the cap when
 * scout_count is 0 (analyst hasn't dispatched yet).
 *
 * Exported for tests.
 */
export function computeAdaptiveResearchTimeout(
	analystOutbox: { type: string; to: string }[],
): number {
	const scoutDispatches = analystOutbox.filter(
		(m) => m.type === "dispatch" && m.to.startsWith("scout-"),
	).length;
	if (scoutDispatches === 0) return ADAPTIVE_RESEARCH_CAP_MS;
	return Math.min(scoutDispatches * ADAPTIVE_RESEARCH_PER_SCOUT_MS, ADAPTIVE_RESEARCH_CAP_MS);
}

/**
 * Wait for `spec_ready` mail from product-clarifier.
 *
 * Clarifier emits this once product-spec.md is materialized at the canonical
 * artifact path.
 */
export function evaluateAwaitSpecReady(
	mission: Mission,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
	projectRoot?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };

	const clarifierName = `product-clarifier-${mission.slug}`;
	const fromClarifier = mailStore.getAll({ from: clarifierName });
	const ready = filterMailSinceGate(fromClarifier, gateEnteredAt).find(
		(m) => m.type === "spec_ready",
	);
	if (ready) {
		// Bug fix (overstory-#401): the clarifier writes product-spec.md inside
		// its worktree (`<artifactRoot>/product-spec.md` interpreted relative to
		// worktree root, not canonical), so downstream handlers like
		// create-tracker-issue can't find it. Detect + copy from the predictable
		// worktree path before signalling the gate is met. Best-effort: missing
		// worktree copy just leaves the canonical path empty for the operator.
		if (projectRoot && mission.artifactRoot && mission.slug) {
			const canonicalSpec = joinPath(mission.artifactRoot, "product-spec.md");
			if (!existsSync(canonicalSpec)) {
				const worktreeSpec = joinPath(
					projectRoot,
					".overstory",
					"worktrees",
					mission.slug,
					`product-clarifier-${mission.slug}`,
					"product-spec.md",
				);
				if (existsSync(worktreeSpec)) {
					try {
						copyFileSync(worktreeSpec, canonicalSpec);
					} catch {
						// Non-fatal: human-spec-review or create-tracker-issue will
						// surface the missing-spec error if the copy fails.
					}
				}
			}
		}
		return { met: true, trigger: "spec_ready" };
	}

	return {
		met: false,
		nudgeTarget: clarifierName,
		nudgeMessage:
			"product-spec.md not yet emitted — synthesize intent + research into the spec template and send `spec_ready` mail.",
	};
}

/**
 * Supervised-mode human gate for product-spec review. Resolved by the operator
 * via `ha mission spec approve|reject`, which emits a `spec_approved` or
 * `spec_rejected` mail addressed to `operator-decision-${slug}`. Auto-skip for
 * non-supervised autonomies happens at the handler layer (see intake-phase.ts);
 * this evaluator only runs for supervised missions.
 *
 * Returns `met:true` with trigger `approved` or `rejected` once the operator
 * verdict mail is observed; otherwise stays open (no nudge target — there is
 * no agent to wake; the operator is the gate).
 */
export function evaluateHumanSpecReview(
	mission: Mission,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
): GateEvalResult {
	// Auto-skip the human gate for non-supervised autonomy modes. The engine
	// returns gate-result BEFORE invoking node handlers for `gate: "human"`
	// nodes, so the auto-skip MUST live here in the evaluator (the inline
	// handler in intake-phase.ts is unreachable from the engine).
	if (mission.autonomy === "auto-spec" || mission.autonomy === "auto-all") {
		return { met: true, trigger: "approved" };
	}

	if (!mailStore) return { met: false };
	const decisionRecipient = `operator-decision-${mission.slug}`;
	const verdicts = filterMailSinceGate(mailStore.getAll({ to: decisionRecipient }), gateEnteredAt);
	const verdict = verdicts.find((m) => m.type === "spec_approved" || m.type === "spec_rejected");
	if (verdict) {
		return {
			met: true,
			trigger: verdict.type === "spec_approved" ? "approved" : "rejected",
		};
	}
	// No nudge target — operator is the gate. Watchdog will surface stuck state
	// via gate-timeout escalation (default 1h on the human gate).
	return { met: false };
}

/**
 * Wait for tier to be set by tier-classifier (mission.tier transitions from
 * null to direct/planned/full).
 */
export function evaluateAwaitTierSet(mission: Mission): GateEvalResult {
	if (mission.tier !== null) {
		return { met: true, trigger: "tier_set" };
	}
	return {
		met: false,
		nudgeTarget: `tier-classifier-${mission.slug}`,
		nudgeMessage:
			"Mission tier not set — read product-spec.md, classify, and call `ha mission tier set <tier>`.",
	};
}

/** Window during which project-context.json is treated as fresh enough to
 * satisfy the await-context gate. Mirrors CONTEXT_CACHE_FRESH_MS in
 * intake-phase.ts (see #236). */
const CONTEXT_CACHE_FRESH_MS = 60 * 60 * 1000;

/**
 * Wait for `.overstory/project-context.json` to be written or refreshed by the
 * background `ha context generate` process spawned from
 * intake-phase.ensure-context-generate (#236).
 *
 * Gate is met when the cache file exists and its mtime is within
 * CONTEXT_CACHE_FRESH_MS of `now` — meaning either the file was already fresh
 * (handler should have short-circuited) or the background regen completed
 * since the gate was entered. The handler's freshness check uses the same
 * window, so this evaluator does not need its own staleness allowance.
 *
 * Optional deps allow tests to inject `now`/`statMtime` and avoid touching
 * the real filesystem. Production defaults call `Date.now()` and `statSyncFn`.
 */
export function evaluateAwaitContext(
	projectRoot: string | undefined,
	_deps?: { now?: () => number; statMtime?: (path: string) => number | null },
): GateEvalResult {
	// Missing projectRoot — degenerate case (e.g. tests, recovery). Treat as
	// "context_ready" so the graph can advance rather than stalling.
	if (!projectRoot) {
		return { met: true, trigger: "context_ready" };
	}
	const now = _deps?.now ?? (() => Date.now());
	const statMtime =
		_deps?.statMtime ??
		((path: string): number | null => {
			try {
				return statSyncFn(path).mtimeMs;
			} catch {
				return null;
			}
		});
	const overstoryDir = joinPath(projectRoot, detectHaruDir(projectRoot));
	const cachePath = joinPath(overstoryDir, "project-context.json");
	const mtimeMs = statMtime(cachePath);
	if (mtimeMs !== null && now() - mtimeMs < CONTEXT_CACHE_FRESH_MS) {
		return { met: true, trigger: "context_ready" };
	}
	// Background regen still in flight (or never started). No nudge target —
	// there is no agent to wake; the spawned subprocess will write the file
	// when ready. Watchdog will surface stuck state via the gateTimeout (600s)
	// configured on the await-context node in intake-phase.ts.
	return { met: false };
}

/**
 * Stage C: post-merge holdout gate with snapshot-diff semantics (w11).
 *
 * Compares baseline.json against holdout-result-<N>.json using compareSnapshotDiff.
 * Falls back to the subprocess-spawn path when no current result file exists yet.
 *
 * Result triggers:
 *   - `holdout_pass`: no new failures vs baseline
 *   - `holdout_fail`: new failures detected
 *   - `holdout_baseline_missing`: neither sentinel nor baseline.json present
 *   - `holdout_baseline_corrupt`: baseline.json unparseable or sentinel/file invariant broken
 *   - `holdout_skip`: legacy mission with null featureBranch (graceful degradation)
 */
export async function evaluateHoldoutGate(
	mission: Mission,
	missionStore: MissionStore | null,
	artifactRoot: string,
	projectRoot: string | undefined,
	_gateEnteredAt?: string,
): Promise<GateEvalResult> {
	if (!mission.featureBranch) {
		return { met: true, trigger: "holdout_skip" };
	}
	if (!missionStore) return { met: false };
	if (!projectRoot) {
		return { met: true, trigger: "holdout_skip" };
	}

	const attemptN = readDebugAttempts(missionStore, mission.id);
	const baselinePath = `${artifactRoot}/results/baseline.json`;
	const sentinelPresent = await baselineExists(artifactRoot);
	const baselineFile = Bun.file(baselinePath);
	const baselineFileExists = await baselineFile.exists();

	if (!baselineFileExists && !sentinelPresent) {
		return { met: true, trigger: "holdout_baseline_missing" };
	}

	// Try to parse baseline
	let baseline: HoldoutCheck[];
	try {
		baseline = (await baselineFile.json()) as HoldoutCheck[];
	} catch {
		return { met: true, trigger: "holdout_baseline_corrupt" };
	}

	// Invariant: sentinel must be present when file is present
	if (baselineFileExists && !sentinelPresent) {
		return { met: true, trigger: "holdout_baseline_corrupt" };
	}

	// Read current holdout result
	const resultPath = `${artifactRoot}/debug/holdout-result-${attemptN}.json`;
	const resultFile = Bun.file(resultPath);

	if (!(await resultFile.exists())) {
		// No result yet — fall back to subprocess-spawn path for forward-compat.
		const cp = missionStore.checkpoints.getCheckpoint(mission.id, "done-phase:holdout");
		const cpData = cp?.data as { pid?: number; attemptN?: number; startedAt?: string } | null;

		if (cpData?.pid && cpData.attemptN === attemptN) {
			if (isProcessRunning(cpData.pid)) {
				return {
					met: false,
					nudgeMessage: `Quality gates running (pid ${cpData.pid}, attempt ${attemptN})`,
				};
			}
			missionStore.checkpoints.saveCheckpoint(mission.id, "done-phase:holdout", {
				attemptN,
				crashedPid: cpData.pid,
				completedAt: new Date().toISOString(),
			});
			return { met: true, trigger: "holdout_fail" };
		}

		const runnerPath = new URL("../missions/holdout-runner.ts", import.meta.url).pathname;
		const debugDir = `${artifactRoot}/debug`;
		await Bun.write(`${debugDir}/.keep`, "");

		const subproc = Bun.spawn(
			["bun", "run", runnerPath, mission.id, String(attemptN), projectRoot, resultPath],
			{ detached: true, stdio: ["ignore", "ignore", "ignore"] },
		);
		subproc.unref();

		missionStore.checkpoints.saveCheckpoint(mission.id, "done-phase:holdout", {
			pid: subproc.pid,
			attemptN,
			featureBranch: mission.featureBranch,
			startedAt: new Date().toISOString(),
		});

		return {
			met: false,
			nudgeMessage: `Quality gates dispatched (pid ${subproc.pid}, attempt ${attemptN})`,
		};
	}

	const parsed = (await resultFile.json()) as { checks: HoldoutCheck[] };
	const diff = compareSnapshotDiff(baseline, parsed.checks);

	if (diff.newFailures.length === 0) {
		return {
			met: true,
			trigger: "holdout_pass",
			payload: { newFailures: diff.newFailures, resolvedFailures: diff.resolvedFailures },
		};
	}
	return {
		met: true,
		trigger: "holdout_fail",
		payload: { newFailures: diff.newFailures, resolvedFailures: diff.resolvedFailures },
	};
}

/** Read current debug attempt counter from checkpoint stored by dispatch-debugger handler. */
function readDebugAttempts(missionStore: MissionStore, missionId: string): number {
	const cp = missionStore.checkpoints.getCheckpoint(missionId, "done-phase:dispatch-debugger");
	const data = cp?.data as { debugAttempts?: number } | null;
	return data?.debugAttempts ?? 0;
}

/**
 * Stage C: wait for mission-analyst's `debug_brief_ready` mail.
 *
 * Fix #5 from full-PR review: debugger spawned per attempt with name
 * `debugger-<slug>-attempt-<N>`. Gate must read the correct per-attempt inbox.
 * Attempt counter lives in checkpoint at `done-phase:dispatch-debugger`.
 *
 * Fix #6 from full-PR review: filter by `dispatchedAt` (checkpoint timestamp)
 * instead of `gateEnteredAt`. The debugger and analyst run concurrently after
 * dispatch — by the time `request-analyst-brief` gate enters, mail may already
 * exist. Using `gateEnteredAt` would race-condition out valid early mails.
 */
export function evaluateAwaitDebugBriefReady(
	mission: Mission,
	mailStore: MailStore | null,
	missionStore: MissionStore | null,
	_gateEnteredAt?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };
	const attemptN = missionStore ? readDebugAttempts(missionStore, mission.id) : 0;
	const dispatchedAt = missionStore
		? (() => {
				const cp = missionStore.checkpoints.getCheckpoint(
					mission.id,
					"done-phase:dispatch-debugger",
				);
				const data = cp?.data as { dispatchedAt?: string } | null;
				return data?.dispatchedAt;
			})()
		: undefined;
	const debuggerInbox = `debugger-${mission.slug}-attempt-${attemptN}`;
	const msgs = mailStore.getAll({ to: debuggerInbox });
	const ready = msgs.find(
		(m) => m.type === "debug_brief_ready" && (!dispatchedAt || m.createdAt >= dispatchedAt),
	);
	if (ready) return { met: true, trigger: "brief_ready" };
	return {
		met: false,
		nudgeTarget: `mission-analyst-${mission.slug}`,
		nudgeMessage: "Package failure context into debug-brief.md; send debug_brief_ready mail.",
	};
}

/**
 * Stage C: wait for debugger's verdict — either `debug_fix_committed` (→ merge step)
 * or `debug_failed` (→ check-attempts handler for retry/exhausted decision).
 *
 * Same dispatchedAt-based filtering as evaluateAwaitDebugBriefReady (fix #6).
 */
export function evaluateAwaitDebugFix(
	mission: Mission,
	mailStore: MailStore | null,
	missionStore: MissionStore | null,
	_gateEnteredAt?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };
	const dispatchedAt = missionStore
		? (() => {
				const cp = missionStore.checkpoints.getCheckpoint(
					mission.id,
					"done-phase:dispatch-debugger",
				);
				const data = cp?.data as { dispatchedAt?: string } | null;
				return data?.dispatchedAt;
			})()
		: undefined;
	const coordinatorName = `coordinator-${mission.slug}`;
	const msgs = mailStore.getAll({ to: coordinatorName });
	const verdict = msgs.find(
		(m) =>
			(m.type === "debug_fix_committed" || m.type === "debug_failed") &&
			(!dispatchedAt || m.createdAt >= dispatchedAt),
	);
	if (verdict) {
		return {
			met: true,
			trigger: verdict.type === "debug_fix_committed" ? "fix_committed" : "fix_failed",
		};
	}
	// Issue #337: nudge the actual spawned agent name. The dispatch-debugger
	// handler spawns `debugger-<slug>-attempt-<N>` (see debug-loop-handlers.ts),
	// so a slug-only nudge target results in `delivered:false` because no agent
	// is registered under that bare name. Read attemptN from the same
	// checkpoint that evaluateAwaitDebugBriefReady uses.
	const attemptN = missionStore ? readDebugAttempts(missionStore, mission.id) : 0;
	return {
		met: false,
		nudgeTarget: `debugger-${mission.slug}-attempt-${attemptN}`,
		nudgeMessage: "Apply minimal fix per debug-brief; commit and send debug_fix_committed.",
	};
}

/** Dispatch gate evaluator based on the current node ID. */
export async function evaluateGate(
	nodeId: string,
	mission: Mission,
	stores: {
		mailStore: MailStore | null;
		sessionStore: SessionStore;
		missionStore?: MissionStore | null;
	},
	artifactRoot: string,
	gateEnteredAt?: string,
	/** Stage C: project root passed through for holdout subprocess cwd. Optional
	 * for backward compat with evaluators that don't need it. */
	projectRoot?: string,
	prConfig?: PrConfig,
): Promise<GateEvalResult> {
	// Node IDs follow cellType:nodeName convention
	const parts = nodeId.split(":");
	const nodeName = parts[1];

	switch (nodeName) {
		case "await-research":
			return evaluateAwaitResearch(mission, stores.mailStore, gateEnteredAt);
		case "evaluate":
			return evaluateUnderstandReady(mission, stores.mailStore, gateEnteredAt);
		case "dispatch-planning":
			return evaluateDispatchPlanning(mission, stores.mailStore, gateEnteredAt);
		case "await-plan":
			return evaluateAwaitPlan(mission, artifactRoot);
		case "architect-design":
			return evaluateArchitectDesign(mission, artifactRoot, stores.mailStore, gateEnteredAt);
		case "await-handoff":
			return evaluateAwaitHandoff(mission);
		case "await-ws-completion":
			return evaluateWsCompletion(
				mission,
				stores.mailStore,
				artifactRoot,
				stores.missionStore ?? null,
				gateEnteredAt,
			);
		case "dispatch-architect":
			return evaluateArchReviewDispatch(mission, stores.mailStore, gateEnteredAt);
		case "await-arch-review":
			return evaluateArchReviewComplete(mission, stores.mailStore, gateEnteredAt);
		case "await-refactor":
			return evaluateRefactorCompletion(mission, stores.mailStore, gateEnteredAt);
		case "await-arch-final":
			return evaluateArchFinal(mission, stores.mailStore, gateEnteredAt);
		case "summary":
			return evaluateSummaryReady(mission, artifactRoot);
		case "await-leads-done":
			return evaluateAwaitLeadsDone(mission, stores.mailStore, gateEnteredAt);
		case "review":
			return evaluatePlanReviewComplete(mission, stores.mailStore, gateEnteredAt);
		case "review-stuck":
			return evaluateReviewStuck(mission, stores.mailStore);
		case "collect-verdicts":
			return evaluateCollectVerdicts(mission, stores.mailStore, gateEnteredAt);
		case "frozen":
			// Human gates are resolved by ha mission answer, not by evaluators.
			// Return met:false without unknown flag to suppress missing-evaluator warnings.
			return { met: false };
		case "await-research-complete":
			return evaluateAwaitResearchComplete(mission, stores.mailStore, gateEnteredAt);
		case "await-spec-ready":
			return evaluateAwaitSpecReady(mission, stores.mailStore, gateEnteredAt, projectRoot);
		case "await-tier-set":
			return evaluateAwaitTierSet(mission);
		case "await-context":
			return evaluateAwaitContext(projectRoot);
		case "human-spec-review":
			// Supervised mode: resolved by `ha mission spec approve|reject` which
			// emits `spec_approved` / `spec_rejected` mail. Auto-spec/auto-all
			// modes short-circuit via the handler before this evaluator runs.
			return evaluateHumanSpecReview(mission, stores.mailStore, gateEnteredAt);
		// Stage C debug-loop gates
		case "holdout":
			return evaluateHoldoutGate(
				mission,
				stores.missionStore ?? null,
				artifactRoot,
				projectRoot,
				gateEnteredAt,
			);
		case "request-analyst-brief":
			return evaluateAwaitDebugBriefReady(
				mission,
				stores.mailStore,
				stores.missionStore ?? null,
				gateEnteredAt,
			);
		case "await-debug-fix":
			return evaluateAwaitDebugFix(
				mission,
				stores.mailStore,
				stores.missionStore ?? null,
				gateEnteredAt,
			);
		// PR-phase gates (Stage E)
		case "await-ci":
			return evaluateAwaitCI(mission, stores.missionStore ?? null, projectRoot, gateEnteredAt, {
				prConfig,
			});
		case "await-comments":
			return evaluateAwaitComments(
				mission,
				stores.missionStore ?? null,
				projectRoot,
				gateEnteredAt,
				{ prConfig },
			);
		case "await-approval":
			return evaluateAwaitApproval(
				mission,
				stores.missionStore ?? null,
				stores.mailStore,
				projectRoot,
				gateEnteredAt,
				{ prConfig },
			);
		case "await-debug-complete":
			return evaluateAwaitDebugComplete(mission, stores.mailStore, gateEnteredAt);
		default:
			return { met: false, unknown: true };
	}
}

/** Direct-tier gate: check coordinator inbox for merge_ready from leads. */
function evaluateAwaitLeadsDone(
	mission: Mission,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };
	// Coordinator name is slug-scoped or bare
	const coordName = mission.slug ? `coordinator-${mission.slug}` : "coordinator";
	const msgs = filterMailSinceGate(mailStore.getAll({ to: coordName }), gateEnteredAt);
	const mergeReady = msgs.find((m) => m.type === "merge_ready");
	if (mergeReady) {
		return {
			met: true,
			trigger: "lead_done",
		};
	}
	return {
		met: false,
		nudgeTarget: coordName,
		nudgeMessage: "Waiting for lead merge_ready signal. Check lead status.",
	};
}

/** Plan-phase review gate: check if plan review converged with APPROVE verdict. */
function evaluatePlanReviewComplete(
	mission: Mission,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };
	const analystName = mission.slug ? `mission-analyst-${mission.slug}` : "mission-analyst";
	const msgs = mailStore.getAll({ to: analystName });
	const approved = filterMailSinceGate(msgs, gateEnteredAt).find(
		(m) =>
			m.type === "plan_review_consolidated" &&
			(m.subject?.toLowerCase().includes("approve") ?? false),
	);
	if (approved) {
		return { met: true, trigger: "approved" };
	}
	const stuck = filterMailSinceGate(msgs, gateEnteredAt).find(
		(m) =>
			m.type === "plan_review_consolidated" &&
			(m.subject?.toLowerCase().includes("stuck") ?? false),
	);
	if (stuck) {
		return { met: true, trigger: "stuck" };
	}
	return { met: false };
}

/** Plan-phase review-stuck gate: check if stuck review was resolved. */
function evaluateReviewStuck(mission: Mission, mailStore: MailStore | null): GateEvalResult {
	if (!mailStore) return { met: false };
	if (mission.phase !== "plan") {
		return { met: true, trigger: "override" };
	}
	return { met: false };
}

/** Review cell collect-verdicts gate: check if any critic verdicts arrived. */
function evaluateCollectVerdicts(
	_mission: Mission,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };
	const reviewLeadMsgs = filterMailSinceGate(
		mailStore.getAll({ to: "plan-review-lead" }),
		gateEnteredAt,
	);
	const hasVerdicts = reviewLeadMsgs.some((m) => m.type === "plan_critic_verdict");
	if (hasVerdicts) {
		return { met: true, trigger: "verdicts_collected" };
	}
	return { met: false };
}
