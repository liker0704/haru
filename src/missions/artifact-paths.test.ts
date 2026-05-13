import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildPaths, type MissionArtifactPaths } from "./artifact-paths.ts";

describe("buildPaths", () => {
	test("T-w2-1: returns all required fields as non-empty strings with correct root", () => {
		const paths: MissionArtifactPaths = buildPaths("mission-abc", "/tmp/.overstory");

		const requiredFields: Array<keyof MissionArtifactPaths> = [
			"root",
			"missionMd",
			"decisionsMd",
			"openQuestionsMd",
			"productSpecMd",
			"researchDir",
			"researchSummaryMd",
			"researchCurrentStateMd",
			"planDir",
			"workstreamsJson",
			"architectureMd",
			"testPlanYaml",
			"debugDir",
			"debugBriefMd",
			"resultsDir",
			"mrpJson",
			"predecessorSummaryMd",
			"prCommentsDir",
			"baselineJson",
		];

		for (const field of requiredFields) {
			const value = paths[field];
			expect(typeof value).toBe("string");
			expect(value.length).toBeGreaterThan(0);
		}

		expect(paths.root).toBe(join("/tmp/.overstory", "missions", "mission-abc"));
	});

	test("T-w2-2: Stage E path values are exact", () => {
		const paths = buildPaths("mission-abc", "/tmp/.overstory");

		expect(paths.mrpJson).toBe(`${paths.root}/merge-readiness-pack.json`);
		expect(paths.predecessorSummaryMd).toBe(`${paths.root}/predecessor-summary.md`);
		expect(paths.prCommentsDir).toBe(`${paths.root}/pr-comments`);
		expect(paths.prCommentsDir.endsWith("/")).toBe(false);
		expect(paths.baselineJson).toBe(`${paths.root}/results/baseline.json`);
	});

	test("T-w2-2b: canonical pre-existing layout fields are exact", () => {
		const paths = buildPaths("mission-abc", "/tmp/.overstory");
		const root = paths.root;

		expect(paths.missionMd).toBe(`${root}/mission.md`);
		expect(paths.decisionsMd).toBe(`${root}/decisions.md`);
		expect(paths.openQuestionsMd).toBe(`${root}/open-questions.md`);
		expect(paths.productSpecMd).toBe(`${root}/product-spec.md`);
		expect(paths.researchDir).toBe(`${root}/research`);
		expect(paths.researchSummaryMd).toBe(`${root}/research/_summary.md`);
		expect(paths.researchCurrentStateMd).toBe(`${root}/research/current-state.md`);
		expect(paths.planDir).toBe(`${root}/plan`);
		expect(paths.workstreamsJson).toBe(`${root}/plan/workstreams.json`);
		expect(paths.architectureMd).toBe(`${root}/plan/architecture.md`);
		expect(paths.testPlanYaml).toBe(`${root}/plan/test-plan.yaml`);
		expect(paths.debugDir).toBe(`${root}/debug`);
		expect(paths.debugBriefMd).toBe(`${root}/debug/debug-brief.md`);
		expect(paths.resultsDir).toBe(`${root}/results`);
	});
});
