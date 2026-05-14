/**
 * CLI command: haru watch [--interval <ms>] [--background]
 *
 * Starts the Tier 0 mechanical watchdog daemon. Foreground mode shows real-time status.
 * Background mode spawns a detached process via Bun.spawn and writes a PID file.
 * Interval configurable, default 30000ms.
 */

import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { detectHaruDir, loadConfig } from "../config.ts";
import { OverstoryError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { printError, printHint, printSuccess } from "../logging/color.ts";
import { isProcessRunning } from "../process/util.ts";
import type { HealthCheck } from "../types.ts";
import { startDaemon } from "../watchdog/daemon.ts";

/**
 * Format a health check for display.
 */
function formatCheck(check: HealthCheck): string {
	const actionIcon =
		check.action === "terminate"
			? "x"
			: check.action === "escalate"
				? "!"
				: check.action === "investigate"
					? ">"
					: "x";
	const pidLabel = check.pidAlive === null ? "n/a" : check.pidAlive ? "up" : "down";
	let line = `${actionIcon} ${check.agentName}: ${check.state} (tmux=${check.tmuxAlive ? "up" : "down"}, pid=${pidLabel})`;
	if (check.reconciliationNote) {
		line += ` [${check.reconciliationNote}]`;
	}
	return line;
}

// isProcessRunning is imported from ../process/util.ts (shared process utility)

/**
 * Read the PID from the watchdog PID file.
 * Returns null if the file doesn't exist or can't be parsed.
 */
async function readPidFile(pidFilePath: string): Promise<number | null> {
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
async function removePidFile(pidFilePath: string): Promise<void> {
	const { unlink } = await import("node:fs/promises");
	try {
		await unlink(pidFilePath);
	} catch {
		// File may already be gone — not an error
	}
}

/**
 * Daemon self-claim of the PID file using O_CREAT | O_EXCL atomicity.
 * On success: PID file is owned by this process and heartbeat is written.
 * On EEXIST: checks the incumbent; exits 0 if healthy, SIGKILLs if wedged.
 * If the second attempt also fails: writes to stderr and exits 1.
 */
async function claimPidFile(
	pidFilePath: string,
	heartbeatPath: string,
	stateDir: string,
	intervalMs: number,
): Promise<void> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(pidFilePath, "wx");
			writeSync(fd, String(process.pid));
			closeSync(fd);
			// Bootstrap heartbeat write (da-r2-07): close the window where an observer
			// could see "PID alive + heartbeat missing" before the first async tick.
			mkdirSync(stateDir, { recursive: true });
			writeFileSync(heartbeatPath, String(Date.now()));
			return;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			const existing = await readPidFile(pidFilePath);
			if (existing === null) {
				// File vanished between open and read — retry
				continue;
			}
			const alive = isProcessRunning(existing);
			if (!alive) {
				unlinkSync(pidFilePath);
				continue;
			}
			// Check heartbeat freshness
			const heartbeatFile = Bun.file(heartbeatPath);
			let fresh = false;
			if (await heartbeatFile.exists()) {
				const stat = await heartbeatFile.stat();
				fresh = stat.mtimeMs >= Date.now() - 2 * intervalMs;
			}
			if (fresh) {
				// Another healthy daemon owns the file — this process is redundant
				process.exit(0);
			}
			// Wedged daemon: SIGTERM + poll + SIGKILL fallback + unlink + retry
			try {
				process.kill(existing, "SIGTERM");
			} catch {}
			for (let i = 0; i < 10; i++) {
				await Bun.sleep(200);
				if (!isProcessRunning(existing)) break;
			}
			if (isProcessRunning(existing)) {
				try {
					process.kill(existing, "SIGKILL");
				} catch {}
			}
			try {
				unlinkSync(pidFilePath);
			} catch {}
		}
	}
	process.stderr.write("watchdog: failed to claim PID file after retry\n");
	process.exit(1);
}

/**
 * Resolve the path to the haru binary for re-launching.
 * Uses `which ov` first, then falls back to process.argv.
 * Exported so control.ts can reuse it without a shared helper module.
 */
