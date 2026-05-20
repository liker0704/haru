/**
 * `ha mission override` — operator-fires a trigger on a stuck mission node.
 *
 * Bug fix #352: when a mission auto-suspends at a node like
 * `plan-phase:review-stuck` after max review rounds, operators today have no
 * documented way to push through — the graph defines `override` edges but no
 * CLI fires them, and `ha mission resume` looks for top-level lifecycle edges
 * that don't exist on subgraph nodes.
 *
 * This handler takes the user-supplied `--node` and `--trigger`, validates
 * both against the lifecycle graph, fires the trigger via the checkpoint
 * store's `saveStepResult` (atomic record + advance), and flips the mission
 * back to `active` so the watchdog tick picks it up.
 */

import { join } from "node:path";
import { jsonError, jsonOutput } from "../json.ts";
import { printError, printSuccess } from "../logging/color.ts";
import { buildLifecycleGraph } from "../missions/engine-wiring.ts";
import { createMissionStore } from "../missions/store.ts";
import type { MissionGraphEdge, MissionGraphNode } from "../types.ts";

export interface MissionOverrideOpts {
	missionId: string | undefined;
	node: string;
	trigger: string;
	json: boolean;
}

/**
 * Find the outgoing edge from `nodeId` with the given trigger, walking the
 * lifecycle graph and all attached subgraphs.
 */
function findEdge(
	nodes: readonly MissionGraphNode[],
	nodeId: string,
	trigger: string,
): MissionGraphEdge | null {
	for (const node of nodes) {
		if (node.kind === "lifecycle" && node.subgraph) {
			for (const edge of node.subgraph.edges) {
				if (edge.from === nodeId && edge.trigger === trigger) return edge;
			}
		}
	}
	// Top-level lifecycle edges are searched as a fallback (e.g. operator firing
	// `phase_advance` from a lifecycle node).
	return null;
}

export async function missionOverride(
	overstoryDir: string,
	opts: MissionOverrideOpts,
): Promise<void> {
	const dbPath = join(overstoryDir, "sessions.db");
	const missionStore = createMissionStore(dbPath);

	try {
		let missionId = opts.missionId;
		if (!missionId) {
			const active = missionStore.getActive();
			if (!active) {
				if (opts.json) jsonError("mission override", "No active mission");
				else printError("No active mission");
				process.exitCode = 1;
				return;
			}
			missionId = active.id;
		}
		const mission = missionStore.getById(missionId) ?? missionStore.getBySlug(missionId);
		if (!mission) {
			if (opts.json) jsonError("mission override", `Mission not found: ${opts.missionId}`);
			else printError(`Mission not found: ${opts.missionId}`);
			process.exitCode = 1;
			return;
		}

		if (mission.currentNode !== opts.node) {
			const msg = `Mission ${mission.slug} is at node '${mission.currentNode}', not '${opts.node}'`;
			if (opts.json) jsonError("mission override", msg);
			else printError(msg);
			process.exitCode = 1;
			return;
		}

		const graph = buildLifecycleGraph(mission);
		const edge = findEdge(graph.nodes, opts.node, opts.trigger);
		if (!edge) {
			const msg = `No edge with trigger '${opts.trigger}' from node '${opts.node}' in the lifecycle graph`;
			if (opts.json) jsonError("mission override", msg);
			else printError(msg);
			process.exitCode = 1;
			return;
		}

		// Atomically advance: record transition + update currentNode.
		missionStore.checkpoints.saveStepResult(mission.id, opts.node, edge.to, opts.trigger, null);
		missionStore.updateCurrentNode(mission.id, edge.to);
		if (mission.state === "suspended") {
			missionStore.updateState(mission.id, "active");
		}

		if (opts.json) {
			jsonOutput("mission override", {
				mission: mission.slug,
				from: opts.node,
				to: edge.to,
				trigger: opts.trigger,
				wasSuspended: mission.state === "suspended",
			});
		} else {
			printSuccess(
				"Mission overridden",
				`${mission.slug}: ${opts.node} → ${edge.to} via ${opts.trigger}` +
					(mission.state === "suspended" ? " (suspended → active)" : ""),
			);
		}
	} finally {
		missionStore.close();
	}
}
