import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HoldoutCheck } from "../types.ts";
import {
	backfillBaseline,
	baselineExists,
	captureBaseline,
	compareSnapshotDiff,
} from "./baseline-snapshot.ts";

// === Helpers ===

async function makeTempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "baseline-snapshot-"));
}

async function pathExists(p: string): Promise<boolean> {
	return Bun.file(p).exists();
}

function fakeCheck(
	id: string,
	status: "pass" | "fail" | "warn" | "skip",
	overrides: Partial<HoldoutCheck> = {},
): HoldoutCheck {
	return {
		id,
		level: 1,
		name: overrides.name ?? id,
		status,
		message: overrides.message ?? `${id}:${status}`,
		...overrides,
	};
}

function buildFailingChecks(count: number, prefix = "l1-tsc"): HoldoutCheck[] {
	const out: HoldoutCheck[] = [];
	for (let i = 1; i <= count; i++) {
		out.push(fakeCheck(`${prefix}-${i}`, "fail", { message: `failure #${i}` }));
	}
	return out;
}

// === State ===

let tmpRoot: string;
let artifactRoot: string;
let projectRoot: string;

beforeEach(async () => {
	tmpRoot = await makeTempRoot();
	artifactRoot = join(tmpRoot, "artifacts");
	projectRoot = join(tmpRoot, "project");
	await mkdir(artifactRoot, { recursive: true });
	await mkdir(projectRoot, { recursive: true });
});

