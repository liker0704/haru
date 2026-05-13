/**
 * Tests for MissionStore (SQLite-backed mission tracking).
 *
 * Uses real bun:sqlite with temp files. No mocks.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { InsertMission, MissionStore } from "../types.ts";
import { createMissionStore } from "./store.ts";

let tempDir: string;
let dbPath: string;
let store: MissionStore;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "haru-missions-test-"));
	dbPath = join(tempDir, "sessions.db");
	store = createMissionStore(dbPath);
});

afterEach(async () => {
	store.close();
	await cleanupTempDir(tempDir);
});

/** Helper to create an InsertMission with optional overrides. */
function makeMission(overrides: Partial<InsertMission> = {}): InsertMission {
	return {
		id: "mission-001",
		slug: "test-mission",
		objective: "Test the mission store",
		...overrides,
	};
}

// === create ===

describe("create", () => {
	test("inserts a new mission and returns it", () => {
		const inserted = makeMission();
		const mission = store.create(inserted);

		expect(mission.id).toBe("mission-001");
		expect(mission.slug).toBe("test-mission");
		expect(mission.objective).toBe("Test the mission store");
		expect(mission.state).toBe("active");
		expect(mission.phase).toBe("intake");
		expect(mission.pendingUserInput).toBe(false);
		expect(mission.pendingInputKind).toBeNull();
		expect(mission.pendingInputThreadId).toBeNull();
		expect(mission.reopenCount).toBe(0);
		expect(mission.runId).toBeNull();
		expect(mission.artifactRoot).toBeNull();
		expect(mission.pausedWorkstreamIds).toEqual([]);
		expect(mission.firstFreezeAt).toBeNull();
		expect(mission.createdAt).toBeTruthy();
		expect(mission.updatedAt).toBeTruthy();
	});

	test("accepts optional runId and artifactRoot", () => {
		const mission = store.create(
			makeMission({ runId: "run-abc", artifactRoot: "/tmp/missions/test" }),
		);
		expect(mission.runId).toBe("run-abc");
		expect(mission.artifactRoot).toBe("/tmp/missions/test");
	});

	test("all fields roundtrip correctly (camelCase TS -> snake_case SQLite -> camelCase TS)", () => {
		const inserted = makeMission({
			id: "mission-roundtrip",
			slug: "roundtrip-slug",
			objective: "Roundtrip objective",
			runId: "run-xyz",
			artifactRoot: "/artifacts/roundtrip",
		});
		const mission = store.create(inserted);

		const fetched = store.getById("mission-roundtrip");
		expect(fetched).not.toBeNull();
		expect(fetched).toEqual(mission);
	});

	test("fails on duplicate slug", () => {
		store.create(makeMission({ slug: "same-slug", id: "mission-001" }));
		expect(() => store.create(makeMission({ slug: "same-slug", id: "mission-002" }))).toThrow();
	});

	test("autonomy defaults to 'supervised' when omitted", () => {
		const mission = store.create(makeMission());
		expect(mission.autonomy).toBe("supervised");
	});

	test("accepts explicit autonomy values", () => {
		const supervised = store.create(makeMission({ id: "m1", slug: "s1", autonomy: "supervised" }));
		const autoSpec = store.create(makeMission({ id: "m2", slug: "s2", autonomy: "auto-spec" }));
		const autoAll = store.create(makeMission({ id: "m3", slug: "s3", autonomy: "auto-all" }));
		expect(supervised.autonomy).toBe("supervised");
		expect(autoSpec.autonomy).toBe("auto-spec");
		expect(autoAll.autonomy).toBe("auto-all");
	});

	test("rejects invalid autonomy via DB CHECK constraint", () => {
		expect(() =>
			// @ts-expect-error — testing runtime DB constraint with invalid value
			store.create(makeMission({ autonomy: "rogue" })),
		).toThrow();
	});
});

// === migration v9: autonomy column ===

describe("migration v9: autonomy column", () => {
	test("autonomy column exists with default 'supervised' after migration", () => {
		const probe = new Database(dbPath);
		const cols = probe.prepare("PRAGMA table_info(missions)").all() as Array<{
			name: string;
			dflt_value: string | null;
		}>;
		const autonomyCol = cols.find((c) => c.name === "autonomy");
		expect(autonomyCol).toBeDefined();
		expect(autonomyCol?.dflt_value).toContain("supervised");
		probe.close();
	});

	test("rows inserted via raw SQL without autonomy still parse with default", () => {
		// Simulates a row inserted by older code paths that don't pass autonomy.
		// SQLite default kicks in.
		const raw = new Database(dbPath);
		raw.exec(
			"INSERT INTO missions (id, slug, objective, created_at, updated_at) " +
				"VALUES ('raw-1', 'raw-slug', 'raw obj', '2026-01-01', '2026-01-01')",
		);
		raw.close();

		const mission = store.getById("raw-1");
		expect(mission).not.toBeNull();
		expect(mission?.autonomy).toBe("supervised");
	});

	test("migration is idempotent (re-opening store does not fail)", () => {
		store.close();
		store = createMissionStore(dbPath);
		const mission = store.create(makeMission());
		expect(mission.autonomy).toBe("supervised");
	});
});

// === getById / getBySlug ===

describe("getById", () => {
	test("returns null for unknown id", () => {
		expect(store.getById("nonexistent")).toBeNull();
	});

	test("returns the mission after create", () => {
		store.create(makeMission());
		const result = store.getById("mission-001");
		expect(result).not.toBeNull();
		expect(result?.slug).toBe("test-mission");
	});
});

describe("getBySlug", () => {
	test("returns null for unknown slug", () => {
		expect(store.getBySlug("nonexistent-slug")).toBeNull();
	});

	test("returns the mission by slug", () => {
		store.create(makeMission());
		const result = store.getBySlug("test-mission");
		expect(result).not.toBeNull();
		expect(result?.id).toBe("mission-001");
	});
});

// === getActive ===

