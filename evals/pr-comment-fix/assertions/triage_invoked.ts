import type { EvalContext } from "../../../src/eval/types.ts";

const COMMENT_ID = "c001";
const TRIAGE_AGENT = `triage-${COMMENT_ID}`;

export default async function (
	context: EvalContext,
): Promise<{ passed: boolean; message: string }> {
	const { events } = context;

	const spawnCount = events.filter(
		(e) =>
			e.eventType === "spawn" && (e.agentName === TRIAGE_AGENT || e.data?.includes(TRIAGE_AGENT)),
	).length;

	const passed = spawnCount === 1;
	return {
		passed,
		message: passed
			? `triage_invoked: exactly 1 spawn event for ${TRIAGE_AGENT}`
			: `triage_invoked: expected 1 spawn for ${TRIAGE_AGENT}, found ${spawnCount}`,
	};
}
