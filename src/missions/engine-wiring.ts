/**
 * Engine wiring bridge module.
 *
 * Bridges lifecycle.ts and engine.ts: defines the cell registry, bridge
 * functions for starting/advancing cell engines, and status queries.
 * All engine orchestration logic lives here; lifecycle.ts only calls guard
 * clauses that delegate here.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { OverstoryConfig } from "../config-types.ts";
import { assembleMrp as runAssembleMrp } from "../merge/mrp-assembler.ts";
import { createMetricsStore } from "../metrics/store.ts";
import type { SessionStore } from "../sessions/store.ts";
import type {
	CheckpointStore,
	Mission,
	MissionGraph,
	MissionStore,
	MissionTier,
} from "../types.ts";
import { archReviewPhaseCell } from "./cells/arch-review-phase.ts";
import { architectureReviewCell } from "./cells/architecture-review.ts";
import { donePhaseCell } from "./cells/done-phase.ts";
import { executeDirectPhaseCell } from "./cells/execute-direct-phase.ts";
import { executePhaseCell } from "./cells/execute-phase.ts";
import { intakePhaseCell } from "./cells/intake-phase.ts";
import { planPhaseCell } from "./cells/plan-phase.ts";
import { planReviewCell } from "./cells/plan-review.ts";
import { prPhaseCell } from "./cells/pr-phase.ts";
import { prePrPhaseCell } from "./cells/pre-pr-phase.ts";
import type {
	PhaseCellConfig,
	PhaseCellDefinition,
	ReviewCellConfig,
	ReviewCellDefinition,
} from "./cells/types.ts";
import { understandPhaseCell } from "./cells/understand-phase.ts";
import { createGraphEngine, type GraphEngine, type RunResult, type StepResult } from "./engine.ts";
import { DEFAULT_MISSION_GRAPH } from "./graph.ts";
import { autoAdvanceHandlers } from "./handlers/auto-advance.ts";
import { createHandlerRegistry } from "./handlers.ts";
import type { HandlerRegistry } from "./types.ts";

// === Types ===

export type { PhaseCellDefinition, ReviewCellConfig, ReviewCellDefinition } from "./cells/types.ts";
export type { StepResult } from "./engine.ts";

export interface EngineDeps {
	checkpointStore: CheckpointStore;
	missionStore: MissionStore;
	sendMail?: (to: string, subject: string, body: string, type: string) => Promise<void>;
	sessionStore?: SessionStore;
	/** Optional mail store for handlers that need inbox/outbox inspection
	 * (e.g. execute-phase check-remaining disambiguates lead waiting state). */
	mailStore?: import("../mail/store.ts").MailStore;
	/** Optional haru directory — needed by handlers that spawn role agents
	 * (e.g. plan-phase ensure-architect). */
	overstoryDir?: string;
	/** Optional project root — needed by handlers that spawn role agents
	 * (e.g. plan-phase ensure-architect). */
	projectRoot?: string;
}

export interface EngineStatus {
	cellType: string;
	currentNodeId: string;
	transitions: Array<{ fromNode: string; toNode: string; trigger: string; createdAt: string }>;
}

// === Cell registries ===

/** Review cell registry (plan-review, architecture-review). Used by startCellEngine(). */
export const CELL_REGISTRY: Record<string, ReviewCellDefinition> = {
	"plan-review": planReviewCell,
	"architecture-review": architectureReviewCell,
};

/** Phase cell registry (intake, understand, plan, execute, arch-review, pre-pr, pr, done). Used by startLifecycleEngine(). */
export const PHASE_CELL_REGISTRY: Record<string, PhaseCellDefinition> = {
	"intake-phase": intakePhaseCell,
	"understand-phase": understandPhaseCell,
	"plan-phase": planPhaseCell,
	"execute-phase": executePhaseCell,
	"arch-review-phase": archReviewPhaseCell,
	"pre-pr-phase": prePrPhaseCell,
	"pr-phase": prPhaseCell,
	"done-phase": donePhaseCell,
};