describe("getActive", () => {
	test("returns null when no active mission", () => {
		expect(store.getActive()).toBeNull();
	});

	test("returns active mission", () => {
		store.create(makeMission());
		const result = store.getActive();
		expect(result).not.toBeNull();
		expect(result?.id).toBe("mission-001");
	});

	test("returns frozen mission as active (pending input)", () => {
		store.create(makeMission());
		store.freeze("mission-001", "question", null);
		const result = store.getActive();
		expect(result).not.toBeNull();
		expect(result?.state).toBe("frozen");
	});

	test("returns null after mission is completed", () => {
		store.create(makeMission());
		store.updateState("mission-001", "completed");
		expect(store.getActive()).toBeNull();
	});
});

// === getActiveList ===

describe("getActiveList", () => {
	test("returns empty array when no active missions", () => {
		expect(store.getActiveList()).toEqual([]);
	});

	test("returns multiple active missions", () => {
		store.create(makeMission({ id: "mission-001", slug: "slug-one" }));
		store.create(makeMission({ id: "mission-002", slug: "slug-two" }));
		const result = store.getActiveList();
		expect(result).toHaveLength(2);
		const ids = result.map((m) => m.id);
		expect(ids).toContain("mission-001");
		expect(ids).toContain("mission-002");
	});

	test("includes both active and frozen missions", () => {
		store.create(makeMission({ id: "mission-001", slug: "slug-one" }));
		store.create(makeMission({ id: "mission-002", slug: "slug-two" }));
		store.freeze("mission-002", "question", null);
		const result = store.getActiveList();
		expect(result).toHaveLength(2);
		const states = result.map((m) => m.state);
		expect(states).toContain("active");
		expect(states).toContain("frozen");
	});

	test("excludes completed, stopped, failed, and suspended missions", () => {
		store.create(makeMission({ id: "mission-active", slug: "slug-active" }));
		store.create(makeMission({ id: "mission-completed", slug: "slug-completed" }));
		store.create(makeMission({ id: "mission-stopped", slug: "slug-stopped" }));
		store.create(makeMission({ id: "mission-failed", slug: "slug-failed" }));
		store.create(makeMission({ id: "mission-suspended", slug: "slug-suspended" }));
		store.updateState("mission-completed", "completed");
		store.updateState("mission-stopped", "stopped");
		store.updateState("mission-failed", "failed");
		store.updateState("mission-suspended", "suspended");
		const result = store.getActiveList();
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("mission-active");
	});
});

// === list ===

describe("list", () => {
	test("returns empty array when no missions", () => {
		expect(store.list()).toEqual([]);
	});

	test("returns all missions", () => {
		store.create(makeMission({ id: "mission-001", slug: "slug-one" }));
		store.create(makeMission({ id: "mission-002", slug: "slug-two" }));
		const result = store.list();
		expect(result).toHaveLength(2);
		const ids = result.map((m) => m.id);
		expect(ids).toContain("mission-001");
		expect(ids).toContain("mission-002");
	});

	test("filters by state", () => {
		store.create(makeMission({ id: "mission-001", slug: "slug-one" }));
		store.create(makeMission({ id: "mission-002", slug: "slug-two" }));
		store.updateState("mission-001", "completed");

		const active = store.list({ state: "active" });
		expect(active).toHaveLength(1);
		expect(active[0]?.id).toBe("mission-002");

		const completed = store.list({ state: "completed" });
		expect(completed).toHaveLength(1);
		expect(completed[0]?.id).toBe("mission-001");
	});

	test("limits results", () => {
		store.create(makeMission({ id: "mission-001", slug: "slug-one" }));
		store.create(makeMission({ id: "mission-002", slug: "slug-two" }));
		store.create(makeMission({ id: "mission-003", slug: "slug-three" }));

		const result = store.list({ limit: 2 });
		expect(result).toHaveLength(2);
	});
});

// === updateState ===

describe("updateState", () => {
	test("transitions mission state", () => {
		store.create(makeMission());
		store.updateState("mission-001", "completed");
		const result = store.getById("mission-001");
		expect(result?.state).toBe("completed");
	});

	test("updates updated_at on state change", () => {
		store.create(makeMission());
		const before = store.getById("mission-001");
		store.updateState("mission-001", "stopped");
		const after = store.getById("mission-001");
		// updated_at may be equal if very fast, but should be >= before
		const afterUpdatedAt = after?.updatedAt ?? "";
		const beforeUpdatedAt = before?.updatedAt ?? "";
		expect(afterUpdatedAt >= beforeUpdatedAt).toBe(true);
	});
});

// === delete ===

describe("delete", () => {
	test("removes the mission record", () => {
		store.create(makeMission());
		store.delete("mission-001");
		expect(store.getById("mission-001")).toBeNull();
	});
});

// === updatePhase ===

describe("updatePhase", () => {
	test("transitions mission phase", () => {
		store.create(makeMission());
		store.updatePhase("mission-001", "align");
		const result = store.getById("mission-001");
		expect(result?.phase).toBe("align");
	});
});

// === freeze / unfreeze ===

describe("freeze", () => {
	test("sets state=frozen, pendingUserInput=true, records kind and threadId", () => {
		store.create(makeMission());
		store.freeze("mission-001", "question", "thread-abc");
		const result = store.getById("mission-001");
		expect(result?.state).toBe("frozen");
		expect(result?.pendingUserInput).toBe(true);
		expect(result?.pendingInputKind).toBe("question");
		expect(result?.pendingInputThreadId).toBe("thread-abc");
	});

	test("sets firstFreezeAt on first freeze", () => {
		store.create(makeMission());
		store.freeze("mission-001", "approval", null);
		const result = store.getById("mission-001");
		expect(result?.firstFreezeAt).not.toBeNull();
	});

	test("preserves firstFreezeAt on subsequent freezes", () => {
		store.create(makeMission());
		store.freeze("mission-001", "question", null);
		const firstFreeze = store.getById("mission-001")?.firstFreezeAt;

		store.unfreeze("mission-001");
		store.freeze("mission-001", "decision", null);
		const secondFreeze = store.getById("mission-001")?.firstFreezeAt;

		expect(firstFreeze).toBe(secondFreeze);
	});

	test("accepts null threadId", () => {
		store.create(makeMission());
		store.freeze("mission-001", "clarification", null);
		const result = store.getById("mission-001");
		expect(result?.pendingInputThreadId).toBeNull();
	});

	test("does NOT clobber currentNode on freeze", () => {
		store.create(makeMission());
		store.updateCurrentNode("mission-001", "understand-phase:evaluate");
		store.freeze("mission-001", "question", null);
		const result = store.getById("mission-001");
		// currentNode should be preserved — engine manages subgraph position
		expect(result?.currentNode).toBe("understand-phase:evaluate");
	});
});

