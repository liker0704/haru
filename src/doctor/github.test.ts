import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverstoryConfig } from "../types.ts";
import { type GhProbe, makeCheckGithub } from "./github.ts";

/** Build a minimal valid OverstoryConfig for testing. Pattern: providers.test.ts. */
function makeConfig(overrides: Partial<OverstoryConfig> = {}): OverstoryConfig {
	const tmp = tmpdir();
	return {
		project: {
			name: "test-project",
			root: tmp,
			canonicalBranch: "main",
		},
		agents: {
			manifestPath: join(tmp, ".overstory", "agent-manifest.json"),
			baseDir: join(tmp, ".overstory", "agents"),
			maxConcurrent: 5,
			staggerDelayMs: 1000,
			maxDepth: 2,
			maxSessionsPerRun: 0,
			maxAgentsPerLead: 5,
		},
		worktrees: {
			baseDir: join(tmp, ".overstory", "worktrees"),
		},
		taskTracker: {
			backend: "auto",
			enabled: false,
		},
		mulch: {
			enabled: false,
			domains: [],
			primeFormat: "markdown",
		},
		merge: {
			aiResolveEnabled: false,
			reimagineEnabled: false,
		},
		providers: {
			anthropic: { type: "native" },
		},
		watchdog: {
			tier0Enabled: false,
			tier0IntervalMs: 30000,
			tier1Enabled: false,
			tier2Enabled: false,
			staleThresholdMs: 300000,
			zombieThresholdMs: 600000,
			nudgeIntervalMs: 60000,
		},
		models: {},
		logging: {
			verbose: false,
			redactSecrets: true,
		},
		...overrides,
	};
}

/** Build a mock GhProbe with a given exit code. */
function mockProbe(exitCode: number, stdout = "", stderr = ""): GhProbe {
	return async () => ({ exitCode, stdout, stderr });
}

const HARU_DIR = join(tmpdir(), ".overstory");

describe("checkGithub", () => {
	test("T-w9-4: gh auth status exit=1 → 'GitHub auth' status='warn'", async () => {
		const check = makeCheckGithub({ runGhProbe: mockProbe(1, "", "not logged in") });
		const config = makeConfig({ pr: { enabled: false } });
		const checks = await check(config, HARU_DIR);

		const ghAuth = checks.find((c) => c.name === "GitHub auth");
		expect(ghAuth).toBeDefined();
		expect(ghAuth?.status).toBe("warn");
	});

	test("T-w9-4-pass: gh auth status exit=0 → 'GitHub auth' status='pass'", async () => {
		const check = makeCheckGithub({ runGhProbe: mockProbe(0, "Logged in to github.com") });
		const config = makeConfig({ pr: { enabled: false } });
		const checks = await check(config, HARU_DIR);

		const ghAuth = checks.find((c) => c.name === "GitHub auth");
		expect(ghAuth).toBeDefined();
		expect(ghAuth?.status).toBe("pass");
	});

	test("T-w9-5: pr.enabled=true with no operatorGithubLogin → 'PR operator login' status='fail'", async () => {
		const check = makeCheckGithub({ runGhProbe: mockProbe(0) });
		const config = makeConfig({ pr: { enabled: true } });
		const checks = await check(config, HARU_DIR);

		const operator = checks.find((c) => c.name === "PR operator login");
		expect(operator).toBeDefined();
		expect(operator?.status).toBe("fail");
	});

	test("T-w9-5-pass: pr.enabled=true with operatorGithubLogin set → 'PR operator login' status='pass'", async () => {
		const check = makeCheckGithub({ runGhProbe: mockProbe(0) });
		const config = makeConfig({ pr: { enabled: true, operatorGithubLogin: "alice" } });
		const checks = await check(config, HARU_DIR);

		const operator = checks.find((c) => c.name === "PR operator login");
		expect(operator).toBeDefined();
		expect(operator?.status).toBe("pass");
	});

	test("T-w9-6: pr.enabled=false → no 'PR operator login' check emitted", async () => {
		const check = makeCheckGithub({ runGhProbe: mockProbe(0) });
		const config = makeConfig({ pr: { enabled: false } });
		const checks = await check(config, HARU_DIR);

		// Baseline: at minimum the GitHub auth check is always emitted. Without
		// this assertion the RED-phase stub (which returns []) would pass T-w9-6
		// trivially (FALSE_GREEN).
		expect(checks.find((c) => c.name === "GitHub auth")).toBeDefined();

		const operator = checks.find((c) => c.name === "PR operator login");
		expect(operator).toBeUndefined();
	});

	test("T-w9-7: directTierIncludesPr=true with no operatorGithubLogin → 'PR direct-tier opt-in' status='fail'", async () => {
		const check = makeCheckGithub({ runGhProbe: mockProbe(0) });
		const config = makeConfig({
			pr: { enabled: false, directTierIncludesPr: true },
		});
		const checks = await check(config, HARU_DIR);

		const directTier = checks.find((c) => c.name === "PR direct-tier opt-in");
		expect(directTier).toBeDefined();
		expect(directTier?.status).toBe("fail");
	});

	test("T-w9-8: ghBudget.rpm=6000 → 'gh-budget rpm sanity' status='warn'", async () => {
		const check = makeCheckGithub({ runGhProbe: mockProbe(0) });
		const config = makeConfig({
			pr: { enabled: false, ghBudget: { rpm: 6000 } },
		});
		const checks = await check(config, HARU_DIR);

		const budget = checks.find((c) => c.name === "gh-budget rpm sanity");
		expect(budget).toBeDefined();
		expect(budget?.status).toBe("warn");
	});

	test("T-w9-8-pass: ghBudget.rpm=60 → no 'gh-budget rpm sanity' check emitted", async () => {
		const check = makeCheckGithub({ runGhProbe: mockProbe(0) });
		const config = makeConfig({
			pr: { enabled: false, ghBudget: { rpm: 60 } },
		});
		const checks = await check(config, HARU_DIR);

		// Baseline so the empty-stub doesn't trivially pass this case.
		expect(checks.find((c) => c.name === "GitHub auth")).toBeDefined();

		const budget = checks.find((c) => c.name === "gh-budget rpm sanity");
		expect(budget).toBeUndefined();
	});

	test("shape sanity: every emitted check has string name, valid status, string message", async () => {
		const check = makeCheckGithub({ runGhProbe: mockProbe(0) });
		const config = makeConfig({ pr: { enabled: true, operatorGithubLogin: "alice" } });
		const checks = await check(config, HARU_DIR);

		// Non-empty baseline so the empty-stub doesn't make this vacuously pass.
		expect(checks.length).toBeGreaterThan(0);
		for (const c of checks) {
			expect(typeof c.name).toBe("string");
			expect(c.name.length).toBeGreaterThan(0);
			expect(typeof c.category).toBe("string");
			expect(["pass", "warn", "fail"]).toContain(c.status);
			expect(typeof c.message).toBe("string");
		}
	});
});
