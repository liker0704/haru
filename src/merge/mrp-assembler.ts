import { readdirSync } from "node:fs";
import { join } from "node:path";
import { OverstoryError } from "../errors.ts";
import type { SessionMetrics } from "../metrics/types.ts";
import type { Mission } from "../missions/types.ts";
import type { MergeReadinessPack } from "./mrp-renderer.ts";

export class MrpAssemblyError extends OverstoryError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, "MRP_ASSEMBLY_ERROR", options);
		this.name = "MrpAssemblyError";
	}
}

interface GitRunResult {
	stdout: string;
	exitCode: number;
	stderr: string;
}

type GitRunner = (args: string[], cwd: string) => Promise<GitRunResult>;

export interface AssembleMrpDeps {
	missionStore: {
		getById(id: string): Mission | null;
	};
	metricsStore: {
		getSessionsByRun(runId: string): SessionMetrics[];
	};
	resolveArtifactRoot: (mission: Mission) => string;
	repoRoot: string;
	runGit?: GitRunner;
	baseBranch?: string;
}

async function defaultRunGit(args: string[], cwd: string): Promise<GitRunResult> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { stdout, exitCode, stderr };
}

interface FileStat {
	file: string;
	additions: number;
	deletions: number;
}

interface NumstatResult {
	filesChanged: number;
	additions: number;
	deletions: number;
	files: FileStat[];
}

function parseNumstat(output: string): NumstatResult {
	const lines = output
		.trim()
		.split("\n")
		.filter((l) => l.length > 0);
	const files: FileStat[] = [];
	let additions = 0;
	let deletions = 0;
	for (const line of lines) {
		const parts = line.split("\t");
		const add = parseInt(parts[0] ?? "0", 10) || 0;
		const del = parseInt(parts[1] ?? "0", 10) || 0;
		const file = parts[2] ?? "";
		if (file) {
			files.push({ file, additions: add, deletions: del });
			additions += add;
			deletions += del;
		}
	}
	return { filesChanged: files.length, additions, deletions, files };
}

async function readJsonOrDefault<T>(filePath: string, fallback: T): Promise<T> {
	try {
		const value = await Bun.file(filePath).json();
		return value as T;
	} catch {
		return fallback;
	}
}