describe("unfreeze", () => {
	test("sets state=active, clears pending fields, increments reopenCount", () => {
		store.create(makeMission());
		store.freeze("mission-001", "question", "thread-abc");
		store.unfreeze("mission-001");

		const result = store.getById("mission-001");
		expect(result?.state).toBe("active");
		expect(result?.pendingUserInput).toBe(false);
		expect(result?.pendingInputKind).toBeNull();
		expect(result?.pendingInputThreadId).toBeNull();
		expect(result?.reopenCount).toBe(1);
	});

	test("increments reopenCount on each unfreeze", () => {
		store.create(makeMission());

		store.freeze("mission-001", "question", null);
		store.unfreeze("mission-001");
		store.freeze("mission-001", "decision", null);
		store.unfreeze("mission-001");

		const result = store.getById("mission-001");
		expect(result?.reopenCount).toBe(2);
	});

	test("does NOT clobber currentNode on unfreeze", () => {
		store.create(makeMission());
		store.updateCurrentNode("mission-001", "understand-phase:evaluate");
		store.freeze("mission-001", "question", null);
		// currentNode preserved through freeze
		expect(store.getById("mission-001")?.currentNode).toBe("understand-phase:evaluate");

		store.unfreeze("mission-001");
		// currentNode preserved through unfreeze too
		expect(store.getById("mission-001")?.currentNode).toBe("understand-phase:evaluate");
	});
});

// === updatePausedWorkstreams ===

describe("updatePausedWorkstreams", () => {
	test("sets paused workstream ids as JSON array", () => {
		store.create(makeMission());
		store.updatePausedWorkstreams("mission-001", ["ws-a", "ws-b"]);
		const result = store.getById("mission-001");
		expect(result?.pausedWorkstreamIds).toEqual(["ws-a", "ws-b"]);
	});

	test("clears workstreams when passed empty array", () => {
		store.create(makeMission());
		store.updatePausedWorkstreams("mission-001", ["ws-a"]);
		store.updatePausedWorkstreams("mission-001", []);
		const result = store.getById("mission-001");
		expect(result?.pausedWorkstreamIds).toEqual([]);
	});
});

// === updateArtifactRoot ===

describe("updateArtifactRoot", () => {
	test("sets artifact root path", () => {
		store.create(makeMission());
		store.updateArtifactRoot("mission-001", "/missions/mission-001/artifacts");
		const result = store.getById("mission-001");
		expect(result?.artifactRoot).toBe("/missions/mission-001/artifacts");
	});
});

// === bindSessions ===

describe("updateCurrentNode phase sync", () => {
	test("auto-syncs phase when nodeId is a lifecycle node", () => {
		store.create(makeMission());
		// Stage A: new missions default to phase=intake
		expect(store.getById("mission-001")?.phase).toBe("intake");

		store.updateCurrentNode("mission-001", "plan:active");
		expect(store.getById("mission-001")?.phase).toBe("plan");
		expect(store.getById("mission-001")?.currentNode).toBe("plan:active");
	});

	test("syncs phase for execute:active", () => {
		store.create(makeMission());
		store.updateCurrentNode("mission-001", "execute:active");
		expect(store.getById("mission-001")?.phase).toBe("execute");
	});

	test("syncs phase for done:completed", () => {
		store.create(makeMission());
		store.updateCurrentNode("mission-001", "done:completed");
		expect(store.getById("mission-001")?.phase).toBe("done");
	});

	test("does NOT sync phase for subgraph nodes", () => {
		store.create(makeMission());
		store.updateCurrentNode("mission-001", "understand-phase:evaluate");
		// Subgraph node — phase should stay at original "intake" default
		expect(store.getById("mission-001")?.phase).toBe("intake");
		expect(store.getById("mission-001")?.currentNode).toBe("understand-phase:evaluate");
	});

	test("does NOT sync phase for non-phase prefixes", () => {
		store.create(makeMission());
		store.updateCurrentNode("mission-001", "custom:node");
		// "custom" is not a valid MissionPhase — phase stays at intake default
		expect(store.getById("mission-001")?.phase).toBe("intake");
	});
});

describe("bindSessions", () => {
	test("new missions have null session IDs by default", () => {
		store.create(makeMission());
		const mission = store.getById("mission-001");
		expect(mission?.analystSessionId).toBeNull();
		expect(mission?.executionDirectorSessionId).toBeNull();
	});

	test("binds analystSessionId", () => {
		store.create(makeMission());
		store.bindSessions("mission-001", { analystSessionId: "session-analyst-abc" });
		const mission = store.getById("mission-001");
		expect(mission?.analystSessionId).toBe("session-analyst-abc");
		expect(mission?.executionDirectorSessionId).toBeNull();
	});

	test("binds executionDirectorSessionId", () => {
		store.create(makeMission());
		store.bindSessions("mission-001", { executionDirectorSessionId: "session-director-xyz" });
		const mission = store.getById("mission-001");
		expect(mission?.analystSessionId).toBeNull();
		expect(mission?.executionDirectorSessionId).toBe("session-director-xyz");
	});

	test("binds both session IDs independently", () => {
		store.create(makeMission());
		store.bindSessions("mission-001", { analystSessionId: "session-analyst-1" });
		store.bindSessions("mission-001", { executionDirectorSessionId: "session-director-1" });
		const mission = store.getById("mission-001");
		expect(mission?.analystSessionId).toBe("session-analyst-1");
		expect(mission?.executionDirectorSessionId).toBe("session-director-1");
	});

	test("session IDs round-trip through create and read", () => {
		store.create(makeMission());
		store.bindSessions("mission-001", {
			analystSessionId: "session-a",
			executionDirectorSessionId: "session-b",
		});
		const mission = store.getById("mission-001");
		expect(mission?.analystSessionId).toBe("session-a");
		expect(mission?.executionDirectorSessionId).toBe("session-b");
	});
});

