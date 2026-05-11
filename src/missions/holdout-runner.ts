#!/usr/bin/env bun
/**
 * Stage C: standalone subprocess invoked by `evaluateHoldoutGate` to run L1
 * quality gates (bun test / lint / typecheck) on a mission's integration
 * branch worktree without blocking the watchdog daemon's tick loop.
 *
 * Invocation (from `src/watchdog/gate-evaluators.ts`):
 *   bun run src/missions/holdout-runner.ts <missionId> <attemptN> <featureBranchWorktree> <resultJsonPath>
 *
 * The runner:
 *  1. Resolves project quality gates from config (or DEFAULT_QUALITY_GATES fallback)
 *  2. Invokes the exported `checkQualityGates` against `featureBranchWorktree` as cwd
 *  3. Writes `HoldoutCheck[]` JSON to `resultJsonPath` for the evaluator to parse
 *
 * Runs detached (`Bun.spawn({detached: true, stdio: ["ignore","ignore","ignore"]}).unref()`)
 * so it survives parent watchdog daemon restart per `src/commands/watch.ts:163-173` pattern.
 */

import { DEFAULT_QUALITY_GATES, loadConfig } from "../config.ts";
import { checkQualityGates } from "./holdout.ts";

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

async function main(): Promise<void> {
	const [, , missionId, attemptN, featureBranchWorktree, resultJsonPath] = process.argv;
	if (!missionId || !attemptN || !featureBranchWorktree || !resultJsonPath) {
		process.stderr.write(
			"holdout-runner: missing required args " +
				"(missionId, attemptN, featureBranchWorktree, resultJsonPath)\n",
		);
		process.exit(2);
	}

	const config = await loadConfig(featureBranchWorktree);
	const gates = config.project.qualityGates ?? DEFAULT_QUALITY_GATES;
	const checks = await checkQualityGates(featureBranchWorktree, gates, defaultRunCommand);

	await Bun.write(
		resultJsonPath,
		JSON.stringify(
			{
				missionId,
				attemptN: Number(attemptN),
				featureBranchWorktree,
				producedAt: new Date().toISOString(),
				checks,
			},
			null,
			2,
		),
	);
}

main().catch((err) => {
	process.stderr.write(
		`holdout-runner failed: ${err instanceof Error ? err.message : String(err)}\n`,
	);
	process.exit(1);
});