// === Tier-phase mapping ===

/**
 * Frozen tier→phase chains. Used by callers that do not have an OverstoryConfig
 * to consult. Prefer `getTierPhases(tier, config)` when a config is available —
 * it honors `config.pr.enabled` and the direct-tier opt-in.
 *
 * @deprecated For new code, use `getTierPhases(tier, config)` instead.
 */
export const TIER_PHASES: Record<MissionTier, readonly string[]> = {
	direct: ["intake", "execute", "pre-pr", "done"],
	planned: ["intake", "understand", "plan", "execute", "pre-pr", "pr", "done"],
	full: [
		"intake",
		"understand",
		"align",
		"decide",
		"plan",
		"execute",
		"arch-review",
		"pre-pr",
		"pr",
		"done",
	],
};

/**
 * Tier-aware phase chain that consults `config.pr` for opt-in/opt-out behavior.
 *
 * Direct tier opts OUT by default (per da-01: prevents direct missions from
 * stalling on `gh_auth_missing` when GitHub is not configured). To enable
 * pr-phase for direct tier, the operator must set ALL of:
 *   - `config.pr.enabled !== false` (default true)
 *   - `config.pr.operatorGithubLogin` (truthy)
 *   - `config.pr.directTierIncludesPr === true`
 *
 * Planned/full tiers opt IN by default. Disabled only when
 * `config.pr.enabled === false`.
 *
 * `"pr"` is inserted between `"execute"` and `"done"` when included.
 */
export function getTierPhases(tier: MissionTier, config: OverstoryConfig): readonly string[] {
	const baseDirect = ["intake", "execute", "pre-pr", "done"];
	const basePlanned = ["intake", "understand", "plan", "execute", "pre-pr", "done"];
	const baseFull = [
		"intake",
		"understand",
		"align",
		"decide",
		"plan",
		"execute",
		"arch-review",
		"pre-pr",
		"done",
	];

	const prEnabled = config.pr?.enabled !== false;
	const prRequiresLogin = !!config.pr?.operatorGithubLogin;
	const includeDirect = prEnabled && prRequiresLogin && config.pr?.directTierIncludesPr === true;
	const includePlannedFull = prEnabled;

	const insertPr = (arr: readonly string[]): string[] => arr.slice(0, -1).concat(["pr", "done"]);

	switch (tier) {
		case "direct":
			return includeDirect ? insertPr(baseDirect) : baseDirect;
		case "planned":
			return includePlannedFull ? insertPr(basePlanned) : basePlanned;
		case "full":
			return includePlannedFull ? insertPr(baseFull) : baseFull;
	}
}

/**
 * Build a `PhaseCellConfig` for the given mission, optionally populating the
 * `pr` block from `OverstoryConfig.pr` (arch-05).
 */
export function buildPhaseCellConfig(mission: Mission, config?: OverstoryConfig): PhaseCellConfig {
	const tier: MissionTier = mission.tier ?? "full";
	const cellConfig: PhaseCellConfig = {
		missionId: mission.id,
		artifactRoot: mission.artifactRoot ?? "",
		projectRoot: config?.project?.root ?? "",
		tier,
	};
	if (config?.pr) {
		cellConfig.pr = {
			enabled: config.pr.enabled,
			directTierIncludesPr: config.pr.directTierIncludesPr,
			operatorGithubLogin: config.pr.operatorGithubLogin,
			commentTriageAuthors: config.pr.commentTriageAuthors,
			ciTimeoutMs: config.pr.ciTimeoutMs,
			commentsTimeoutMs: config.pr.commentsTimeoutMs,
			approvalTimeoutMs: config.pr.approvalTimeoutMs,
			mergeStrategy: config.pr.mergeStrategy,
			showCost: config.pr.showCost,
			autoCloseSuperseded: config.pr.autoCloseSuperseded,
			maxTriageSpawnsPerMission: config.pr.maxTriageSpawnsPerMission,
			maxTriagePerAuthorPerHour: config.pr.maxTriagePerAuthorPerHour,
			maxCoordinatorResumesPerPr: config.pr.maxCoordinatorResumesPerPr,
			requireOperatorPermission: config.pr.requireOperatorPermission,
			triage: config.pr.triage,
			ghBudget: config.pr.ghBudget,
			classifyCiRed: config.pr.classifyCiRed,
		};
	}
	return cellConfig;
}

