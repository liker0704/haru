/**
 * Beads tracker adapter.
 *
 * Wraps src/beads/client.ts to implement the unified TrackerClient interface.
 */

import { createBeadsClient } from "../beads/client.ts";
import { AgentError } from "../errors.ts";
import type { TrackerClient, TrackerIssue } from "./types.ts";

/**
 * Create a TrackerClient backed by the beads (bd) CLI.
 *
 * @param cwd - Working directory for bd commands
 */
export function createBeadsTracker(cwd: string): TrackerClient {
	const client = createBeadsClient(cwd);

	return {
		async ready() {
			const issues = await client.ready();
			return issues as TrackerIssue[];
		},

		async show(id) {
			const issue = await client.show(id);
			return issue as TrackerIssue;
		},

		async create(title, options) {
			return client.create(title, options);
		},

		async claim(id) {
			return client.claim(id);
		},

		async close(id, reason) {
			return client.close(id, reason);
		},

		async comment(id, body) {
			// Beads (`bd`) has no first-class comment subcommand at time of writing;
			// we invoke `bd comment <id> --body <body>` optimistically. If the
			// installed `bd` version lacks the subcommand, this throws AgentError
			// and the caller should fall back to mail / structured-close-reason.
			// See docs/architecture/agent-commenting-policy.md.
			const proc = Bun.spawn(["bd", "comment", id, "--body", body], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			if (exitCode !== 0) {
				const stderr = await new Response(proc.stderr).text();
				throw new AgentError(`bd comment ${id} failed (exit ${exitCode}): ${stderr.trim()}`);
			}
		},

		async list(options) {
			const issues = await client.list(options);
			return issues as TrackerIssue[];
		},

		async sync() {
			const proc = Bun.spawn(["bd", "sync"], { cwd, stdout: "pipe", stderr: "pipe" });
			const exitCode = await proc.exited;
			if (exitCode !== 0) {
				const stderr = await new Response(proc.stderr).text();
				throw new AgentError(`bd sync failed (exit ${exitCode}): ${stderr.trim()}`);
			}
		},
	};
}
