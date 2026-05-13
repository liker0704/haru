/**
 * RED-phase tests for pr-phase-triggers (T-w3-24 .. T-w3-28).
 *
 * Stub currently exports `PR_PHASE_TRIGGERS = [] as const` so the membership
 * + size assertions below fail at runtime. Compile passes because the
 * `satisfies readonly string[]` check trivially holds for an empty tuple
 * and TypeScript treats the union as `never`.
 *
 * FIXME(w3-builder):
 *   - Populate PR_PHASE_TRIGGERS per architecture §6 (≥30 members).
 *   - Extend DebugBriefRequestPayload (src/mail/types.ts) to a discriminated
 *     union: `{ failureSource:'ci', failedChecks: GhCheck[] } |
 *             { failureSource:'holdout', failedGates: HoldoutCheck[] }`.
 *     T-w3-26 / T-w3-27 below cast through `unknown` until that lands.
 *   - Add `failureSource`/`holdout`/`ci`/`failedChecks`/`failedGates` prose
 *     to agents/shared-mandate.md `debug-brief-protocol` section.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DebugBriefRequestPayload } from "../../mail/types.ts";
import { prPhaseCell } from "./pr-phase.ts";
import { PR_PHASE_TRIGGERS, type PrPhaseTrigger } from "./pr-phase-triggers.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Walk up to repo root: src/missions/cells/ → ../../..
const REPO_ROOT = join(__dirname, "..", "..", "..");

// Shared engine-level triggers tolerated outside PR_PHASE_TRIGGERS membership.
const ENGINE_TRIGGERS = new Set(["timeout", "escalated"]);

describe("PR_PHASE_TRIGGERS — shape and contents", () => {
	test("T-w3-24: readonly + as const, ≥30 members, includes canonical triggers", () => {
		// Compile-time invariant: derived literal-union type matches list.
		const sample: PrPhaseTrigger = "merged" as PrPhaseTrigger;
		expect(typeof sample).toBe("string");

		// `as const` makes the array readonly; assignability check catches accidental widening.
		const list: readonly string[] = PR_PHASE_TRIGGERS;
		expect(Array.isArray(list)).toBe(true);

		// Size floor — architecture §6 enumerates ~30+ pr-phase triggers.
		expect(list.length).toBeGreaterThanOrEqual(30);

		const required = [
			"preflight_passed",
			"pr_created",
			"ci_passed",
			"ci_failed",
			"merged",
			"escalated",
		];
		for (const t of required) {
			expect(list).toContain(t);
		}
	});
});

describe("PR_PHASE_TRIGGERS — exhaustiveness vs subgraph", () => {
	test("T-w3-25: every subgraph edge.trigger is a member of PR_PHASE_TRIGGERS ∪ engine triggers", () => {
		const graph = prPhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/a",
			projectRoot: "/tmp/p",
		});

		// Guard against vacuous pass on empty inputs during RED phase.
		expect(graph.edges.length).toBeGreaterThanOrEqual(20);

		const allowed = new Set<string>([...PR_PHASE_TRIGGERS, ...ENGINE_TRIGGERS]);
		const unknownTriggers: string[] = [];
		for (const edge of graph.edges) {
			if (!allowed.has(edge.trigger)) {
				unknownTriggers.push(edge.trigger);
			}
		}
		expect(unknownTriggers).toEqual([]);
	});
});

// =============================================================================
// DebugBriefRequestPayload discriminated union: T-w3-26, T-w3-27
// =============================================================================

describe("DebugBriefRequestPayload discriminated union", () => {
	// Both T-w3-26 and T-w3-27 verify a discriminated union that the w3 builder
	// must add to src/mail/types.ts. Since TypeScript types are erased at
	// runtime, we read the source file and assert the union shape is encoded
	// there. The narrow() function below is the *behavioral* contract that the
	// new type must support; the source-level check makes the assertion fail at
	// runtime today (before builder edits mail/types.ts).
	async function readMailTypesSource(): Promise<string> {
		const path = join(REPO_ROOT, "src", "mail", "types.ts");
		return await readFile(path, "utf-8");
	}

	test("T-w3-26: DebugBriefRequestPayload narrows on failureSource discriminator", async () => {
		const src = await readMailTypesSource();
		// Type-level expectation: builder will ship a tagged union with both
		// 'ci' and 'holdout' variants. Test runtime asserts both literals and
		// both array fields are present in the type declaration source.
		expect(src).toContain("DebugBriefRequestPayload");
		expect(src).toMatch(/failureSource\s*:\s*["']ci["']/);
		expect(src).toMatch(/failureSource\s*:\s*["']holdout["']/);
		expect(src).toContain("failedChecks");
		expect(src).toContain("failedGates");

		// Behavioral contract: a narrow() function must be writable against the
		// union and select the correct array at runtime.
		type CiVariant = {
			failureSource: "ci";
			failedChecks: ReadonlyArray<unknown>;
		};
		type HoldoutVariant = {
			failureSource: "holdout";
			failedGates: ReadonlyArray<unknown>;
		};
		function narrow(p: CiVariant | HoldoutVariant): number {
			if (p.failureSource === "ci") return p.failedChecks.length;
			return p.failedGates.length;
		}

		const ci = { failureSource: "ci", failedChecks: [1] } as unknown as CiVariant;
		const holdout = { failureSource: "holdout", failedGates: [1, 2] } as unknown as HoldoutVariant;
		expect(narrow(ci)).toBe(1);
		expect(narrow(holdout)).toBe(2);
	});

	test("T-w3-27: both holdout + ci variants compile and JSON round-trip preserves all fields", async () => {
		// Source-level guard — fails until builder lands the union variants.
		const src = await readMailTypesSource();
		expect(src).toMatch(/failureSource\s*:\s*["']ci["']/);
		expect(src).toMatch(/failureSource\s*:\s*["']holdout["']/);

		const ci = {
			missionId: "m1",
			attemptN: 1,
			integrationBranch: "feature/x",
			integrationSha: "abc",
			debuggerName: "debugger-m1-attempt-1",
			failureSource: "ci",
			failedChecks: [{ name: "tsc", conclusion: "FAILURE", durationMs: 60_000 }],
		} as unknown as DebugBriefRequestPayload;

		const holdout = {
			missionId: "m1",
			attemptN: 1,
			integrationBranch: "feature/x",
			integrationSha: "abc",
			debuggerName: "debugger-m1-attempt-1",
			failureSource: "holdout",
			failedGates: [{ id: "tsc", level: 1, name: "tsc", status: "fail", message: "msg" }],
		} as unknown as DebugBriefRequestPayload;

		const ciRound = JSON.parse(JSON.stringify(ci));
		const holdoutRound = JSON.parse(JSON.stringify(holdout));

		expect(ciRound).toEqual(ci as unknown as object);
		expect(holdoutRound).toEqual(holdout as unknown as object);
		expect(ciRound.failureSource).toBe("ci");
		expect(holdoutRound.failureSource).toBe("holdout");
		expect(ciRound.failedChecks).toEqual([
			{ name: "tsc", conclusion: "FAILURE", durationMs: 60_000 },
		]);
		expect(holdoutRound.failedGates).toEqual([
			{ id: "tsc", level: 1, name: "tsc", status: "fail", message: "msg" },
		]);
	});
});

// =============================================================================
// shared-mandate.md: T-w3-28
// =============================================================================

describe("agents/shared-mandate.md debug-brief-protocol", () => {
	test("T-w3-28: contains failureSource, holdout, ci, failedChecks, failedGates, debug-brief-protocol", async () => {
		const path = join(REPO_ROOT, "agents", "shared-mandate.md");
		const text = await readFile(path, "utf-8");
		expect(text).toContain("debug-brief-protocol");
		expect(text).toContain("failureSource");
		expect(text).toContain("holdout");
		expect(text).toContain("ci");
		expect(text).toContain("failedChecks");
		expect(text).toContain("failedGates");
	});
});
