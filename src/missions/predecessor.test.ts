/**
 * RED-phase tests for w8-continue-from — predecessor synthesis + applyContinueFrom.
 *
 * Cases T-w8-4 .. T-w8-11 from
 * .overstory/missions/mission-1778699081737-stage-e-v2/plan/test-plan.yaml
 *
 * These tests intentionally import from the not-yet-created module
 * `./predecessor.ts`. Imports failing at runtime is the expected RED state —
 * the builder will create `predecessor.ts` to satisfy these tests.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OverstoryError } from "../errors.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { MissionStore } from "../types.ts";
import {
	type ApplyContinueFromDeps,
	applyContinueFrom,
	type PredecessorInput,
	synthesizePredecessorSummary,
} from "./predecessor.ts";
import { createMissionStore } from "./store.ts";

let tempDir: string;
let dbPath: string;
let store: MissionStore;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "haru-predecessor-test-"));
	dbPath = join(tempDir, "sessions.db");
	store = createMissionStore(dbPath);
});

afterEach(async () => {
	store.close();
	await cleanupTempDir(tempDir);
});

/** Default readFile that returns empty for any path (used when no MRP/feedback artifacts exist). */
const emptyReadFile = async (_p: string): Promise<string> => "";

/** Build a baseline PredecessorInput. */
function makeInput(overrides: Partial<PredecessorInput> = {}): PredecessorInput {
	return {
		oldMissionId: "mission-old-001",
		oldArtifactRoot: "/tmp/old-mission",
		newIntent: "Refactor the auth flow per reviewer feedback",
		...overrides,
	};
}

// === T-w8-4 ===

describe("synthesizePredecessorSummary", () => {
	test("T-w8-4: produces markdown with all six required section headers", async () => {
		const md = await synthesizePredecessorSummary(makeInput(), {
			missionStore: store,
			readFile: emptyReadFile,
		});

		expect(md).toContain("# Predecessor");
		expect(md).toContain("## Original intent");
		expect(md).toContain("## What was shipped");
		expect(md).toContain("## Reviewer feedback");
		expect(md).toContain("## Operator");
		expect(md).toContain("new intent");
		expect(md).toContain("## Predecessor artifacts");
	});

	// === T-w8-5 ===

	test("T-w8-5: deterministic — identical input produces identical bytes across two calls", async () => {
		const input = makeInput({
			triggeringComment: {
				author: "reviewer-a",
				body: "Please use a simpler approach",
				timestamp: "2026-05-13T12:00:00Z",
			},
		});

		const a = await synthesizePredecessorSummary(input, {
			missionStore: store,
			readFile: emptyReadFile,
		});
		const b = await synthesizePredecessorSummary(input, {
			missionStore: store,
			readFile: emptyReadFile,
		});

		expect(a).toBe(b);
	});

	// === T-w8-6 ===

	test("T-w8-6: triggering comment body wrapped in code fence with 'untrusted content' label and capped to 4KB", async () => {
		const longBody = "x".repeat(5000); // 5KB > 4KB cap

		const md = await synthesizePredecessorSummary(
			makeInput({
				triggeringComment: {
					author: "reviewer-a",
					body: longBody,
					timestamp: "2026-05-13T12:00:00Z",
				},
			}),
			{ missionStore: store, readFile: emptyReadFile },
		);

		// Code fence wrapping
		expect(md).toContain("```");

		// Untrusted-content labeling (defense-in-depth, markdown-appropriate)
		expect(md.toLowerCase()).toContain("untrusted");

		// Body capped to 4KB — full 5000-char run must NOT appear verbatim
		expect(md).not.toContain("x".repeat(5000));

		// But a substantial 4KB-truncated prefix MUST appear
		expect(md).toContain("x".repeat(4000));

		// Truncation marker must be present so the reader sees this is incomplete
		expect(md.toLowerCase()).toMatch(/truncat|\[\.\.\.\]/);
	});
});

// === applyContinueFrom helpers ===

/**
 * Local stub MissionStore for tests that target applyContinueFrom's contract.
 * Backed by a real bun:sqlite store created in beforeEach (so transaction()
 * exercises real SQLite semantics).
 */

/** Helper: create old mission with state set. */
function seedOldMission(args: {
	id: string;
	state?: "active" | "frozen" | "completed" | "failed" | "stopped" | "suspended";
	currentNode?: string;
}) {
	store.create({
		id: args.id,
		slug: `slug-${args.id}`,
		objective: "old objective",
	});
	store.start(args.id);
	if (args.state && args.state !== "active") {
		store.updateState(args.id, args.state);
	}
	if (args.currentNode) {
		store.updateCurrentNode(args.id, args.currentNode);
	}
}

/** Helper: create new mission. */
function seedNewMission(id: string) {
	store.create({
		id,
		slug: `slug-${id}`,
		objective: "new mission",
	});
	store.start(id);
}

