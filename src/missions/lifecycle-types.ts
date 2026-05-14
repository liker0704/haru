/**
 * Shared types for mission lifecycle operations.
 */

import type { nudgeAgent } from "../commands/nudge.ts";
import type { stopCommand } from "../commands/stop.ts";
import type { ApplyContinueFromDeps } from "./predecessor.ts";
import type {
	startExecutionDirector,
	startMissionAnalyst,
	startMissionCoordinator,
	stopMissionRole,
} from "./roles.ts";

export interface MissionCommandDeps {
	startMissionCoordinator?: typeof startMissionCoordinator;
	startMissionAnalyst?: typeof startMissionAnalyst;
	startExecutionDirector?: typeof startExecutionDirector;
	stopMissionRole?: typeof stopMissionRole;
	stopAgentCommand?: typeof stopCommand;
	ensureCanonicalWorkstreamTasks?: typeof import("./workstreams.ts").ensureCanonicalWorkstreamTasks;
	nudgeAgent?: typeof nudgeAgent;
	captureBaseline?: (missionId: string, artifactRoot: string, projectRoot: string) => Promise<void>;
	applyContinueFrom?: (
		oldMissionId: string,
		newMissionId: string,
		newArtifactRoot: string,
		deps: ApplyContinueFromDeps,
	) => Promise<void>;
}
