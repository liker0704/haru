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
import type { TrackerClient } from "../../tracker/types.ts";
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
	/** PR-phase configuration (Stage E). All fields are optional for backwards compat. */
	pr?: {
		enabled?: boolean;
		directTierIncludesPr?: boolean;
		operatorGithubLogin?: string;
		commentTriageAuthors?: string[];
		ciTimeoutMs?: number;
		commentsTimeoutMs?: number;
		approvalTimeoutMs?: number;
		mergeStrategy?: "squash" | "rebase" | "merge";
		showCost?: boolean;
		autoCloseSuperseded?: boolean;
		maxTriageSpawnsPerMission?: number;
		maxTriagePerAuthorPerHour?: number;
		maxCoordinatorResumesPerPr?: number;
		requireOperatorPermission?: boolean;
		triage?: { minConfidence?: number };
		ghBudget?: { rpm?: number; burst?: number; callTimeoutMs?: number; maxConcurrent?: number };
		classifyCiRed?: { flakeThresholdMs?: number; maxFlakeRetries?: number };
	};
}

export interface PhaseCellDeps {
	mailSend: (to: string, subject: string, body: string, type: string) => Promise<void>;
	checkpointStore: CheckpointStore;
	missionStore: MissionStore;
	/** REQUIRED: tracker client constructed once at watchdog startup (D-1). */
	tracker: TrackerClient;
	sessionStore?: SessionStore;
	/** Optional: needed by check-remaining handler to disambiguate "waiting" lead state. */
	mailStore?: import("../../mail/store.ts").MailStore;
	/** Absolute path to the .overstory directory — needed by handlers that
	 *  spawn role agents (e.g. plan-phase ensure-architect). */
	overstoryDir?: string;
	/** Absolute path to the project root — needed by handlers that spawn
	 *  role agents (e.g. plan-phase ensure-architect). */
	projectRoot?: string;
	/** DI for Bun.spawn — used by spawn-helpers and intake-phase dispatch handlers. */
	spawn?: typeof Bun.spawn;
	/** DI for ensureMissionAnalyst — used by intake-phase dispatch-analyst-intake handler. */
	ensureMissionAnalyst?: (
		mission: import("../../types.ts").Mission,
		overstoryDir: string,
		projectRoot: string,
		role?: import("../roles.ts").AnalystRole,
	) => Promise<void>;
	/** DI for assembleMrp — used by pre-pr-phase write-mrp handler. */
	assembleMrp?: (
		missionId: string,
	) => Promise<import("../../merge/mrp-renderer.ts").MergeReadinessPack>;
}

export interface PhaseCellDefinition {
	cellType: string;
	buildSubgraph(config: PhaseCellConfig): MissionGraph;
	buildHandlers(deps: PhaseCellDeps, config?: PhaseCellConfig): HandlerRegistry;
}
