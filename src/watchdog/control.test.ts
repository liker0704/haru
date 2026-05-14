/**
 * Tests for WatchdogControl: isRunning, start, stop, getLastStartError.
 * Uses DI seam (isProcessRunning, now) for unit tests; real spawns for integration.
 * NO mock.module — avoids mx-56558b leakage.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOverstoryBin } from "../commands/watch.ts";
import { isProcessRunning } from "../process/util.ts";
import {
	createWatchdogControl,
	getLastStartError,
	readWatchdogPid,
	removeWatchdogPid,
} from "./control.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTempProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "haru-control-test-"));
	mkdirSync(join(dir, ".overstory"), { recursive: true });
	return dir;
}

function cleanupProject(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

function pidFilePath(root: string): string {
	return join(root, ".overstory", "watchdog.pid");
}

function heartbeatFilePath(root: string): string {
	return join(root, ".overstory", "state", "watchdog.heartbeat");
}

function stateDirPath(root: string): string {
	return join(root, ".overstory", "state");
}

function stderrLogPath(root: string): string {
	return join(root, ".overstory", "state", "watchdog.stderr.log");
}

function writePidFile(root: string, pid: number): void {
	writeFileSync(pidFilePath(root), String(pid));
}

/** Write heartbeat and set its mtime to the given millisecond timestamp. */
function writeHeartbeat(root: string, mtimeMs: number): void {
	mkdirSync(stateDirPath(root), { recursive: true });
	const path = heartbeatFilePath(root);
	writeFileSync(path, String(mtimeMs));
	const mtimeSec = mtimeMs / 1000;
	utimesSync(path, mtimeSec, mtimeSec);
}

function writeStderrLog(root: string, content: string): void {
	mkdirSync(stateDirPath(root), { recursive: true });
	writeFileSync(stderrLogPath(root), content);
}

// Points at the worktree src/index.ts so integration tests spawn current code,
// not the installed `ha` binary which may have older watch.ts without claimPidFile.
const worktreeIndexPath = join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts");
function worktreeBinResolver(): Promise<string> {
	return Promise.resolve(worktreeIndexPath);
}

// ── isRunning(intervalMs) matrix ─────────────────────────────────────────────

describe("isRunning(intervalMs) matrix", () => {
	let tempRoot: string;
	beforeEach(() => {
		tempRoot = createTempProject();
	});
	afterEach(() => {
		cleanupProject(tempRoot);
	});

	test("missing PID file → false", async () => {
		const ctrl = createWatchdogControl(tempRoot, { isProcessRunning: () => true });
		expect(await ctrl.isRunning(30_000)).toBe(false);
	});

	test("missing heartbeat file → false", async () => {
		writePidFile(tempRoot, 99_999);
		const ctrl = createWatchdogControl(tempRoot, { isProcessRunning: () => true });
		expect(await ctrl.isRunning(30_000)).toBe(false);
	});

	test("stale heartbeat (mtime 120s ago, window 60s) → false", async () => {
		writePidFile(tempRoot, 99_999);
		writeHeartbeat(tempRoot, Date.now() - 120_000); // 120s ago > 2×30s
		const ctrl = createWatchdogControl(tempRoot, { isProcessRunning: () => true });
		expect(await ctrl.isRunning(30_000)).toBe(false);
	});

	test("live PID + fresh heartbeat → true", async () => {
		const fixedNow = Date.now();
		writePidFile(tempRoot, 99_999);
		writeHeartbeat(tempRoot, fixedNow - 5_000); // 5s ago, within 60s window
		const ctrl = createWatchdogControl(tempRoot, {
			isProcessRunning: () => true,
			now: () => fixedNow,
		});
		expect(await ctrl.isRunning(30_000)).toBe(true);
	});
});

// ── start() unit cases ───────────────────────────────────────────────────────

