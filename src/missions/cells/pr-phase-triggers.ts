/**
 * PR-phase trigger string-literal union.
 */
export const PR_PHASE_TRIGGERS = [
	// preflight
	"preflight_passed",
	"pr_phase_disabled",
	"gh_auth_missing",
	// create
	"pr_created",
	"pr_already_exists",
	"pr_create_network_fail",
	"pr_rate_limited",
	"pr_branch_protected",
	"pr_no_commits",
	// ci
	"ci_passed",
	"ci_failed",
	"ci_timeout",
	// classify-ci-red
	"ci_flake_retry",
	"ci_infra_fail",
	"ci_code_fail",
	// debug-loop (shared with done-phase, from w12 factory)
	"debugger_dispatched",
	"capability_missing",
	"dispatch_failed",
	"brief_ready",
	"fix_committed",
	"fix_failed",
	"debug_timeout",
	"retry",
	"exhausted",
	"escalated",
	// merge-debug-fix
	"merged",
	"merge_conflict",
	// comments / triage
	"new_comment",
	"approval_event",
	"comments_stale",
	"trivial_fix",
	"needs_context",
	"refactor_request",
	"reply_only",
	"human_triage_request",
	"pr_triage_flood",
	// resume-coordinator
	"coordinator_done",
	"coordinator_session_unavailable",
	// approval
	"approved",
	"changes_requested",
	"approval_pending_long",
	// merge
	"pr_head_changed",
	"pr_merge_conflict",
] as const;

export type PrPhaseTrigger = (typeof PR_PHASE_TRIGGERS)[number];
