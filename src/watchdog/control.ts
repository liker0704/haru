/**
 * Watchdog process control: start, stop, and query the background watchdog daemon.
 *
 * Extracted from commands/coordinator.ts so that both `ha coordinator start`
 * and `ha mission start` (and resume) can share the same logic.
 */

import { closeSync, mkdirSync, openSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { resolveOverstoryBin } from "../commands/watch.ts";
import { detectHaruDir } from "../config.ts";
import { isProcessRunning as defaultIsProcessRunning } from "../process/util.ts";

/** Minimal control surface for the watchdog daemon. */
export interface WatchdogControl {
	start(): Promise<{ pid: number } | null>;
	stop(): Promise<boolean>;
	isRunning(intervalMs?: number): Promise<boolean>;
}

/**
 * Read the PID from the watchdog PID file.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export async function readWatchdogPid(projectRoot: string): Promise<number | null> {
	const pidFilePath = join(projectRoot, detectHaruDir(projectRoot), "watchdog.pid");
	const file = Bun.file(pidFilePath);
	const exists = await file.exists();
	if (!exists) {
		return null;
	}

	try {
		const text = await file.text();
		const pid = Number.parseInt(text.trim(), 10);
		if (Number.isNaN(pid) || pid <= 0) {
			return null;
		}
		return pid;
	} catch {
		return null;
	}
}

/**
 * Remove the watchdog PID file.
 */
export async function removeWatchdogPid(projectRoot: string): Promise<void> {
	const pidFilePath = join(projectRoot, detectHaruDir(projectRoot), "watchdog.pid");
	try {
		await unlink(pidFilePath);
	} catch {
		// File may already be gone — not an error
	}
}

/**
 * Read the first 2KB of the watchdog stderr log from the most recent start attempt.
 * Returns null if the file is absent or empty.
 */
export async function getLastStartError(projectRoot: string): Promise<string | null> {
	const path = join(projectRoot, detectHaruDir(projectRoot), "state", "watchdog.stderr.log");
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	const text = (await file.text()).slice(0, 2048).trim();
	return text.length > 0 ? text : null;
}

// ── Internal helpers ────────────────────────────────────────────────────────

async function isHeartbeatFresh(
	heartbeatPath: string,
	intervalMs: number,
	now: () => number,
): Promise<boolean> {
	const file = Bun.file(heartbeatPath);
	if (!(await file.exists())) return false;
	const stat = await file.stat();
	return stat.mtimeMs >= now() - 2 * intervalMs;
}

async function truncateStderrLog(stderrLogPath: string): Promise<void> {
	try {
		await Bun.write(stderrLogPath, "");
	} catch {
		// Non-fatal: if the file can't be truncated we still attempt start
	}
}

async function pollForPid(
	projectRoot: string,
	opts: { timeoutMs: number; intervalMs: number },
): Promise<number | null> {
	const deadline = Date.now() + opts.timeoutMs;
	while (Date.now() < deadline) {
		const pid = await readWatchdogPid(projectRoot);
		if (pid !== null) return pid;
		await Bun.sleep(opts.intervalMs);
	}
	return null;
}

// ── Factory ─────────────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 30_000;

/**
 * Create a WatchdogControl instance.
 *
 * @param projectRoot - The root directory of the project.
 * @param deps - Optional DI seam for testing. Inject `isProcessRunning`, `now`,
 *   and/or `resolveBin` to drive deterministic liveness and freshness checks
 *   without spawning real processes or relying on wall-clock time. `resolveBin`
 *   overrides the binary path used for daemon spawn (useful in tests to point at
 *   the worktree source instead of the installed binary).
 */
export function createWatchdogControl(
	projectRoot: string,
	deps: {
		isProcessRunning?: (pid: number) => boolean;
		now?: () => number;
		resolveBin?: () => Promise<string>;
	} = {},
): WatchdogControl {
	const isRunningFn = deps.isProcessRunning ?? defaultIsProcessRunning;
	const nowFn = deps.now ?? (() => Date.now());
	const resolveBinFn = deps.resolveBin ?? resolveOverstoryBin;

	const haruDir = join(projectRoot, detectHaruDir(projectRoot));
	const stateDir = join(haruDir, "state");
	const heartbeatPath = join(stateDir, "watchdog.heartbeat");
	const stderrLogPath = join(stateDir, "watchdog.stderr.log");

	return {
		async start(): Promise<{ pid: number } | null> {
			// Ensure state/ exists before we try to open the stderr log
			mkdirSync(stateDir, { recursive: true });

			// Truncate the stderr log so getLastStartError() reflects only this attempt
			await truncateStderrLog(stderrLogPath);

			const existingPid = await readWatchdogPid(projectRoot);
			if (existingPid !== null) {
				if (isRunningFn(existingPid)) {
					const fresh = await isHeartbeatFresh(heartbeatPath, DEFAULT_INTERVAL_MS, nowFn);
					if (fresh) return null; // Already healthy
					// Wedged daemon: stop it before respawning
					await this.stop();
				} else {
					await removeWatchdogPid(projectRoot);
				}
			}

			const overstoryBin = await resolveBinFn();
			const stderrFd = openSync(stderrLogPath, "w");
			const proc = Bun.spawn(["bun", "run", overstoryBin, "watch", "--background"], {
				cwd: projectRoot,
				detached: true,
				stdout: "ignore",
				stderr: stderrFd,
				stdin: "ignore",
			});
			proc.unref();
			const exitCode = await proc.exited;
			closeSync(stderrFd);

			if (exitCode !== 0) return null;

			// Daemon self-claims the PID file; poll until it appears
			const pid = await pollForPid(projectRoot, { timeoutMs: 3000, intervalMs: 50 });
			return pid !== null ? { pid } : null;
		},

		async stop(): Promise<boolean> {
			const pid = await readWatchdogPid(projectRoot);
			if (pid === null) return false;
			if (!isRunningFn(pid)) {
				await removeWatchdogPid(projectRoot);
				return false;
			}
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				return false;
			}
			// Poll for graceful exit (up to 2s)
			for (let i = 0; i < 10; i++) {
				await Bun.sleep(200);
				if (!isRunningFn(pid)) break;
			}
			if (isRunningFn(pid)) {
				try {
					process.kill(pid, "SIGKILL");
					// Brief wait for the kernel to complete the kill before callers
					// check liveness (avoids a race in the test assertion window).
					await Bun.sleep(100);
				} catch {}
			}
			await removeWatchdogPid(projectRoot);
			return true;
		},

		async isRunning(intervalMs?: number): Promise<boolean> {
			const effectiveInterval = intervalMs ?? DEFAULT_INTERVAL_MS;
			const pid = await readWatchdogPid(projectRoot);
			if (pid === null) return false;
			if (!isRunningFn(pid)) return false;
			return isHeartbeatFresh(heartbeatPath, effectiveInterval, nowFn);
		},
	};
}