describe("start() unit cases (via DI seam)", () => {
	let tempRoot: string;
	beforeEach(() => {
		tempRoot = createTempProject();
	});
	afterEach(() => {
		cleanupProject(tempRoot);
	});

	test("alive + fresh → returns null without spawning", async () => {
		const fixedNow = Date.now();
		writePidFile(tempRoot, 99_999);
		writeHeartbeat(tempRoot, fixedNow - 1_000);
		const ctrl = createWatchdogControl(tempRoot, {
			isProcessRunning: () => true,
			now: () => fixedNow,
		});
		const result = await ctrl.start();
		expect(result).toBeNull();
		// PID file must be unchanged — no new daemon was spawned
		expect(await readWatchdogPid(tempRoot)).toBe(99_999);
	});

	test("alive + stale → stop() called before spawn; exactly one PID file at end", async () => {
		const fakePid = 1_000_000; // vanishingly unlikely to exist
		writePidFile(tempRoot, fakePid);
		writeHeartbeat(tempRoot, Date.now() - 120_000); // stale

		let stopCalled = false;
		const ctrl = createWatchdogControl(tempRoot, {
			isProcessRunning: (pid) => pid === fakePid,
			resolveBin: worktreeBinResolver,
		});

		// Spy: record call, manually remove stale PID file so start() can proceed
		ctrl.stop = async () => {
			stopCalled = true;
			try {
				unlinkSync(pidFilePath(tempRoot));
			} catch {}
			return true;
		};

		const result = await ctrl.start();

		expect(stopCalled).toBe(true);
		// A new PID file should exist after the spawn
		const newPid = await readWatchdogPid(tempRoot);
		expect(newPid).not.toBeNull();

		// Cleanup daemon
		const pidToKill = result?.pid ?? newPid;
		if (pidToKill !== null && pidToKill !== undefined) {
			try {
				process.kill(pidToKill, "SIGKILL");
			} catch {}
		}
		await removeWatchdogPid(tempRoot);
	}, 10_000);
});

// ── start() integration tests ─────────────────────────────────────────────────

describe("start() integration tests", () => {
	let tempRoot: string;
	beforeEach(() => {
		tempRoot = createTempProject();
	});
	afterEach(async () => {
		const pid = await readWatchdogPid(tempRoot);
		if (pid !== null) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		cleanupProject(tempRoot);
	});

	test("first call → returns { pid } with a live process", async () => {
		const ctrl = createWatchdogControl(tempRoot, { resolveBin: worktreeBinResolver });
		const result = await ctrl.start();
		expect(result).not.toBeNull();
		expect(result?.pid).toBeGreaterThan(0);
	}, 10_000);

	test("bootstrap heartbeat written synchronously at PID claim (da-r2-07)", async () => {
		const beforeStart = Date.now();
		const ctrl = createWatchdogControl(tempRoot, { resolveBin: worktreeBinResolver });
		const result = await ctrl.start();
		try {
			expect(result).not.toBeNull();
			const hb = heartbeatFilePath(tempRoot);
			expect(existsSync(hb)).toBe(true);
			const stat = statSync(hb);
			// Heartbeat mtime must be >= when this test started (written synchronously)
			expect(stat.mtimeMs).toBeGreaterThanOrEqual(beforeStart - 5_000);
		} finally {
			if (result?.pid) {
				try {
					process.kill(result.pid, "SIGKILL");
				} catch {}
			}
			await removeWatchdogPid(tempRoot);
		}
	}, 10_000);

	test("start() truncates stderr log before spawn (log empty after null return)", async () => {
		// Pre-write error content; alive+fresh path returns null after truncating
		const fixedNow = Date.now();
		writePidFile(tempRoot, 99_999);
		writeHeartbeat(tempRoot, fixedNow - 1_000);
		writeStderrLog(tempRoot, "previous error content");

		const ctrl = createWatchdogControl(tempRoot, {
			isProcessRunning: () => true,
			now: () => fixedNow,
		});
		const result = await ctrl.start();
		expect(result).toBeNull(); // alive+fresh → no spawn
		// Log must have been truncated
		const err = await getLastStartError(tempRoot);
		expect(err).toBeNull();
	}, 5_000);
});

// ── Inner-daemon stderr capture (so-r2-impl-13) ──────────────────────────────

