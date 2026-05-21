/**
 * Tests for additional watchdog doctor checks (issue #379).
 *
 * Uses real temp dirs with injected deps (now, listTmuxSessions, readManifest)
 * for deterministic coverage of each failure mode without real tmux or manifest I/O.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverstoryConfig } from "../types.ts";
import { buildCheckWatchdogExtras } from "./watchdog-checks.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createTempProject(): { root: string; overstoryDir: string } {
	const root = mkdtempSync(join(tmpdir(), "doctor-watchdog-extras-test-"));
	const overstoryDir = join(root, ".overstory");
	mkdirSync(overstoryDir, { recursive: true });
	return { root, overstoryDir };
}

function writePidFile(overstoryDir: string, content: string): void {
	writeFileSync(join(overstoryDir, "watchdog.pid"), content);
}

function writePidFileWithMtime(overstoryDir: string, pid: number, mtimeMs: number): void {
	const path = join(overstoryDir, "watchdog.pid");
	writeFileSync(path, String(pid));
	const mtimeSec = mtimeMs / 1000;
	utimesSync(path, mtimeSec, mtimeSec);
}

function makeConfig(
	root: string,
	overrides: { tier1Enabled?: boolean; tier2Enabled?: boolean; projectName?: string } = {},
): OverstoryConfig {
	return {
		project: { name: overrides.projectName ?? "test-project", root, canonicalBranch: "main" },
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
			tier0IntervalMs: 30_000,
			tier1Enabled: overrides.tier1Enabled ?? false,
			tier2Enabled: overrides.tier2Enabled ?? false,
			staleThresholdMs: 300_000,
			zombieThresholdMs: 600_000,
			nudgeIntervalMs: 60_000,
		},
		models: {},
		logging: { verbose: false, redactSecrets: true },
	} as OverstoryConfig;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("checkWatchdogExtras", () => {
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

	// === watchdog-pid-not-corrupt ===

	describe("watchdog-pid-not-corrupt", () => {
		test("omits check when PID file is missing", async () => {
			const check = buildCheckWatchdogExtras({ now: () => Date.now() });
			const results = await check(makeConfig(tempRoot), overstoryDir);
			expect(results.find((c) => c.name === "watchdog-pid-not-corrupt")).toBeUndefined();
		});

		test("passes when PID file contains a valid positive integer", async () => {
			writePidFile(overstoryDir, "12345");
			const check = buildCheckWatchdogExtras({ now: () => Date.now() });
			const results = await check(makeConfig(tempRoot), overstoryDir);
			const found = results.find((c) => c.name === "watchdog-pid-not-corrupt");
			expect(found?.status).toBe("pass");
		});

		test("passes when PID file has trailing newline (common from shell writes)", async () => {
			writePidFile(overstoryDir, "12345\n");
			const check = buildCheckWatchdogExtras({ now: () => Date.now() });
			const results = await check(makeConfig(tempRoot), overstoryDir);
			const found = results.find((c) => c.name === "watchdog-pid-not-corrupt");
			expect(found?.status).toBe("pass");
		});

		test("fails when PID file contains non-integer text", async () => {
			writePidFile(overstoryDir, "not-a-pid");
			const check = buildCheckWatchdogExtras({ now: () => Date.now() });
			const results = await check(makeConfig(tempRoot), overstoryDir);
			const found = results.find((c) => c.name === "watchdog-pid-not-corrupt");
			expect(found?.status).toBe("fail");
			expect(found?.message).toContain("not-a-pid");
		});

		test("fails when PID file contains zero", async () => {
			writePidFile(overstoryDir, "0");
			const check = buildCheckWatchdogExtras({ now: () => Date.now() });
			const results = await check(makeConfig(tempRoot), overstoryDir);
			expect(results.find((c) => c.name === "watchdog-pid-not-corrupt")?.status).toBe("fail");
		});

		test("fails when PID file contains a negative number", async () => {
			writePidFile(overstoryDir, "-1234");
			const check = buildCheckWatchdogExtras({ now: () => Date.now() });
			const results = await check(makeConfig(tempRoot), overstoryDir);
			expect(results.find((c) => c.name === "watchdog-pid-not-corrupt")?.status).toBe("fail");
		});

		test("fails when PID file contains a float", async () => {
			writePidFile(overstoryDir, "12.5");
			const check = buildCheckWatchdogExtras({ now: () => Date.now() });
			const results = await check(makeConfig(tempRoot), overstoryDir);
			expect(results.find((c) => c.name === "watchdog-pid-not-corrupt")?.status).toBe("fail");
		});

		test("fails when PID file is empty", async () => {
			writePidFile(overstoryDir, "");
			const check = buildCheckWatchdogExtras({ now: () => Date.now() });
			const results = await check(makeConfig(tempRoot), overstoryDir);
			expect(results.find((c) => c.name === "watchdog-pid-not-corrupt")?.status).toBe("fail");
		});
	});

	// === watchdog-tier2-monitor ===

	describe("watchdog-tier2-monitor", () => {
		test("omits check when tier2Enabled is false", async () => {
			const check = buildCheckWatchdogExtras({
				now: () => Date.now(),
				listTmuxSessions: async () => [],
			});
			const results = await check(makeConfig(tempRoot, { tier2Enabled: false }), overstoryDir);
			expect(results.find((c) => c.name === "watchdog-tier2-monitor")).toBeUndefined();
		});

		test("passes when tier2Enabled and monitor session exists", async () => {
			const check = buildCheckWatchdogExtras({
				now: () => Date.now(),
				listTmuxSessions: async () => ["haru-test-project-monitor"],
			});
			const results = await check(
				makeConfig(tempRoot, { tier2Enabled: true, projectName: "test-project" }),
				overstoryDir,
			);
			const found = results.find((c) => c.name === "watchdog-tier2-monitor");
			expect(found?.status).toBe("pass");
			expect(found?.message).toContain("haru-test-project-monitor");
		});

		test("fails when tier2Enabled but no monitor session exists", async () => {
			const check = buildCheckWatchdogExtras({
				now: () => Date.now(),
				listTmuxSessions: async () => [],
			});
			const results = await check(
				makeConfig(tempRoot, { tier2Enabled: true, projectName: "test-project" }),
				overstoryDir,
			);
			const found = results.find((c) => c.name === "watchdog-tier2-monitor");
			expect(found?.status).toBe("fail");
			expect(found?.message).toContain("haru-test-project-monitor");
			expect(found?.details?.some((d) => d.includes("ha monitor start"))).toBe(true);
		});

		test("sanitizes project name dots in session name", async () => {
			const check = buildCheckWatchdogExtras({
				now: () => Date.now(),
				// Dots in project names become underscores via sanitizeTmuxName
				listTmuxSessions: async () => ["haru-my_project-monitor"],
			});
			const results = await check(
				makeConfig(tempRoot, { tier2Enabled: true, projectName: "my.project" }),
				overstoryDir,
			);
			const found = results.find((c) => c.name === "watchdog-tier2-monitor");
			expect(found?.status).toBe("pass");
		});
	});

	// === watchdog-tier1-triage ===

	describe("watchdog-tier1-triage", () => {
		test("omits check when tier1Enabled is false", async () => {
			const check = buildCheckWatchdogExtras({
				now: () => Date.now(),
				readManifest: async () => null,
			});
			const results = await check(makeConfig(tempRoot, { tier1Enabled: false }), overstoryDir);
			expect(results.find((c) => c.name === "watchdog-tier1-triage")).toBeUndefined();
		});

		test("passes when tier1Enabled and tier1-triage capability is registered", async () => {
			const check = buildCheckWatchdogExtras({
				now: () => Date.now(),
				readManifest: async () => ({
					capabilityIndex: { "tier1-triage": ["triage-agent"] },
				}),
			});
			const results = await check(makeConfig(tempRoot, { tier1Enabled: true }), overstoryDir);
			const found = results.find((c) => c.name === "watchdog-tier1-triage");
			expect(found?.status).toBe("pass");
		});

		test("fails when tier1Enabled but tier1-triage capability is absent", async () => {
			const check = buildCheckWatchdogExtras({
				now: () => Date.now(),
				readManifest: async () => ({
					capabilityIndex: { "other-capability": ["other-agent"] },
				}),
			});
			const results = await check(makeConfig(tempRoot, { tier1Enabled: true }), overstoryDir);
			const found = results.find((c) => c.name === "watchdog-tier1-triage");
			expect(found?.status).toBe("fail");
			expect(found?.message).toContain("tier1-triage");
		});

		test("fails when tier1Enabled but manifest is unreadable", async () => {
			const check = buildCheckWatchdogExtras({
				now: () => Date.now(),
				readManifest: async () => null,
			});
			const results = await check(makeConfig(tempRoot, { tier1Enabled: true }), overstoryDir);
			const found = results.find((c) => c.name === "watchdog-tier1-triage");
			expect(found?.status).toBe("fail");
		});

		test("fails when tier1Enabled and capabilityIndex entry is empty array", async () => {
			const check = buildCheckWatchdogExtras({
				now: () => Date.now(),
				readManifest: async () => ({
					capabilityIndex: { "tier1-triage": [] },
				}),
			});
			const results = await check(makeConfig(tempRoot, { tier1Enabled: true }), overstoryDir);
			const found = results.find((c) => c.name === "watchdog-tier1-triage");
			expect(found?.status).toBe("fail");
		});
	});

	// === watchdog-pid-stale ===

	describe("watchdog-pid-stale", () => {
		const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
		// Use a modern epoch so utimes has no edge cases
		const NOW = 1_700_000_000_000;

		test("omits check when PID file is missing", async () => {
			const check = buildCheckWatchdogExtras({ now: () => NOW });
			const results = await check(makeConfig(tempRoot), overstoryDir);
			expect(results.find((c) => c.name === "watchdog-pid-stale")).toBeUndefined();
		});

		test("passes when PID file mtime is within 24h", async () => {
			// 1 hour old — well within threshold
			writePidFileWithMtime(overstoryDir, 12345, NOW - 3_600_000);
			const check = buildCheckWatchdogExtras({ now: () => NOW });
			const results = await check(makeConfig(tempRoot), overstoryDir);
			const found = results.find((c) => c.name === "watchdog-pid-stale");
			expect(found?.status).toBe("pass");
		});

		test("warns when PID file mtime is older than 24h", async () => {
			// 25 hours old — past threshold
			writePidFileWithMtime(overstoryDir, 12345, NOW - 25 * 3_600_000);
			const check = buildCheckWatchdogExtras({ now: () => NOW });
			const results = await check(makeConfig(tempRoot), overstoryDir);
			const found = results.find((c) => c.name === "watchdog-pid-stale");
			expect(found?.status).toBe("warn");
			expect(found?.message).toContain("stale");
		});

		test("passes at exactly the 24h boundary (threshold is exclusive)", async () => {
			writePidFileWithMtime(overstoryDir, 12345, NOW - STALE_THRESHOLD_MS);
			const check = buildCheckWatchdogExtras({ now: () => NOW });
			const results = await check(makeConfig(tempRoot), overstoryDir);
			const found = results.find((c) => c.name === "watchdog-pid-stale");
			// ageMs === threshold: condition is > not >=, so not stale
			expect(found?.status).toBe("pass");
		});
	});

	// === cross-cutting ===

	test("all emitted checks have category 'watchdog'", async () => {
		writePidFile(overstoryDir, "12345");
		const check = buildCheckWatchdogExtras({
			now: () => Date.now(),
			listTmuxSessions: async () => ["haru-test-project-monitor"],
			readManifest: async () => ({ capabilityIndex: { "tier1-triage": ["triage-agent"] } }),
		});
		const results = await check(
			makeConfig(tempRoot, { tier1Enabled: true, tier2Enabled: true }),
			overstoryDir,
		);
		expect(results.length).toBeGreaterThan(0);
		expect(results.every((c) => c.category === "watchdog")).toBe(true);
	});
});
