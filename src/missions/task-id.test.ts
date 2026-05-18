/**
 * Tests for src/missions/task-id.ts — PENDING_SENTINEL constant and
 * isRealTaskId type guard.
 *
 * RED phase: src/missions/task-id.ts does not yet exist. The import below
 * will fail until the builder lands the foundation workstream (ws-store-types).
 *
 * Spec: .overstory/specs/haru-2061.md (workstream ws-store-types).
 */

import { describe, expect, test } from "bun:test";
import { isRealTaskId, PENDING_SENTINEL } from "./task-id.ts";

// Tracker id grammar enforced by sd / bd / gh adapters.
// Sentinel must fail this grammar so it can never be mistaken for a real id.
const TRACKER_ID_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

describe("PENDING_SENTINEL", () => {
	test('T-1: value is exactly "!pending-tracker-create"', () => {
		expect(PENDING_SENTINEL).toBe("!pending-tracker-create");
	});

	test("T-2: sentinel fails the tracker-id grammar /^[A-Za-z0-9][A-Za-z0-9_-]*$/", () => {
		// Leading "!" is the deliberate poison pill — it makes the sentinel
		// invalid as a real tracker id, so accidental persistence is detectable.
		expect(TRACKER_ID_GRAMMAR.test(PENDING_SENTINEL)).toBe(false);
	});
});

describe("isRealTaskId", () => {
	test("T-3: returns false for null", () => {
		expect(isRealTaskId(null)).toBe(false);
	});

	test("T-4: returns false for undefined", () => {
		expect(isRealTaskId(undefined)).toBe(false);
	});

	test('T-5: returns false for the empty string ""', () => {
		expect(isRealTaskId("")).toBe(false);
	});

	test("T-6: returns false for PENDING_SENTINEL", () => {
		expect(isRealTaskId(PENDING_SENTINEL)).toBe(false);
	});

	test('T-7: returns true for "haru-db98"', () => {
		expect(isRealTaskId("haru-db98")).toBe(true);
	});

	test('T-8: returns true for "gh-123"', () => {
		expect(isRealTaskId("gh-123")).toBe(true);
	});

	test('T-9: returns true for "foo_bar-1"', () => {
		expect(isRealTaskId("foo_bar-1")).toBe(true);
	});

	test("T-10: type guard narrows parameter to string inside truthy branch", () => {
		// This test exercises the runtime behavior; the type narrowing is a
		// compile-time contract verified by tsc. The cast at the call site
		// proves the predicate's `t is string` signature flows through.
		const t: string | null | undefined = "haru-db98";
		if (isRealTaskId(t)) {
			// Inside this branch, `t` must be narrowed to `string`. Calling
			// String.prototype methods without optional chaining is the proof.
			expect(t.length).toBeGreaterThan(0);
			expect(t.startsWith("haru-")).toBe(true);
		} else {
			throw new Error("isRealTaskId should have narrowed t to string");
		}
	});
});
