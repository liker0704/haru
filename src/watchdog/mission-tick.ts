/**
 * Mission lifecycle engine tick.
 *
 * Called once per watchdog daemon tick. Evaluates active mission gates,
 * nudges stuck agents, and recovers dead agents.
 *
 * The engine is a controller, not a replacement for agents. It nudges when
 * agents are alive but stuck, and respawns when agents are dead.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { validateTransition } from "../agents/state-machine.ts";
import { resumeAgent } from "../commands/resume.ts";
import { loadConfig } from "../config.ts";
import type { OverstoryConfig } from "../config-types.ts";
import type { EventStore } from "../events/types.ts";
import type { MailStore } from "../mail/store.ts";
import { REPLAY_SAFE_HANDLERS } from "../missions/engine.ts";
import {
	buildLifecycleGraph,
	buildLifecycleHandlers,
	CELL_REGISTRY,
	type startLifecycleEngine,
} from "../missions/engine-wiring.ts";
import { nodeId } from "../missions/graph.ts";
import type { SessionStore } from "../sessions/store.ts";
import type {
	AgentSession,
	Mission,
	MissionGraph,
	MissionGraphEdge,
	MissionGraphNode,
	MissionStore,
	MissionTier,
} from "../types.ts";
import { listSessions as listTmuxSessions } from "../worktree/tmux.ts";
import { evaluateGate } from "./gate-evaluators.ts";
import { evaluateHealth } from "./health.ts";

// === Types ===

export interface MissionTickOpts {
	overstoryDir: string;
	projectRoot: string;
	config: OverstoryConfig;
	missionStore: MissionStore;
	sessionStore: SessionStore;
	mailStore: MailStore | null;
	eventStore: EventStore | null;
	intervalMs: number;
	/** DI override: custom engine factory. */
	_startEngine?: typeof startLifecycleEngine;
	/** DI override: custom tmux session listing (test seam). */
	_listTmuxSessions?: typeof listTmuxSessions;
	/** DI override: custom resumeAgent (test seam). */
	_resumeAgent?: typeof resumeAgent;
}

// === Grace period defaults (ms) ===

const DEFAULT_GRACE_MS = 120_000; // 2 minutes
const DEFAULT_MAX_TOTAL_WAIT_MS = 3_600_000; // 1 hour absolute ceiling

/** Grace overrides per node name suffix. */
const GRACE_OVERRIDES: Record<string, number> = {
	"await-plan": 300_000, // 5 min — analyst needs time to write plan
	"architect-design": 300_000, // 5 min — architect explores and writes
	"await-ws-completion": 600_000, // 10 min — full dev cycle
	review: 360_000, // 6 min — critics working
	"await-refactor": 600_000, // 10 min — refactor builders working
	"await-arch-final": 300_000, // 5 min — architect finalizing
	summary: 180_000, // 3 min — analyst writing summary
	"await-leads-done": 600_000, // 10 min — direct-tier leads take time
};

/** Total wait ceiling overrides. */
const MAX_TOTAL_WAIT_OVERRIDES: Record<string, number> = {
	"await-ws-completion": 14_400_000, // 4 hours — real builds take time
	"await-refactor": 14_400_000, // 4 hours
	"await-leads-done": 14_400_000, // 4 hours — direct-tier leads
};

const resumeAttempts = new Map<string, number>();
const resumeFailureEmitted = new Set<string>();
const MAX_RESUME_ATTEMPTS = 5;

/**
 * Wrap all advance writes for a gate resolution in a single SQLite transaction.
 * Subgraph sites pass a non-null subgraphCheckpointKey; top-level falls back to missionId.
 */
function commitAdvance(
	missionStore: MissionStore,
	missionId: string,
	fromNodeId: string,
	toNodeId: string,
	trigger: string,
	subgraphCheckpointKey: string | null,
): void {
	missionStore.transaction(() => {
		missionStore.resolveGate(missionId, fromNodeId, trigger);
		if (subgraphCheckpointKey !== null) {
			missionStore.checkpoints.saveStepResult(
				subgraphCheckpointKey,
				fromNodeId,
				toNodeId,
				trigger,
				null,
			);
		}
		missionStore.resetGateState(missionId, toNodeId);
		missionStore.updateCurrentNode(missionId, toNodeId);
		missionStore.checkpoints.markCheckpointConfirmed(
			subgraphCheckpointKey ?? missionId,
			fromNodeId,
		);
	});
}

/** Reset module-local resume counters. Test-only escape hatch. */
export function __resetResumeCountersForTesting(): void {
	resumeAttempts.clear();
	resumeFailureEmitted.clear();
}

