import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMetrics } from "../metrics/types.ts";
import type { Mission } from "../missions/types.ts";
import { type AssembleMrpDeps, assembleMrp, MrpAssemblyError } from "./mrp-assembler.ts";

function makeGitRunner(responses: Partial<Record<string, string>> = {}) {
	return async (
		args: string[],
		_cwd: string,
	): Promise<{ stdout: string; exitCode: number; stderr: string }> => {
		const key = args.slice(0, 2).join(" ");
		const stdout = responses[key] ?? "";
		return { stdout, exitCode: 0, stderr: "" };
	};
}

function buildFakeMission(overrides: Partial<Mission> = {}): Mission {
	return {
		id: "mission-001",
		slug: "test-mission",
		objective: "Test objective for #123 integration",
		runId: "run-001",
		state: "completed",
		phase: "done",
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
		startedAt: "2026-05-01T10:00:00.000Z",
		completedAt: "2026-05-01T11:30:00.000Z",
		createdAt: "2026-05-01T10:00:00.000Z",
		updatedAt: "2026-05-01T11:30:00.000Z",
		learningsExtracted: false,
		tier: "direct",
		hasEmittedWsProducerWrite: false,
		autonomy: "supervised",
		featureBranch: "feature/test",
		parentMissionId: null,
		...overrides,
	};
}

function buildFakeSession(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
	return {
		agentName: "builder-test",
		taskId: "task-001",
		capability: "builder",
		startedAt: "2026-05-01T10:00:00.000Z",
		completedAt: "2026-05-01T11:30:00.000Z",
		durationMs: 5_400_000,
		exitCode: 0,
		mergeResult: null,
		parentAgent: null,
		inputTokens: 1000,
		outputTokens: 500,
		cacheReadTokens: 200,
		cacheCreationTokens: 100,
		estimatedCostUsd: 0.05,
		modelUsed: "claude-sonnet",
		runId: "run-001",
		...overrides,
	};
}

