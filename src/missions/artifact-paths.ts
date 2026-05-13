import { join } from "node:path";

export interface MissionArtifactPaths {
	root: string;
	missionMd: string;
	decisionsMd: string;
	openQuestionsMd: string;
	productSpecMd: string;
	researchDir: string;
	researchSummaryMd: string;
	researchCurrentStateMd: string;
	planDir: string;
	workstreamsJson: string;
	architectureMd: string;
	testPlanYaml: string;
	debugDir: string;
	debugBriefMd: string;
	resultsDir: string;
	mrpJson: string;
	predecessorSummaryMd: string;
	prCommentsDir: string;
	baselineJson: string;
}

export function buildPaths(missionId: string, overstoryDir: string): MissionArtifactPaths {
	const root = join(overstoryDir, "missions", missionId);
	return {
		root,
		missionMd: join(root, "mission.md"),
		decisionsMd: join(root, "decisions.md"),
		openQuestionsMd: join(root, "open-questions.md"),
		productSpecMd: join(root, "product-spec.md"),
		researchDir: join(root, "research"),
		researchSummaryMd: join(root, "research", "_summary.md"),
		researchCurrentStateMd: join(root, "research", "current-state.md"),
		planDir: join(root, "plan"),
		workstreamsJson: join(root, "plan", "workstreams.json"),
		architectureMd: join(root, "plan", "architecture.md"),
		testPlanYaml: join(root, "plan", "test-plan.yaml"),
		debugDir: join(root, "debug"),
		debugBriefMd: join(root, "debug", "debug-brief.md"),
		resultsDir: join(root, "results"),
		mrpJson: join(root, "merge-readiness-pack.json"),
		predecessorSummaryMd: join(root, "predecessor-summary.md"),
		prCommentsDir: join(root, "pr-comments"),
		baselineJson: join(root, "results", "baseline.json"),
	};
}