// === bindCoordinatorSession ===

describe("bindCoordinatorSession", () => {
	test("new missions have null coordinatorSessionId by default", () => {
		store.create(makeMission());
		const mission = store.getById("mission-001");
		expect(mission?.coordinatorSessionId).toBeNull();
	});

	test("binds coordinatorSessionId directly", () => {
		store.create(makeMission());
		store.bindCoordinatorSession("mission-001", "session-coord-abc");
		const mission = store.getById("mission-001");
		expect(mission?.coordinatorSessionId).toBe("session-coord-abc");
	});
});

// === updatePausedLeads ===

describe("updatePausedLeads", () => {
	test("new missions have empty pausedLeadNames by default", () => {
		store.create(makeMission());
		const mission = store.getById("mission-001");
		expect(mission?.pausedLeadNames).toEqual([]);
	});

	test("sets paused lead names as JSON array", () => {
		store.create(makeMission());
		store.updatePausedLeads("mission-001", ["lead-a", "lead-b"]);
		const result = store.getById("mission-001");
		expect(result?.pausedLeadNames).toEqual(["lead-a", "lead-b"]);
	});

	test("clears leads when passed empty array", () => {
		store.create(makeMission());
		store.updatePausedLeads("mission-001", ["lead-a"]);
		store.updatePausedLeads("mission-001", []);
		const result = store.getById("mission-001");
		expect(result?.pausedLeadNames).toEqual([]);
	});
});

// === updatePauseReason ===

describe("updatePauseReason", () => {
	test("new missions have null pauseReason by default", () => {
		store.create(makeMission());
		const mission = store.getById("mission-001");
		expect(mission?.pauseReason).toBeNull();
	});

	test("sets pause reason", () => {
		store.create(makeMission());
		store.updatePauseReason("mission-001", "waiting for user input");
		const result = store.getById("mission-001");
		expect(result?.pauseReason).toBe("waiting for user input");
	});

	test("clears pause reason when null passed", () => {
		store.create(makeMission());
		store.updatePauseReason("mission-001", "some reason");
		store.updatePauseReason("mission-001", null);
		const result = store.getById("mission-001");
		expect(result?.pauseReason).toBeNull();
	});
});

// === start / complete ===

describe("start", () => {
	test("new missions have null startedAt by default", () => {
		store.create(makeMission());
		const mission = store.getById("mission-001");
		expect(mission?.startedAt).toBeNull();
	});

	test("sets startedAt", () => {
		store.create(makeMission());
		store.start("mission-001");
		const result = store.getById("mission-001");
		expect(result?.startedAt).not.toBeNull();
	});

	test("start is idempotent (does not overwrite existing startedAt)", () => {
		store.create(makeMission());
		store.start("mission-001");
		const first = store.getById("mission-001")?.startedAt;
		store.start("mission-001");
		const second = store.getById("mission-001")?.startedAt;
		expect(first).toBe(second);
	});
});

describe("completeMission", () => {
	test("new missions have null completedAt by default", () => {
		store.create(makeMission());
		const mission = store.getById("mission-001");
		expect(mission?.completedAt).toBeNull();
	});

	test("sets completedAt and state=completed atomically", () => {
		store.create(makeMission());
		store.completeMission("mission-001");
		const result = store.getById("mission-001");
		expect(result?.completedAt).not.toBeNull();
		expect(result?.state).toBe("completed");
	});

	test("clears pending input fields", () => {
		store.create(makeMission());
		store.freeze("mission-001", "question", "msg-123");
		store.completeMission("mission-001");
		const result = store.getById("mission-001");
		expect(result?.pendingUserInput).toBe(false);
		expect(result?.pendingInputKind).toBeNull();
		expect(result?.pendingInputThreadId).toBeNull();
	});
});

// === checkpoints accessor ===

describe("checkpoints", () => {
	test("store exposes checkpoints accessor", () => {
		expect(store.checkpoints).toBeDefined();
	});

	test("checkpoints save and retrieve via store.checkpoints", () => {
		store.create(makeMission());
		store.checkpoints.saveCheckpoint("mission-001", "node-a", { data: "test" });
		const result = store.checkpoints.getCheckpoint("mission-001", "node-a");
		expect(result).not.toBeNull();
		expect(result?.data).toEqual({ data: "test" });
	});

	test("checkpoints accessor backed by same db (transitions visible)", () => {
		store.checkpoints.recordTransition("mission-001", "node-a", "node-b", "done");
		const history = store.checkpoints.getTransitionHistory("mission-001");
		expect(history).toHaveLength(1);
	});
});

// === idempotency: create table twice ===

