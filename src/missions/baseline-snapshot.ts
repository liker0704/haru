import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_QUALITY_GATES, loadConfig } from "../config.ts";
import type { HoldoutCheck } from "../types.ts";
import { checkQualityGates, extractCheckKey } from "./holdout.ts";

// === DI Interface ===

interface CaptureDeps {
	runQualityGates?: (
		projectRoot: string,
		gates: ReadonlyArray<{ name: string; command: string; description?: string }>,
		run: (
			cmd: string[],
			cwd: string,
		) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
	) => Promise<HoldoutCheck[]>;
	runCommand?: (
		cmd: string[],
		cwd: string,
	) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
	// DI seam: caller wires recordMissionEvent; tests inject a capture function
	emitEvent?: (kind: string, payload: Record<string, unknown>) => void;
}

// === Default subprocess runner ===

async function defaultRunCommand(
	cmd: string[],
	cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

// === Exported Functions ===

export async function captureBaseline(
	missionId: string,
	artifactRoot: string,
	projectRoot: string,
	deps?: CaptureDeps,
): Promise<void> {
	try {
		const runQualityGates = deps?.runQualityGates ?? checkQualityGates;
		const run = deps?.runCommand ?? defaultRunCommand;

		const config = await loadConfig(projectRoot);
		const gates = config.project.qualityGates ?? DEFAULT_QUALITY_GATES;

		const checks = await runQualityGates(projectRoot, gates, run);

		const resultsDir = join(artifactRoot, "results");
		await mkdir(resultsDir, { recursive: true });
		await writeFile(join(resultsDir, "baseline.json"), JSON.stringify(checks, null, 2));
		await writeFile(join(resultsDir, ".baseline-captured"), "");
	} catch (err) {
		console.error(
			`[baseline-snapshot] captureBaseline failed for mission ${missionId}:`,
			err instanceof Error ? err.message : String(err),
		);
	}
}

export function compareSnapshotDiff(
	baseline: HoldoutCheck[],
	current: HoldoutCheck[],
): { newFailures: HoldoutCheck[]; resolvedFailures: HoldoutCheck[]; unchanged: HoldoutCheck[] } {
	const baselineMap = new Map<string, HoldoutCheck>();
	for (const check of baseline) {
		baselineMap.set(extractCheckKey(check), check);
	}
	const currentMap = new Map<string, HoldoutCheck>();
	for (const check of current) {
		currentMap.set(extractCheckKey(check), check);
	}

	const newFailures: HoldoutCheck[] = [];
	const resolvedFailures: HoldoutCheck[] = [];
	const unchanged: HoldoutCheck[] = [];

	const allKeys = new Set([...baselineMap.keys(), ...currentMap.keys()]);

	for (const key of allKeys) {
		const b = baselineMap.get(key);
		const c = currentMap.get(key);

		if (b !== undefined && c !== undefined) {
			if (b.status === c.status) {
				unchanged.push(c);
			} else if (c.status === "fail") {
				newFailures.push(c);
			} else if (b.status === "fail") {
				resolvedFailures.push(b);
			}
			// different non-fail statuses: neither bucket
		} else if (c !== undefined) {
			// current-only
			if (c.status === "fail") {
				newFailures.push(c);
			}
		} else if (b !== undefined) {
			// baseline-only
			if (b.status === "fail") {
				resolvedFailures.push(b);
			}
		}
	}

	return { newFailures, resolvedFailures, unchanged };
}

export async function baselineExists(artifactRoot: string): Promise<boolean> {
	const captured = join(artifactRoot, "results", ".baseline-captured");
	const backfilled = join(artifactRoot, "results", ".baseline-backfilled");
	return existsSync(captured) || existsSync(backfilled);
}

export async function backfillBaseline(
	missionId: string,
	artifactRoot: string,
	projectRoot: string,
	featureBranch: string,
	deps?: CaptureDeps,
): Promise<void> {
	const runQualityGates = deps?.runQualityGates ?? checkQualityGates;
	const runCommand = deps?.runCommand ?? defaultRunCommand;
	const emitEvent = deps?.emitEvent ?? (() => {});

	const resultsDir = join(artifactRoot, "results");
	await mkdir(resultsDir, { recursive: true });

	const tempDir = await mkdtemp(join(tmpdir(), "haru-baseline-backfill-"));

	const worktreeResult = await runCommand(
		["git", "worktree", "add", tempDir, featureBranch],
		projectRoot,
	);

	if (worktreeResult.exitCode !== 0) {
		await writeFile(join(resultsDir, ".baseline-backfill-failed"), "");
		emitEvent("baseline_backfill_failed", { reason: "worktree_add_failed", artifactRoot });
		return;
	}

	try {
		const config = await loadConfig(projectRoot);
		const gates = config.project.qualityGates ?? DEFAULT_QUALITY_GATES;

		const checks = await runQualityGates(tempDir, gates, runCommand);

		await writeFile(join(resultsDir, "baseline.json"), JSON.stringify(checks, null, 2));
		await writeFile(join(resultsDir, ".baseline-backfilled"), "");
		emitEvent("baseline_backfilled", { artifactRoot, baselinePath: "results/baseline.json" });
	} catch (err) {
		console.error(
			`[baseline-snapshot] backfillBaseline failed for mission ${missionId}:`,
			err instanceof Error ? err.message : String(err),
		);
		await writeFile(join(resultsDir, ".baseline-backfill-failed"), "");
		emitEvent("baseline_backfill_failed", {
			reason: "quality_gates_failed",
			artifactRoot,
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		// Best-effort cleanup
		await runCommand(["git", "worktree", "remove", tempDir, "--force"], projectRoot).catch(
			() => {},
		);
	}
}