function extractIssueRefs(text: string): string[] {
	const matches = text.match(/#\d+/g) ?? [];
	return [...new Set(matches)];
}

function parseAcceptanceCriteria(
	content: string,
): Array<{ text: string; status: "pass" | "fail" | "unknown" }> {
	const parts = content.split(/^## Acceptance criteria/im);
	const section = parts[1];
	if (!section) return [];
	const body = section.split(/^## /m)[0] ?? section;
	const items: Array<{ text: string; status: "pass" | "fail" | "unknown" }> = [];
	for (const line of body.split("\n")) {
		const m = line.match(/^- \[[ xX]\] (.+)/);
		if (m) {
			const text = m[1];
			if (text) items.push({ text: text.trim(), status: "unknown" });
		}
	}
	return items;
}

function parseAgentTrail(
	output: string,
): Array<{ commit: string; author_agent: string; capability: string }> {
	const lines = output
		.trim()
		.split("\n")
		.filter((l) => l.length > 0);
	return lines.map((line) => {
		const parts = line.split("|");
		const commit = (parts[0] ?? "").trim();
		const email = parts[1] ?? "";
		const author_agent = email.split("@")[0] ?? email;
		return { commit, author_agent, capability: "unknown" };
	});
}

function extractMarkdownSection(content: string, keyword: string): string | undefined {
	const lines = content.split("\n");
	let inSection = false;
	const buf: string[] = [];
	for (const line of lines) {
		if (/^#{1,3}\s/.test(line) && line.toLowerCase().includes(keyword.toLowerCase())) {
			inSection = true;
			continue;
		}
		if (inSection && /^#{1,3}\s/.test(line)) break;
		if (inSection && line.trim()) buf.push(line.trim());
	}
	return buf.length > 0 ? buf.join(" ") : undefined;
}

async function scanDebugAttempts(
	artifactRoot: string,
): Promise<Array<{ attempt: number; failure_summary: string; fix_summary: string }>> {
	const attemptsDir = join(artifactRoot, "debug", "attempts");
	let entries: string[];
	try {
		entries = readdirSync(attemptsDir);
	} catch {
		return [];
	}
	const result: Array<{ attempt: number; failure_summary: string; fix_summary: string }> = [];
	for (const entry of entries) {
		const n = parseInt(entry, 10);
		if (Number.isNaN(n)) continue;
		let content = "";
		try {
			content = await Bun.file(join(attemptsDir, entry, "hypothesis.md")).text();
		} catch {
			// graceful default
		}
		result.push({
			attempt: n,
			failure_summary: extractMarkdownSection(content, "failure") ?? "",
			fix_summary: extractMarkdownSection(content, "fix") ?? "",
		});
	}
	result.sort((a, b) => a.attempt - b.attempt);
	return result;
}

// Internal JSON file shapes
interface WorkstreamEntry {
	id?: string;
	taskId?: string;
	objective?: string;
	fileScope?: string[];
}

interface WorkstreamsFile {
	workstreams?: WorkstreamEntry[];
}

interface TestReportFile {
	total?: number;
	passed?: number;
	failed?: number;
	skipped?: number;
	new_tests?: Array<{ file: string; name: string }>;
}

interface QualityGatesFile {
	bun_test?: "pass" | "fail" | "skip";
	biome?: "pass" | "fail" | "skip";
	tsc?: "pass" | "fail" | "skip";
}

export async function assembleMrp(
	missionId: string,
	deps: AssembleMrpDeps,
): Promise<MergeReadinessPack> {
	const runGit = deps.runGit ?? defaultRunGit;
	const baseBranch = deps.baseBranch ?? "main";

	const mission = deps.missionStore.getById(missionId);
	if (!mission) {
		throw new MrpAssemblyError(`assembleMrp: mission not found: ${missionId}`);
	}

	const featureBranch = mission.featureBranch;
	if (!featureBranch) {
		throw new MrpAssemblyError("assembleMrp requires featureBranch");
	}

	const artifactRoot = deps.resolveArtifactRoot(mission);

	const startedAt = mission.createdAt;
	const finishedAt = new Date().toISOString();
	const wallClockSeconds = Math.max(
		0,
		Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000),
	);

	const wsFile = await readJsonOrDefault<WorkstreamsFile>(
		join(artifactRoot, "plan", "workstreams.json"),
		{},
	);
	const workstreams = (wsFile.workstreams ?? []).map((ws) => ({
		ws_id: ws.id ?? "",
		objective: ws.objective ?? "",
		files_touched: ws.fileScope ?? [],
		task_id: ws.taskId ?? "",
	}));

	const diffRaw = await runGit(
		["diff", "--numstat", `${baseBranch}...${featureBranch}`],
		deps.repoRoot,
	);
	const diffParsed: NumstatResult =
		diffRaw.exitCode === 0
			? parseNumstat(diffRaw.stdout)
			: { filesChanged: 0, additions: 0, deletions: 0, files: [] };

	const byWorkstream = workstreams.map((ws) => {
		const matched = diffParsed.files.filter((f) =>
			ws.files_touched.some(
				(scope) =>
					f.file === scope || f.file.startsWith(`${scope}/`) || scope.startsWith(`${f.file}/`),
			),
		);
		return {
			ws_id: ws.ws_id,
			files_changed: matched.length,
			additions: matched.reduce((s, f) => s + f.additions, 0),
			deletions: matched.reduce((s, f) => s + f.deletions, 0),
		};
	});

	const testReport = await readJsonOrDefault<TestReportFile>(
		join(artifactRoot, "results", "test-report.json"),
		{},
	);
	const tests: MergeReadinessPack["tests"] = {
		total: testReport.total ?? 0,
		passed: testReport.passed ?? 0,
		failed: testReport.failed ?? 0,
		skipped: testReport.skipped ?? 0,
		new_tests: testReport.new_tests ?? [],
	};

	const gatesFile = await readJsonOrDefault<QualityGatesFile>(
		join(artifactRoot, "results", "quality-gates.json"),
		{},
	);
	const quality_gates: MergeReadinessPack["quality_gates"] = {
		bun_test: gatesFile.bun_test ?? "skip",
		biome: gatesFile.biome ?? "skip",
		tsc: gatesFile.tsc ?? "skip",
	};

	let specContent = "";
	try {
		specContent = await Bun.file(join(artifactRoot, "product-spec.md")).text();
	} catch {
		// graceful default
	}

	const acceptance_criteria = parseAcceptanceCriteria(specContent);

	const issueRefs = new Set(extractIssueRefs(specContent));
	const logRaw = await runGit(
		["log", "--format=%s", `${baseBranch}..${featureBranch}`],
		deps.repoRoot,
	);
	if (logRaw.exitCode === 0) {
		for (const ref of extractIssueRefs(logRaw.stdout)) issueRefs.add(ref);
	}
	const selfRef = /#\d+/.exec(mission.objective)?.[0] ?? null;
	const linked_issues = [...issueRefs].filter((ref) => ref !== selfRef).map((ref) => ({ ref }));

	const debug_iterations = await scanDebugAttempts(artifactRoot);

	const trailRaw = await runGit(
		["log", "--format=%H|%ae|%s", `${baseBranch}..${featureBranch}`],
		deps.repoRoot,
	);
	const agent_trail = trailRaw.exitCode === 0 ? parseAgentTrail(trailRaw.stdout) : [];

	let tokensTotal = 0;
	let usdTotal = 0;
	if (mission.runId) {
		for (const s of deps.metricsStore.getSessionsByRun(mission.runId)) {
			tokensTotal += s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheCreationTokens;
			usdTotal += s.estimatedCostUsd ?? 0;
		}
	}

	return {
		schema_version: 1,
		mission: {
			id: mission.id,
			slug: mission.slug,
			tier: mission.tier ?? "direct",
			autonomy: mission.autonomy,
			intent_summary: mission.objective,
			parent_mission_id: mission.parentMissionId ?? null,
		},
		duration: {
			started_at: startedAt,
			finished_at: finishedAt,
			wall_clock_seconds: wallClockSeconds,
		},
		diff: {
			files_changed: diffParsed.filesChanged,
			additions: diffParsed.additions,
			deletions: diffParsed.deletions,
			by_workstream: byWorkstream,
		},
		tests,
		quality_gates,
		compat: { breaking_changes: [], checked_branches: [] },
		risk_signals: {},
		workstreams,
		acceptance_criteria,
		linked_issues,
		debug_iterations,
		agent_trail,
		cost: { tokens_total: tokensTotal, usd_total: usdTotal },
	};
}
