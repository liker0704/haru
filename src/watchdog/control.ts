/**
 * Watchdog process control: start, stop, and query the background watchdog daemon.
 *
 * Extracted from commands/coordinator.ts so that both `ha coordinator start`
 * and `ha mission start` (and resume) can share the same logic.
 */

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
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

// ── Lock file (haru-orphan-fix) ─────────────────────────────────────────────
//
// Without serialization, multiple in-process `start()` callers (e.g. parallel
// `ha mission stop`/`ha sling` lifecycle hooks) all read the PID file BEFORE
// any one of them spawns + writes, so all see "no daemon" / "stale heartbeat"
// and all spawn. The daemon-side `claimPidFile()` resolves the inner race for
// the PID file but only after the outer process has already exited, by which
// point N+1 outer spawns are already in flight. We serialize `start()` here
// with an advisory lock file so only one caller runs the read-then-spawn
// critical section at a time.
const LOCK_FILENAME = "watchdog.lock";
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_INTERVAL_MS = 50;
// Treat an existing lock file as stale if its owner PID is dead or unreadable.
function isLockStale(lockFilePath: string, isRunningFn: (pid: number) => boolean): boolean {
	try {
		const text = readFileSync(lockFilePath, "utf8").trim();
		const pid = Number.parseInt(text, 10);
		if (Number.isNaN(pid) || pid <= 0) return true;
		return !isRunningFn(pid);
	} catch {
		// File vanished between exists check and read — treat as stale (retry will recreate).
		return true;
	}
}

/**
 * Acquire an advisory lock by atomically creating the lock file with O_EXCL.
 * Writes the caller's PID so peers can detect a stale lock from a crashed holder.
 * Returns a release function that unlinks the lock file. On timeout, throws.
 */
async function acquireStartLock(
	lockFilePath: string,
	isRunningFn: (pid: number) => boolean,
	timeoutMs: number = LOCK_TIMEOUT_MS,
): Promise<() => void> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		try {
			const fd = openSync(lockFilePath, "wx");
			writeSync(fd, String(process.pid));
			closeSync(fd);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				try {
					unlinkSync(lockFilePath);
				} catch {
					// Already gone — fine
				}
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			// Lock held — check staleness so a crashed holder can't deadlock us.
			if (isLockStale(lockFilePath, isRunningFn)) {
				try {
					unlinkSync(lockFilePath);
				} catch {
					// Someone else beat us to it — fine, fall through to retry.
				}
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(`watchdog start lock timeout after ${timeoutMs}ms (${lockFilePath})`);
			}
			await Bun.sleep(LOCK_POLL_INTERVAL_MS);
		}
	}
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
	const lockFilePath = join(haruDir, LOCK_FILENAME);

	return {
		async start(): Promise<{ pid: number } | null> {
			// Ensure state/ exists before we try to open the stderr log
			mkdirSync(stateDir, { recursive: true });

			// Serialize the entire read-then-spawn critical section so concurrent
			// callers can't all see "no daemon" and all spawn. See acquireStartLock
			// for the race rationale (haru-orphan-fix).
			const release = await acquireStartLock(lockFilePath, isRunningFn);
			try {
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
			} finally {
				release();
			}
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
