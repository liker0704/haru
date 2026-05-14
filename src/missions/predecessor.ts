/**
 * Predecessor mission synthesis and continue-from wiring.
 *
 * synthesizePredecessorSummary — produce a deterministic markdown brief
 * that packages the old mission's intent, shipped work, reviewer feedback,
 * and new operator intent into a single document.
 *
 * applyContinueFrom — atomic DB transition that marks the old mission
 * superseded, links the new mission as its successor, writes the brief,
 * and optionally closes the prior PR.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { OverstoryError } from "../errors.ts";
import type { MissionStore } from "../types.ts";

export interface PredecessorInput {
	oldMissionId: string;
	oldArtifactRoot: string;
	newIntent: string;
	triggeringComment?: { author: string; body: string; timestamp: string };
}

export interface ApplyContinueFromDeps {
	missionStore: MissionStore;
	runGh?: (...args: string[]) => Promise<{ stdout: string; exitCode: number }>;
	config?: { pr?: { autoCloseSuperseded?: boolean } };
	readFile?: (path: string) => Promise<string>;
	writeFile?: (path: string, content: string) => Promise<void>;
}

const BODY_CAP = 4096;

export async function synthesizePredecessorSummary(
	input: PredecessorInput,
	deps: { readFile: (p: string) => Promise<string>; missionStore?: MissionStore },
): Promise<string> {
	const { oldMissionId, oldArtifactRoot, newIntent, triggeringComment } = input;

	let originalIntent: string;
	try {
		const specContent = await deps.readFile(join(oldArtifactRoot, "product-spec.md"));
		originalIntent = specContent.trim() || "Unknown — spec missing";
	} catch {
		originalIntent = "Unknown — spec missing";
	}

	let shipped: string;
	try {
		const mrpContent = await deps.readFile(join(oldArtifactRoot, "merge-readiness-pack.json"));
		shipped = mrpContent.trim() || "No MRP available";
	} catch {
		shipped = "No MRP available";
	}

	let reviewerSection: string;
	if (triggeringComment) {
		const { author, body, timestamp } = triggeringComment;
		let safeBody = body;
		let truncationMarker = "";
		if (body.length > BODY_CAP) {
			safeBody = body.slice(0, BODY_CAP);
			truncationMarker = `\n[...truncated, original was ${body.length} bytes...]`;
		}
		reviewerSection = `**${author}** — ${timestamp}\n\n\`\`\`untrusted\n${safeBody}${truncationMarker}\n\`\`\``;
	} else {
		reviewerSection = "No reviewer feedback.";
	}

	return [
		"# Predecessor",
		"",
		"## Original intent",
		originalIntent,
		"",
		"## What was shipped (from old MRP)",
		shipped,
		"",
		"## Reviewer feedback",
		reviewerSection,
		"",
		"## Operator's new intent",
		newIntent,
		"",
		"## Predecessor artifacts",
		`- old mission id: ${oldMissionId}`,
		`- artifact root: ${oldArtifactRoot}`,
	].join("\n");
}

export async function applyContinueFrom(
	oldMissionId: string,
	newMissionId: string,
	newArtifactRoot: string,
	deps: ApplyContinueFromDeps,
): Promise<void> {
	const { missionStore } = deps;
	const readFile =
		deps.readFile ??
		(async (p: string) => {
			try {
				return await Bun.file(p).text();
			} catch {
				return "";
			}
		});
	const writeFile =
		deps.writeFile ??
		(async (p: string, content: string) => {
			await Bun.write(p, content);
		});

	const old = missionStore.getById(oldMissionId);
	if (!old) {
		throw new OverstoryError(
			`Cannot continue from mission ${oldMissionId}: mission not found`,
			"MISSION_NOT_FOUND",
		);
	}

	// Idempotent replay: if already superseded and new mission already linked, no-op
	const newMission = missionStore.getById(newMissionId);
	if (old.state === "superseded" && (newMission?.parentMissionId ?? null) === oldMissionId) {
		return;
	}

	// Terminal-or-pr gate: old mission must be in a completed, superseded,
	// pr-phase, or done state to be safe to continue from.
	const isTerminalState = old.state === "completed" || old.state === "superseded";
	const isPrOrDonePhase = old.phase === "done";
	const isPrOrDoneNode =
		(old.currentNode?.startsWith("pr-phase:") || old.currentNode?.startsWith("done:")) ?? false;

	if (!isTerminalState && !isPrOrDonePhase && !isPrOrDoneNode) {
		throw new OverstoryError(
			`Cannot continue from mission ${oldMissionId}: it is in an active state ` +
				`(state=${old.state}, phase=${old.phase}, node=${old.currentNode ?? "none"}). ` +
				`Only completed, superseded, or PR-phase missions can be continued from.`,
			"MISSION_NOT_TERMINAL",
		);
	}

	// DB writes wrapped in a single transaction
	missionStore.transaction(() => {
		missionStore.setSuperseded(oldMissionId);
		missionStore.setParentMissionId(newMissionId, oldMissionId);
	});

	// Synthesize and write predecessor summary (outside transaction — I/O)
	const summary = await synthesizePredecessorSummary(
		{
			oldMissionId,
			oldArtifactRoot: old.artifactRoot ?? oldMissionId,
			newIntent: newMission?.objective ?? "Unknown",
		},
		{ readFile },
	);
	await mkdir(newArtifactRoot, { recursive: true });
	await writeFile(join(newArtifactRoot, "predecessor-summary.md"), summary);

	// PR close: only when runGh is provided AND autoCloseSuperseded is true (default true)
	if (deps.runGh) {
		const autoClose = deps.config?.pr?.autoCloseSuperseded ?? true;
		if (autoClose) {
			const prState = missionStore.getPrState(oldMissionId);
			if (prState) {
				try {
					const viewResult = await deps.runGh(
						"pr",
						"view",
						String(prState.prNumber),
						"--json",
						"state",
					);
					if (viewResult.exitCode === 0) {
						const parsed = JSON.parse(viewResult.stdout) as { state?: string };
						if (parsed.state === "OPEN") {
							const closeResult = await deps.runGh(
								"pr",
								"close",
								String(prState.prNumber),
								"--comment",
								`Superseded by mission ${newMissionId}`,
							);
							if (closeResult.exitCode !== 0) {
								process.stderr.write(
									`[applyContinueFrom] gh pr close failed for PR ${prState.prNumber}: exit ${closeResult.exitCode}\n`,
								);
							}
						}
					}
				} catch (err) {
					process.stderr.write(`[applyContinueFrom] gh pr close warning: ${String(err)}\n`);
				}
			}
		}
	}
}
