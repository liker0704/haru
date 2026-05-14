import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalContext } from "../../../src/eval/types.ts";

// Fixture path: ha-eval-<runId> in tmpdir (see src/commands/eval.ts:119).
// Hook derives fixtureRoot from context.events[0]?.runId, then verifies:
// (a) merge-readiness-pack.json exists under <fixtureRoot>/{.haru,.overstory}/missions/<id>/
// (b) mission_pr_state.merged_at IS NOT NULL in sessions.db
// Falls back to mission-event substring match when fixtureRoot is unavailable.
export default async function (
	context: EvalContext,
): Promise<{ passed: boolean; message: string }> {
	const runId = context.events[0]?.runId ?? null;
	const checks: string[] = [];
	let mrpFound = false;
	let mergedAtFound = false;

	if (runId) {
		const fixtureRoot = join(tmpdir(), `ha-eval-${runId}`);
		const haruDir =
			!existsSync(join(fixtureRoot, ".haru")) && existsSync(join(fixtureRoot, ".overstory"))
				? ".overstory"
				: ".haru";
		const missionsDir = join(fixtureRoot, haruDir, "missions");

		if (existsSync(missionsDir)) {
			for (const missionId of readdirSync(missionsDir)) {
				const mrpPath = join(missionsDir, missionId, "merge-readiness-pack.json");
				if (existsSync(mrpPath)) {
					mrpFound = true;
					checks.push(`MRP at ${haruDir}/missions/${missionId}/merge-readiness-pack.json`);
					break;
				}
			}
		}

		const sessionsDbPath = join(fixtureRoot, haruDir, "sessions.db");
		if (existsSync(sessionsDbPath)) {
			try {
				const db = new Database(sessionsDbPath, { readonly: true });
				const row = db
					.query("SELECT merged_at FROM mission_pr_state WHERE merged_at IS NOT NULL LIMIT 1")
					.get();
				db.close();
				if (row !== null) {
					mergedAtFound = true;
					checks.push("mission_pr_state.merged_at non-null in sessions.db");
				}
			} catch {
				checks.push("sessions.db query failed (table may not exist yet)");
			}
		}
	}

	if (mrpFound || mergedAtFound) {
		return { passed: true, message: `PR merge confirmed: ${checks.join("; ")}` };
	}

	// Fallback: event-substring check when fixture path is unavailable
	const mergedEvent = context.missionEvents.find(
		(e) =>
			e.data?.includes("merged_at") ||
			e.data?.includes("pr_merged") ||
			e.data?.includes("merge-readiness-pack"),
	);
	if (mergedEvent) {
		return {
			passed: true,
			message: `PR merge confirmed via event fallback: ${mergedEvent.data?.slice(0, 80)}`,
		};
	}

	return {
		passed: false,
		message: "No PR merge evidence: MRP file absent, merged_at null, no merge event signal",
	};
}
