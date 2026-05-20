import { describe, expect, test } from "bun:test";
import { CURRENT_CONFIG_VERSION, KNOWN_FIELDS, SUPPORTED_VERSIONS } from "./config-schema.ts";
import { validateUnknownFields } from "./config-validate.ts";

describe("config-schema constants", () => {
	test("CURRENT_CONFIG_VERSION is 2", () => {
		expect(CURRENT_CONFIG_VERSION).toBe(2);
	});

	test("SUPPORTED_VERSIONS includes 1 and 2", () => {
		expect(SUPPORTED_VERSIONS).toContain(1);
		expect(SUPPORTED_VERSIONS).toContain(2);
	});

	test("KNOWN_FIELDS.root includes all expected top-level sections", () => {
		const expected = [
			"version",
			"project",
			"agents",
			"worktrees",
			"taskTracker",
			"mulch",
			"merge",
			"providers",
			"watchdog",
			"models",
			"logging",
			"coordinator",
			"rateLimit",
			"runtime",
			"mission",
			"mail",
			"resilience",
			"headroom",
			"reminders",
		];
		for (const key of expected) {
			expect(KNOWN_FIELDS.root.has(key)).toBe(true);
		}
	});

	test("KNOWN_FIELDS.root does not include legacy keys", () => {
		expect(KNOWN_FIELDS.root.has("beads")).toBe(false);
		expect(KNOWN_FIELDS.root.has("seeds")).toBe(false);
		expect(KNOWN_FIELDS.root.has("supervisor")).toBe(false);
	});

	test("KNOWN_FIELDS.watchdog includes all tier keys", () => {
		expect(KNOWN_FIELDS.watchdog.has("tier0Enabled")).toBe(true);
		expect(KNOWN_FIELDS.watchdog.has("tier0IntervalMs")).toBe(true);
		expect(KNOWN_FIELDS.watchdog.has("tier1Enabled")).toBe(true);
		expect(KNOWN_FIELDS.watchdog.has("tier2Enabled")).toBe(true);
		expect(KNOWN_FIELDS.watchdog.has("staleThresholdMs")).toBe(true);
		expect(KNOWN_FIELDS.watchdog.has("zombieThresholdMs")).toBe(true);
		expect(KNOWN_FIELDS.watchdog.has("nudgeIntervalMs")).toBe(true);
	});

	test("KNOWN_FIELDS.watchdog does not include legacy tier1/tier2 alias keys", () => {
		// Old keys before the watchdog rename are not in the schema
		expect(KNOWN_FIELDS.watchdog.has("tier1IntervalMs")).toBe(false);
	});

	test("KNOWN_FIELDS.watchdog includes all 4 new configurable timeout/cap keys", () => {
		expect(KNOWN_FIELDS.watchdog.has("rpcTimeoutMs")).toBe(true);
		expect(KNOWN_FIELDS.watchdog.has("triageTimeoutMs")).toBe(true);
		expect(KNOWN_FIELDS.watchdog.has("maxEscalationLevel")).toBe(true);
		expect(KNOWN_FIELDS.watchdog.has("triageMaxConcurrent")).toBe(true);
	});

	test("KNOWN_FIELDS.providerItem covers all provider fields", () => {
		expect(KNOWN_FIELDS.providerItem.has("type")).toBe(true);
		expect(KNOWN_FIELDS.providerItem.has("baseUrl")).toBe(true);
		expect(KNOWN_FIELDS.providerItem.has("authTokenEnv")).toBe(true);
		expect(KNOWN_FIELDS.providerItem.size).toBe(3);
	});

	test("KNOWN_FIELDS.reminders includes all reminder config keys", () => {
		const expected = [
			"lookbackWindowMs",
			"completionTrendThreshold",
			"mergeConflictThreshold",
			"errorRecurrenceMinCount",
			"staleEscalationMaxAgeMs",
			"escalationResponseMinRate",
		];
		for (const key of expected) {
			expect(KNOWN_FIELDS.reminders.has(key)).toBe(true);
		}
		expect(KNOWN_FIELDS.reminders.size).toBe(6);
	});
});

// ============================================================================
// W9 — pr config block (arch §5.15, §5.16)
// ============================================================================

describe("pr config block", () => {
	const fields = KNOWN_FIELDS as unknown as Record<string, Set<string> | undefined>;

	test("T-w9-3: KNOWN_FIELDS.root contains 'pr'", () => {
		expect(KNOWN_FIELDS.root.has("pr")).toBe(true);
	});

	test("T-w9-1: KNOWN_FIELDS.prConfig has 17 keys (14 scalars + 3 nested-block names)", () => {
		const prConfig = fields.prConfig;
		expect(prConfig).toBeDefined();
		const scalars = [
			"enabled",
			"directTierIncludesPr",
			"operatorGithubLogin",
			"commentTriageAuthors",
			"ciTimeoutMs",
			"commentsTimeoutMs",
			"approvalTimeoutMs",
			"mergeStrategy",
			"showCost",
			"autoCloseSuperseded",
			"maxTriageSpawnsPerMission",
			"maxTriagePerAuthorPerHour",
			"maxCoordinatorResumesPerPr",
			"requireOperatorPermission",
		];
		const nested = ["triage", "ghBudget", "classifyCiRed"];
		for (const key of [...scalars, ...nested]) {
			expect(prConfig?.has(key)).toBe(true);
		}
		expect(prConfig?.size).toBe(17);
	});

	test("T-w9-2: validateUnknownFields rejects unknown keys under pr", () => {
		expect(() =>
			validateUnknownFields({
				pr: { enabled: true, garbageKey: "x" },
			}),
		).toThrow(/garbageKey/);
	});

	test("KNOWN_FIELDS.prTriageConfig has 'minConfidence'", () => {
		const prTriage = fields.prTriageConfig;
		expect(prTriage).toBeDefined();
		expect(prTriage?.has("minConfidence")).toBe(true);
	});

	test("KNOWN_FIELDS.prGhBudgetConfig has rpm/burst/callTimeoutMs/maxConcurrent", () => {
		const prGhBudget = fields.prGhBudgetConfig;
		expect(prGhBudget).toBeDefined();
		for (const key of ["rpm", "burst", "callTimeoutMs", "maxConcurrent"]) {
			expect(prGhBudget?.has(key)).toBe(true);
		}
	});

	test("KNOWN_FIELDS.prClassifyCiRedConfig has flakeThresholdMs/maxFlakeRetries", () => {
		const prClassify = fields.prClassifyCiRedConfig;
		expect(prClassify).toBeDefined();
		for (const key of ["flakeThresholdMs", "maxFlakeRetries"]) {
			expect(prClassify?.has(key)).toBe(true);
		}
	});
});