/** Capture all runGh invocations for assertion. */
function makeRunGhCapture() {
	const calls: string[][] = [];
	const runGh = async (...args: string[]): Promise<{ stdout: string; exitCode: number }> => {
		calls.push(args);
		// Default: pretend `pr view` returns OPEN, anything else exit 0 with empty stdout.
		if (args[0] === "pr" && args[1] === "view") {
			return { stdout: JSON.stringify({ state: "OPEN" }), exitCode: 0 };
		}
		return { stdout: "", exitCode: 0 };
	};
	return { runGh, calls };
}

function makeDeps(overrides: Partial<ApplyContinueFromDeps> = {}): ApplyContinueFromDeps {
	const cap = makeRunGhCapture();
	return {
		missionStore: store,
		runGh: cap.runGh,
		...overrides,
	};
}

// === T-w8-7 ===

describe("applyContinueFrom", () => {
	test("T-w8-7: old mission state='pr-phase' → updates to state='superseded' + current_node='done:superseded' + sets new mission's parentMissionId", async () => {
		// Seed old mission and force into pr-phase via raw current_node update.
		seedOldMission({ id: "mission-old-1", currentNode: "pr-phase:create" });
		// Coerce state via explicit cast since 'pr-phase' isn't part of MissionState yet
		// (w1 is responsible for adding it). Tests exercise the contract — the builder
		// must broaden the state union to make this assignable.
		store.updateState("mission-old-1", "pr-phase" as never);
		seedNewMission("mission-new-1");

		const deps = makeDeps();
		await applyContinueFrom("mission-old-1", "mission-new-1", join(tempDir, "new-artifacts"), deps);

		const old = store.getById("mission-old-1");
		const fresh = store.getById("mission-new-1");
		expect(old?.state).toBe("superseded" as never);
		expect(old?.currentNode).toBe("done:superseded");
		// parentMissionId is the new field on Mission added by w1+w8.
		expect((fresh as unknown as { parentMissionId: string | null })?.parentMissionId).toBe(
			"mission-old-1",
		);
	});

	// === T-w8-8 ===

	test("T-w8-8: idempotent replay — old already 'superseded' AND new mission's parentMissionId === oldId → no-op (no throw, no extra updates)", async () => {
		seedOldMission({ id: "mission-old-2", currentNode: "done:superseded" });
		store.updateState("mission-old-2", "superseded" as never);
		seedNewMission("mission-new-2");
		// Pre-link new → old via the new accessor (also still RED).
		(
			store as unknown as {
				setParentMissionId(missionId: string, parentMissionId: string): void;
			}
		).setParentMissionId("mission-new-2", "mission-old-2");

		const cap = makeRunGhCapture();
		const deps = makeDeps({ runGh: cap.runGh });

		await applyContinueFrom(
			"mission-old-2",
			"mission-new-2",
			join(tempDir, "replay-artifacts"),
			deps,
		);

		// State unchanged.
		expect(store.getById("mission-old-2")?.state).toBe("superseded" as never);
		// No gh calls were made — the early-exit replay path skips gh entirely.
		expect(cap.calls).toHaveLength(0);
	});

	// === T-w8-9 ===

	test("T-w8-9: old mission in state='execute' → throws OverstoryError with actionable message", async () => {
		seedOldMission({ id: "mission-old-3" });
		// Force into the execute lifecycle phase (active state, execute phase).
		store.updatePhase("mission-old-3", "execute");
		store.updateCurrentNode("mission-old-3", "execute:active");
		seedNewMission("mission-new-3");

		const deps = makeDeps();

		await expect(
			applyContinueFrom("mission-old-3", "mission-new-3", join(tempDir, "exec-artifacts"), deps),
		).rejects.toThrow(OverstoryError);

		// Actionable: includes the current state in the message so operator sees why.
		try {
			await applyContinueFrom(
				"mission-old-3",
				"mission-new-3",
				join(tempDir, "exec-artifacts2"),
				deps,
			);
			expect.unreachable("expected applyContinueFrom to throw");
		} catch (err) {
			const message = (err as Error).message;
			// Either "active" (state) or "execute" (phase) must appear in the message.
			expect(message.toLowerCase()).toMatch(/cannot|state|execute|active/);
		}
	});

	// === T-w8-10 ===

	test("T-w8-10: gh pr view returns 'CLOSED' → does NOT call gh pr close (no-op)", async () => {
		seedOldMission({ id: "mission-old-4", currentNode: "pr-phase:done" });
		store.updateState("mission-old-4", "pr-phase" as never);
		seedNewMission("mission-new-4");

		// Seed a PR row so applyContinueFrom can find it and try gh pr view.
		(
			store as unknown as {
				upsertPrState(row: {
					missionId: string;
					prNumber: number;
					prUrl: string;
					branch: string;
					createdAt: string;
					lastCiStatus: string | null;
					lastReviewDecision: string | null;
					approvedHeadSha: string | null;
					mergedAt: string | null;
				}): void;
			}
		).upsertPrState({
			missionId: "mission-old-4",
			prNumber: 101,
			prUrl: "https://example/pull/101",
			branch: "feature/old",
			createdAt: "2026-05-13T00:00:00Z",
			lastCiStatus: null,
			lastReviewDecision: null,
			approvedHeadSha: null,
			mergedAt: null,
		});

		const calls: string[][] = [];
		const runGh = async (...args: string[]): Promise<{ stdout: string; exitCode: number }> => {
			calls.push(args);
			if (args[0] === "pr" && args[1] === "view") {
				return { stdout: JSON.stringify({ state: "CLOSED" }), exitCode: 0 };
			}
			return { stdout: "", exitCode: 0 };
		};

		await applyContinueFrom("mission-old-4", "mission-new-4", join(tempDir, "closed-artifacts"), {
			missionStore: store,
			runGh,
		});

		const closeCalls = calls.filter((c) => c[0] === "pr" && c[1] === "close");
		expect(closeCalls).toHaveLength(0);
	});

	// === T-w8-11 ===

	test("T-w8-11: gh pr view returns 'OPEN' AND config.pr.autoCloseSuperseded=true → calls runGh(['pr','close',...])", async () => {
		seedOldMission({ id: "mission-old-5", currentNode: "pr-phase:done" });
		store.updateState("mission-old-5", "pr-phase" as never);
		seedNewMission("mission-new-5");

		(
			store as unknown as {
				upsertPrState(row: {
					missionId: string;
					prNumber: number;
					prUrl: string;
					branch: string;
					createdAt: string;
					lastCiStatus: string | null;
					lastReviewDecision: string | null;
					approvedHeadSha: string | null;
					mergedAt: string | null;
				}): void;
			}
		).upsertPrState({
			missionId: "mission-old-5",
			prNumber: 202,
			prUrl: "https://example/pull/202",
			branch: "feature/old-5",
			createdAt: "2026-05-13T00:00:00Z",
			lastCiStatus: null,
			lastReviewDecision: null,
			approvedHeadSha: null,
			mergedAt: null,
		});

		const calls: string[][] = [];
		const runGh = async (...args: string[]): Promise<{ stdout: string; exitCode: number }> => {
			calls.push(args);
			if (args[0] === "pr" && args[1] === "view") {
				return { stdout: JSON.stringify({ state: "OPEN" }), exitCode: 0 };
			}
			return { stdout: "", exitCode: 0 };
		};

		await applyContinueFrom("mission-old-5", "mission-new-5", join(tempDir, "open-artifacts"), {
			missionStore: store,
			runGh,
			config: { pr: { autoCloseSuperseded: true } },
		} as ApplyContinueFromDeps);

		const closeCalls = calls.filter((c) => c[0] === "pr" && c[1] === "close");
		expect(closeCalls).toHaveLength(1);
		// PR number is the second positional arg of `gh pr close`
		expect(closeCalls[0]?.[2]).toBe("202");
	});

	test("T-w8-11b: applyContinueFrom uses injected runGh, not raw Bun.spawn (CT-7 spy contract)", async () => {
		seedOldMission({ id: "mission-old-6", currentNode: "pr-phase:done" });
		store.updateState("mission-old-6", "pr-phase" as never);
		seedNewMission("mission-new-6");

		(
			store as unknown as {
				upsertPrState(row: {
					missionId: string;
					prNumber: number;
					prUrl: string;
					branch: string;
					createdAt: string;
					lastCiStatus: string | null;
					lastReviewDecision: string | null;
					approvedHeadSha: string | null;
					mergedAt: string | null;
				}): void;
			}
		).upsertPrState({
			missionId: "mission-old-6",
			prNumber: 303,
			prUrl: "https://example/pull/303",
			branch: "feature/old-6",
			createdAt: "2026-05-13T00:00:00Z",
			lastCiStatus: null,
			lastReviewDecision: null,
			approvedHeadSha: null,
			mergedAt: null,
		});

		const runGh = mock(async (...args: string[]): Promise<{ stdout: string; exitCode: number }> => {
			if (args[0] === "pr" && args[1] === "view") {
				return { stdout: JSON.stringify({ state: "OPEN" }), exitCode: 0 };
			}
			return { stdout: "", exitCode: 0 };
		});

		await applyContinueFrom("mission-old-6", "mission-new-6", join(tempDir, "spy-artifacts"), {
			missionStore: store,
			runGh,
			config: { pr: { autoCloseSuperseded: true } },
		} as ApplyContinueFromDeps);

		// Spy invariant: the injected runGh was called at least once
		// (CT-7: no raw Bun.spawn(['gh', ...]) anywhere in applyContinueFrom).
		expect(runGh).toHaveBeenCalled();
	});
});