function getGraceMs(nodeName: string, config?: OverstoryConfig): number {
	const configOverride = config?.mission?.gates?.gracePeriods?.[nodeName];
	if (configOverride !== undefined) return configOverride;
	return GRACE_OVERRIDES[nodeName] ?? DEFAULT_GRACE_MS;
}

function getMaxTotalWaitMs(nodeName: string, config?: OverstoryConfig): number {
	const configOverride = config?.mission?.gates?.maxTotalWaitMs?.[nodeName];
	if (configOverride !== undefined) return configOverride;
	return MAX_TOTAL_WAIT_OVERRIDES[nodeName] ?? DEFAULT_MAX_TOTAL_WAIT_MS;
}

/**
 * Find a graph node in a pre-built lifecycle graph (including subgraphs).
 * Searches top-level nodes, then phase cell subgraphs, then falls back to
 * CELL_REGISTRY for review cell nodes (plan-review, architecture-review)
 * which are not embedded in the lifecycle graph.
 */
function findGraphNode(
	nodeIdStr: string,
	graph: MissionGraph,
	mission: Mission,
): MissionGraphNode | undefined {
	// Search top-level lifecycle nodes
	const topLevel = graph.nodes.find((n) => n.id === nodeIdStr);
	if (topLevel) return topLevel;

	// Search in phase cell subgraphs attached to lifecycle :active nodes
	for (const node of graph.nodes) {
		if (node.kind === "lifecycle" && node.subgraph) {
			const sub = node.subgraph.nodes.find((n) => n.id === nodeIdStr);
			if (sub) return sub;
		}
	}

	// Fallback: review cell nodes (plan-review, architecture-review) are not
	// embedded in the lifecycle graph. Search CELL_REGISTRY for them.
	const colonIdx = nodeIdStr.indexOf(":");
	if (colonIdx !== -1) {
		const prefix = nodeIdStr.slice(0, colonIdx);
		const reviewCell = CELL_REGISTRY[prefix];
		if (reviewCell) {
			const subgraph = reviewCell.buildSubgraph({
				tier: mission.tier === "direct" ? "simple" : "full",
				maxRounds: 3,
				artifactRoot: mission.artifactRoot ?? "",
			});
			return subgraph.nodes.find((n) => n.id === nodeIdStr);
		}
	}

	return undefined;
}

/**
 * Find an edge in a subgraph of the pre-built lifecycle graph.
 * Used for timeout routing and gate advancement in place of
 * PHASE_CELL_REGISTRY[cellType].buildSubgraph() lookups.
 */
function findSubgraphEdge(
	graph: MissionGraph,
	fromNodeId: string,
	trigger: string,
): MissionGraphEdge | undefined {
	for (const node of graph.nodes) {
		if (node.kind === "lifecycle" && node.subgraph) {
			const edge = node.subgraph.edges.find((e) => e.from === fromNodeId && e.trigger === trigger);
			if (edge) return edge;
		}
	}
	return undefined;
}

// === Waiting agent auto-resume ===

async function checkAndResumeWaitingAgents(mission: Mission, opts: MissionTickOpts): Promise<void> {
	const listFn = opts._listTmuxSessions ?? listTmuxSessions;
	const resumeFn = opts._resumeAgent ?? resumeAgent;
	const tmuxSessions = await listFn();
	const tmuxNames = new Set(tmuxSessions.map((s) => s.name));

	for (const { sessionId } of getMissionRoleSessions(mission)) {
		if (!sessionId) continue;
		const session = opts.sessionStore.getAll().find((s) => s.id === sessionId);
		if (!session || session.state !== "waiting") continue;
		if (tmuxNames.has(session.tmuxSession)) continue;
		if (!existsSync(session.worktreePath)) continue;

		// Per #323: count both queued AND claimed-but-unprocessed mail.
		// Convergence-mail (verify-then-ack, #314) can be left claimed when an
		// agent goes waiting; those messages must still trigger auto-resume.
		const pendingCount =
			opts.mailStore?.getPendingForWaitingAgent(session.agentName, session.lastActivity).length ??
			0;
		if (pendingCount === 0) continue;

		const attempts = resumeAttempts.get(session.agentName) ?? 0;
		if (attempts >= MAX_RESUME_ATTEMPTS) {
			if (!resumeFailureEmitted.has(session.agentName)) {
				resumeFailureEmitted.add(session.agentName);
				const coordName = mission.slug ? `coordinator-${mission.slug}` : "coordinator";
				opts.mailStore?.insert({
					id: "",
					from: "engine",
					to: coordName,
					subject: `Cannot resume waiting agent: ${session.agentName}`,
					body: `Agent ${session.agentName} has ${pendingCount} unread mail items but resume has failed ${attempts} times. Inspect worktree and tmux state manually.`,
					type: "mission_finding",
					priority: "high",
					threadId: null,
				});
			}
			continue;
		}

		try {
			await resumeFn(session, opts.config, opts.projectRoot);
			resumeAttempts.delete(session.agentName);
			resumeFailureEmitted.delete(session.agentName);
			opts.eventStore?.insert({
				runId: mission.runId,
				agentName: "engine",
				sessionId: session.id,
				eventType: "engine_agent_resumed_on_mail",
				toolName: null,
				toolArgs: null,
				toolDurationMs: null,
				level: "info",
				data: JSON.stringify({
					missionId: mission.id,
					agentName: session.agentName,
					unreadCount: pendingCount,
					attempts: attempts + 1,
				}),
			});
		} catch (err) {
			resumeAttempts.set(session.agentName, attempts + 1);
			process.stderr.write(
				`[mission-tick] resume ${session.agentName} attempt ${attempts + 1}: ${String(err)}\n`,
			);
		}
	}
}

