import type { EvalContext } from "../../../src/eval/types.ts";

export default async function (
	context: EvalContext,
): Promise<{ passed: boolean; message: string }> {
	const { events, missionEvents } = context;

	const resumeEvent = events.find(
		(e) => e.eventType === "engine_agent_resumed_on_mail" || e.data?.includes("resume-coordinator"),
	);

	const coordinatorResumed =
		resumeEvent !== undefined ||
		missionEvents.some(
			(e) => e.eventType === "engine_gate_advanced" && e.data?.includes("resume-coordinator"),
		);

	if (!coordinatorResumed) {
		return {
			passed: false,
			message: "coordinator_resumed: no resume-coordinator event found in events or mission events",
		};
	}

	return {
		passed: true,
		message: "coordinator_resumed: resume-coordinator handler fired and coordinator was resumed",
	};
}