describe("schema idempotency", () => {
	test("creating a second store on the same db path does not throw", () => {
		const store2 = createMissionStore(dbPath);
		store2.close();
	});

	test("legacy missions table with cancelled state is migrated to stopped", () => {
		store.close();

		const legacyDb = new Database(dbPath);
		legacyDb.exec("DROP TABLE IF EXISTS missions");
		legacyDb.exec(`
			CREATE TABLE missions (
				id TEXT PRIMARY KEY,
				slug TEXT NOT NULL UNIQUE,
				objective TEXT NOT NULL,
				run_id TEXT,
				state TEXT NOT NULL DEFAULT 'active'
					CHECK(state IN ('active','frozen','completed','failed','cancelled')),
				phase TEXT NOT NULL DEFAULT 'understand'
					CHECK(phase IN ('understand','align','decide','plan','execute','done')),
				first_freeze_at TEXT,
				pending_user_input INTEGER NOT NULL DEFAULT 0,
				pending_input_kind TEXT,
				pending_input_thread_id TEXT,
				reopen_count INTEGER NOT NULL DEFAULT 0,
				artifact_root TEXT,
				paused_workstream_ids TEXT NOT NULL DEFAULT '[]',
				analyst_session_id TEXT,
				execution_director_session_id TEXT,
				coordinator_session_id TEXT,
				paused_lead_names TEXT NOT NULL DEFAULT '[]',
				pause_reason TEXT,
				started_at TEXT,
				completed_at TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`);
		legacyDb.exec(`
			INSERT INTO missions (
				id, slug, objective, state, phase, paused_workstream_ids, paused_lead_names, created_at, updated_at
			) VALUES (
				'legacy-mission',
				'legacy-mission',
				'Legacy mission objective',
				'cancelled',
				'execute',
				'[]',
				'[]',
				'2026-01-01T00:00:00.000Z',
				'2026-01-01T00:00:00.000Z'
			)
		`);
		legacyDb.close();

		const migratedStore = createMissionStore(dbPath);
		try {
			const mission = migratedStore.getById("legacy-mission");
			expect(mission?.state).toBe("stopped");
			migratedStore.updateState("legacy-mission", "stopped");
			expect(migratedStore.getById("legacy-mission")?.state).toBe("stopped");
		} finally {
			migratedStore.close();
		}

		store = createMissionStore(dbPath);
	});

	test("legacy missions table missing newer runtime columns is rebuilt in place", () => {
		store.close();

		const legacyDb = new Database(dbPath);
		legacyDb.exec("DROP TABLE IF EXISTS missions");
		legacyDb.exec(`
			CREATE TABLE missions (
				id TEXT PRIMARY KEY,
				slug TEXT NOT NULL UNIQUE,
				objective TEXT NOT NULL,
				run_id TEXT,
				state TEXT NOT NULL DEFAULT 'active'
					CHECK(state IN ('active','frozen','completed','failed','cancelled')),
				phase TEXT NOT NULL DEFAULT 'planning'
					CHECK(phase IN ('planning','scouting','building','reviewing','merging','done')),
				first_freeze_at TEXT,
				pending_user_input INTEGER NOT NULL DEFAULT 0,
				pending_input_kind TEXT CHECK(pending_input_kind IS NULL OR pending_input_kind IN ('question','approval','decision','clarification')),
				pending_input_thread_id TEXT,
				reopen_count INTEGER NOT NULL DEFAULT 0,
				artifact_root TEXT,
				paused_workstream_ids TEXT NOT NULL DEFAULT '[]',
				analyst_session_id TEXT,
				execution_director_session_id TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`);
		legacyDb.exec(`
			INSERT INTO missions (
				id, slug, objective, run_id, state, phase, first_freeze_at,
				pending_user_input, pending_input_kind, pending_input_thread_id,
				reopen_count, artifact_root, paused_workstream_ids, analyst_session_id,
				execution_director_session_id, created_at, updated_at
			) VALUES (
				'legacy-runtime-mission',
				'legacy-runtime-mission',
				'Legacy runtime mission',
				'run-legacy',
				'cancelled',
				'planning',
				'2026-01-01T00:00:00.000Z',
				1,
				'clarification',
				'thread-legacy',
				2,
				'/tmp/legacy-artifacts',
				'["ws-auth"]',
				'sess-analyst',
				'sess-director',
				'2026-01-01T00:00:00.000Z',
				'2026-01-02T00:00:00.000Z'
			)
		`);
		legacyDb.close();

		const migratedStore = createMissionStore(dbPath);
		try {
			const mission = migratedStore.getById("legacy-runtime-mission");
			expect(mission).not.toBeNull();
			expect(mission?.state).toBe("stopped");
			expect(mission?.phase).toBe("plan");
			expect(mission?.coordinatorSessionId).toBeNull();
			expect(mission?.pausedLeadNames).toEqual([]);
			expect(mission?.pauseReason).toBeNull();
			expect(mission?.startedAt).toBe("2026-01-01T00:00:00.000Z");
			expect(mission?.completedAt).toBeNull();

			migratedStore.bindCoordinatorSession("legacy-runtime-mission", "sess-coordinator");
			migratedStore.updatePausedLeads("legacy-runtime-mission", ["lead-auth"]);
			migratedStore.updatePauseReason("legacy-runtime-mission", "Waiting on regenerated spec");
			migratedStore.start("legacy-runtime-mission");

			const updated = migratedStore.getById("legacy-runtime-mission");
			expect(updated?.coordinatorSessionId).toBe("sess-coordinator");
			expect(updated?.pausedLeadNames).toEqual(["lead-auth"]);
			expect(updated?.pauseReason).toBe("Waiting on regenerated spec");
			expect(updated?.startedAt).toBe("2026-01-01T00:00:00.000Z");
		} finally {
			migratedStore.close();
		}

		store = createMissionStore(dbPath);
	});
});

// === tier operations ===

