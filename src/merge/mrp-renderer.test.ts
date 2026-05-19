import { describe, expect, test } from "bun:test";
import { PENDING_SENTINEL } from "../missions/task-id.ts";
import { type MergeReadinessPack, renderMrpMarkdown } from "./mrp-renderer.ts";

function buildSampleMrp(overrides: Partial<MergeReadinessPack> = {}): MergeReadinessPack {
	const base: MergeReadinessPack = {
		schema_version: 1,
		mission: {
			id: "mission-1778699081737-stage-e-v2",
			slug: "stage-e-v2",
			tier: "full",
			autonomy: "supervised",
			intent_summary: "Stage E v2 — merge readiness pack and renderer",
			parent_mission_id: null,
		},
		duration: {
			started_at: "2026-05-01T00:00:00.000Z",
			finished_at: "2026-05-01T01:30:00.000Z",
			wall_clock_seconds: 5400,
		},
		diff: {
			files_changed: 4,
			additions: 320,
			deletions: 40,
			by_workstream: [
				{
					ws_id: "w2-mrp-renderer",
					files_changed: 4,
					additions: 320,
					deletions: 40,
				},
			],
		},
		tests: {
			total: 480,
			passed: 480,
			failed: 0,
			skipped: 0,
			new_tests: [
				{ file: "src/merge/mrp-renderer.test.ts", name: "renders happy-path MRP" },
				{
					file: "src/missions/artifact-paths.test.ts",
					name: "buildPaths returns canonical layout",
				},
			],
		},
		quality_gates: {
			bun_test: "pass",
			biome: "pass",
			tsc: "pass",
		},
		compat: {
			breaking_changes: [],
			checked_branches: ["main"],
		},
		risk_signals: {},
		workstreams: [
			{
				ws_id: "w2-mrp-renderer",
				objective: "Build MRP schema v1 + markdown renderer",
				files_touched: ["src/merge/mrp-renderer.ts", "src/missions/artifact-paths.ts"],
				task_id: "haru-d3b9",
			},
		],
		acceptance_criteria: [
			{ text: "MRP schema_version is 1 and frozen", status: "pass" },
			{ text: "renderer is pure (no I/O)", status: "pass" },
		],
		linked_issues: [{ ref: "#283" }],
		debug_iterations: [],
		agent_trail: [
			{
				commit: "abc1234",
				author_agent: "builder-mrp-w2",
				capability: "builder",
			},
		],
		cost: {
			tokens_total: 123456,
			usd_total: 1.23,
		},
	};
	return { ...base, ...overrides };
}

describe("MergeReadinessPack schema", () => {
	test("T-w2-3: JSON.stringify(mrp) begins with schema_version:1", () => {
		const mrp = buildSampleMrp();
		const json = JSON.stringify(mrp);
		expect(json.startsWith('{"schema_version":1')).toBe(true);
	});
});

