/**
 * Tracker factory — creates the right backend client based on configuration.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { TaskTrackerBackend } from "../types.ts";
import { createBeadsTracker } from "./beads.ts";
import { createGitHubTracker } from "./github.ts";
import { createSeedsTracker } from "./seeds.ts";
import type { TrackerBackend, TrackerClient } from "./types.ts";

/**
 * Create a tracker client for the specified backend.
 *
 * @param backend - Which backend to use ("beads" or "seeds")
 * @param cwd - Working directory for CLI commands
 */
export function createTrackerClient(backend: TrackerBackend, cwd: string): TrackerClient {
	switch (backend) {
		case "beads":
			return createBeadsTracker(cwd);
		case "seeds":
			return createSeedsTracker(cwd);
		case "github":
			return createGitHubTracker(cwd);
		default: {
			const _exhaustive: never = backend;
			throw new Error(`Unknown tracker backend: ${_exhaustive}`);
		}
	}
}

/**
 * Resolve "auto" to a concrete backend by probing the filesystem.
 * Explicit "beads"/"seeds"/"github" values pass through unchanged.
 *
 * Resolution order for "auto": .suji/ → .seeds/ → .beads/ → github remote → "seeds" fallback.
 * Both .suji/ and .seeds/ map to the "seeds" backend (on-disk format unchanged across rename).
 *
 * Optional DI seams (#410): callers in tests can inject deterministic predicates;
 * production callers omit them and get the filesystem-probe defaults. Replaces
 * the duplicate implementation that previously lived in engine-wiring.ts.
 */
export async function resolveBackend(
	configBackend: TaskTrackerBackend,
	cwd: string,
	deps?: {
		hasSujiDir?: (root: string) => boolean | Promise<boolean>;
		hasSeedsDir?: (root: string) => boolean | Promise<boolean>;
		hasBeadsDir?: (root: string) => boolean | Promise<boolean>;
		hasGithubRemote?: (root: string) => boolean | Promise<boolean>;
	},
): Promise<TrackerBackend> {
	if (configBackend === "beads") return "beads";
	if (configBackend === "seeds") return "seeds";
	if (configBackend === "github") return "github";

	const dirExists = async (path: string): Promise<boolean> => {
		try {
			const s = await stat(path);
			return s.isDirectory();
		} catch {
			return false;
		}
	};
	const hasSuji = deps?.hasSujiDir ?? ((root) => dirExists(join(root, ".suji")));
	const hasSeeds = deps?.hasSeedsDir ?? ((root) => dirExists(join(root, ".seeds")));
	const hasBeads = deps?.hasBeadsDir ?? ((root) => dirExists(join(root, ".beads")));
	const hasGithub =
		deps?.hasGithubRemote ??
		(async (root) => {
			try {
				const proc = Bun.spawn(["git", "remote", "get-url", "origin"], {
					cwd: root,
					stdout: "pipe",
					stderr: "pipe",
				});
				const exitCode = await proc.exited;
				if (exitCode !== 0) return false;
				const url = await new Response(proc.stdout).text();
				return url.trim().includes("github.com");
			} catch {
				return false;
			}
		});

	if (await hasSuji(cwd)) return "seeds";
	if (await hasSeeds(cwd)) return "seeds";
	if (await hasBeads(cwd)) return "beads";
	if (await hasGithub(cwd)) return "github";
	return "seeds";
}

/**
 * Return the CLI tool name for a resolved backend.
 */
export function trackerCliName(backend: TrackerBackend): string {
	if (backend === "github") return "gh";
	return backend === "seeds" ? "su" : "bd";
}

// Re-export types for convenience
export type { TrackerBackend, TrackerClient, TrackerIssue } from "./types.ts";
