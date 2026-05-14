/**
 * Watchdog liveness doctor check.
 *
 * Verifies that the Tier-0 watchdog daemon is healthy:
 *   1. PID file exists and the pid is alive.
 *   2. Heartbeat file at .overstory/state/watchdog.heartbeat is fresh
 *      (mtime within 2 × tier0IntervalMs of now).
 *   3. Only one watchdog process is running (no zombie duplicates).
 */

import { join } from "node:path";
import { isProcessRunning as defaultIsProcessRunning } from "../process/util.ts";
import { readWatchdogPid } from "../watchdog/control.ts";
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/** DI seam for testing. */
export interface CheckWatchdogDeps {
	isProcessRunning?: (pid: number) => boolean;
	now?: () => number;
	listWatchdogPids?: () => Promise<number[]>;
}

/**
 * Default implementation: find watchdog processes via `pgrep -f`.
 * Matches processes whose command line contains "watch --background".
 * Returns an empty list on any failure (pgrep not installed, no matches, etc).
 */
async function defaultListWatchdogPids(): Promise<number[]> {
	try {
		const proc = Bun.spawn(["pgrep", "-f", "watch --background"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		// pgrep exits 1 when no matches — that's not an error
		if (exitCode !== 0 && exitCode !== 1) return [];
		const pids: number[] = [];
		for (const line of stdout.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			const pid = Number.parseInt(trimmed, 10);
			if (!Number.isNaN(pid) && pid > 0) pids.push(pid);
		}
		return pids;
	} catch {
		return [];
	}
}

/**
 * Build the check function with optional DI seam.
 * Returns a DoctorCheckFn so we can be registered alongside other checks.
 */
export function buildCheckWatchdog(deps: CheckWatchdogDeps = {}): DoctorCheckFn {
	const isProcessRunning = deps.isProcessRunning ?? defaultIsProcessRunning;
	const now = deps.now ?? (() => Date.now());
	const listWatchdogPids = deps.listWatchdogPids ?? defaultListWatchdogPids;

	return async (config, overstoryDir): Promise<DoctorCheck[]> => {
		const checks: DoctorCheck[] = [];
		const projectRoot = config.project.root;
		const heartbeatPath = join(overstoryDir, "state", "watchdog.heartbeat");
		const intervalMs = config.watchdog.tier0IntervalMs;

		// Check 1: PID file presence and pid liveness
		const pid = await readWatchdogPid(projectRoot);
		if (pid === null) {
			checks.push({
				name: "watchdog-pid",
				category: "watchdog",
				status: "fail",
				message: "Watchdog is not running (no PID file)",
				details: ["Run: ha watch --background"],
				fixable: false,
			});
			return checks;
		}

		const alive = isProcessRunning(pid);
		if (!alive) {
			checks.push({
				name: "watchdog-pid",
				category: "watchdog",
				status: "fail",
				message: `Watchdog PID ${pid} is not alive (stale PID file)`,
				details: [
					"Stale PID file at .overstory/watchdog.pid. Remove and run: ha watch --background",
				],
				fixable: false,
			});
			return checks;
		}

		checks.push({
			name: "watchdog-pid",
			category: "watchdog",
			status: "pass",
			message: `Watchdog process alive (pid ${pid})`,
			fixable: false,
		});

		// Check 2: Heartbeat freshness
		const heartbeatFile = Bun.file(heartbeatPath);
		const heartbeatExists = await heartbeatFile.exists();
		if (!heartbeatExists) {
			checks.push({
				name: "watchdog-heartbeat",
				category: "watchdog",
				status: "fail",
				message: "Watchdog heartbeat file missing",
				details: [`Watchdog appears wedged. Restart: kill ${pid} && ha watch --background`],
				fixable: false,
			});
		} else {
			const stat = await heartbeatFile.stat();
			const ageMs = now() - stat.mtimeMs;
			const maxAgeMs = 2 * intervalMs;
			if (ageMs > maxAgeMs) {
				checks.push({
					name: "watchdog-heartbeat",
					category: "watchdog",
					status: "fail",
					message: `Watchdog heartbeat is stale (${Math.round(ageMs / 1000)}s old, max ${Math.round(maxAgeMs / 1000)}s)`,
					details: [`Watchdog appears wedged. Restart: kill ${pid} && ha watch --background`],
					fixable: false,
				});
			} else {
				checks.push({
					name: "watchdog-heartbeat",
					category: "watchdog",
					status: "pass",
					message: `Heartbeat fresh (${Math.round(ageMs / 1000)}s old)`,
					fixable: false,
				});
			}
		}

		// Check 3: Only one watchdog process running
		const allPids = await listWatchdogPids();
		if (allPids.length > 1) {
			const pidList = allPids.join(", ");
			checks.push({
				name: "watchdog-singleton",
				category: "watchdog",
				status: "fail",
				message: `Multiple watchdog processes detected (${allPids.length})`,
				details: [`Multiple watchdog processes detected: ${pidList}. Kill duplicates.`],
				fixable: false,
			});
		} else {
			checks.push({
				name: "watchdog-singleton",
				category: "watchdog",
				status: "pass",
				message: "Single watchdog process",
				fixable: false,
			});
		}

		return checks;
	};
}

/** Default exported check, used by the doctor command registry. */
export const checkWatchdog: DoctorCheckFn = buildCheckWatchdog();