describe("renderMrpMarkdown", () => {
	test("T-w2-4: golden snapshot for happy-path MRP — ≤120 lines, has required headers", () => {
		const mrp = buildSampleMrp({
			workstreams: [
				{
					ws_id: "w2-mrp-renderer",
					objective: "Build MRP schema v1 + markdown renderer",
					files_touched: ["src/merge/mrp-renderer.ts"],
					task_id: "haru-d3b9",
				},
			],
			acceptance_criteria: [
				{ text: "schema is frozen at v1", status: "pass" },
				{ text: "renderer is pure", status: "pass" },
			],
			debug_iterations: [],
		});

		const output = renderMrpMarkdown(mrp);

		expect(output).toMatchSnapshot();
		expect(output.split("\n").length).toBeLessThanOrEqual(120);

		expect(output).toContain(mrp.mission.slug);
		expect(output).toContain("## TL;DR");
		expect(output).toContain("## Diff");
		expect(output).toContain("## Acceptance");
		expect(output).toContain("## Quality gates");
		expect(output).toContain("## Workstreams");
		expect(output).toContain("## Linked issues");
		expect(output).toContain("## Agent trail");
	});

	test("T-w2-5: Cost section is gated by opts.showCost", () => {
		const mrp = buildSampleMrp();

		const defaultOutput = renderMrpMarkdown(mrp);
		expect(defaultOutput).not.toContain("## Cost");
		expect(defaultOutput).not.toContain("tokens_total");
		expect(defaultOutput).not.toContain("usd_total");

		const offOutput = renderMrpMarkdown(mrp, { showCost: false });
		expect(offOutput).not.toContain("## Cost");
		expect(offOutput).not.toContain("tokens_total");
		expect(offOutput).not.toContain("usd_total");

		const onOutput = renderMrpMarkdown(mrp, { showCost: true });
		expect(onOutput).toContain("## Cost");
		expect(onOutput).toContain(String(mrp.cost.tokens_total));
		expect(onOutput).toContain(String(mrp.cost.usd_total));
	});

	test("T-w2-6: Debug iterations section is gated on array length", () => {
		const empty = buildSampleMrp({ debug_iterations: [] });
		const emptyOut = renderMrpMarkdown(empty);
		expect(emptyOut.toLowerCase()).not.toContain("## debug iterations");

		const withOne = buildSampleMrp({
			debug_iterations: [
				{
					attempt: 1,
					failure_summary: "bun_test failed on artifact-paths.test.ts",
					fix_summary: "added missing prCommentsDir field",
				},
			],
		});
		const withOneOut = renderMrpMarkdown(withOne);
		expect(withOneOut.toLowerCase()).toContain("## debug iterations");
	});

	test("T-w2-7: renderer is idempotent (byte-identical on repeat calls)", () => {
		const mrp = buildSampleMrp();
		const a = renderMrpMarkdown(mrp);
		const b = renderMrpMarkdown(mrp);
		expect(a).toBe(b);

		expect(a).toContain(mrp.duration.started_at);
		expect(a).toContain(mrp.duration.finished_at);
	});

	test("T-w2-8: forward-compat — unknown top-level keys are ignored, not thrown", () => {
		const mrp = buildSampleMrp();
		const augmented = {
			...mrp,
			future_unknown_field: { whatever: 1, nested: ["x", "y"] },
			another_unknown: "string-value",
		} as unknown as MergeReadinessPack;

		const output = renderMrpMarkdown(augmented);

		expect(typeof output).toBe("string");
		expect(output.length).toBeGreaterThan(0);
		expect(output).toContain("## TL;DR");
		expect(output).toContain("## Diff");
		expect(output).toContain("## Acceptance");
		expect(output).toContain("## Quality gates");
		expect(output).toContain("## Workstreams");
		expect(output).toContain("## Linked issues");
		expect(output).toContain("## Agent trail");
	});
});

describe("renderMrpMarkdown — taskId Closes-footer (T-w162-r1..r5)", () => {
	// FIXME(w162-builder): drop cast once renderMrpMarkdown opts type includes taskId.
	const renderWithTaskId = renderMrpMarkdown as unknown as (
		mrp: MergeReadinessPack,
		opts?: { showCost?: boolean; taskId?: string },
	) => string;

	test('T-w162-r1: taskId real string → output ends with "\\n\\nCloses haru-1234"', () => {
		const mrp = buildSampleMrp();
		const output = renderWithTaskId(mrp, { taskId: "haru-1234" });
		expect(output.endsWith("\n\nCloses haru-1234")).toBe(true);
	});

	test("T-w162-r2: taskId undefined → output is byte-identical to baseline", () => {
		const mrp = buildSampleMrp();
		const baseline = renderMrpMarkdown(mrp);
		const explicit = renderWithTaskId(mrp, { taskId: undefined });
		expect(explicit).toBe(baseline);
		expect(explicit).not.toContain("Closes");
	});

	test("T-w162-r3: taskId empty string → no footer appended", () => {
		const mrp = buildSampleMrp();
		const baseline = renderMrpMarkdown(mrp);
		const empty = renderWithTaskId(mrp, { taskId: "" });
		expect(empty).toBe(baseline);
		expect(empty).not.toContain("Closes");
	});

	test("T-w162-r4: renderer is dumb — PENDING_SENTINEL emitted verbatim (caller filters)", () => {
		const mrp = buildSampleMrp();
		const output = renderWithTaskId(mrp, { taskId: PENDING_SENTINEL });
		expect(output.endsWith(`\n\nCloses ${PENDING_SENTINEL}`)).toBe(true);
	});

	test("T-w162-r5: showCost + taskId compose — both Cost section AND Closes footer appear", () => {
		const mrp = buildSampleMrp();
		const output = renderWithTaskId(mrp, { showCost: true, taskId: "haru-9999" });
		expect(output).toContain("## Cost");
		expect(output.endsWith("\n\nCloses haru-9999")).toBe(true);
	});
});
