/**
 * Pre-PR phase subgraph cell — Stage D-½ (narrow #346).
 *
 * Runs AFTER execute-phase and BEFORE pr-phase for planned/full tiers (or BEFORE
 * done for direct tier). Assembles the Merge Readiness Pack (MRP) from mission
 * artifacts and quality gate results, then advances the lifecycle to the next phase.
 *
 * Subgraph nodes:
 *   finalize    (handler) → finalize_done | finalize_failed
 *   check-gates (handler) → gates_pass | gates_skip | gates_fail
 *   write-mrp   (handler) → mrp_written | mrp_write_failed
 *   complete    (terminal)
 *   escalate    (handler) → escalated
 *   paused      (terminal)
 *
 * NOTE: escalate → paused is INFORMATIONAL only. Subgraph-terminal completion bubbles
 * status=completed to the parent lifecycle, which auto-advances to the next phase. The
 * `escalate` handler emits a `mission_finding` mail so the operator knows something went
 * wrong; it does NOT prevent phase advancement. Hard-halt semantics are out of scope for
 * this narrow v1 and will be revisited when the debug loop is wired in.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderMrpMarkdown } from "../../merge/mrp-renderer.ts";
import type { MissionGraph } from "../../types.ts";
import type { HandlerRegistry } from "../types.ts";
import type { PhaseCellConfig, PhaseCellDefinition, PhaseCellDeps } from "./types.ts";

const CELL_TYPE = "pre-pr-phase";

function buildSubgraph(_config: PhaseCellConfig): MissionGraph {
	return {
		version: 1,
		nodes: [
			{
				kind: "cell",
				id: `${CELL_TYPE}:finalize`,
				cellType: CELL_TYPE,
				handler: "finalize",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:check-gates`,
				cellType: CELL_TYPE,
				handler: "check-gates",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:write-mrp`,
				cellType: CELL_TYPE,
				handler: "write-mrp",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:complete`,
				cellType: CELL_TYPE,
				terminal: true,
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:escalate`,
				cellType: CELL_TYPE,
				handler: "escalate",
			},
			{
				kind: "cell",
				id: `${CELL_TYPE}:paused`,
				cellType: CELL_TYPE,
				terminal: true,
			},
		],
		edges: [
			{
				from: `${CELL_TYPE}:finalize`,
				to: `${CELL_TYPE}:check-gates`,
				trigger: "finalize_done",
			},
			{
				from: `${CELL_TYPE}:finalize`,
				to: `${CELL_TYPE}:escalate`,
				trigger: "finalize_failed",
			},
			{
				from: `${CELL_TYPE}:check-gates`,
				to: `${CELL_TYPE}:write-mrp`,
				trigger: "gates_pass",
			},
			{
				from: `${CELL_TYPE}:check-gates`,
				to: `${CELL_TYPE}:write-mrp`,
				trigger: "gates_skip",
			},
			{
				from: `${CELL_TYPE}:check-gates`,
				to: `${CELL_TYPE}:escalate`,
				trigger: "gates_fail",
			},
			{
				from: `${CELL_TYPE}:write-mrp`,
				to: `${CELL_TYPE}:complete`,
				trigger: "mrp_written",
			},
			{
				from: `${CELL_TYPE}:write-mrp`,
				to: `${CELL_TYPE}:escalate`,
				trigger: "mrp_write_failed",
			},
			{
				from: `${CELL_TYPE}:escalate`,
				to: `${CELL_TYPE}:paused`,
				trigger: "escalated",
			},
		],
	};
}

interface PrePrCheckpoint {
	mrpFailureReason?: string;
	failedAt?: string;
}

function buildHandlers(deps: PhaseCellDeps): HandlerRegistry {
	return {
		finalize: async (_ctx) => {
			// v1: no-op. Real holdout integration lands in follow-up mission. The MRP
			// assembler treats missing results/quality-gates.json and results/test-report.json
			// as "skip" / zero — matching the v1 intent without producing misleading on-disk
			// artifacts.
			return { trigger: "finalize_done" };
		},

		"check-gates": async (ctx) => {
			const mission = ctx.getMission();
			if (!mission) return { trigger: "gates_skip" };

			// Direct tier always skips gate check — no holdout infrastructure by design.
			if (mission.tier === "direct") {
				return { trigger: "gates_skip" };
			}

			// Planned/full: read quality-gates.json produced by the holdout runner.
			const gatesPath = join(mission.artifactRoot ?? "", "results", "quality-gates.json");
			if (!existsSync(gatesPath)) {
				return { trigger: "gates_skip" };
			}

			try {
				const raw = readFileSync(gatesPath, "utf-8");
				const gates = JSON.parse(raw) as {
					bun_test?: string;
					biome?: string;
					tsc?: string;
				};
				const values = [gates.bun_test, gates.biome, gates.tsc];

				if (values.some((v) => v === "fail")) {
					return { trigger: "gates_fail" };
				}
				if (!values.every((v) => v === "pass")) {
					return { trigger: "gates_skip" };
				}
				return { trigger: "gates_pass" };
			} catch {
				return { trigger: "gates_skip" };
			}
		},

		"write-mrp": async (ctx) => {
			const mission = ctx.getMission();
			if (!mission) return { trigger: "mrp_write_failed" };

			if (!mission.featureBranch) {
				// Direct tier: legitimate skip (no branch by design for ad-hoc work).
				// Planned/full: a real defect — execute-phase should have set featureBranch.
				if (mission.tier === "direct") {
					return { trigger: "mrp_written" };
				}
				await ctx.saveCheckpoint({
					mrpFailureReason: "write-mrp: missing featureBranch on non-direct mission",
					failedAt: new Date().toISOString(),
				});
				return { trigger: "mrp_write_failed" };
			}

			if (!deps.assembleMrp) {
				// DI not wired — tier-aware to surface production wiring bugs while staying
				// friendly to test-stub deps. (da-risk-03b)
				if (mission.tier === "direct") {
					return { trigger: "mrp_written" };
				}
				await ctx.saveCheckpoint({
					mrpFailureReason: "DI: assembleMrp not provided",
					failedAt: new Date().toISOString(),
				});
				return { trigger: "mrp_write_failed" };
			}

			try {
				const mrp = await deps.assembleMrp(mission.id);
				// Sanity-render to surface render bugs early; do NOT write the markdown.
				renderMrpMarkdown(mrp);
				await Bun.write(
					join(mission.artifactRoot ?? "", "merge-readiness-pack.json"),
					JSON.stringify(mrp, null, 2),
				);
				return { trigger: "mrp_written" };
			} catch (err) {
				await ctx.saveCheckpoint({
					mrpFailureReason: err instanceof Error ? err.message : String(err),
					failedAt: new Date().toISOString(),
				});
				return { trigger: "mrp_write_failed" };
			}
		},

		escalate: async (ctx) => {
			const mission = ctx.getMission();
			if (!mission) return { trigger: "escalated" };
			const checkpoint = (ctx.checkpoint ?? {}) as PrePrCheckpoint;
			try {
				await ctx.sendMail(
					"operator",
					`Pre-PR phase issue: ${mission.slug ?? mission.id}`,
					`Pre-PR phase encountered an issue. Reason: ${checkpoint.mrpFailureReason ?? "(unknown)"}. ` +
						`Mission will continue advancing to the next phase (escalate → paused is informational).`,
					"mission_finding",
				);
			} catch {
				// Best-effort — never block the trigger on mail failure.
			}
			return { trigger: "escalated" };
		},
	};
}

export const prePrPhaseCell: PhaseCellDefinition = {
	cellType: CELL_TYPE,
	buildSubgraph,
	buildHandlers,
};