afterEach(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

// === Tests ===

describe("compareSnapshotDiff", () => {
	test("T-1: identical empty inputs → empty diff", () => {
		const result = compareSnapshotDiff([], []);
		expect(result.newFailures).toEqual([]);
		expect(result.resolvedFailures).toEqual([]);
		expect(result.unchanged).toEqual([]);
	});

	test("T-2: identical non-empty inputs → all unchanged", () => {
		const arr: HoldoutCheck[] = [fakeCheck("l1-tests", "pass")];
		const result = compareSnapshotDiff(arr, arr);
		expect(result.unchanged).toHaveLength(1);
		expect(result.newFailures).toEqual([]);
		expect(result.resolvedFailures).toEqual([]);
	});

	test("T-3: 17 baseline fail + 17 same current fail → empty newFailures, 17 unchanged", () => {
		const baseline = buildFailingChecks(17);
		const current = buildFailingChecks(17);
		const result = compareSnapshotDiff(baseline, current);
		expect(result.newFailures).toHaveLength(0);
		expect(result.unchanged).toHaveLength(17);
		expect(result.resolvedFailures).toHaveLength(0);
	});

	test("T-4: new failure adds to newFailures, prior 17 stay unchanged", () => {
		const baseline = buildFailingChecks(17);
		const current = [...buildFailingChecks(17), fakeCheck("l1-tsc-18", "fail")];
		const result = compareSnapshotDiff(baseline, current);
		expect(result.newFailures).toHaveLength(1);
		expect(result.newFailures[0]?.id).toBe("l1-tsc-18");
		expect(result.unchanged).toHaveLength(17);
		expect(result.resolvedFailures).toHaveLength(0);
	});

	test("T-5: resolved failure (baseline 17 → current 16, one removed)", () => {
		const baseline = buildFailingChecks(17);
		const current = baseline.slice(0, 16);
		const result = compareSnapshotDiff(baseline, current);
		expect(result.newFailures).toHaveLength(0);
		expect(result.resolvedFailures).toHaveLength(1);
		expect(result.resolvedFailures[0]?.id).toBe("l1-tsc-17");
	});

	test("T-6: fail-to-pass flip on same id is a resolved failure", () => {
		const baseline: HoldoutCheck[] = [fakeCheck("l1-lint", "fail")];
		const current: HoldoutCheck[] = [fakeCheck("l1-lint", "pass")];
		const result = compareSnapshotDiff(baseline, current);
		expect(result.resolvedFailures).toHaveLength(1);
		expect(result.resolvedFailures[0]?.id).toBe("l1-lint");
		expect(result.newFailures).toHaveLength(0);
	});

	test("T-7: pass-to-fail flip on same id is a new failure", () => {
		const baseline: HoldoutCheck[] = [fakeCheck("l1-lint", "pass")];
		const current: HoldoutCheck[] = [fakeCheck("l1-lint", "fail")];
		const result = compareSnapshotDiff(baseline, current);
		expect(result.newFailures).toHaveLength(1);
		expect(result.newFailures[0]?.id).toBe("l1-lint");
		expect(result.resolvedFailures).toHaveLength(0);
	});

	test("T-8: warn status is not a failure (warn-warn → unchanged)", () => {
		const baseline: HoldoutCheck[] = [fakeCheck("l1-cov", "warn")];
		const current: HoldoutCheck[] = [fakeCheck("l1-cov", "warn")];
		const result = compareSnapshotDiff(baseline, current);
		expect(result.unchanged).toHaveLength(1);
		expect(result.newFailures).toHaveLength(0);
		expect(result.resolvedFailures).toHaveLength(0);
	});

	test("T-9: skip in both is unchanged", () => {
		const baseline: HoldoutCheck[] = [fakeCheck("l1-skipme", "skip")];
		const current: HoldoutCheck[] = [fakeCheck("l1-skipme", "skip")];
		const result = compareSnapshotDiff(baseline, current);
		expect(result.unchanged).toHaveLength(1);
		expect(result.newFailures).toHaveLength(0);
		expect(result.resolvedFailures).toHaveLength(0);
	});

	test("T-10: purity — inputs are not mutated", () => {
		const baseline: HoldoutCheck[] = [fakeCheck("l1-a", "fail"), fakeCheck("l1-b", "pass")];
		const current: HoldoutCheck[] = [fakeCheck("l1-a", "pass"), fakeCheck("l1-c", "fail")];
		const baselineClone = structuredClone(baseline);
		const currentClone = structuredClone(current);
		compareSnapshotDiff(baseline, current);
		expect(baseline).toEqual(baselineClone);
		expect(current).toEqual(currentClone);
	});
});

describe("captureBaseline", () => {
	test("T-11: writes baseline.json with bare HoldoutCheck[] schema", async () => {
		const checks: HoldoutCheck[] = [fakeCheck("l1-tests", "pass"), fakeCheck("l1-lint", "pass")];
		await captureBaseline("mission-x", artifactRoot, projectRoot, {
			runQualityGates: async () => checks,
		});
		const baselinePath = join(artifactRoot, "results", "baseline.json");
		const raw = await Bun.file(baselinePath).text();
		const parsed = JSON.parse(raw);
		expect(parsed).toEqual(checks);
		expect(Array.isArray(parsed)).toBe(true);
	});

	test("T-12: writes .baseline-captured sentinel on success", async () => {
		await captureBaseline("mission-x", artifactRoot, projectRoot, {
			runQualityGates: async () => [fakeCheck("l1-tests", "pass")],
		});
		expect(await pathExists(join(artifactRoot, "results", ".baseline-captured"))).toBe(true);
	});

	test("T-13: does NOT write .baseline-backfilled", async () => {
		await captureBaseline("mission-x", artifactRoot, projectRoot, {
			runQualityGates: async () => [fakeCheck("l1-tests", "pass")],
		});
		expect(await pathExists(join(artifactRoot, "results", ".baseline-backfilled"))).toBe(false);
	});

	test("T-14: idempotent on re-run (overwrites)", async () => {
		const first: HoldoutCheck[] = [fakeCheck("l1-tests", "pass", { message: "first" })];
		const second: HoldoutCheck[] = [fakeCheck("l1-tests", "fail", { message: "second" })];
		await captureBaseline("mission-x", artifactRoot, projectRoot, {
			runQualityGates: async () => first,
		});
		await captureBaseline("mission-x", artifactRoot, projectRoot, {
			runQualityGates: async () => second,
		});
		const raw = await Bun.file(join(artifactRoot, "results", "baseline.json")).text();
		const parsed = JSON.parse(raw) as HoldoutCheck[];
		expect(parsed).toEqual(second);
	});

	test("T-15: failure-tolerant — captures failing checks without throwing", async () => {
		const failing: HoldoutCheck[] = [fakeCheck("l1-tests", "fail", { message: "broke" })];
		await captureBaseline("mission-x", artifactRoot, projectRoot, {
			runQualityGates: async () => failing,
		});
		const raw = await Bun.file(join(artifactRoot, "results", "baseline.json")).text();
		const parsed = JSON.parse(raw) as HoldoutCheck[];
		expect(parsed).toEqual(failing);
	});

	test("T-16: creates results/ directory if missing", async () => {
		const freshArtifactRoot = join(tmpRoot, "fresh-artifacts");
		await mkdir(freshArtifactRoot, { recursive: true });
		// results/ subdir intentionally absent
		await captureBaseline("mission-x", freshArtifactRoot, projectRoot, {
			runQualityGates: async () => [fakeCheck("l1-tests", "pass")],
		});
		expect(await pathExists(join(freshArtifactRoot, "results", "baseline.json"))).toBe(true);
		expect(await pathExists(join(freshArtifactRoot, "results", ".baseline-captured"))).toBe(true);
	});

	test("T-28: smoke — captureBaseline → read baseline.json → compareSnapshotDiff(baseline, baseline) yields holdout_pass equivalent", async () => {
		const checks: HoldoutCheck[] = [
			fakeCheck("l1-tests", "pass"),
			fakeCheck("l1-lint", "pass"),
			fakeCheck("l1-tsc", "fail", { message: "preexisting failure" }),
		];
		await captureBaseline("mission-smoke", artifactRoot, projectRoot, {
			runQualityGates: async () => checks,
		});

		const baselineRaw = await Bun.file(join(artifactRoot, "results", "baseline.json")).text();
		const baseline = JSON.parse(baselineRaw) as HoldoutCheck[];

		const diff = compareSnapshotDiff(baseline, checks);
		expect(diff.newFailures).toEqual([]);
		expect(diff.unchanged.map((c) => c.id)).toContain("l1-tsc");
		expect(diff.resolvedFailures).toEqual([]);
	});
});

describe("backfillBaseline", () => {
	test("T-17: writes baseline.json + .baseline-backfilled sentinel (no .baseline-captured)", async () => {
		const checks: HoldoutCheck[] = [fakeCheck("l1-tests", "pass")];
		await backfillBaseline("mission-x", artifactRoot, projectRoot, "feature/x", {
			runQualityGates: async () => checks,
			runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		});
		expect(await pathExists(join(artifactRoot, "results", "baseline.json"))).toBe(true);
		expect(await pathExists(join(artifactRoot, "results", ".baseline-backfilled"))).toBe(true);
		expect(await pathExists(join(artifactRoot, "results", ".baseline-captured"))).toBe(false);
	});

	test("T-18: distinct from captureBaseline observably — only backfilled sentinel present", async () => {
		await backfillBaseline("mission-x", artifactRoot, projectRoot, "feature/x", {
			runQualityGates: async () => [fakeCheck("l1-tests", "pass")],
			runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		});
		expect(await baselineExists(artifactRoot)).toBe(true);
		expect(await pathExists(join(artifactRoot, "results", ".baseline-backfilled"))).toBe(true);
		expect(await pathExists(join(artifactRoot, "results", ".baseline-captured"))).toBe(false);
	});

	test("T-19: on failure, writes .baseline-backfill-failed and no baseline.json", async () => {
		await backfillBaseline("mission-x", artifactRoot, projectRoot, "feature/x", {
			runQualityGates: async () => {
				throw new Error("gate failure");
			},
			runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		});
		expect(await pathExists(join(artifactRoot, "results", "baseline.json"))).toBe(false);
		expect(await pathExists(join(artifactRoot, "results", ".baseline-backfill-failed"))).toBe(true);
		expect(await pathExists(join(artifactRoot, "results", ".baseline-backfilled"))).toBe(false);
	});
});

describe("backfillBaseline events", () => {
	test("T-25: happy path emits baseline_backfilled with artifactRoot and baselinePath", async () => {
		const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
		await backfillBaseline("mission-x", artifactRoot, projectRoot, "feature/x", {
			runQualityGates: async () => [fakeCheck("l1-tests", "pass")],
			runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			emitEvent: (kind, payload) => events.push({ kind, payload }),
		});
		const backfilled = events.find((e) => e.kind === "baseline_backfilled");
		expect(backfilled).toBeDefined();
		expect(backfilled?.payload.artifactRoot).toBe(artifactRoot);
		expect(backfilled?.payload.baselinePath).toBe("results/baseline.json");
	});

	test("T-26: worktree-add failure emits baseline_backfill_failed with reason=worktree_add_failed", async () => {
		const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
		await backfillBaseline("mission-x", artifactRoot, projectRoot, "feature/x", {
			runQualityGates: async () => [fakeCheck("l1-tests", "pass")],
			runCommand: async (cmd) => {
				if (cmd[0] === "git" && cmd[1] === "worktree" && cmd[2] === "add") {
					return { exitCode: 1, stdout: "", stderr: "worktree exists" };
				}
				return { exitCode: 0, stdout: "", stderr: "" };
			},
			emitEvent: (kind, payload) => events.push({ kind, payload }),
		});
		const failed = events.find((e) => e.kind === "baseline_backfill_failed");
		expect(failed).toBeDefined();
		expect(failed?.payload.reason).toBe("worktree_add_failed");
	});

	test("T-27: quality-gates failure emits baseline_backfill_failed with reason=quality_gates_failed and error string", async () => {
		const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
		await backfillBaseline("mission-x", artifactRoot, projectRoot, "feature/x", {
			runQualityGates: async () => {
				throw new Error("gates exploded");
			},
			runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			emitEvent: (kind, payload) => events.push({ kind, payload }),
		});
		const failed = events.find((e) => e.kind === "baseline_backfill_failed");
		expect(failed).toBeDefined();
		expect(failed?.payload.reason).toBe("quality_gates_failed");
		expect(typeof failed?.payload.error).toBe("string");
		expect(failed?.payload.error as string).toContain("gates exploded");
	});
});

describe("baselineExists", () => {
	test("T-20: returns false when neither sentinel exists", async () => {
		expect(await baselineExists(artifactRoot)).toBe(false);
	});

	test("T-21: returns true when .baseline-captured exists", async () => {
		await mkdir(join(artifactRoot, "results"), { recursive: true });
		await writeFile(join(artifactRoot, "results", ".baseline-captured"), "");
		expect(await baselineExists(artifactRoot)).toBe(true);
	});

	test("T-22: returns true when .baseline-backfilled exists", async () => {
		await mkdir(join(artifactRoot, "results"), { recursive: true });
		await writeFile(join(artifactRoot, "results", ".baseline-backfilled"), "");
		expect(await baselineExists(artifactRoot)).toBe(true);
	});

	test("T-23: returns false when .baseline-backfill-failed exists alone", async () => {
		await mkdir(join(artifactRoot, "results"), { recursive: true });
		await writeFile(join(artifactRoot, "results", ".baseline-backfill-failed"), "");
		expect(await baselineExists(artifactRoot)).toBe(false);
	});

	test("T-24: returns false when baseline.json exists without any sentinel", async () => {
		await mkdir(join(artifactRoot, "results"), { recursive: true });
		await writeFile(join(artifactRoot, "results", "baseline.json"), "[]");
		expect(await baselineExists(artifactRoot)).toBe(false);
	});
});