describe("tier operations", () => {
	test("updateTier stores and retrieves correctly", () => {
		store.create(makeMission());
		store.updateTier("mission-001", "direct");
		const result = store.getById("mission-001");
		expect(result?.tier).toBe("direct");
	});

	test("updateTier upgrades from direct to planned", () => {
		store.create(makeMission());
		store.updateTier("mission-001", "direct");
		store.updateTier("mission-001", "planned");
		const result = store.getById("mission-001");
		expect(result?.tier).toBe("planned");
	});

	test("updateTier rejects downgrades (planned to direct throws)", () => {
		store.create(makeMission());
		store.updateTier("mission-001", "planned");
		expect(() => store.updateTier("mission-001", "direct")).toThrow(
			"Cannot downgrade mission tier from planned to direct",
		);
	});

	test("updateTier rejects same-tier update (full to full throws)", () => {
		store.create(makeMission());
		store.updateTier("mission-001", "full");
		expect(() => store.updateTier("mission-001", "full")).toThrow(
			"Cannot downgrade mission tier from full to full",
		);
	});

	test("updateTier records transition in mission_tier_transitions", () => {
		store.create(makeMission());
		store.updateTier("mission-001", "direct", "auto-detect");

		const db = new Database(dbPath, { readonly: true });
		const rows = db
			.prepare(
				"SELECT mission_id, from_tier, to_tier, triggered_by FROM mission_tier_transitions WHERE mission_id = ?",
			)
			.all("mission-001") as Array<{
			mission_id: string;
			from_tier: string | null;
			to_tier: string;
			triggered_by: string | null;
		}>;
		db.close();

		expect(rows).toHaveLength(1);
		const row = rows[0]!;
		expect(row.mission_id).toBe("mission-001");
		expect(row.from_tier).toBeNull();
		expect(row.to_tier).toBe("direct");
		expect(row.triggered_by).toBe("auto-detect");
	});

	test("updateTier records multiple transitions on upgrade path", () => {
		store.create(makeMission());
		store.updateTier("mission-001", "direct", "init");
		store.updateTier("mission-001", "planned", "escalation");
		store.updateTier("mission-001", "full", "user-request");

		const db = new Database(dbPath, { readonly: true });
		const rows = db
			.prepare(
				"SELECT from_tier, to_tier, triggered_by FROM mission_tier_transitions WHERE mission_id = ? ORDER BY id",
			)
			.all("mission-001") as Array<{
			from_tier: string | null;
			to_tier: string;
			triggered_by: string | null;
		}>;
		db.close();

		expect(rows).toHaveLength(3);
		expect(rows[0]?.from_tier).toBeNull();
		expect(rows[0]?.to_tier).toBe("direct");
		expect(rows[1]?.from_tier).toBe("direct");
		expect(rows[1]?.to_tier).toBe("planned");
		expect(rows[2]?.from_tier).toBe("planned");
		expect(rows[2]?.to_tier).toBe("full");
	});

	test("clearGateStates clears gate state rows", () => {
		store.create(makeMission());
		// Insert a gate state via the store API
		store.ensureGateState("mission-001", "execute:active", 120_000, 3_600_000);

		// Verify gate state exists
		const db = new Database(dbPath, { readonly: true });
		const before = db
			.prepare("SELECT COUNT(*) as cnt FROM mission_gate_state WHERE mission_id = ?")
			.get("mission-001") as { cnt: number };
		expect(before.cnt).toBeGreaterThan(0);
		db.close();

		// Clear and verify
		store.clearGateStates("mission-001");

		const db2 = new Database(dbPath, { readonly: true });
		const after = db2
			.prepare("SELECT COUNT(*) as cnt FROM mission_gate_state WHERE mission_id = ?")
			.get("mission-001") as { cnt: number };
		db2.close();

		expect(after.cnt).toBe(0);
	});

	test("clearCheckpoints clears checkpoint rows", () => {
		store.create(makeMission());
		// Insert a checkpoint via the checkpoints accessor
		store.checkpoints.saveCheckpoint("mission-001", "understand:active", { step: 1 });

		// Verify checkpoint exists
		const cp = store.checkpoints.getCheckpoint("mission-001", "understand:active");
		expect(cp).not.toBeNull();

		// Clear and verify
		store.clearCheckpoints("mission-001");

		const after = store.checkpoints.getCheckpoint("mission-001", "understand:active");
		expect(after).toBeNull();
	});

	test("legacy missions created without tier have tier: null", () => {
		const mission = store.create(makeMission());
		expect(mission.tier).toBeNull();

		const fetched = store.getById("mission-001");
		expect(fetched?.tier).toBeNull();
	});
});

// === migration v13: PR lifecycle persistence ===

/**
 * Local shape declarations for the PR-state / PR-comment accessors that the
 * builder will add to MissionStore in W1. The cast keeps the test file
 * compiling against the un-widened MissionStore interface during RED phase.
 */
type MissionPrStateRow = {
	missionId: string;
	prNumber: number;
	prUrl: string;
	branch: string;
	createdAt: string;
	lastCiStatus: string | null;
	lastReviewDecision: string | null;
	approvedHeadSha: string | null;
	mergedAt: string | null;
};
type MissionPrCommentRow = {
	missionId: string;
	prNumber: number;
	commentId: string;
	author: string;
	body: string;
	action: string | null;
	status: string;
	fixCycles: number;
	detectedAt: string;
	resolvedAt: string | null;
};
type PrExt = {
	getPrState(missionId: string): MissionPrStateRow | null;
	upsertPrState(row: MissionPrStateRow): void;
	updatePrCiStatus(missionId: string, status: string): void;
	updatePrReviewDecision(missionId: string, decision: string): void;
	setApprovedHeadSha(missionId: string, sha: string): void;
	markPrMerged(missionId: string, mergedAt: string): void;
	listPrComments(missionId: string): MissionPrCommentRow[];
	countTriageSpawnsSince(missionId: string, since: string): number;
	countTriagePerAuthorSince(missionId: string, author: string, since: string): number;
	recordPrComment(row: MissionPrCommentRow): void;
	updatePrCommentAction(commentId: string, action: string, status: string): void;
	markPrCommentResolved(commentId: string): void;
};
const ext = (s: MissionStore): MissionStore & PrExt => s as MissionStore & PrExt;