describe("assembleMrp", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "mrp-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("happy-path: returns MergeReadinessPack with all 15 top-level fields populated", async () => {
		await mkdir(join(tmpDir, "plan"), { recursive: true });
		await mkdir(join(tmpDir, "results"), { recursive: true });

		await Bun.write(
			join(tmpDir, "plan", "workstreams.json"),
			JSON.stringify({
				version: 1,
				workstreams: [
					{
						id: "ws-1",
						taskId: "task-001",
						objective: "Build assembler",
						fileScope: ["src/merge/mrp-assembler.ts"],
					},
				],
			}),
		);
		await Bun.write(
			join(tmpDir, "results", "test-report.json"),
			JSON.stringify({
				total: 10,
				passed: 9,
				failed: 1,
				skipped: 0,
				new_tests: [{ file: "src/merge/mrp-assembler.test.ts", name: "happy-path test" }],
			}),
		);
		await Bun.write(
			join(tmpDir, "results", "quality-gates.json"),
			JSON.stringify({ bun_test: "pass", biome: "pass", tsc: "pass" }),
		);
		await Bun.write(
			join(tmpDir, "product-spec.md"),
			"# Spec\n\n## Acceptance criteria\n\n- [ ] Criterion one\n- [ ] Criterion two\n",
		);

		const mission = buildFakeMission();
		const sessions = [buildFakeSession()];
		const deps: AssembleMrpDeps = {
			missionStore: { getById: (id) => (id === mission.id ? mission : null) },
			metricsStore: { getSessionsByRun: () => sessions },
			resolveArtifactRoot: () => tmpDir,
			repoRoot: tmpDir,
			runGit: makeGitRunner({
				"diff --numstat":
					"15\t3\tsrc/merge/mrp-assembler.ts\n5\t1\tsrc/merge/mrp-assembler.test.ts\n",
				"log --format=%s": "feat: implement assembler #456\n",
				"log --format=%H|%ae|%s": "abc123|builder-mrp@haru.dev|feat: implement assembler\n",
			}),
		};

		const mrp = await assembleMrp(mission.id, deps);

		expect(mrp.schema_version).toBe(1);
		expect(mrp.mission.id).toBe(mission.id);
		expect(mrp.mission.slug).toBe("test-mission");
		expect(mrp.mission.tier).toBe("direct");
		expect(mrp.mission.autonomy).toBe("supervised");
		expect(mrp.mission.intent_summary).toBe(mission.objective);
		expect(mrp.mission.parent_mission_id).toBeNull();
		expect(mrp.duration.started_at).toBe(mission.createdAt);
		expect(typeof mrp.duration.finished_at).toBe("string");
		expect(mrp.duration.wall_clock_seconds).toBeGreaterThanOrEqual(0);
		expect(mrp.diff.files_changed).toBe(2);
		expect(mrp.diff.additions).toBe(20);
		expect(mrp.diff.deletions).toBe(4);
		expect(mrp.diff.by_workstream).toHaveLength(1);
		expect(mrp.tests.total).toBe(10);
		expect(mrp.tests.passed).toBe(9);
		expect(mrp.tests.failed).toBe(1);
		expect(mrp.tests.new_tests).toHaveLength(1);
		expect(mrp.quality_gates.bun_test).toBe("pass");
		expect(mrp.quality_gates.biome).toBe("pass");
		expect(mrp.quality_gates.tsc).toBe("pass");
		expect(mrp.compat.breaking_changes).toEqual([]);
		expect(mrp.compat.checked_branches).toEqual([]);
		expect(mrp.risk_signals).toEqual({});
		expect(mrp.workstreams).toHaveLength(1);
		expect(mrp.workstreams[0]?.ws_id).toBe("ws-1");
		expect(mrp.acceptance_criteria).toHaveLength(2);
		expect(mrp.acceptance_criteria[0]?.status).toBe("unknown");
		// #456 from commit message; #123 (self-ref from objective) filtered out
		expect(mrp.linked_issues.some((i) => i.ref === "#456")).toBe(true);
		expect(mrp.linked_issues.some((i) => i.ref === "#123")).toBe(false);
		expect(mrp.debug_iterations).toEqual([]);
		expect(mrp.agent_trail).toHaveLength(1);
		expect(mrp.agent_trail[0]?.author_agent).toBe("builder-mrp");
		expect(mrp.agent_trail[0]?.capability).toBe("unknown");
		// 1000 + 500 + 200 + 100 = 1800
		expect(mrp.cost.tokens_total).toBe(1800);
		expect(mrp.cost.usd_total).toBeCloseTo(0.05);
	});

	test("missing-test-report: tests fields all zero, no throw", async () => {
		const mission = buildFakeMission();
		const deps: AssembleMrpDeps = {
			missionStore: { getById: () => mission },
			metricsStore: { getSessionsByRun: () => [] },
			resolveArtifactRoot: () => tmpDir,
			repoRoot: tmpDir,
			runGit: makeGitRunner({}),
		};

		const mrp = await assembleMrp(mission.id, deps);

		expect(mrp.tests.total).toBe(0);
		expect(mrp.tests.passed).toBe(0);
		expect(mrp.tests.failed).toBe(0);
		expect(mrp.tests.skipped).toBe(0);
		expect(mrp.tests.new_tests).toEqual([]);
	});

	test("missing-quality-gates: gates all 'skip', no throw", async () => {
		const mission = buildFakeMission();
		const deps: AssembleMrpDeps = {
			missionStore: { getById: () => mission },
			metricsStore: { getSessionsByRun: () => [] },
			resolveArtifactRoot: () => tmpDir,
			repoRoot: tmpDir,
			runGit: makeGitRunner({}),
		};

		const mrp = await assembleMrp(mission.id, deps);

		expect(mrp.quality_gates.bun_test).toBe("skip");
		expect(mrp.quality_gates.biome).toBe("skip");
		expect(mrp.quality_gates.tsc).toBe("skip");
	});

	test("missing-workstreams: workstreams empty array, no throw", async () => {
		const mission = buildFakeMission();
		const deps: AssembleMrpDeps = {
			missionStore: { getById: () => mission },
			metricsStore: { getSessionsByRun: () => [] },
			resolveArtifactRoot: () => tmpDir,
			repoRoot: tmpDir,
			runGit: makeGitRunner({}),
		};

		const mrp = await assembleMrp(mission.id, deps);

		expect(mrp.workstreams).toEqual([]);
		expect(mrp.diff.by_workstream).toEqual([]);
	});

	test("no-featureBranch-throws: throws MrpAssemblyError", async () => {
		const mission = buildFakeMission({ featureBranch: null });
		const deps: AssembleMrpDeps = {
			missionStore: { getById: () => mission },
			metricsStore: { getSessionsByRun: () => [] },
			resolveArtifactRoot: () => tmpDir,
			repoRoot: tmpDir,
			runGit: makeGitRunner({}),
		};

		await expect(assembleMrp(mission.id, deps)).rejects.toBeInstanceOf(MrpAssemblyError);
	});

	test("mission-not-found-throws: throws MrpAssemblyError", async () => {
		const deps: AssembleMrpDeps = {
			missionStore: { getById: () => null },
			metricsStore: { getSessionsByRun: () => [] },
			resolveArtifactRoot: () => tmpDir,
			repoRoot: tmpDir,
			runGit: makeGitRunner({}),
		};

		await expect(assembleMrp("nonexistent-id", deps)).rejects.toBeInstanceOf(MrpAssemblyError);
	});
});