// === Bridge functions ===

/**
 * Returns true if graph execution engine is enabled via config flag.
 */
export function shouldUseEngine(mission: Mission, config: OverstoryConfig): boolean {
	// mission param reserved for future per-mission overrides
	void mission;
	return config.mission?.graphExecution !== false;
}

/**
 * Start engine for a cell type from the registry.
 *
 * Idempotent: if a checkpoint already shows critics were dispatched, resumes
 * from checkpoint rather than re-dispatching from the start.
 */
export async function startCellEngine(
	mission: Mission,
	cellType: string,
	deps: EngineDeps,
	config?: ReviewCellConfig,
): Promise<RunResult> {
	const cell = CELL_REGISTRY[cellType];
	if (!cell) {
		throw new Error(
			`Unknown cell type: '${cellType}'. Known types: ${Object.keys(CELL_REGISTRY).join(", ")}`,
		);
	}

	const defaultConfig: ReviewCellConfig = config ?? {
		tier: "full",
		maxRounds: 3,
		artifactRoot: mission.artifactRoot ?? "",
	};

	const graph = cell.buildSubgraph(defaultConfig);
	const handlers = cell.buildHandlers({
		mailSend: deps.sendMail ?? (async () => {}),
		checkpointStore: deps.checkpointStore,
		missionStore: deps.missionStore,
	});

	// Idempotent dispatch: if checkpoint exists, engine resumes from it automatically
	// (createGraphEngine resolves startNodeId from checkpoint when not specified)
	const engine = createGraphEngine({
		graph,
		handlers,
		checkpointStore: deps.checkpointStore,
		missionId: mission.id,
		missionStore: deps.missionStore,
		sendMail: deps.sendMail,
	});

	return engine.run();
}

/**
 * Advance a gate node in the active cell engine for a mission.
 *
 * Determines the active cell from the latest checkpoint node ID prefix,
 * rebuilds the engine (resuming from checkpoint), then calls advanceNode.
 */
export async function advanceCellGate(
	mission: Mission,
	trigger: string,
	data: unknown,
	deps: EngineDeps,
): Promise<RunResult> {
	// data param reserved for future use
	void data;

	const latest = deps.checkpointStore.getLatestCheckpoint(mission.id);
	if (!latest) {
		return {
			status: "error",
			steps: [],
			currentNodeId: "",
			error: `No checkpoint found for mission '${mission.id}'`,
		};
	}

	// Determine cellType from the node ID prefix (e.g., "plan-review:await-critics" → "plan-review")
	const colonIdx = latest.nodeId.indexOf(":");
	if (colonIdx === -1) {
		return {
			status: "error",
			steps: [],
			currentNodeId: latest.nodeId,
			error: `Cannot determine cellType from node ID '${latest.nodeId}'`,
		};
	}
	const cellType = latest.nodeId.slice(0, colonIdx);

	const cell = CELL_REGISTRY[cellType];
	if (!cell) {
		return {
			status: "error",
			steps: [],
			currentNodeId: latest.nodeId,
			error: `Unknown cell type '${cellType}' derived from checkpoint node '${latest.nodeId}'`,
		};
	}

	const defaultConfig: ReviewCellConfig = {
		tier: "full",
		maxRounds: 3,
		artifactRoot: mission.artifactRoot ?? "",
	};

	const graph = cell.buildSubgraph(defaultConfig);
	const handlers = cell.buildHandlers({
		mailSend: deps.sendMail ?? (async () => {}),
		checkpointStore: deps.checkpointStore,
		missionStore: deps.missionStore,
	});

	// Engine resumes from checkpoint automatically
	const engine = createGraphEngine({
		graph,
		handlers,
		checkpointStore: deps.checkpointStore,
		missionId: mission.id,
		missionStore: deps.missionStore,
		sendMail: deps.sendMail,
	});

	return engine.advanceNode(trigger);
}