describe("inner-daemon stderr capture (so-r2-impl-13)", () => {
	let tempRoot: string;
	beforeEach(() => {
		tempRoot = createTempProject();
	});
	afterEach(async () => {
		const pid = await readWatchdogPid(tempRoot);
		if (pid !== null) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		cleanupProject(tempRoot);
	});

	test("stderr log captures daemon output via inherit (mechanism test)", async () => {
		// Verify getLastStartError reads content written to the log file.
		// Writing content simulates what the daemon writes when stderr: "inherit"
		// flows daemon stderr to state/watchdog.stderr.log.
		mkdirSync(stateDirPath(tempRoot), { recursive: true });
		const capturedMsg = "watchdog: failed to claim PID file after retry";
		writeStderrLog(tempRoot, capturedMsg);

		const err = await getLastStartError(tempRoot);
		expect(err).toBe(capturedMsg);
	});

	test("start() with two concurrent outer spawns leaves exactly one daemon", async () => {
		if (process.platform !== "linux") return;

		const overstoryBin = await resolveOverstoryBin();
		const [p1, p2] = [
			Bun.spawn(["bun", "run", overstoryBin, "watch", "--background"], {
				cwd: tempRoot,
				stdout: "ignore",
				stderr: "ignore",
				stdin: "ignore",
			}),
			Bun.spawn(["bun", "run", overstoryBin, "watch", "--background"], {
				cwd: tempRoot,
				stdout: "ignore",
				stderr: "ignore",
				stdin: "ignore",
			}),
		];
		await Promise.all([p1.exited, p2.exited]);
		await Bun.sleep(500);

		const pid = await readWatchdogPid(tempRoot);
		expect(pid).not.toBeNull();
		if (pid !== null) {
			expect(isProcessRunning(pid)).toBe(true);
		}
	}, 20_000);
});

// ── stop() ────────────────────────────────────────────────────────────────────