describe("migration v13: parent_mission_id + learnings_extracted_at", () => {
	test("T-w1-1: both columns exist on missions with TEXT/nullable, positioned after feature_branch", () => {
		const probe = new Database(dbPath);
		const cols = probe.prepare("PRAGMA table_info(missions)").all() as Array<{
			cid: number;
			name: string;
			type: string;
			notnull: number;
			dflt_value: string | null;
			pk: number;
		}>;
		probe.close();

		const parentCol = cols.find((c) => c.name === "parent_mission_id");
		const learningsAtCol = cols.find((c) => c.name === "learnings_extracted_at");
		expect(parentCol).toBeDefined();
		expect(learningsAtCol).toBeDefined();
		expect(parentCol?.type).toBe("TEXT");
		expect(parentCol?.notnull).toBe(0);
		expect(learningsAtCol?.type).toBe("TEXT");
		expect(learningsAtCol?.notnull).toBe(0);

		const featureBranchCol = cols.find((c) => c.name === "feature_branch");
		expect(featureBranchCol).toBeDefined();
		const featureBranchCid = featureBranchCol?.cid ?? -1;
		expect(parentCol?.cid).toBeGreaterThan(featureBranchCid);
		expect(learningsAtCol?.cid).toBeGreaterThan(featureBranchCid);
	});

	test("T-w1-2: re-opening the store is idempotent (no duplicate columns)", () => {
		store.close();
		expect(() => {
			store = createMissionStore(dbPath);
		}).not.toThrow();

		const probe = new Database(dbPath);
		const cols = probe.prepare("PRAGMA table_info(missions)").all() as Array<{ name: string }>;
		probe.close();

		const parentMatches = cols.filter((c) => c.name === "parent_mission_id");
		const learningsAtMatches = cols.filter((c) => c.name === "learnings_extracted_at");
		expect(parentMatches).toHaveLength(1);
		expect(learningsAtMatches).toHaveLength(1);
	});
});

describe("migration v13: mission_pr_state table", () => {
	test("T-w1-3: mission_pr_state has 9 columns in declared order, mission_id is PRIMARY KEY", () => {
		const probe = new Database(dbPath);
		const cols = probe.prepare("PRAGMA table_info(mission_pr_state)").all() as Array<{
			name: string;
			pk: number;
		}>;
		probe.close();

		expect(cols.map((c) => c.name)).toEqual([
			"mission_id",
			"pr_number",
			"pr_url",
			"branch",
			"created_at",
			"last_ci_status",
			"last_review_decision",
			"approved_head_sha",
			"merged_at",
		]);

		const pkRow = cols.find((c) => c.name === "mission_id");
		expect(pkRow?.pk).toBe(1);
	});
});

describe("migration v13: mission_pr_comments table", () => {
	test("T-w1-4: mission_pr_comments has 10 columns in declared order, comment_id is PRIMARY KEY", () => {
		const probe = new Database(dbPath);
		const cols = probe.prepare("PRAGMA table_info(mission_pr_comments)").all() as Array<{
			name: string;
			pk: number;
		}>;
		probe.close();

		expect(cols.map((c) => c.name)).toEqual([
			"mission_id",
			"pr_number",
			"comment_id",
			"author",
			"body",
			"action",
			"status",
			"fix_cycles",
			"detected_at",
			"resolved_at",
		]);

		const pkRow = cols.find((c) => c.name === "comment_id");
		expect(pkRow?.pk).toBe(1);
	});

	test("T-w1-5: body CHECK constraint rejects > 65536 chars, accepts == 65536", () => {
		const raw = new Database(dbPath);
		try {
			const tooLong = "x".repeat(65537);
			expect(() =>
				raw.exec(
					`INSERT INTO mission_pr_comments
					 (mission_id, pr_number, comment_id, author, body, status, fix_cycles, detected_at)
					 VALUES ('mission-001', 1, 'c-too-long', 'octocat',
					         '${tooLong}', 'open', 0, '2026-05-13T00:00:00Z')`,
				),
			).toThrow();

			const justRight = "x".repeat(65536);
			expect(() =>
				raw.exec(
					`INSERT INTO mission_pr_comments
					 (mission_id, pr_number, comment_id, author, body, status, fix_cycles, detected_at)
					 VALUES ('mission-001', 1, 'c-just-right', 'octocat',
					         '${justRight}', 'open', 0, '2026-05-13T00:00:00Z')`,
				),
			).not.toThrow();
		} finally {
			raw.close();
		}
	});
});

