/**
 * Shared cell types for mission subgraph cells.
 */

import type { SessionStore } from "../../sessions/store.ts";
import type {
	CheckpointStore,
	MissionGraph,
	MissionStore,
	MissionTier,
	PlanReviewTier,
} from "../../types.ts";
import type { HandlerRegistry } from "../types.ts";

// === Review cell types (plan-review, architecture-review) ===

export interface ReviewCellConfig {
	tier: PlanReviewTier;
	maxRounds: number;
	artifactRoot: string;
}

export interface ReviewCellDeps {
	mailSend: (to: string, subject: string, body: string, type: string) => Promise<void>;
	checkpointStore: CheckpointStore;
	missionStore: MissionStore;
}

export interface ReviewCellDefinition {
	cellType: string;
	buildSubgraph(config: ReviewCellConfig): MissionGraph;
	buildHandlers(deps: ReviewCellDeps): HandlerRegistry;
}

// === Phase cell types (understand, plan, execute, done) ===

export interface PhaseCellConfig {
	missionId: string;
	artifactRoot: string;
	projectRoot: string;
	/** Mission tier — controls tier-conditional subgraph routing
	 *  (e.g. plan-phase skips architect-design for `planned`). */
	tier?: MissionTier;
}

export interface PhaseCellDeps {
	mailSend: (to: string, subject: string, body: string, type: string) => Promise<void>;
	checkpointStore: CheckpointStore;
	missionStore: MissionStore;
	sessionStore?: SessionStore;
	/** Optional: needed by check-remaining handler to disambiguate "waiting" lead state. */
	mailStore?: import("../../mail/store.ts").MailStore;
	/** Absolute path to the .overstory directory — needed by handlers that
	 *  spawn role agents (e.g. plan-phase ensure-architect). */
	overstoryDir?: string;
	/** Absolute path to the project root — needed by handlers that spawn
	 *  role agents (e.g. plan-phase ensure-architect). */
	projectRoot?: string;
}

export interface PhaseCellDefinition {
	cellType: string;
	buildSubgraph(config: PhaseCellConfig): MissionGraph;
	buildHandlers(deps: PhaseCellDeps): HandlerRegistry;
}
