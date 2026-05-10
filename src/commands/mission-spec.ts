/**
 * `ha mission spec <approve|reject>` — operator verdict on the materialized
 * product-spec.md during the supervised intake-phase human-spec-review gate.
 *
 * Emits `spec_approved` / `spec_rejected` mail to the synthetic recipient
 * `operator-decision-${slug}`; the watchdog gate evaluator
 * (`evaluateHumanSpecReview`) picks it up and fires the matching engine
 * trigger (`approved` or `rejected`).
 */

import { join } from "node:path";
import { Command } from "commander";
import { detectHaruDir, loadConfig } from "../config.ts";
import { jsonError, jsonOutput } from "../json.ts";
import { printError, printSuccess } from "../logging/color.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { resolveCurrentMissionId } from "../missions/lifecycle-helpers.ts";
import { createMissionStore } from "../missions/store.ts";

export function createMissionSpecCommand(): Command {
	const cmd = new Command("spec").description(
		"Operator verdict on product-spec.md during intake-phase human-spec-review gate",
	);

	cmd
		.command("approve")
		.description("Approve the materialized product-spec.md and advance to tier-classifier")
		.option("--mission <id-or-slug>", "Target a specific mission")
		.option("--json", "Output as JSON")
		.action(async (opts: { mission?: string; json?: boolean }) => {
			await emitSpecVerdict("approved", opts);
		});

	cmd
		.command("reject")
		.description("Reject the materialized spec; clarifier respins with the rejection reason")
		.option("--reason <text>", "Free-text rejection reason routed to clarifier")
		.option("--mission <id-or-slug>", "Target a specific mission")
		.option("--json", "Output as JSON")
		.action(async (opts: { reason?: string; mission?: string; json?: boolean }) => {
			if (!opts.reason || opts.reason.trim().length === 0) {
				const message = "--reason <text> is required when rejecting a spec";
				if (opts.json) {
					jsonError("mission spec reject", message);
				} else {
					printError("Spec rejection failed", message);
				}
				process.exitCode = 1;
				return;
			}
			await emitSpecVerdict("rejected", opts);
		});

	return cmd;
}

async function emitSpecVerdict(
	verdict: "approved" | "rejected",
	opts: { reason?: string; mission?: string; json?: boolean },
): Promise<void> {
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const overstoryDir = join(config.project.root, detectHaruDir(config.project.root));

	const missionStore = createMissionStore(join(overstoryDir, "sessions.db"));
	const mailStore = createMailStore(join(overstoryDir, "mail.db"));
	try {
		const missionId = opts.mission ?? (await resolveCurrentMissionId(overstoryDir));
		if (!missionId) {
			const message = "No active mission";
			if (opts.json) {
				jsonError("mission spec", message);
			} else {
				printError(message);
			}
			process.exitCode = 1;
			return;
		}
		const mission = missionStore.getById(missionId);
		if (!mission) {
			const message = `Mission ${missionId} not found`;
			if (opts.json) {
				jsonError("mission spec", message);
			} else {
				printError(message);
			}
			process.exitCode = 1;
			return;
		}
		if (mission.phase !== "intake") {
			const message = `Mission is in '${mission.phase}' phase; spec verdict only applies during intake`;
			if (opts.json) {
				jsonError("mission spec", message);
			} else {
				printError(message);
			}
			process.exitCode = 1;
			return;
		}

		const mailClient = createMailClient(mailStore);
		const mailType = verdict === "approved" ? "spec_approved" : "spec_rejected";
		const payload =
			verdict === "approved"
				? { missionId: mission.id }
				: { missionId: mission.id, reason: opts.reason ?? "" };

		const messageId = mailClient.send({
			from: "operator",
			to: `operator-decision-${mission.slug}`,
			subject: verdict === "approved" ? "Spec approved" : "Spec rejected",
			body: verdict === "approved" ? "Operator approved the spec." : (opts.reason ?? ""),
			type: mailType,
			missionId: mission.id,
			payload: JSON.stringify(payload),
		});

		if (opts.json) {
			jsonOutput("mission spec", {
				missionId: mission.id,
				slug: mission.slug,
				verdict,
				messageId,
			});
		} else {
			printSuccess(verdict === "approved" ? "Spec approved" : "Spec rejected", mission.slug);
		}
	} finally {
		mailStore.close();
		missionStore.close();
	}
}