export async function resolveOverstoryBin(): Promise<string> {
	// When invoked directly as the CLI entry point source file (e.g.
	// `bun run src/index.ts`), preserve the source path so the daemon child
	// also runs from the same source rather than a potentially stale installed binary.
	const scriptPath = process.argv[1];
	if (scriptPath?.endsWith("index.ts")) {
		return scriptPath;
	}

	for (const name of ["ov", "ha"]) {
		try {
			const proc = Bun.spawn(["which", name], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			if (exitCode === 0) {
				const binPath = (await new Response(proc.stdout).text()).trim();
				if (binPath.length > 0) {
					return binPath;
				}
			}
		} catch {
			// which not available or binary not on PATH — try next
		}
	}

	// Fallback: use the script that's currently running (process.argv[1])
	if (scriptPath) {
		return scriptPath;
	}

	throw new OverstoryError("Cannot resolve haru binary path for background launch", "WATCH_ERROR");
}

/**
 * Core implementation for the watch command.
 */
async function runWatch(opts: {
	interval?: string;
	background?: boolean;
	json?: boolean;
}): Promise<void> {
	const cwd = process.cwd();
	const config = await loadConfig(cwd);

	const intervalMs = opts.interval
		? Number.parseInt(opts.interval, 10)
		: config.watchdog.tier0IntervalMs;

	const staleThresholdMs = config.watchdog.staleThresholdMs;
	const zombieThresholdMs = config.watchdog.zombieThresholdMs;
	const haruDir = join(config.project.root, detectHaruDir(config.project.root));
	const stateDir = join(haruDir, "state");
	const heartbeatPath = join(stateDir, "watchdog.heartbeat");
	const pidFilePath = join(haruDir, "watchdog.pid");

	const useJson = opts.json ?? false;

	if (opts.background) {
		// Fast-fail only when a daemon is confirmed healthy (alive + fresh heartbeat).
		// No heartbeat or stale heartbeat means wedged — let claimPidFile recover it.
		// Bootstrap sync write in claimPidFile guarantees healthy daemons always have
		// a heartbeat immediately after claim, so missing heartbeat = pre-fix wedged case.
		const existingPid = await readPidFile(pidFilePath);
		if (existingPid !== null && isProcessRunning(existingPid)) {
			const heartbeatFile = Bun.file(heartbeatPath);
			let isHealthy = false;
			if (await heartbeatFile.exists()) {
				const stat = await heartbeatFile.stat();
				isHealthy = stat.mtimeMs >= Date.now() - 2 * intervalMs;
			}
			if (isHealthy) {
				if (useJson) {
					jsonOutput("watch", {
						running: true,
						pid: existingPid,
						error: "Watchdog already running",
					});
				} else {
					printError(
						`Watchdog already running (PID: ${existingPid}). Kill it first or remove ${pidFilePath}`,
					);
				}
				process.exitCode = 1;
				return;
			}
			// Alive but no/stale heartbeat (wedged): proceed — daemon self-claim will handle it
		} else if (existingPid !== null) {
			// Dead process: clean up stale PID file
			await removePidFile(pidFilePath);
		}

		// Build the args for the child process, forwarding --interval but not --background
		const childArgs: string[] = ["watch"];
		if (opts.interval) {
			childArgs.push("--interval", opts.interval);
		}

		// Resolve the haru binary path
		const overstoryBin = await resolveOverstoryBin();

		// Spawn a detached foreground daemon process
		// stderr: "inherit" so the daemon's stderr (including claim-failure messages)
		// flows to the fd opened by control.ts:start() against state/watchdog.stderr.log
		const child = Bun.spawn(["bun", "run", overstoryBin, ...childArgs], {
			cwd,
			detached: true,
			stdout: "ignore",
			stderr: "inherit",
			stdin: "ignore",
		});

		// Unref the child so the outer process can exit without waiting for it
		child.unref();

		const childPid = child.pid;
		// Daemon self-claims the PID file via O_CREAT|O_EXCL — outer no longer writes it

		if (useJson) {
			jsonOutput("watch", { pid: childPid, intervalMs, pidFile: pidFilePath });
		} else {
			printSuccess("Watchdog started in background", `PID: ${childPid}, interval: ${intervalMs}ms`);
			printHint(`PID file: ${pidFilePath}`);
		}
		return;
	}

	// Foreground mode: show real-time health checks
	if (useJson) {
		jsonOutput("watch", { pid: process.pid, intervalMs, mode: "foreground" });
	} else {
		printSuccess("Watchdog running", `interval: ${intervalMs}ms`);
		printHint("Press Ctrl+C to stop.");
	}

	// Self-claim PID file with O_CREAT|O_EXCL atomicity; writes bootstrap heartbeat
	await claimPidFile(pidFilePath, heartbeatPath, stateDir, intervalMs);

	const { stop } = startDaemon({
		root: config.project.root,
		intervalMs,
		staleThresholdMs,
		zombieThresholdMs,
		nudgeIntervalMs: config.watchdog.nudgeIntervalMs,
		tier1Enabled: config.watchdog.tier1Enabled,
		config,
		onHealthCheck(check) {
			const timestamp = new Date().toISOString().slice(11, 19);
			process.stdout.write(`[${timestamp}] ${formatCheck(check)}\n`);
		},
	});

	// Keep running until interrupted
	await new Promise<void>((resolve) => {
		process.on("SIGINT", () => {
			stop();
			// Clean up PID file on graceful shutdown
			removePidFile(pidFilePath).finally(() => {
				printSuccess("Watchdog stopped.");
				process.exitCode = 0;
				resolve();
			});
		});
	});
}

export function createWatchCommand(): Command {
	return new Command("watch")
		.description("Start Tier 0 mechanical watchdog daemon")
		.option("--interval <ms>", "Health check interval in milliseconds")
		.option("--background", "Daemonize (run in background)")
		.option("--json", "Output as JSON")
		.action(async (opts: { interval?: string; background?: boolean; json?: boolean }) => {
			await runWatch(opts);
		});
}

/**
 * Entry point for `haru watch [--interval <ms>] [--background]`.
 */
export async function watchCommand(args: string[]): Promise<void> {
	const cmd = createWatchCommand();
	cmd.exitOverride();

	try {
		await cmd.parseAsync(args, { from: "user" });
	} catch (err: unknown) {
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: string }).code;
			if (code === "commander.helpDisplayed" || code === "commander.version") {
				return;
			}
		}
		throw err;
	}
}
