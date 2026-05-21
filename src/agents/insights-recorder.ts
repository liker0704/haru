import { analyzeSessionInsights } from "../insights/analyzer.ts";
import type { MulchClient } from "../mulch/client.ts";
import type { AgentSession, EventStore } from "../types.ts";

interface RecorderLogger {
	warn: (msg: string, meta?: unknown) => void;
}

function outcomeStatusForState(state: AgentSession["state"]): "success" | "failure" | null {
	if (state === "completed") return "success";
	if (state === "zombie" || (state as string) === "escalated") return "failure";
	return null;
}

export async function recordSessionInsights(params: {
	session: AgentSession;
	eventStore: EventStore;
	mulchClient: MulchClient;
	logger?: RecorderLogger;
}): Promise<void> {
	const { session, eventStore, mulchClient, logger } = params;
	try {
		const outcomeStatus = outcomeStatusForState(session.state);
		if (outcomeStatus === null) return;

		const events = eventStore.getByAgent(session.agentName);
		const toolStats = eventStore.getToolStats({ agentName: session.agentName });

		const analysis = analyzeSessionInsights({
			events,
			toolStats,
			agentName: session.agentName,
			capability: session.capability,
			domains: [],
		});

		for (const insight of analysis.insights) {
			try {
				await mulchClient.record(insight.domain, {
					type: insight.type,
					description: insight.description,
					tags: insight.tags,
					classification: "observational",
					outcomeStatus,
					outcomeAgent: session.agentName,
				});
			} catch (err) {
				logger?.warn(
					`insights-recorder: failed to record insight for ${session.agentName} (domain=${insight.domain})`,
					err,
				);
			}
		}
	} catch (err) {
		logger?.warn(`insights-recorder: unexpected error analyzing session ${session.agentName}`, err);
	}
}
