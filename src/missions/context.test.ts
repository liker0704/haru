import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { Mission } from "../types.ts";
import {
	buildMissionRoleBeacon,
	ensureMissionArtifacts,
	getMissionArtifactPaths,
	materializeMissionRolePrompt,
} from "./context.ts";

function makeMission(overrides: Partial<Mission> = {}): Mission {
	return {
		id: "mission-context-001",
		slug: "context-smoke",
		objective: "Verify mission prompt materialization and artifact scaffolding",
		runId: "run-context-001",
		state: "active",
		phase: "understand",
		firstFreezeAt: null,
		pendingUserInput: false,
		pendingInputKind: null,
		pendingInputThreadId: null,
		reopenCount: 0,
		artifactRoot: "",
		pausedWorkstreamIds: [],
		analystSessionId: null,
		executionDirectorSessionId: null,
		coordinatorSessionId: null,
		architectSessionId: null,
		pausedLeadNames: [],
		pauseReason: null,
		currentNode: null,
		startedAt: "2026-03-13T00:00:00.000Z",
		completedAt: null,
		createdAt: "2026-03-13T00:00:00.000Z",
		updatedAt: "2026-03-13T00:00:00.000Z",
		learningsExtracted: false,
		hasEmittedWsProducerWrite: false,
		tier: null,
		autonomy: "supervised",
		...overrides,
	};
}

describe("mission context helpers", () => {
	let tempDir: string;
	let mission: Mission;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "haru-mission-context-"));
		await mkdir(join(tempDir, "agent-defs"), { recursive: true });
		await Bun.write(
			join(tempDir, "agent-defs", "mission-analyst.md"),
			"Base prompt\n\nSee {{INSTRUCTION_PATH}}\n",
		);
		mission = makeMission({
			artifactRoot: join(tempDir, "missions", "mission-context-001"),
		});
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	test("ensureMissionArtifacts creates canonical mission files", async () => {
		const paths = await ensureMissionArtifacts(mission);

		expect(paths).toEqual(getMissionArtifactPaths(mission));
		expect(await Bun.file(paths.missionMd).exists()).toBe(true);
		expect(await Bun.file(paths.decisionsMd).exists()).toBe(true);
		expect(await Bun.file(paths.openQuestionsMd).exists()).toBe(true);
		expect(await Bun.file(paths.currentStateMd).exists()).toBe(true);
		expect(await Bun.file(paths.researchSummaryMd).exists()).toBe(true);
		expect(await Bun.file(paths.workstreamsJson).exists()).toBe(true);
	});

	test("getMissionArtifactPaths returns productSpecMd at the artifact root", () => {
		const paths = getMissionArtifactPaths(mission);
		expect(paths.productSpecMd).toBe(join(paths.root, "product-spec.md"));
	});

	test("materializeMissionRolePrompt renders context and resolved prompt", async () => {
		const materialized = await materializeMissionRolePrompt({
			overstoryDir: tempDir,
			agentName: "mission-analyst",
			capability: "mission-analyst",
			roleLabel: "Mission Analyst",
			mission,
		});

		const context = await Bun.file(materialized.contextPath).text();
		const prompt = await Bun.file(materialized.promptPath).text();

		expect(context).toContain("Mission ID: mission-context-001");
		expect(context).toContain("plan/workstreams.json");
		expect(context).toContain("## Workstream Handoff Contract");
		expect(context).toContain('"briefPath": "workstreams/docs-smoke/brief.md"');
		expect(context).toContain(
			"Do not use legacy/non-runtime fields like `name`, `capability`, `files`, or `dependencies`.",
		);
		expect(prompt).toContain(materialized.contextPath);
		expect(prompt).not.toContain("{{INSTRUCTION_PATH}}");
	});

	test("mission context states the canonical CLI agent name when capability differs", async () => {
		await Bun.write(
			join(tempDir, "agent-defs", "coordinator-mission.md"),
			"Mission coordinator\n\nSee {{INSTRUCTION_PATH}}\n",
		);

		const materialized = await materializeMissionRolePrompt({
			overstoryDir: tempDir,
			agentName: "coordinator",
			capability: "coordinator-mission",
			roleLabel: "Mission Coordinator",
			mission,
		});

		const context = await Bun.file(materialized.contextPath).text();
		expect(context).toContain("canonical CLI agent name is `coordinator`");
		expect(context).toContain("capability is `coordinator-mission`");
	});

	test("buildMissionRoleBeacon references context path and mission id", () => {
		const beacon = buildMissionRoleBeacon({
			agentName: "mission-analyst",
			missionId: "mission-context-001",
			contextPath: "/tmp/context.md",
		});

		expect(beacon).toContain("/tmp/context.md");
		expect(beacon).toContain("mission-context-001");
		expect(beacon).toContain("mission-analyst");
	});
});

describe("materializeMissionRolePrompt MISSION_AUTONOMY substitution", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "haru-mission-autonomy-"));
		await mkdir(join(tempDir, "agent-defs"), { recursive: true });
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	async function renderWithAutonomy(autonomy: Mission["autonomy"]): Promise<string> {
		await Bun.write(
			join(tempDir, "agent-defs", "coordinator-mission.md"),
			"Autonomy mode is {{MISSION_AUTONOMY}} here.\n",
		);
		const m = {
			id: "mission-auto-test",
			slug: "auto-test",
			objective: "Test autonomy substitution",
			runId: "run-auto-001",
			state: "active" as const,
			phase: "plan" as const,
			autonomy,
			artifactRoot: join(tempDir, "missions", "mission-auto-test"),
		};
		const materialized = await materializeMissionRolePrompt({
			overstoryDir: tempDir,
			agentName: "coordinator",
			capability: "coordinator-mission",
			roleLabel: "Mission Coordinator",
			mission: m,
		});
		return Bun.file(materialized.promptPath).text();
	}

	test("substitutes supervised for autonomy=supervised", async () => {
		const prompt = await renderWithAutonomy("supervised");
		expect(prompt).toContain("Autonomy mode is supervised here.");
		expect(prompt).not.toContain("{{MISSION_AUTONOMY}}");
	});

	test("substitutes auto-spec for autonomy=auto-spec", async () => {
		const prompt = await renderWithAutonomy("auto-spec");
		expect(prompt).toContain("Autonomy mode is auto-spec here.");
		expect(prompt).not.toContain("{{MISSION_AUTONOMY}}");
	});

	test("substitutes auto-all for autonomy=auto-all", async () => {
		const prompt = await renderWithAutonomy("auto-all");
		expect(prompt).toContain("Autonomy mode is auto-all here.");
		expect(prompt).not.toContain("{{MISSION_AUTONOMY}}");
	});

	test("substitutes supervised when autonomy is null (null cast)", async () => {
		const prompt = await renderWithAutonomy(null as unknown as Mission["autonomy"]);
		expect(prompt).toContain("Autonomy mode is supervised here.");
		expect(prompt).not.toContain("{{MISSION_AUTONOMY}}");
	});
});