/**
 * Get the current engine status for a mission, or null if no checkpoint exists.
 */
export function getCellEngineStatus(mission: Mission, deps: EngineDeps): EngineStatus | null {
	const latest = deps.checkpointStore.getLatestCheckpoint(mission.id);
	if (!latest) return null;

	const colonIdx = latest.nodeId.indexOf(":");
	if (colonIdx === -1) return null;
	const cellType = latest.nodeId.slice(0, colonIdx);

	const transitions = deps.checkpointStore.getTransitionHistory(mission.id);

	return {
		cellType,
		currentNodeId: latest.nodeId,
		transitions: transitions.map((t) => ({
			fromNode: t.fromNode,
			toNode: t.toNode,
			trigger: t.trigger,
			createdAt: t.createdAt,
		})),
	};
}

// === Lifecycle engine ===

/**
 * Build a merged handler registry from all phase cells + auto-advance handlers.
 * Accepts tier to conditionally swap the execute-phase cell for direct tier.
 */
export function buildLifecycleHandlers(
	deps: EngineDeps,
	tier: MissionTier = "full",
): HandlerRegistry {
	const overstoryDir = deps.overstoryDir;
	const projectRoot = deps.projectRoot;
	const missionStore = deps.missionStore;
	const cellDeps = {
		mailSend: deps.sendMail ?? (async () => {}),
		checkpointStore: deps.checkpointStore,
		missionStore,
		sessionStore: deps.sessionStore,
		mailStore: deps.mailStore,
		overstoryDir,
		projectRoot,
		assembleMrp: async (missionId: string) => {
			if (!overstoryDir) {
				throw new Error("assembleMrp factory: overstoryDir not in scope");
			}
			// Lazy: open metrics.db on demand (mirrors dashboard/data.ts:80-88 pattern).
			const metricsDbPath = join(overstoryDir, "metrics.db");
			if (!existsSync(metricsDbPath)) {
				throw new Error(`assembleMrp factory: metrics.db not found at ${metricsDbPath}`);
			}
			const metricsStore = createMetricsStore(metricsDbPath);
			return runAssembleMrp(missionId, {
				missionStore,
				metricsStore,
				resolveArtifactRoot: (m) => m.artifactRoot ?? "",
				repoRoot: projectRoot ?? "",
			});
		},
	};
	// Namespace each cell's handlers by cellType to prevent collisions across
	// phase cells (e.g., both intake-phase and done-phase register "escalate";
	// without namespacing the later registration silently shadows the earlier
	// one and intake's escalate node ends up running done-phase's debug-loop
	// escalate). See haru-0f81. Keys are stored as `${cellType}:${handlerName}`
	// (e.g., "intake-phase:escalate") and the engine resolves cell nodes via
	// `${node.cellType}:${node.handler}` first, falling back to the bare name
	// for lifecycle nodes (auto-advance handlers, which have no cellType).
	const phaseHandlers: HandlerRegistry = {};
	const registerNamespaced = (cellType: string, handlers: HandlerRegistry): void => {
		for (const [name, fn] of Object.entries(handlers)) {
			phaseHandlers[`${cellType}:${name}`] = fn;
			// Keep bare name registered as a fallback for nodes that don't carry
			// cellType (lifecycle :active handlers). Last writer wins here — same
			// collision risk as before, but cell nodes now hit the namespaced
			// key first and are immune.
			phaseHandlers[name] = fn;
		}
	};
	for (const [key, cell] of Object.entries(PHASE_CELL_REGISTRY)) {
		// Skip standard execute cell if direct tier (use direct cell instead)
		if (tier === "direct" && key === "execute-phase") continue;
		registerNamespaced(key, cell.buildHandlers(cellDeps));
	}
	// Add direct execute handlers if direct tier. NOTE: executeDirectPhaseCell
	// uses cellType="execute-phase" on its nodes (mirrors the standard execute
	// cell's namespace), so its handlers must register under the same prefix.
	if (tier === "direct") {
		registerNamespaced("execute-phase", executeDirectPhaseCell.buildHandlers(cellDeps));
	}
	return createHandlerRegistry({ ...autoAdvanceHandlers, ...phaseHandlers });
}