// === Dead agent detection ===

/** Session IDs bound to a mission for critical roles. */
function getMissionRoleSessions(
	mission: Mission,
): Array<{ role: string; sessionId: string | null }> {
	return [
		{ role: "coordinator", sessionId: mission.coordinatorSessionId },
		{ role: "analyst", sessionId: mission.analystSessionId },
		{ role: "execution-director", sessionId: mission.executionDirectorSessionId },
		{ role: "architect", sessionId: mission.architectSessionId },
	];
}

/**
 * Check if critical mission role agents are dead and record events.
 * Checks tmux liveness + PID liveness via evaluateHealth.
 */
async function checkAndRecoverDeadAgents(mission: Mission, opts: MissionTickOpts): Promise<void> {
	const { sessionStore, eventStore } = opts;
	const tmuxSessions = await listTmuxSessions();
	const tmuxNames = new Set(tmuxSessions.map((s) => s.name));
	const thresholds = { staleMs: 300_000, zombieMs: 600_000 };

	for (const { role, sessionId } of getMissionRoleSessions(mission)) {
		if (!sessionId) continue;

		// Get session from store
		let session: AgentSession | undefined;
		const allSessions = sessionStore.getAll();
		session = allSessions.find((s) => s.id === sessionId);
		if (!session) continue;
		if (session.state === "completed" || session.state === "zombie" || session.state === "waiting")
			continue;

		// Evaluate health
		const tmuxAlive = tmuxNames.has(session.tmuxSession);
		const check = evaluateHealth(session, tmuxAlive, thresholds);

		if (check.state === "zombie") {
			// Mark zombie and attempt resume for mission role agents
			const vr = validateTransition(
				session.state,
				"zombie",
				{
					agentName: session.agentName,
					capability: session.capability,
					reason: "mission-tick: health check detected zombie",
				},
				{ force: true },
			);
			if (vr.success) {
				sessionStore.updateState(session.agentName, "zombie");
			}

			// Try to resume the dead agent via ha resume
			let resumed = false;
			try {
				if (existsSync(session.worktreePath)) {
					const config = await loadConfig(opts.projectRoot);
					await resumeAgent(session, config, opts.projectRoot);
					resumed = true;
				}
			} catch {
				// Non-fatal: resume failure, agent stays zombie
			}

			if (eventStore) {
				eventStore.insert({
					runId: mission.runId,
					agentName: "engine",
					sessionId: session.id,
					eventType: "engine_agent_respawned",
					toolName: null,
					toolArgs: null,
					toolDurationMs: null,
					level: "warn",
					data: JSON.stringify({
						kind: resumed ? "dead_agent_respawned" : "dead_agent_detected",
						missionId: mission.id,
						role,
						agentName: session.agentName,
						note: check.reconciliationNote,
						resumed,
					}),
				});
			}
		}
	}
}

// === Main tick ===

export async function runMissionTick(opts: MissionTickOpts): Promise<void> {
	const { missionStore, intervalMs } = opts;
	const missions = missionStore.getActiveList();

	for (const mission of missions) {
		if (mission.state !== "active") continue;

		// Acquire per-mission tick lock via missionStore (single DB connection)
		if (!missionStore.acquireTickLock(mission.id, intervalMs)) {
			continue; // Another tick is processing this mission
		}

		try {
			await processMission(mission, opts);
		} finally {
			missionStore.releaseTickLock(mission.id);
		}
	}
}

