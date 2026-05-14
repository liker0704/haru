/**
 * Tests for watchdog doctor check.
 *
 * Uses temp directories with real filesystem operations and injected
 * deps (isProcessRunning, now, listWatchdogPids) for deterministic
 * coverage of each failure mode.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverstoryConfig } from "../types.ts";
import { buildCheckWatchdog } from "./watchdog.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createTempProject(): { root: string; overstoryDir: string } {
	const root = mkdtempSync(join(tmpdir(), "doctor-watchdog-test-"));
	const overstoryDir = join(root, ".overstory");
	mkdirSync(overstoryDir, { recursive: true });
	return { root, overstoryDir };
}

function writePidFile(overstoryDir: string, pid: number): void {
	writeFileSync(join(overstoryDir, "watchdog.pid"), String(pid));
}

function writeHeartbeat(overstoryDir: string, mtimeMs: number): void {
	const stateDir = join(overstoryDir, "state");
	mkdirSync(stateDir, { recursive: true });
	const path = join(stateDir, "watchdog.heartbeat");
	writeFileSync(path, String(mtimeMs));
	const mtimeSec = mtimeMs / 1000;
	utimesSync(path, mtimeSec, mtimeSec);
}

function makeConfig(root: string, tier0IntervalMs = 30_000): OverstoryConfig {
	return {
		project: { name: "test", root, canonicalBranch: "main" },
		agents: {
			manifestPath: ".overstory/agent-manifest.json",
			baseDir: ".overstory/agent-defs",
			maxConcurrent: 5,
			staggerDelayMs: 1000,
			maxDepth: 2,
			maxSessionsPerRun: 0,
			maxAgentsPerLead: 5,
		},
		worktrees: { baseDir: ".overstory/worktrees" },
		taskTracker: { backend: "auto", enabled: true },
		mulch: { enabled: true, domains: [], primeFormat: "markdown" },
		merge: { aiResolveEnabled: false, reimagineEnabled: false },
		providers: { anthropic: { type: "native" } },
		watchdog: {
			tier0Enabled: true,
			tier0IntervalMs,
			tier1Enabled: false,
			tier2Enabled: false,
			staleThresholdMs: 300_000,
			zombieThresholdMs: 600_000,
			nudgeIntervalMs: 60_000,
		},
		models: {},
		logging: { verbose: false, redactSecrets: true },
	} as OverstoryConfig;
}

describe("checkWatchdog", () => {
	let tempRoot: string;
	let overstoryDir: string;

	beforeEach(() => {
		const t = createTempProject();
		tempRoot = t.root;
		overstoryDir = t.overstoryDir;
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	test("fails with 'ha watch --background' hint when PID file missing", async () => {
		const check = buildCheckWatchdog({
			isProcessRunning: () => true,
			now: () => 1_000_000,
			listWatchdogPids: async () => [],
		});

		const results = await check(makeConfig(tempRoot), overstoryDir);
		const pidCheck = results.find((c) => c.name === "watchdog-pid");

		expect(pidCheck).toBeDefined();
		expect(pidCheck?.status).toBe("fail");
		expect(pidCheck?.message).toContain("not running");
		expect(pidCheck?.details?.some((d) => d.includes("ha watch --background"))).toBe(true);
		// Should bail early — no other checks
		expect(results.length).toBe(1);
	});

	test("fails with 'stale PID file' hint when pid is dead", async () => {
		writePidFile(overstoryDir, 99999);

		const check = buildCheckWatchdog({
			isProcessRunning: (pid) => pid !== 99999,
			now: () => 1_000_000,
			listWatchdogPids: async () => [],
		});

		const results = await check(makeConfig(tempRoot), overstoryDir);
		const pidCheck = results.find((c) => c.name === "watchdog-pid");

		expect(pidCheck).toBeDefined();
		expect(pidCheck?.status).toBe("fail");
		expect(pidCheck?.message).toContain("not alive");
		expect(
			pidCheck?.details?.some((d) => d.includes("Stale PID file at .overstory/watchdog.pid")),
		).toBe(true);
		expect(pidCheck?.details?.some((d) => d.includes("ha watch --background"))).toBe(true);
		// Should bail early — no other checks
		expect(results.length).toBe(1);
	});

	test("fails with 'wedged' hint when heartbeat file is missing", async () => {
		writePidFile(overstoryDir, 12345);

		const check = buildCheckWatchdog({
			isProcessRunning: () => true,
			now: () => 1_000_000,
			listWatchdogPids: async () => [12345],
		});

		const results = await check(makeConfig(tempRoot), overstoryDir);
		const hbCheck = results.find((c) => c.name === "watchdog-heartbeat");

		expect(hbCheck).toBeDefined();
		expect(hbCheck?.status).toBe("fail");
		expect(hbCheck?.message).toContain("missing");
		expect(
			hbCheck?.details?.some((d) =>
				d.includes("Watchdog appears wedged. Restart: kill 12345 && ha watch --background"),
			),
		).toBe(true);
	});

	test("fails with 'wedged' hint when heartbeat mtime is stale", async () => {
		writePidFile(overstoryDir, 12345);
		const tier0IntervalMs = 30_000;
		const now = 1_000_000;
		// Heartbeat is 3 × interval old — well past 2 × threshold
		writeHeartbeat(overstoryDir, now - 3 * tier0IntervalMs);

		const check = buildCheckWatchdog({
			isProcessRunning: () => true,
			now: () => now,
			listWatchdogPids: async () => [12345],
		});

		const results = await check(makeConfig(tempRoot, tier0IntervalMs), overstoryDir);
		const hbCheck = results.find((c) => c.name === "watchdog-heartbeat");

		expect(hbCheck).toBeDefined();
		expect(hbCheck?.status).toBe("fail");
		expect(hbCheck?.message).toContain("stale");
		expect(
			hbCheck?.details?.some((d) =>
				d.includes("Watchdog appears wedged. Restart: kill 12345 && ha watch --background"),
			),
		).toBe(true);
	});

	test("passes heartbeat check when mtime is within 2 × tier0IntervalMs", async () => {
		writePidFile(overstoryDir, 12345);
		const tier0IntervalMs = 30_000;
		const now = 1_000_000;
		// Fresh — 1 × interval old, well within 2 × threshold
		writeHeartbeat(overstoryDir, now - tier0IntervalMs);

		const check = buildCheckWatchdog({
			isProcessRunning: () => true,
			now: () => now,
			listWatchdogPids: async () => [12345],
		});

		const results = await check(makeConfig(tempRoot, tier0IntervalMs), overstoryDir);
		const hbCheck = results.find((c) => c.name === "watchdog-heartbeat");

		expect(hbCheck).toBeDefined();
		expect(hbCheck?.status).toBe("pass");
	});

	test("fails when multiple watchdog processes are detected", async () => {
		writePidFile(overstoryDir, 12345);
		const tier0IntervalMs = 30_000;
		const now = 1_000_000;
		writeHeartbeat(overstoryDir, now);

		const check = buildCheckWatchdog({
			isProcessRunning: () => true,
			now: () => now,
			listWatchdogPids: async () => [12345, 12346, 12347],
		});

		const results = await check(makeConfig(tempRoot, tier0IntervalMs), overstoryDir);
		const singletonCheck = results.find((c) => c.name === "watchdog-singleton");

		expect(singletonCheck).toBeDefined();
		expect(singletonCheck?.status).toBe("fail");
		expect(singletonCheck?.message).toContain("Multiple watchdog processes");
		expect(
			singletonCheck?.details?.some((d) =>
				d.includes("Multiple watchdog processes detected: 12345, 12346, 12347"),
			),
		).toBe(true);
		expect(singletonCheck?.details?.some((d) => d.includes("Kill duplicates"))).toBe(true);
	});

	test("passes singleton check with exactly one process", async () => {
		writePidFile(overstoryDir, 12345);
		const tier0IntervalMs = 30_000;
		const now = 1_000_000;
		writeHeartbeat(overstoryDir, now);

		const check = buildCheckWatchdog({
			isProcessRunning: () => true,
			now: () => now,
			listWatchdogPids: async () => [12345],
		});

		const results = await check(makeConfig(tempRoot, tier0IntervalMs), overstoryDir);
		const singletonCheck = results.find((c) => c.name === "watchdog-singleton");

		expect(singletonCheck).toBeDefined();
		expect(singletonCheck?.status).toBe("pass");
	});

	test("passes all three checks when watchdog is fully healthy", async () => {
		writePidFile(overstoryDir, 12345);
		const tier0IntervalMs = 30_000;
		const now = 1_000_000;
		writeHeartbeat(overstoryDir, now);

		const check = buildCheckWatchdog({
			isProcessRunning: () => true,
			now: () => now,
			listWatchdogPids: async () => [12345],
		});

		const results = await check(makeConfig(tempRoot, tier0IntervalMs), overstoryDir);
		expect(results.length).toBe(3);
		expect(results.every((c) => c.status === "pass")).toBe(true);
	});

	test("emits watchdog category for every check", async () => {
		writePidFile(overstoryDir, 12345);
		const tier0IntervalMs = 30_000;
		const now = 1_000_000;
		writeHeartbeat(overstoryDir, now);

		const check = buildCheckWatchdog({
			isProcessRunning: () => true,
			now: () => now,
			listWatchdogPids: async () => [12345],
		});

		const results = await check(makeConfig(tempRoot, tier0IntervalMs), overstoryDir);
		expect(results.every((c) => c.category === "watchdog")).toBe(true);
	});
});
