import type { EvalContext } from "../../../src/eval/types.ts";

export default async function (
	context: EvalContext,
): Promise<{ passed: boolean; message: string }> {
	const { events, missionEvents, mailMessages } = context;

	// (b) Original mission must have state === "superseded" visible in events
	const supersededEvent = missionEvents.find((e) => {
		if (e.data === null) return false;
		try {
			const d = JSON.parse(e.data) as Record<string, unknown>;
			return d.state === "superseded" || d.newState === "superseded";
		} catch {
			return e.data.includes("superseded");
		}
	});

	const supersededInEvents =
		supersededEvent !== undefined || events.some((e) => e.data?.includes("superseded"));

	if (!supersededInEvents) {
		return {
			passed: false,
			message: "supersession: no event found indicating original mission reached state=superseded",
		};
	}

	// (a) New mission with parent_mission_id should appear in mission events or mail
	const childMissionEvent = missionEvents.find((e) => e.data?.includes("parent_mission_id"));

	const childMissionInMail = mailMessages.some(
		(m) =>
			m.body.includes("parent_mission_id") ||
			m.subject.includes("supersession") ||
			m.payload?.includes("parent_mission_id"),
	);

	if (childMissionEvent === undefined && !childMissionInMail) {
		return {
			passed: false,
			message: "supersession: no child mission with parent_mission_id found in events or mail",
		};
	}

	// (c) predecessor-summary.md should be referenced in events or mail
	const predecessorSummaryReferenced =
		events.some((e) => e.data?.includes("predecessor-summary.md")) ||
		mailMessages.some(
			(m) =>
				m.body.includes("predecessor-summary.md") || m.payload?.includes("predecessor-summary.md"),
		);

	if (!predecessorSummaryReferenced) {
		return {
			passed: false,
			message: "supersession: predecessor-summary.md not referenced in events or mail",
		};
	}

	return {
		passed: true,
		message:
			"supersession: original mission superseded, child mission with parent_mission_id created, predecessor-summary.md referenced",
	};
}