async function processMission(mission: Mission, opts: MissionTickOpts): Promise<void> {
	const { missionStore } = opts;

	// Resume waiting agents whose tmux is dead and have unread mail.
	// Runs before zombie-mark logic so we don't churn agents that are legitimately
	// in `waiting` (sub-agent dispatch idle state) but just need a wake-up nudge.
	await checkAndResumeWaitingAgents(mission, opts);

	// === Dead agent detection for critical mission roles ===
	await checkAndRecoverDeadAgents(mission, opts);

	// Stage A: legacy assess-mode skip-guard removed.
	//
	// Pre-Stage-A behavior: missions with tier=null AND currentNode=null skipped
	// the engine entirely so the assess coordinator could run before the lifecycle
	// graph kicked in. With Stage A's intake-phase as the FIRST graph node, the
	// engine must run from mission start — `lifecycle-start.ts` seeds
	// currentNode='intake:active' for new missions, and intake-phase calls
	// `ha mission tier set` once the classifier finishes.
	//
	// Legacy missions with tier=null AND currentNode=null (rare, dev-only) will
	// fall through and the engine will seed currentNode below from `phase:state`.

	// Seed checkpoint on first engine tick for this mission (backward compat)
	const checkpoint = missionStore.checkpoints.getLatestCheckpoint(mission.id);
	if (!checkpoint) {
		const startNode = nodeId(mission.phase, mission.state);
		missionStore.checkpoints.saveCheckpoint(mission.id, startNode, { seeded: true });
	}

	// Reconstruct engine from checkpoint.
	// If the current node is a subgraph node (e.g., "understand-phase:evaluate"),
	// tell the parent engine to start at the parent lifecycle node so it can
	// re-enter the subgraph properly.
	const engineFactory =
		opts._startEngine ?? (await import("../missions/engine-wiring.ts")).startLifecycleEngine;

	// Build tier-aware graph and handlers ONCE per tick per mission.
	// Reused by findGraphNode() and findSubgraphEdge() below.
	const tier: MissionTier = mission.tier ?? "full";
	const sendMail = opts.mailStore
		? async (to: string, subject: string, body: string, type: string) => {
				opts.mailStore?.insert({
					id: "",
					from: "engine",
					to,
					subject,
					body,
					type: type as "status",
					priority: "normal",
					threadId: null,
				});
			}
		: undefined;
	const engineDeps = {
		checkpointStore: missionStore.checkpoints,
		missionStore,
		sendMail,
		sessionStore: opts.sessionStore,
		mailStore: opts.mailStore ?? undefined,
		overstoryDir: opts.overstoryDir,
		projectRoot: opts.projectRoot,
	};
	const tickGraph = buildLifecycleGraph(mission);
	const tickHandlers = buildLifecycleHandlers(engineDeps, tier);

	// Read mission once — reused for subgraph detection and later as freshMission
	const latestMission = missionStore.getById(mission.id);
	const currentMissionNode = latestMission?.currentNode;
	let startNodeOverride: string | undefined;
	if (currentMissionNode?.includes("-phase:")) {
		const phasePart = currentMissionNode.split("-phase:")[0];
		if (phasePart) {
			startNodeOverride = `${phasePart}:active`;
		}
	}

	if (!startNodeOverride && currentMissionNode && !currentMissionNode.includes("-phase:")) {
		// Lifecycle node — check if checkpoint is out of sync with currentNode.
		// This happens after performAdvance updates currentNode but the mission-level
		// checkpoint still points at the previous node (e.g. after execute:active →
		// pre-pr:active advance, checkpoint still says execute:active).
		const latestCkpt = missionStore.checkpoints.getLatestCheckpoint(mission.id);
		if (latestCkpt && latestCkpt.nodeId !== currentMissionNode) {
			startNodeOverride = currentMissionNode;
		}
	}

	const engine = engineFactory(mission, engineDeps, {
		...(startNodeOverride ? { startNodeId: startNodeOverride } : {}),
		graph: tickGraph,
		handlers: tickHandlers,
	});

	// Execute one step
	const result = await engine.step();

	if (result.status === "gate") {
		// Re-read mission to get latest currentNode (engine.step may have updated it)
		const freshMission = missionStore.getById(mission.id) ?? latestMission;
		const currentNodeId = freshMission?.currentNode ?? engine.currentNodeId();

		// If we fell back to engine.currentNodeId(), it's the parent lifecycle node
		// (e.g., "understand:active"), not the subgraph node. Gate evaluation won't
		// match any subgraph gate — skip this tick rather than evaluate wrong node.
		if (!freshMission?.currentNode && currentNodeId === engine.currentNodeId()) {
			return;
		}

		// Emit diagnostic event when a non-replay-safe handler left a pending marker.
		// Routing to dispatch_failed happens in engine.step(); this event is for observability.
		const checkpointKey = currentNodeId.includes("-phase:")
			? `${currentNodeId.split("-phase:")[0] ?? ""}:active:${mission.id}`
			: mission.id;
		const pendingStatusRow = missionStore.checkpoints.getCheckpointStatus(
			checkpointKey,
			currentNodeId,
		);
		if (
			pendingStatusRow?.status === "pending" &&
			pendingStatusRow.pendingHandler &&
			!REPLAY_SAFE_HANDLERS.has(pendingStatusRow.pendingHandler)
		) {
			opts.eventStore?.insert({
				runId: mission.runId,
				agentName: "engine",
				sessionId: null,
				eventType: "engine_pending_unsafe_replay",
				toolName: null,
				toolArgs: null,
				toolDurationMs: null,
				level: "warn",
				data: JSON.stringify({
					missionId: mission.id,
					nodeId: currentNodeId,
					handlerName: pendingStatusRow.pendingHandler,
				}),
			});
		}

		const nodeName = currentNodeId.split(":")[1] ?? "";

		// Look up the current graph node to read per-node timeout overrides
		const currentGraphNode = findGraphNode(currentNodeId, tickGraph, mission);
		const nodeGateTimeoutMs =
			currentGraphNode?.gateTimeout !== undefined ? currentGraphNode.gateTimeout * 1000 : undefined;

		// Ensure gate state row exists (uses missionStore's DB connection)
		// gateTimeout on the node takes priority over config and hardcoded dictionaries
		const gateState = missionStore.ensureGateState(
			mission.id,
			currentNodeId,
			getGraceMs(nodeName, opts.config),
			nodeGateTimeoutMs ?? getMaxTotalWaitMs(nodeName, opts.config),
		);

		const now = Date.now();
		const enteredAt = new Date(gateState.entered_at).getTime();
		const elapsed = now - enteredAt;

		// Evaluate gate FIRST — if already met, advance regardless of elapsed time.
		// This prevents stale gate states from triggering spurious suspensions when
		// the gate condition was actually satisfied before the ceiling expired.
		const artifactRoot = mission.artifactRoot ?? join(opts.overstoryDir, "missions", mission.id);
		// Use resolved_at as the filter baseline when re-entering a node (loop-back).
		// On first entry resolved_at is null, so entered_at is used.
		// On loop-back, INSERT OR IGNORE keeps the original entered_at but resolved_at
		// reflects when the gate last fired — filtering from that point avoids
		// re-triggering on already-processed mail.
		const gateFilterTime = gateState.resolved_at ?? gateState.entered_at;
		const earlyEval = await evaluateGate(
			currentNodeId,
			freshMission ?? mission,
			{
				mailStore: opts.mailStore,
				sessionStore: opts.sessionStore,
				missionStore,
			},
			artifactRoot,
			gateFilterTime,
			opts.projectRoot,
			opts.config.pr,
		);
		if (earlyEval.met && earlyEval.trigger) {
			const advanceEdge = findSubgraphEdge(tickGraph, currentNodeId, earlyEval.trigger);
			if (advanceEdge) {
				const phaseName = currentNodeId.split("-phase:")[0] ?? "";
				const parentNodeId = `${phaseName}:active`;
				const subgraphCheckpointKey = `${parentNodeId}:${mission.id}`;
				commitAdvance(
					missionStore,
					mission.id,
					currentNodeId,
					advanceEdge.to,
					earlyEval.trigger,
					subgraphCheckpointKey,
				);
			} else {
				missionStore.resolveGate(mission.id, currentNodeId, earlyEval.trigger);
				await engine.advanceNode(earlyEval.trigger);
			}
			if (opts.eventStore) {
				opts.eventStore.insert({
					runId: mission.runId,
					agentName: "engine",
					sessionId: null,
					eventType: "engine_gate_advanced",
					toolName: null,
					toolArgs: null,
					toolDurationMs: null,
					level: "info",
					data: JSON.stringify({
						kind: "gate_advanced",
						missionId: mission.id,
						nodeId: currentNodeId,
						trigger: earlyEval.trigger,
					}),
				});
			}
			return;
		}

		// Absolute ceiling check (only fires if gate NOT met above)
		if (elapsed > gateState.max_total_wait_ms) {
			// If the node declares onTimeout, route via timeout edge instead of suspending
			const onTimeout = currentGraphNode?.onTimeout;
			if (onTimeout) {
				// Advance the subgraph to the timeout-edge target using pre-built graph.
				const timeoutEdge = findSubgraphEdge(tickGraph, currentNodeId, "timeout");
				if (timeoutEdge) {
					const phaseName = currentNodeId.split("-phase:")[0] ?? "";
					const parentNodeId = `${phaseName}:active`;
					const subgraphCheckpointKey = `${parentNodeId}:${mission.id}`;
					commitAdvance(
						missionStore,
						mission.id,
						currentNodeId,
						timeoutEdge.to,
						"timeout",
						subgraphCheckpointKey,
					);
				} else {
					// Top-level or review cell gate — use engine.advanceNode
					missionStore.resolveGate(mission.id, currentNodeId, "timeout");
					await engine.advanceNode("timeout");
				}

				if (opts.eventStore) {
					opts.eventStore.insert({
						runId: mission.runId,
						agentName: "engine",
						sessionId: null,
						eventType: "engine_gate_timeout_routed",
						toolName: null,
						toolArgs: null,
						toolDurationMs: null,
						level: "warn",
						data: JSON.stringify({
							kind: "gate_timeout_routed",
							missionId: mission.id,
							nodeId: currentNodeId,
							onTimeout,
							elapsedMs: elapsed,
						}),
					});
				}
			} else {
				// Original behavior: suspend mission
				missionStore.updateState(mission.id, "suspended");

				// Terminate descendant agents. Awaited with a 10s budget so the next
				// tick sees agents actually stopped. Spawn guard in spawn.ts prevents
				// new agents from being created while this runs.
				if (mission.runId) {
					let stopTimer: ReturnType<typeof setTimeout> | undefined;
					try {
						const { stopMissionRunDescendants } = await import("../missions/roles.ts");
						const { stopCommand } = await import("../commands/stop.ts");
						await Promise.race([
							stopMissionRunDescendants({
								overstoryDir: opts.overstoryDir,
								projectRoot: opts.projectRoot,
								runId: mission.runId,
								excludedAgentNames: new Set<string>(),
								stopAgentCommand: (name, o) => stopCommand(name, { force: o.force }),
							}),
							new Promise<never>((_, reject) => {
								stopTimer = setTimeout(
									() => reject(new Error("stop-descendants timed out after 10s")),
									10_000,
								);
							}),
						]);
					} catch (err) {
						process.stderr.write(`[mission-tick] stop-descendants: ${String(err)}\n`);
					} finally {
						if (stopTimer) clearTimeout(stopTimer);
					}
				}

				if (opts.eventStore) {
					opts.eventStore.insert({
						runId: mission.runId,
						agentName: "engine",
						sessionId: null,
						eventType: "engine_mission_suspended",
						toolName: null,
						toolArgs: null,
						toolDurationMs: null,
						level: "warn",
						data: JSON.stringify({
							kind: "max_total_wait_exceeded",
							missionId: mission.id,
							nodeId: currentNodeId,
							elapsedMs: elapsed,
						}),
					});
				}
			}
			return; // Ceiling breached — stop processing this tick
		}

		// Grace period check
		if (elapsed < gateState.grace_ms) {
			return; // Within grace, agent is working
		}

		// Reuse early-eval result — same params, no need to evaluate twice (haru-df60).
		const evalResult = earlyEval;

		if (evalResult.unknown) {
			if (opts.eventStore) {
				opts.eventStore.insert({
					runId: mission.runId,
					agentName: "engine",
					sessionId: null,
					eventType: "engine_gate_evaluator_missing",
					toolName: null,
					toolArgs: null,
					toolDurationMs: null,
					level: "warn",
					data: JSON.stringify({ nodeId: currentNodeId, nodeName }),
				});
			}
		}

		if (evalResult.met && evalResult.trigger) {
			// Gate resolved — advance
			// For subgraph gates, find the target node using pre-built graph
			const advanceEdge = findSubgraphEdge(tickGraph, currentNodeId, evalResult.trigger);
			if (advanceEdge) {
				// Subgraph checkpoints use a prefixed key: "parentNodeId:missionId".
				const phaseName = currentNodeId.split("-phase:")[0] ?? "";
				const parentNodeId = `${phaseName}:active`;
				const subgraphCheckpointKey = `${parentNodeId}:${mission.id}`;
				commitAdvance(
					missionStore,
					mission.id,
					currentNodeId,
					advanceEdge.to,
					evalResult.trigger,
					subgraphCheckpointKey,
				);
			} else {
				// Top-level gate — use engine.advanceNode
				missionStore.resolveGate(mission.id, currentNodeId, evalResult.trigger);
				await engine.advanceNode(evalResult.trigger);
			}

			if (opts.eventStore) {
				opts.eventStore.insert({
					runId: mission.runId,
					agentName: "engine",
					sessionId: null,
					eventType: "engine_gate_advanced",
					toolName: null,
					toolArgs: null,
					toolDurationMs: null,
					level: "info",
					data: JSON.stringify({
						kind: "gate_advanced",
						missionId: mission.id,
						nodeId: currentNodeId,
						trigger: evalResult.trigger,
					}),
				});
			}
		} else if (evalResult.nudgeTarget && evalResult.nudgeMessage) {
			// Not met — nudge if interval elapsed
			const lastNudge = gateState.last_nudge_at ? new Date(gateState.last_nudge_at).getTime() : 0;
			const sinceLastNudge = now - lastNudge;

			if (sinceLastNudge >= gateState.nudge_interval_ms) {
				if (gateState.nudge_count < gateState.max_nudges) {
					// Detect "alive but mute" target before sending another nudge.
					// If we've already sent ≥1 nudge AND the target session's
					// lastActivity didn't advance since the last nudge AND its tmux
					// is still alive — Claude Code is sitting at end_turn ignoring
					// keystrokes. nudgeAgent() will be useless; force-respawn via
					// the existing dead-agent recovery path. See haru-6357.
					if (gateState.nudge_count >= 1 && gateState.last_nudge_at) {
						const targetSession = opts.sessionStore
							.getAll()
							.find((s) => s.agentName === evalResult.nudgeTarget);
						if (
							targetSession &&
							new Date(targetSession.lastActivity).getTime() < lastNudge
						) {
							const tmuxSessions = await (opts._listTmuxSessions ?? listTmuxSessions)();
							const tmuxAlive = tmuxSessions.some((s) => s.name === targetSession.tmuxSession);
							if (tmuxAlive) {
								try {
									const config = await loadConfig(opts.projectRoot);
									await (opts._resumeAgent ?? resumeAgent)(
										targetSession,
										config,
										opts.projectRoot,
									);
									if (opts.eventStore) {
										opts.eventStore.insert({
											runId: mission.runId,
											agentName: "engine",
											sessionId: targetSession.id,
											eventType: "engine_agent_respawned",
											toolName: null,
											toolArgs: null,
											toolDurationMs: null,
											level: "warn",
											data: JSON.stringify({
												kind: "mute_agent_respawned",
												missionId: mission.id,
												nodeId: currentNodeId,
												agentName: targetSession.agentName,
												lastActivity: targetSession.lastActivity,
												lastNudgeAt: gateState.last_nudge_at,
												nudgeCount: gateState.nudge_count,
											}),
										});
									}
								} catch {
									// Non-fatal: respawn failure falls through to normal nudge
								}
							}
						}
					}

					missionStore.incrementNudgeCount(mission.id, currentNodeId);

					// Send actual tmux nudge to the agent
					try {
						const { nudgeAgent } = await import("../commands/nudge.ts");
						await nudgeAgent(
							opts.projectRoot,
							evalResult.nudgeTarget,
							`[ENGINE] ${evalResult.nudgeMessage}`,
							true,
						);
					} catch {
						// Non-fatal: nudge delivery failure
					}

					if (opts.eventStore) {
						opts.eventStore.insert({
							runId: mission.runId,
							agentName: "engine",
							sessionId: null,
							eventType: "engine_nudge_sent",
							toolName: null,
							toolArgs: null,
							toolDurationMs: null,
							level: "info",
							data: JSON.stringify({
								kind: "nudge_sent",
								missionId: mission.id,
								nodeId: currentNodeId,
								target: evalResult.nudgeTarget,
								message: evalResult.nudgeMessage,
								nudgeCount: gateState.nudge_count + 1,
							}),
						});
					}
				} else if (!gateState.ceiling_emitted_at) {
					// Nudge ceiling reached — one-shot escalation to coordinator.
					// Without this branch, the mission would sit silent until the 1h
					// max_total_wait_ms timeout with no operator-visible signal.
					missionStore.markCeilingEmitted(mission.id, currentNodeId);

					// Resolve the real coordinator agent name via session id, not slug.
					// Slug may be stale if the mission was renamed post-spawn.
					const coordSession = mission.coordinatorSessionId
						? (opts.sessionStore?.getById(mission.coordinatorSessionId) ?? null)
						: null;
					const coordName =
						coordSession?.agentName ??
						(mission.slug ? `coordinator-${mission.slug}` : "coordinator");

					const isArchReviewStall = evalResult.payload?.kind === "arch-review-stall";

					if (isArchReviewStall) {
						const archReviewBody = [
							`Gate "${currentNodeId}" is stalled: no architect dispatch mail was observed after ${gateState.max_nudges} nudges.`,
							"",
							"To resolve, do one of the following:",
							"(a) Check that coordinator-mission.md handler for dispatch-architect is being followed by the coordinator agent.",
							`(b) Manually dispatch the architect: ha mail send --to architect-${mission.slug ?? "<slug>"} --type dispatch --subject 'Architecture Review: post-merge reconciliation'`,
						].join("\n");

						try {
							// NOTE: mailStore.insert bypasses parseMissionFindingPayload. Other production
							// emitters (intake-phase.ts, done-phase.ts) emit mission_finding without
							// payload; this emit follows that pattern.
							opts.mailStore?.insert({
								id: "",
								from: "engine",
								to: coordName,
								subject: `Stuck: ${currentNodeId} (no architect dispatch observed)`,
								body: archReviewBody,
								type: "mission_finding",
								priority: "urgent",
								threadId: null,
							});
						} catch {
							// Non-fatal: escalation mail delivery failure
						}
					} else {
						const escalationBody = [
							`Gate "${currentNodeId}" has not progressed after ${gateState.max_nudges} nudges to "${evalResult.nudgeTarget}".`,
							"",
							`Last nudge message: ${evalResult.nudgeMessage}`,
							"",
							"The engine has stopped auto-nudging. Please intervene:",
							"- Verify the expected result mail has been sent",
							"- Check whether the target agent is stuck or confused",
							"- Advance the phase manually if the work is actually complete",
						].join("\n");

						try {
							opts.mailStore?.insert({
								id: "",
								from: "engine",
								to: coordName,
								subject: `Gate ceiling reached: ${currentNodeId}`,
								body: escalationBody,
								type: "question",
								priority: "urgent",
								threadId: null,
							});
						} catch {
							// Non-fatal: escalation mail delivery failure
						}
					}

					if (opts.eventStore) {
						opts.eventStore.insert({
							runId: mission.runId,
							agentName: "engine",
							sessionId: null,
							eventType: "engine_nudge_ceiling_reached",
							toolName: null,
							toolArgs: null,
							toolDurationMs: null,
							level: "warn",
							data: JSON.stringify({
								kind: "nudge_ceiling_reached",
								missionId: mission.id,
								nodeId: currentNodeId,
								target: evalResult.nudgeTarget,
								escalatedTo: coordName,
								nudgeCount: gateState.nudge_count,
							}),
						});
					}
				}
			}
		}
	}

	// Record gate entry events for new gates
	if (result.status === "advanced" && opts.eventStore) {
		opts.eventStore.insert({
			runId: mission.runId,
			agentName: "engine",
			sessionId: null,
			eventType: "engine_gate_entered",
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: "info",
			data: JSON.stringify({
				kind: "step_advanced",
				missionId: mission.id,
				fromNode: result.fromNodeId,
				toNode: result.toNodeId,
				trigger: result.trigger,
			}),
		});
	}

	// Stage C bug fix: engine auto-completes missions on terminal node reach.
	// Pre-Stage-C, engine reached `done-phase:complete` but mission stayed
	// state="active" until operator manually ran `ha mission complete` — `completeMission()`
	// was only called from `lifecycle-terminate.ts:291`. Now engine path finalizes itself.
	//
	// Guard: only fire when state is active (don't re-complete already-completed missions);
	// terminal status implies phase already advanced to "done" via engine transitions.
	if (result.status === "terminal") {
		const freshMission = missionStore.getById(mission.id);
		if (freshMission && freshMission.state === "active" && freshMission.phase === "done") {
			missionStore.completeMission(mission.id);
			if (opts.eventStore) {
				opts.eventStore.insert({
					runId: mission.runId,
					agentName: "engine",
					sessionId: null,
					eventType: "engine_mission_auto_completed",
					toolName: null,
					toolArgs: null,
					toolDurationMs: null,
					level: "info",
					data: JSON.stringify({
						kind: "mission_auto_completed",
						missionId: mission.id,
						terminalNode: result.toNodeId,
					}),
				});
			}
		}
	}
}