/**
 * Build a tier-aware lifecycle graph by filtering phases and attaching subgraphs.
 *
 * For each tier, only the phases in TIER_PHASES[tier] are included.
 * Direct tier gets executeDirectPhaseCell instead of standard executePhaseCell.
 * tier=null missions should never reach this — callers must guard.
 */
export function buildLifecycleGraph(
	mission: Mission,
	overstoryConfig?: OverstoryConfig,
): MissionGraph {
	const tier: MissionTier = mission.tier ?? "full";
	const tierPhaseListForFilter = overstoryConfig
		? getTierPhases(tier, overstoryConfig)
		: TIER_PHASES[tier];
	const allowedPhases = new Set(tierPhaseListForFilter);

	const cellConfig = buildPhaseCellConfig(mission, overstoryConfig);

	// Filter nodes to only include phases in this tier
	const nodes = DEFAULT_MISSION_GRAPH.nodes
		.filter((node) => {
			if (node.kind !== "lifecycle") return false;
			return allowedPhases.has(node.phase);
		})
		.map((node) => {
			if (node.kind !== "lifecycle" || node.state !== "active") return node;

			// Tier-aware cell selection: direct tier gets direct execute cell
			const cell =
				tier === "direct" && node.phase === "execute"
					? executeDirectPhaseCell
					: PHASE_CELL_REGISTRY[`${node.phase}-phase`];
			if (!cell) return node;

			return { ...node, subgraph: cell.buildSubgraph(cellConfig) };
		});

	// Collect valid node IDs for edge filtering
	const nodeIds = new Set(nodes.map((n) => n.id));

	// Filter edges to only include edges between remaining nodes
	const edges = DEFAULT_MISSION_GRAPH.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));

	// Add direct phase_advance edges between consecutive tier phases.
	// DEFAULT_MISSION_GRAPH has edges like understand→align→decide→plan→execute.
	// When tiers skip phases (e.g., planned skips align/decide), the edges are lost.
	// We need direct edges: understand:active → plan:active for planned tier.
	const tierPhaseList = tierPhaseListForFilter;
	for (let i = 0; i < tierPhaseList.length - 1; i++) {
		const fromPhase = tierPhaseList[i];
		const toPhase = tierPhaseList[i + 1];
		if (!fromPhase || !toPhase) continue;
		const fromId = `${fromPhase}:active`;
		const toId = `${toPhase}:active`;
		// Check if a phase_advance/handoff edge already exists between these phases
		const trigger = fromPhase === "plan" && toPhase === "execute" ? "handoff" : "phase_advance";
		const exists = edges.some((e) => e.from === fromId && e.to === toId && e.trigger === trigger);
		if (!exists && nodeIds.has(fromId) && nodeIds.has(toId)) {
			edges.push({ from: fromId, to: toId, trigger, weight: 11 }); // bumped from 10 to stay symmetric with graph.ts static edges
		}
	}

	return { version: 1, nodes, edges };
}

