/**
 * CLI command: ha tracker comment <task-id> <body>
 *
 * Thin wrapper around `TrackerClient.comment()` that lets operators and agent
 * prompts add comments/notes to tracker issues through the unified abstraction
 * (instead of hard-coding `su comment` / `gh issue comment` per backend).
 *
 * Used by lead / reviewer / debugger agents per
 * `docs/architecture/agent-commenting-policy.md`.
 */

import { Command } from "commander";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { printSuccess } from "../logging/color.ts";
import { createTrackerClient, resolveBackend } from "../tracker/factory.ts";

/**
 * Add a comment to a tracker issue via the configured backend.
 */
async function commentOnIssue(id: string, body: string, opts: { json: boolean }): Promise<void> {
	if (!id || id.trim().length === 0) {
		throw new ValidationError("Task ID is required", { field: "task-id" });
	}
	if (!body || body.trim().length === 0) {
		throw new ValidationError("Comment body is required", { field: "body" });
	}

	const config = await loadConfig(process.cwd());
	const projectRoot = config.project.root;
	const resolvedBackend = await resolveBackend(config.taskTracker.backend, projectRoot);
	const tracker = createTrackerClient(resolvedBackend, projectRoot);

	await tracker.comment(id, body);

	if (opts.json) {
		jsonOutput("tracker comment", { id, backend: resolvedBackend });
	} else {
		printSuccess("Comment added", `${id} (${resolvedBackend})`);
	}
}

/**
 * Create the Commander command for `ha tracker`.
 */
export function createTrackerCommand(): Command {
	const cmd = new Command("tracker").description(
		"Interact with the configured tracker backend (seeds/beads/github)",
	);

	cmd
		.command("comment")
		.description("Add a comment to a tracker issue (does not close it)")
		.argument("<task-id>", "Issue ID (e.g., sd-42, bd-7, or GitHub issue number)")
		.argument("<body...>", "Comment body (joined with spaces)")
		.option("--json", "Output as JSON")
		.action(async (taskId: string, bodyParts: string[], opts: { json?: boolean }) => {
			const body = bodyParts.join(" ");
			await commentOnIssue(taskId, body, { json: opts.json ?? false });
		});

	return cmd;
}