describe("MissionStore PR state accessors", () => {
	function baseState(overrides: Partial<MissionPrStateRow> = {}): MissionPrStateRow {
		return {
			missionId: "mission-001",
			prNumber: 42,
			prUrl: "https://github.com/example/repo/pull/42",
			branch: "feature/stage-e",
			createdAt: "2026-05-13T00:00:00Z",
			lastCiStatus: "pending",
			lastReviewDecision: "pending",
			approvedHeadSha: "deadbeef",
			mergedAt: null,
			...overrides,
		};
	}

	test("T-w1-6: upsertPrState + getPrState roundtrip all 9 fields", () => {
		store.create(makeMission());
		const row = baseState();
		ext(store).upsertPrState(row);

		const got = ext(store).getPrState("mission-001");
		expect(got).toEqual(row);
	});

	test("upsertPrState overwrites on PRIMARY KEY conflict (same missionId)", () => {
		store.create(makeMission());
		ext(store).upsertPrState(baseState({ prNumber: 42 }));
		ext(store).upsertPrState(baseState({ prNumber: 99, prUrl: "https://example/pull/99" }));

		const got = ext(store).getPrState("mission-001");
		expect(got?.prNumber).toBe(99);
		expect(got?.prUrl).toBe("https://example/pull/99");
	});

	test("getPrState returns null for unknown mission", () => {
		expect(ext(store).getPrState("does-not-exist")).toBeNull();
	});

	test("updatePrCiStatus mutates only last_ci_status; other fields preserved", () => {
		store.create(makeMission());
		ext(store).upsertPrState(baseState({ lastCiStatus: "pending" }));
		ext(store).updatePrCiStatus("mission-001", "success");

		const got = ext(store).getPrState("mission-001");
		expect(got?.lastCiStatus).toBe("success");
		expect(got?.lastReviewDecision).toBe("pending");
		expect(got?.prNumber).toBe(42);
		expect(got?.branch).toBe("feature/stage-e");
		expect(got?.approvedHeadSha).toBe("deadbeef");
	});

	test("updatePrReviewDecision mutates only last_review_decision; other fields preserved", () => {
		store.create(makeMission());
		ext(store).upsertPrState(baseState({ lastReviewDecision: "pending" }));
		ext(store).updatePrReviewDecision("mission-001", "approved");

		const got = ext(store).getPrState("mission-001");
		expect(got?.lastReviewDecision).toBe("approved");
		expect(got?.lastCiStatus).toBe("pending");
		expect(got?.prUrl).toBe("https://github.com/example/repo/pull/42");
	});

	test("T-w1-7: setApprovedHeadSha sets approved_head_sha; null before, value after", () => {
		store.create(makeMission());
		ext(store).upsertPrState(baseState({ approvedHeadSha: null }));
		const before = ext(store).getPrState("mission-001");
		expect(before?.approvedHeadSha).toBeNull();

		ext(store).setApprovedHeadSha("mission-001", "abc123");
		const after = ext(store).getPrState("mission-001");
		expect(after?.approvedHeadSha).toBe("abc123");
	});

	test("markPrMerged sets mergedAt; other fields preserved", () => {
		store.create(makeMission());
		ext(store).upsertPrState(baseState({ mergedAt: null }));
		ext(store).markPrMerged("mission-001", "2026-05-14T00:00:00Z");

		const got = ext(store).getPrState("mission-001");
		expect(got?.mergedAt).toBe("2026-05-14T00:00:00Z");
		expect(got?.prNumber).toBe(42);
		expect(got?.branch).toBe("feature/stage-e");
		expect(got?.lastCiStatus).toBe("pending");
	});
});

describe("MissionStore PR comment accessors", () => {
	function baseComment(overrides: Partial<MissionPrCommentRow> = {}): MissionPrCommentRow {
		return {
			missionId: "mission-001",
			prNumber: 42,
			commentId: "c1",
			author: "octocat",
			body: "please fix",
			action: null,
			status: "open",
			fixCycles: 0,
			detectedAt: "2026-05-13T01:00:00Z",
			resolvedAt: null,
			...overrides,
		};
	}

	test("T-w1-8: recordPrComment is INSERT OR IGNORE by comment_id (first write wins)", () => {
		store.create(makeMission());
		ext(store).recordPrComment(baseComment({ commentId: "c1", body: "first" }));
		ext(store).recordPrComment(baseComment({ commentId: "c1", body: "second" }));

		const rows = ext(store).listPrComments("mission-001");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.body).toBe("first");
	});

	test("listPrComments returns all rows for the mission", () => {
		store.create(makeMission());
		ext(store).recordPrComment(baseComment({ commentId: "c1" }));
		ext(store).recordPrComment(baseComment({ commentId: "c2" }));
		ext(store).recordPrComment(baseComment({ commentId: "c3" }));

		const rows = ext(store).listPrComments("mission-001");
		expect(rows).toHaveLength(3);
		expect(rows.find((r) => r.commentId === "c1")).toBeDefined();
		expect(rows.find((r) => r.commentId === "c2")).toBeDefined();
		expect(rows.find((r) => r.commentId === "c3")).toBeDefined();
	});

	test("updatePrCommentAction sets action and status on the targeted comment", () => {
		store.create(makeMission());
		ext(store).recordPrComment(baseComment({ commentId: "c1" }));
		ext(store).updatePrCommentAction("c1", "trivial_fix", "in_progress");

		const rows = ext(store).listPrComments("mission-001");
		const c1 = rows.find((r) => r.commentId === "c1");
		expect(c1?.action).toBe("trivial_fix");
		expect(c1?.status).toBe("in_progress");
	});

	test("markPrCommentResolved sets resolvedAt non-null", () => {
		store.create(makeMission());
		ext(store).recordPrComment(baseComment({ commentId: "c1" }));
		ext(store).markPrCommentResolved("c1");

		const rows = ext(store).listPrComments("mission-001");
		const c1 = rows.find((r) => r.commentId === "c1");
		expect(c1?.resolvedAt).not.toBeNull();
	});

	test("T-w1-9: countTriageSpawnsSince counts triage rows since timestamp", () => {
		store.create(makeMission());
		ext(store).recordPrComment(baseComment({ commentId: "c1" }));
		ext(store).recordPrComment(baseComment({ commentId: "c2" }));
		ext(store).updatePrCommentAction("c1", "trivial_fix", "in_progress");

		const sinceEpoch = ext(store).countTriageSpawnsSince("mission-001", "1970-01-01T00:00:00Z");
		expect(sinceEpoch).toBeGreaterThanOrEqual(1);

		const sinceFuture = ext(store).countTriageSpawnsSince("mission-001", "2999-01-01T00:00:00Z");
		expect(sinceFuture).toBe(0);
	});

	test("T-w1-10: countTriagePerAuthorSince counts triage rows per author", () => {
		store.create(makeMission());
		ext(store).recordPrComment(baseComment({ commentId: "c1", author: "A" }));
		ext(store).recordPrComment(baseComment({ commentId: "c2", author: "A" }));
		ext(store).recordPrComment(baseComment({ commentId: "c3", author: "B" }));
		ext(store).updatePrCommentAction("c1", "trivial_fix", "in_progress");
		ext(store).updatePrCommentAction("c2", "trivial_fix", "in_progress");
		ext(store).updatePrCommentAction("c3", "trivial_fix", "in_progress");

		expect(ext(store).countTriagePerAuthorSince("mission-001", "A", "1970-01-01T00:00:00Z")).toBe(
			2,
		);
		expect(ext(store).countTriagePerAuthorSince("mission-001", "B", "1970-01-01T00:00:00Z")).toBe(
			1,
		);
	});
});
