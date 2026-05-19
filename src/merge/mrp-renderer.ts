export interface MergeReadinessPack {
	schema_version: 1;
	mission: {
		id: string;
		slug: string;
		tier: "direct" | "planned" | "full";
		autonomy: "supervised" | "auto-spec" | "auto-all";
		intent_summary: string;
		parent_mission_id?: string | null;
	};
	duration: {
		started_at: string;
		finished_at: string;
		wall_clock_seconds: number;
	};
	diff: {
		files_changed: number;
		additions: number;
		deletions: number;
		by_workstream: Array<{
			ws_id: string;
			files_changed: number;
			additions: number;
			deletions: number;
		}>;
	};
	tests: {
		total: number;
		passed: number;
		failed: number;
		skipped: number;
		new_tests: Array<{ file: string; name: string }>;
	};
	quality_gates: {
		bun_test: "pass" | "fail" | "skip";
		biome: "pass" | "fail" | "skip";
		tsc: "pass" | "fail" | "skip";
	};
	compat: {
		breaking_changes: string[];
		checked_branches: string[];
	};
	risk_signals: Record<string, unknown>;
	workstreams: Array<{
		ws_id: string;
		objective: string;
		files_touched: string[];
		task_id: string;
	}>;
	acceptance_criteria: Array<{ text: string; status: "pass" | "fail" | "unknown" }>;
	linked_issues: Array<{ ref: string; url?: string }>;
	debug_iterations: Array<{ attempt: number; failure_summary: string; fix_summary: string }>;
	agent_trail: Array<{ commit: string; author_agent: string; capability: string }>;
	cost: {
		tokens_total: number;
		usd_total: number;
	};
	reviewers?: string[];
}

function gateIcon(status: "pass" | "fail" | "skip"): string {
	if (status === "pass") return "✅";
	if (status === "fail") return "❌";
	return "⏭️";
}

function criterionIcon(status: "pass" | "fail" | "unknown"): string {
	if (status === "pass") return "✅";
	if (status === "fail") return "❌";
	return "❓";
}

/**
 * Render a MergeReadinessPack as GitHub-flavoured markdown.
 *
 * opts.taskId — when set to a non-empty string, appends "\n\nCloses <taskId>" to the
 * rendered output. The caller is responsible for filtering null / PENDING_SENTINEL / invalid
 * ids via isRealTaskId — the renderer treats taskId as opaque and trusts the caller.
 * Pre-pr-phase also calls this function (for the MRP-on-disk artifact); the new opt is
 * optional and binary-compatible, so that call site is unaffected.
 */
export function renderMrpMarkdown(
	mrp: MergeReadinessPack,
	opts?: { showCost?: boolean; taskId?: string },
): string {
	const lines: string[] = [];

	lines.push(`# Merge Readiness Pack — ${mrp.mission.slug}`);
	lines.push("");

	// TL;DR
	lines.push("## TL;DR");
	lines.push(`- **Intent:** ${mrp.mission.intent_summary}`);
	lines.push(`- **Tier:** ${mrp.mission.tier} | **Autonomy:** ${mrp.mission.autonomy}`);
	lines.push(
		`- **Duration:** ${mrp.duration.started_at} → ${mrp.duration.finished_at} (${mrp.duration.wall_clock_seconds}s)`,
	);
	lines.push("");

	// Diff
	lines.push("## Diff");
	lines.push(
		`- Files: ${mrp.diff.files_changed} changed, +${mrp.diff.additions} / -${mrp.diff.deletions}`,
	);
	if (mrp.diff.by_workstream.length > 0) {
		lines.push("");
		lines.push("| Workstream | Files | +Lines | -Lines |");
		lines.push("|---|---|---|---|");
		for (const ws of mrp.diff.by_workstream) {
			lines.push(`| ${ws.ws_id} | ${ws.files_changed} | ${ws.additions} | ${ws.deletions} |`);
		}
	}
	lines.push("");

	// Acceptance
	lines.push("## Acceptance");
	for (const ac of mrp.acceptance_criteria) {
		lines.push(`- ${criterionIcon(ac.status)} ${ac.text}`);
	}
	lines.push("");

	// Quality gates
	lines.push("## Quality gates");
	lines.push(`- bun_test: ${gateIcon(mrp.quality_gates.bun_test)}`);
	lines.push(`- biome: ${gateIcon(mrp.quality_gates.biome)}`);
	lines.push(`- tsc: ${gateIcon(mrp.quality_gates.tsc)}`);
	lines.push("");

	// Workstreams
	lines.push("## Workstreams");
	lines.push("| ID | Objective | Task |");
	lines.push("|---|---|---|");
	for (const ws of mrp.workstreams) {
		lines.push(`| ${ws.ws_id} | ${ws.objective} | ${ws.task_id} |`);
	}
	lines.push("");

	// Linked issues
	lines.push("## Linked issues");
	for (const issue of mrp.linked_issues) {
		const label = issue.url != null ? `[${issue.ref}](${issue.url})` : issue.ref;
		lines.push(`- ${label}`);
	}
	lines.push("");

	// Debug iterations (conditional)
	if (mrp.debug_iterations.length > 0) {
		lines.push("## Debug iterations");
		for (const iter of mrp.debug_iterations) {
			lines.push(`- **Attempt ${iter.attempt}:** ${iter.failure_summary} → ${iter.fix_summary}`);
		}
		lines.push("");
	}

	// Agent trail
	lines.push("## Agent trail");
	lines.push("| Commit | Agent | Capability |");
	lines.push("|---|---|---|");
	for (const entry of mrp.agent_trail) {
		lines.push(`| ${entry.commit} | ${entry.author_agent} | ${entry.capability} |`);
	}
	lines.push("");

	// Cost (conditional)
	if (opts?.showCost === true) {
		lines.push("## Cost");
		lines.push(`- Tokens: ${mrp.cost.tokens_total}`);
		lines.push(`- USD: $${mrp.cost.usd_total}`);
		lines.push("");
	}

	let result = lines.join("\n");
	if (opts?.taskId) {
		result += `\nCloses ${opts.taskId}`;
	}
	return result;
}