/**
 * Resolve the trigger that advances a mission one step toward done from its
 * current lifecycle node. Returns `null` if no advancing edge exists (e.g.,
 * mission already in done phase or current node is unknown).
 *
 * Used by `ha mission complete` to pick the right trigger based on the
 * mission's current phase — there is no single "complete" trigger anymore;
 * inter-phase advancement uses `phase_advance` (and `handoff` for plan→execute)
 * edges synthesized by buildLifecycleGraph.
 */
export function resolveCompletionTrigger(mission: Mission): string | null {
	if (!mission.currentNode) return null;
	let startNodeId = mission.currentNode;
	if (startNodeId.includes("-phase:")) {
		const phasePart = startNodeId.split("-phase:")[0];
		if (phasePart) {
			startNodeId = `${phasePart}:active`;
		}
	}
	const graph = buildLifecycleGraph(mission);
	const outgoing = graph.edges
		.filter((e) => e.from === startNodeId)
		.filter((e) => e.trigger === "phase_advance" || e.trigger === "handoff")
		.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
	const next = outgoing[0];
	return next ? next.trigger : null;
}

/**
 * Transition a mission's graph state via the engine using a named trigger.
 *
 * Loads the mission, creates a lifecycle engine starting from its currentNode,
 * and calls forceAdvance(trigger). Returns a StepResult — no continuation run.
 */
export async function transitionMissionViaEngine(
	missionId: string,
	trigger: string,
	deps: EngineDeps,
): Promise<StepResult> {
	const mission = deps.missionStore.getById(missionId);
	if (!mission) {
		return {
			status: "error",
			fromNodeId: "",
			toNodeId: "",
			trigger,
			error: `Mission ${missionId} not found`,
		};
	}
	if (!mission.currentNode) {
		return {
			status: "error",
			fromNodeId: "",
			toNodeId: "",
			trigger,
			error: `Mission ${missionId} has no currentNode`,
		};
	}
	// Resolve subgraph nodes to parent lifecycle node for lifecycle triggers.
	// Subgraph nodes use "{phase}-phase:{name}" convention (e.g., "execute-phase:await-leads-done").
	// Lifecycle triggers (stop, complete, suspend, resume, handoff) only have edges from
	// parent lifecycle nodes (e.g., "execute:active"), not from subgraph nodes.
	let startNodeId = mission.currentNode;
	if (startNodeId.includes("-phase:")) {
		const phasePart = startNodeId.split("-phase:")[0];
		if (phasePart) {
			startNodeId = `${phasePart}:active`;
		}
	}

	const tier: MissionTier = mission.tier ?? "full";
	const graph = buildLifecycleGraph(mission);
	const handlers = buildLifecycleHandlers(deps, tier);
	const engine = startLifecycleEngine(mission, deps, {
		startNodeId,
		graph,
		handlers,
	});
	return engine.forceAdvance(trigger);
}

/**
 * Create a lifecycle graph engine for a mission.
 *
 * Builds an enhanced graph with phase subgraphs attached to :active nodes,
 * merges all handler registries (built-in + auto-advance + phase cell handlers).
 * Engine is capped at maxSteps=5 for tick-based execution safety.
 */
export function startLifecycleEngine(
	mission: Mission,
	deps: EngineDeps,
	opts?: { startNodeId?: string; graph?: MissionGraph; handlers?: HandlerRegistry },
): GraphEngine {
	const tier: MissionTier = mission.tier ?? "full";
	const graph = opts?.graph ?? buildLifecycleGraph(mission);
	const handlers = opts?.handlers ?? buildLifecycleHandlers(deps, tier);

	return createGraphEngine({
		graph,
		handlers,
		checkpointStore: deps.checkpointStore,
		missionId: mission.id,
		missionStore: deps.missionStore,
		sendMail: deps.sendMail,
		maxSteps: 5,
		startNodeId: opts?.startNodeId,
	});
}
