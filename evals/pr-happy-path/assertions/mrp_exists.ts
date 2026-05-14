import type { EvalContext } from "../../../src/eval/types.ts";

export default async function (context: EvalContext): Promise<{ passed: boolean; message: string }> {
	const mergedEvent = context.missionEvents.find(
		(e) =>
			e.data !== null &&
			(e.data.includes("merged_at") ||
				e.data.includes("pr_merged") ||
				e.data.includes("merge-readiness-pack")),
	);

	if (!mergedEvent) {
		return {
			passed: false,
			message:
				"No mission event indicating PR was merged (no merged_at / pr_merged / merge-readiness-pack signal)",
		};
	}

	return {
		passed: true,
		message: `PR merge signal found in mission events: ${mergedEvent.data?.slice(0, 80)}`,
	};
}
