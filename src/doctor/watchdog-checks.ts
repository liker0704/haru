/**
 * Additional watchdog doctor checks (issue #379).
 *
 * Complements the 3 checks in watchdog.ts with:
 *   1. PID file content corruption check.
 *   2. Tier 2 monitor session presence (conditional on tier2Enabled).
 *   3. Tier 1 triage capability in agent manifest (conditional on tier1Enabled).
 *   4. PID file staleness (24h threshold).
 */

import { join } from "node:path";
import { sanitizeTmuxName } from "../worktree/tmux.ts";
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

const STALE_PID_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const TIER1_TRIAGE_CAPABILITY = "tier1-triage";
const MONITOR_NAME = "monitor";

/** DI seam for testing. */
export interface CheckWatchdogExtrasDeps {
	now?: () => number;
	listTmuxSessions?: () => Promise<string[]>;
	readManifest?: (path: string) => Promise<{ capabilityIndex: Record<string, string[]> } | null>;
}

async function defaultListTmuxSessions(): Promise<string[]> {
	try {
		const proc = Bun.spawn(["tmux", "list-sessions", "-F", "#{session_name}"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		if (exitCode !== 0) return [];
		return stdout
			.split("\n")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	} catch {
		return [];
	}
}

async function defaultReadManifest(
	path: string,
): Promise<{ capabilityIndex: Record<string, string[]> } | null> {
	try {
		const file = Bun.file(path);
		const exists = await file.exists();
		if (!exists) return null;
		const text = await file.text();
		const parsed = JSON.parse(text) as { capabilityIndex?: unknown };
		if (!parsed.capabilityIndex || typeof parsed.capabilityIndex !== "object") return null;
		return { capabilityIndex: parsed.capabilityIndex as Record<string, string[]> };
	} catch {
		return null;
	}
}

/**
 * Build the check function with optional DI seam.
 * Returns a DoctorCheckFn registered alongside checkWatchdog.
 */
export function buildCheckWatchdogExtras(deps: CheckWatchdogExtrasDeps = {}): DoctorCheckFn {
	const now = deps.now ?? (() => Date.now());
	const listTmuxSessions = deps.listTmuxSessions ?? defaultListTmuxSessions;
	const readManifest = deps.readManifest ?? defaultReadManifest;

	return async (config, overstoryDir): Promise<DoctorCheck[]> => {
		const checks: DoctorCheck[] = [];
		const pidPath = join(overstoryDir, "watchdog.pid");
		const pidFile = Bun.file(pidPath);
		const pidFileExists = await pidFile.exists();

		// Check 1: PID file content integrity — only when file is present.
		// Missing file is the existing watchdog-pid check's responsibility.
		if (pidFileExists) {
			const raw = await pidFile.text();
			const trimmed = raw.trim();
			const pid = Number(trimmed);
			const valid = trimmed.length > 0 && Number.isFinite(pid) && Number.isInteger(pid) && pid > 0;
			checks.push({
				name: "watchdog-pid-not-corrupt",
				category: "watchdog",
				status: valid ? "pass" : "fail",
				message: valid
					? "Watchdog PID file content is valid"
					: `Watchdog PID file contains invalid content: ${JSON.stringify(trimmed)}`,
				...(valid ? {} : { details: ["PID file must contain a positive integer"] }),
				fixable: false,
			});
		}

		// Check 2: Tier 2 monitor session — omit entirely when tier2 is disabled.
		if (config.watchdog.tier2Enabled) {
			const expectedSession = `haru-${sanitizeTmuxName(config.project.name)}-${MONITOR_NAME}`;
			const sessions = await listTmuxSessions();
			const found = sessions.includes(expectedSession);
			checks.push({
				name: "watchdog-tier2-monitor",
				category: "watchdog",
				status: found ? "pass" : "fail",
				message: found
					? `Tier 2 monitor session alive (${expectedSession})`
					: `Tier 2 monitor is enabled but no live session found (expected: ${expectedSession})`,
				...(found ? {} : { details: ["Run: ha monitor start"] }),
				fixable: false,
			});
		}

		// Check 3: Tier 1 triage capability in manifest — omit when tier1 is disabled.
		if (config.watchdog.tier1Enabled) {
			const manifestPath = join(config.project.root, config.agents.manifestPath);
			const manifest = await readManifest(manifestPath);
			const agents = manifest?.capabilityIndex[TIER1_TRIAGE_CAPABILITY];
			const hasTriage = Array.isArray(agents) && agents.length > 0;
			checks.push({
				name: "watchdog-tier1-triage",
				category: "watchdog",
				status: hasTriage ? "pass" : "fail",
				message: hasTriage
					? "Tier 1 triage capability registered"
					: `Tier 1 triage is enabled but no agent with capability "${TIER1_TRIAGE_CAPABILITY}" is registered`,
				...(hasTriage
					? {}
					: {
							details: [
								"Add a triage agent to agent-manifest.json with the tier1-triage capability",
							],
						}),
				fixable: false,
			});
		}

		// Check 4: PID file staleness — omit when file is absent.
		if (pidFileExists) {
			const stat = await pidFile.stat();
			const ageMs = now() - stat.mtimeMs;
			const stale = ageMs > STALE_PID_THRESHOLD_MS;
			checks.push({
				name: "watchdog-pid-stale",
				category: "watchdog",
				status: stale ? "warn" : "pass",
				message: stale
					? `Watchdog PID file is stale (${Math.round(ageMs / 3_600_000)}h old)`
					: "Watchdog PID file is recent",
				...(stale
					? {
							details: [
								"PID file has not been updated in over 24 hours. Consider restarting the watchdog.",
							],
						}
					: {}),
				fixable: false,
			});
		}

		return checks;
	};
}

/** Default exported check, registered in the doctor command registry. */
export const checkWatchdogExtras: DoctorCheckFn = buildCheckWatchdogExtras();