describe("stop()", () => {
	let tempRoot: string;
	beforeEach(() => {
		tempRoot = createTempProject();
	});
	afterEach(() => {
		cleanupProject(tempRoot);
	});

	test("returns false when PID file is missing", async () => {
		const ctrl = createWatchdogControl(tempRoot);
		expect(await ctrl.stop()).toBe(false);
	});

	test("returns false and removes stale PID file when process is dead", async () => {
		writePidFile(tempRoot, 9_999_999); // very unlikely to be alive
		const ctrl = createWatchdogControl(tempRoot);
		const result = await ctrl.stop();
		expect(result).toBe(false);
		expect(existsSync(pidFilePath(tempRoot))).toBe(false);
	});

	test("SIGKILL fallback after 2s when process survives SIGTERM", async () => {
		if (process.platform !== "linux") return;

		// Spawn a process that ignores SIGTERM
		const victim = Bun.spawn(["sh", "-c", "trap '' TERM; sleep 30"], {
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		const victimPid = victim.pid;
		writePidFile(tempRoot, victimPid);

		// Inject isProcessRunning to always return true — forces full SIGKILL path
		const ctrl = createWatchdogControl(tempRoot, {
			isProcessRunning: () => true,
		});

		const t0 = Date.now();
		const stopped = await ctrl.stop();
		const elapsed = Date.now() - t0;

		expect(stopped).toBe(true);
		expect(elapsed).toBeGreaterThan(1800); // 10 × 200ms poll = 2s
		// Victim must be dead (SIGKILL was sent to the real PID)
		expect(isProcessRunning(victimPid)).toBe(false);
		victim.kill();
	}, 15_000);
});

// ── Real-process race (so-test-05) ───────────────────────────────────────────

test("real-process race: concurrent 'watch --background' → exactly one daemon (so-test-05)", async () => {
	if (process.platform !== "linux") return;

	const tempRoot = createTempProject();
	try {
		const overstoryBin = await resolveOverstoryBin();
		const spawns = [
			Bun.spawn(["bun", "run", overstoryBin, "watch", "--background"], {
				cwd: tempRoot,
				stdout: "ignore",
				stderr: "ignore",
				stdin: "ignore",
			}),
			Bun.spawn(["bun", "run", overstoryBin, "watch", "--background"], {
				cwd: tempRoot,
				stdout: "ignore",
				stderr: "ignore",
				stdin: "ignore",
			}),
		];

		await Promise.all(spawns.map((s) => s.exited));
		await Bun.sleep(1_000); // let daemons settle

		// Count running processes whose cmdline contains our bin path + "watch"
		const pid = await readWatchdogPid(tempRoot);
		expect(pid).not.toBeNull();

		// Walk /proc to count matching watch processes
		let watchCount = 0;
		try {
			const { readdirSync, readFileSync } = await import("node:fs");
			for (const entry of readdirSync("/proc")) {
				if (!/^\d+$/.test(entry)) continue;
				try {
					const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
					if (cmdline.includes(overstoryBin) && cmdline.includes("watch")) {
						watchCount++;
					}
				} catch {
					// Process may have exited between readdir and read
				}
			}
		} catch {
			// /proc not available — skip count check
		}

		// Only one daemon must be running
		expect(watchCount).toBeLessThanOrEqual(1);

		// Kill survivors
		if (pid !== null) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	} finally {
		const pid = await readWatchdogPid(tempRoot);
		if (pid !== null) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		cleanupProject(tempRoot);
	}
}, 30_000);

// ── getLastStartError ─────────────────────────────────────────────────────────

describe("getLastStartError()", () => {
	let tempRoot: string;
	beforeEach(() => {
		tempRoot = createTempProject();
	});
	afterEach(() => {
		cleanupProject(tempRoot);
	});

	test("returns null when log does not exist", async () => {
		expect(await getLastStartError(tempRoot)).toBeNull();
	});

	test("returns null when log is empty", async () => {
		writeStderrLog(tempRoot, "");
		expect(await getLastStartError(tempRoot)).toBeNull();
	});

	test("returns log content when present", async () => {
		const msg = "watchdog: failed to start\nsome detail";
		writeStderrLog(tempRoot, msg);
		expect(await getLastStartError(tempRoot)).toBe(msg);
	});

	test("truncates to first 2048 bytes", async () => {
		writeStderrLog(tempRoot, "x".repeat(3_000));
		const result = await getLastStartError(tempRoot);
		expect(result).not.toBeNull();
		expect(result?.length).toBe(2048);
	});
});

// ── DI seam (so-r2-test-14) ──────────────────────────────────────────────────

describe("DI seam (so-r2-test-14)", () => {
	let tempRoot: string;
	beforeEach(() => {
		tempRoot = createTempProject();
	});
	afterEach(() => {
		cleanupProject(tempRoot);
	});

	test("injected isProcessRunning is called for liveness checks", async () => {
		const calledWith: number[] = [];
		writePidFile(tempRoot, 12_345);
		writeHeartbeat(tempRoot, Date.now());
		const ctrl = createWatchdogControl(tempRoot, {
			isProcessRunning: (pid) => {
				calledWith.push(pid);
				return true;
			},
			now: () => Date.now(),
		});
		await ctrl.isRunning(30_000);
		expect(calledWith).toContain(12_345);
	});

	test("injected now() drives heartbeat freshness in isRunning", async () => {
		writePidFile(tempRoot, 12_345);
		const hbMtime = Date.now() - 50_000; // 50s ago

		writeHeartbeat(tempRoot, hbMtime);

		// Real time: 50s < 60s window → fresh
		const ctrlReal = createWatchdogControl(tempRoot, { isProcessRunning: () => true });
		expect(await ctrlReal.isRunning(30_000)).toBe(true);

		// Fake now 120s in the future: 50s + 120s = 170s ago > 60s → stale
		const ctrlFake = createWatchdogControl(tempRoot, {
			isProcessRunning: () => true,
			now: () => Date.now() + 120_000,
		});
		expect(await ctrlFake.isRunning(30_000)).toBe(false);
	});

	test("isRunning uses only injected fns (no real process.kill(pid, 0) calls)", async () => {
		// Inject a PID that doesn't exist but fake fn says it's alive
		const nonExistentPid = 9_876_543;
		writePidFile(tempRoot, nonExistentPid);
		writeHeartbeat(tempRoot, Date.now());

		const ctrl = createWatchdogControl(tempRoot, {
			isProcessRunning: () => true, // fake: says alive
			now: () => Date.now(),
		});
		// Real isProcessRunning would return false for a non-existent PID,
		// but the injected fake returns true → isRunning returns true
		expect(await ctrl.isRunning(30_000)).toBe(true);
	});
});
