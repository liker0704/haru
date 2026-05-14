import { existsSync, readFileSync } from "node:fs";
import type { EvalContext } from "../../../src/eval/types.ts";

export default async function (
	context: EvalContext,
): Promise<{ passed: boolean; message: string }> {
	const prPhaseEvents = context.missionEvents.filter((e) => e.data?.includes("pr-phase"));

	if (prPhaseEvents.length > 0) {
		return {
			passed: false,
			message: `Expected zero pr-phase mission events, found ${prPhaseEvents.length}`,
		};
	}

	const stateDir = process.env.HARU_EVAL_STATE_DIR;
	if (stateDir) {
		const logPath = `${stateDir}/gh-call-log`;
		if (existsSync(logPath)) {
			const content = readFileSync(logPath, "utf8").trim();
			if (content.length > 0) {
				const lineCount = content.split("\n").length;
				return {
					passed: false,
					message: `Expected zero gh calls but gh-call-log has ${lineCount} entr${lineCount === 1 ? "y" : "ies"}`,
				};
			}
		}
	}

	return {
		passed: true,
		message: "No pr-phase events and no gh calls detected",
	};
}
