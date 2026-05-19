/**
 * SQLite-backed mission store for long-running objective tracking.
 *
 * Stores missions in the sessions.db file alongside sessions and runs.
 * WAL mode enables concurrent reads from multiple agent processes.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { ensureMigrations, hasColumn, type Migration, rebuildTable } from "../db/migrate.ts";
import type {
	InsertMission,
	Mission,
	MissionAutonomy,
	MissionPhase,
	MissionPrCommentRow,
	MissionPrStateRow,
	MissionState,
	MissionStore,
	MissionTier,
	PendingInputKind,
} from "../types.ts";
import { createCheckpointStore } from "./checkpoint.ts";
import { MISSION_PHASES, TIER_ORDER } from "./types.ts";
import { areAllWorkstreamsDone as areAllWorkstreamsDoneImpl } from "./workstreams.ts";

/** Safely parse a JSON string from a database column, returning a fallback on failure. */
function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
	if (value == null) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

/** Row shape as stored in SQLite (snake_case columns). */
interface MissionRow {
	id: string;
	slug: string;
	objective: string;
	run_id: string | null;
	state: string;
	phase: string;
	first_freeze_at: string | null;
	frozen_at: string | null;
	pending_user_input: number;
	pending_input_kind: string | null;
	pending_input_thread_id: string | null;
	reopen_count: number;
	artifact_root: string | null;
	paused_workstream_ids: string;
	analyst_session_id: string | null;
	execution_director_session_id: string | null;
	coordinator_session_id: string | null;
	architect_session_id: string | null;
	paused_lead_names: string;
	pause_reason: string | null;
	current_node: string | null;
	started_at: string | null;
	completed_at: string | null;
	created_at: string;
	updated_at: string;
	learnings_extracted: number;
	tier: string | null;
	has_emitted_ws_producer_write: number;
	autonomy: string;
	feature_branch: string | null;
	parent_mission_id: string | null;
	learnings_extracted_at: string | null;
	task_id: string | null;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  objective TEXT NOT NULL,
  run_id TEXT,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK(state IN ('active','frozen','completed','failed','stopped','suspended','superseded','pr-phase')),
  phase TEXT NOT NULL DEFAULT 'intake'
    CHECK(phase IN ('intake','understand','align','decide','plan','execute','pr','pre-pr','done')),
  first_freeze_at TEXT,
  frozen_at TEXT,
  pending_user_input INTEGER NOT NULL DEFAULT 0,
  pending_input_kind TEXT CHECK(pending_input_kind IS NULL OR pending_input_kind IN ('question','approval','decision','clarification','debug-escalation')),
  pending_input_thread_id TEXT,
  reopen_count INTEGER NOT NULL DEFAULT 0,
  artifact_root TEXT,
  paused_workstream_ids TEXT NOT NULL DEFAULT '[]',
  analyst_session_id TEXT,
  execution_director_session_id TEXT,
  coordinator_session_id TEXT,
  architect_session_id TEXT,
  paused_lead_names TEXT NOT NULL DEFAULT '[]',
  pause_reason TEXT,
  current_node TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  learnings_extracted INTEGER NOT NULL DEFAULT 0,
  tier TEXT CHECK(tier IS NULL OR tier IN ('direct','planned','full')),
  has_emitted_ws_producer_write INTEGER NOT NULL DEFAULT 0,
  autonomy TEXT NOT NULL DEFAULT 'supervised'
    CHECK(autonomy IN ('supervised','auto-spec','auto-all')),
  feature_branch TEXT,
  parent_mission_id TEXT REFERENCES missions(id),
  learnings_extracted_at TEXT,
  task_id TEXT CHECK (task_id IS NULL OR length(task_id) <= 64)
)`;

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_missions_state ON missions(state);
CREATE INDEX IF NOT EXISTS idx_missions_slug ON missions(slug);
CREATE INDEX IF NOT EXISTS idx_missions_run ON missions(run_id)`;

const REQUIRED_MISSION_COLUMNS = [
	"id",
	"slug",
	"objective",
	"run_id",
	"state",
	"phase",
	"first_freeze_at",
	"frozen_at",
	"pending_user_input",
	"pending_input_kind",
	"pending_input_thread_id",
	"reopen_count",
	"artifact_root",
	"paused_workstream_ids",
	"analyst_session_id",
	"execution_director_session_id",
	"coordinator_session_id",
	"architect_session_id",
	"paused_lead_names",
	"pause_reason",
	"current_node",
	"started_at",
	"completed_at",
	"created_at",
	"updated_at",
	"learnings_extracted",
	"has_emitted_ws_producer_write",
	"autonomy",
	"feature_branch",
	"task_id",
] as const;

function getMissionColumns(db: Database): Set<string> {
	const rows = db.prepare("PRAGMA table_info(missions)").all() as Array<{ name: string }>;
	return new Set(rows.map((row) => row.name));
}

function missionColumnExpr(
	existingColumns: Set<string>,
	column: (typeof REQUIRED_MISSION_COLUMNS)[number],
	fallbackSql: string,
): string {
	return existingColumns.has(column) ? column : fallbackSql;
}

const CREATE_CHECKPOINT_TABLES = `
CREATE TABLE IF NOT EXISTS mission_node_checkpoints (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  snapshot_data TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(mission_id, node_id, version)
);
CREATE INDEX IF NOT EXISTS idx_mnc_mission ON mission_node_checkpoints(mission_id);
CREATE INDEX IF NOT EXISTS idx_mnc_mission_version ON mission_node_checkpoints(mission_id, version DESC);
CREATE TABLE IF NOT EXISTS mission_state_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  from_node TEXT NOT NULL,
  to_node TEXT NOT NULL,
  trigger TEXT NOT NULL,
  data TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_mst_mission ON mission_state_transitions(mission_id)`;

/** All migrations for the missions domain (shared sessions.db). */
const MISSION_MIGRATIONS: Migration[] = [
	{
		version: 1,
		description: "rebuild legacy mission schemas with current columns and constraints",
		up: (db) => {
			const result = db
				.prepare<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type='table' AND name='missions'",
				)
				.get();
			if (!result) return;

			const existingColumns = getMissionColumns(db);
			const missingColumns = REQUIRED_MISSION_COLUMNS.filter(
				(column) => !existingColumns.has(column),
			);
			const hasCurrentStateConstraint =
				result.sql.includes("'stopped'") && result.sql.includes("'suspended'");
			const hasCurrentPhaseConstraint =
				result.sql.includes("'understand'") &&
				result.sql.includes("'align'") &&
				result.sql.includes("'decide'") &&
				result.sql.includes("'plan'") &&
				result.sql.includes("'execute'") &&
				result.sql.includes("'done'");

			if (missingColumns.length === 0 && hasCurrentStateConstraint && hasCurrentPhaseConstraint) {
				return;
			}

			const stateExpr = existingColumns.has("state")
				? `CASE
						WHEN state = 'cancelled' THEN 'stopped'
						WHEN state IN ('active','frozen','completed','failed','stopped','suspended') THEN state
						ELSE 'active'
					END`
				: `'active'`;
			const phaseExpr = existingColumns.has("phase")
				? `CASE
						WHEN phase = 'planning' THEN 'plan'
						WHEN phase IN ('scouting','building','reviewing','merging') THEN 'execute'
						WHEN phase IN ('understand','align','decide','plan','execute','done') THEN phase
						ELSE 'understand'
					END`
				: `'understand'`;
			const pendingInputKindExpr = existingColumns.has("pending_input_kind")
				? `CASE
						WHEN pending_input_kind IN ('question','approval','decision','clarification')
							THEN pending_input_kind
						ELSE NULL
					END`
				: "NULL";
			const createdAtExpr = missionColumnExpr(
				existingColumns,
				"created_at",
				"strftime('%Y-%m-%dT%H:%M:%fZ','now')",
			);
			const updatedAtExpr = missionColumnExpr(existingColumns, "updated_at", createdAtExpr);

			const allColumns = [
				"id",
				"slug",
				"objective",
				"run_id",
				"state",
				"phase",
				"first_freeze_at",
				"frozen_at",
				"pending_user_input",
				"pending_input_kind",
				"pending_input_thread_id",
				"reopen_count",
				"artifact_root",
				"paused_workstream_ids",
				"analyst_session_id",
				"execution_director_session_id",
				"coordinator_session_id",
				"architect_session_id",
				"paused_lead_names",
				"pause_reason",
				"current_node",
				"started_at",
				"completed_at",
				"created_at",
				"updated_at",
				"learnings_extracted",
			];

			rebuildTable({
				db,
				table: "missions",
				createSql: CREATE_TABLE.replace("CREATE TABLE IF NOT EXISTS", "CREATE TABLE"),
				columns: allColumns,
				selectExprs: {
					id: missionColumnExpr(existingColumns, "id", "NULL"),
					slug: missionColumnExpr(existingColumns, "slug", "NULL"),
					objective: missionColumnExpr(existingColumns, "objective", "''"),
					run_id: missionColumnExpr(existingColumns, "run_id", "NULL"),
					state: stateExpr,
					phase: phaseExpr,
					first_freeze_at: missionColumnExpr(existingColumns, "first_freeze_at", "NULL"),
					frozen_at: missionColumnExpr(existingColumns, "frozen_at", "NULL"),
					pending_user_input: `COALESCE(${missionColumnExpr(existingColumns, "pending_user_input", "0")}, 0)`,
					pending_input_kind: pendingInputKindExpr,
					pending_input_thread_id: missionColumnExpr(
						existingColumns,
						"pending_input_thread_id",
						"NULL",
					),
					reopen_count: `COALESCE(${missionColumnExpr(existingColumns, "reopen_count", "0")}, 0)`,
					artifact_root: missionColumnExpr(existingColumns, "artifact_root", "NULL"),
					paused_workstream_ids: `COALESCE(${missionColumnExpr(existingColumns, "paused_workstream_ids", "'[]'")}, '[]')`,
					analyst_session_id: missionColumnExpr(existingColumns, "analyst_session_id", "NULL"),
					execution_director_session_id: missionColumnExpr(
						existingColumns,
						"execution_director_session_id",
						"NULL",
					),
					coordinator_session_id: missionColumnExpr(
						existingColumns,
						"coordinator_session_id",
						"NULL",
					),
					architect_session_id: missionColumnExpr(existingColumns, "architect_session_id", "NULL"),
					paused_lead_names: `COALESCE(${missionColumnExpr(existingColumns, "paused_lead_names", "'[]'")}, '[]')`,
					pause_reason: missionColumnExpr(existingColumns, "pause_reason", "NULL"),
					current_node: missionColumnExpr(existingColumns, "current_node", "NULL"),
					started_at: missionColumnExpr(existingColumns, "started_at", createdAtExpr),
					completed_at: missionColumnExpr(existingColumns, "completed_at", "NULL"),
					created_at: createdAtExpr,
					updated_at: updatedAtExpr,
					learnings_extracted: `COALESCE(${missionColumnExpr(existingColumns, "learnings_extracted", "0")}, 0)`,
				},
			});
		},
		detect: (db) => {
			const result = db
				.prepare<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type='table' AND name='missions'",
				)
				.get();
			if (!result) return false;
			const cols = getMissionColumns(db);
			const hasAllColumns = REQUIRED_MISSION_COLUMNS.every((c) => cols.has(c));
			const hasCurrentStateConstraint =
				result.sql.includes("'stopped'") && result.sql.includes("'suspended'");
			const hasCurrentPhaseConstraint =
				result.sql.includes("'understand'") &&
				result.sql.includes("'align'") &&
				result.sql.includes("'decide'") &&
				result.sql.includes("'plan'") &&
				result.sql.includes("'execute'") &&
				result.sql.includes("'done'");
			return hasAllColumns && hasCurrentStateConstraint && hasCurrentPhaseConstraint;
		},
	},
	{
		version: 2,
		description: "add mission_node_checkpoints and mission_state_transitions tables",
		up: (db) => {
			db.exec(CREATE_CHECKPOINT_TABLES);
		},
		detect: (db) => {
			const checkpoints = db
				.prepare<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='mission_node_checkpoints'",
				)
				.get();
			const transitions = db
				.prepare<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='mission_state_transitions'",
				)
				.get();
			return checkpoints !== null && transitions !== null;
		},
	},
	{
		version: 3,
		description: "add frozen_at column and dispatch_log table",
		up: (db) => {
			const cols = db.prepare("PRAGMA table_info(missions)").all() as Array<{ name: string }>;
			if (!cols.some((c) => c.name === "frozen_at")) {
				db.exec("ALTER TABLE missions ADD COLUMN frozen_at TEXT");
			}
			db.exec(`
				CREATE TABLE IF NOT EXISTS dispatch_log (
					mission_id TEXT NOT NULL,
					workstream_id TEXT NOT NULL,
					dispatched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
					PRIMARY KEY (mission_id, workstream_id)
				)
			`);
		},
		detect: (db) => {
			const cols = db.prepare("PRAGMA table_info(missions)").all() as Array<{ name: string }>;
			const hasFrozenAt = cols.some((c) => c.name === "frozen_at");
			const hasDispatchLog = db
				.prepare<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='dispatch_log'",
				)
				.get();
			return hasFrozenAt && hasDispatchLog !== null;
		},
	},
	{
		version: 4,
		description: "add architect_session_id column",
		up: (db) => {
			const cols = db.prepare("PRAGMA table_info(missions)").all() as Array<{ name: string }>;
			if (!cols.some((c) => c.name === "architect_session_id")) {
				db.exec("ALTER TABLE missions ADD COLUMN architect_session_id TEXT");
			}
		},
		detect: (db) => {
			const cols = db.prepare("PRAGMA table_info(missions)").all() as Array<{ name: string }>;
			return cols.some((c) => c.name === "architect_session_id");
		},
	},
	{
		version: 5,
		description: "add workstream_status, mission_gate_state, and mission_tick_lock tables",
		up: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS workstream_status (
					mission_id TEXT NOT NULL,
					workstream_id TEXT NOT NULL,
					status TEXT NOT NULL DEFAULT 'planned'
						CHECK(status IN ('planned', 'active', 'paused', 'completed')),
					updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
					updated_by TEXT NOT NULL DEFAULT 'agent',
					PRIMARY KEY(mission_id, workstream_id)
				)
			`);
			db.exec(`
				CREATE TABLE IF NOT EXISTS mission_gate_state (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					mission_id TEXT NOT NULL,
					node_id TEXT NOT NULL,
					entered_at TEXT NOT NULL,
					nudge_count INTEGER NOT NULL DEFAULT 0,
					last_nudge_at TEXT,
					respawn_count INTEGER NOT NULL DEFAULT 0,
					last_respawn_at TEXT,
					grace_ms INTEGER NOT NULL,
					nudge_interval_ms INTEGER NOT NULL DEFAULT 60000,
					max_nudges INTEGER NOT NULL DEFAULT 3,
					max_total_wait_ms INTEGER NOT NULL DEFAULT 3600000,
					resolved_at TEXT,
					resolved_trigger TEXT,
					UNIQUE(mission_id, node_id)
				)
			`);
			db.exec(
				"CREATE INDEX IF NOT EXISTS idx_mgs_active ON mission_gate_state(mission_id, resolved_at)",
			);
			db.exec(`
				CREATE TABLE IF NOT EXISTS mission_tick_lock (
					mission_id TEXT PRIMARY KEY,
					locked_at TEXT NOT NULL,
					locked_by TEXT
				)
			`);
		},
		detect: (db) => {
			const wsStatus = db
				.prepare<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='workstream_status'",
				)
				.get();
			const gateState = db
				.prepare<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='mission_gate_state'",
				)
				.get();
			const tickLock = db
				.prepare<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='mission_tick_lock'",
				)
				.get();
			return wsStatus !== null && gateState !== null && tickLock !== null;
		},
	},
	{
		version: 6,
		description: "Add tier column and tier_transitions table",
		up: (db) => {
			if (!hasColumn(db, "missions", "tier")) {
				db.exec(
					"ALTER TABLE missions ADD COLUMN tier TEXT CHECK(tier IS NULL OR tier IN ('direct','planned','full'))",
				);
			}
			db.exec(`CREATE TABLE IF NOT EXISTS mission_tier_transitions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				mission_id TEXT NOT NULL,
				from_tier TEXT,
				to_tier TEXT NOT NULL,
				triggered_by TEXT,
				created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
			)`);
		},
		detect: (_db, columns) => columns.has("tier"),
	},
	{
		version: 7,
		description: "Add ceiling_emitted_at to mission_gate_state for one-shot escalation",
		up: (db) => {
			if (!hasColumn(db, "mission_gate_state", "ceiling_emitted_at")) {
				db.exec("ALTER TABLE mission_gate_state ADD COLUMN ceiling_emitted_at TEXT");
			}
		},
		detect: (db) => hasColumn(db, "mission_gate_state", "ceiling_emitted_at"),
	},
	{
		version: 8,
		description:
			"Extend workstream_status CHECK to allow merged|failed; add has_emitted_ws_producer_write to missions",
		up: (db) => {
			// 1. Extend workstream_status CHECK constraint (via table rebuild — CHECK cannot
			//    be altered in place). Guard: skip if already extended (idempotent re-run
			//    safety — rebuildTable itself is not idempotent).
			const wsSchemaRow = db
				.prepare<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type='table' AND name='workstream_status'",
				)
				.get();
			if (wsSchemaRow && !wsSchemaRow.sql.includes("'merged'")) {
				rebuildTable({
					db,
					table: "workstream_status",
					createSql: `
						CREATE TABLE workstream_status (
							mission_id TEXT NOT NULL,
							workstream_id TEXT NOT NULL,
							status TEXT NOT NULL
								CHECK(status IN ('planned', 'active', 'paused', 'completed', 'merged', 'failed')),
							updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
							updated_by TEXT NOT NULL DEFAULT 'agent',
							PRIMARY KEY(mission_id, workstream_id)
						)
					`,
					columns: ["mission_id", "workstream_id", "status", "updated_at", "updated_by"],
				});
			}

			// 2. Add has_emitted_ws_producer_write column to missions table.
			if (!hasColumn(db, "missions", "has_emitted_ws_producer_write")) {
				db.exec(
					"ALTER TABLE missions ADD COLUMN has_emitted_ws_producer_write INTEGER NOT NULL DEFAULT 0",
				);
			}

			// 3. Data backfill for in-flight missions. Each mission wrapped in try/catch —
			//    malformed/missing workstreams.json must not abort the whole migration.
			const activeMissions = db
				.prepare<{ id: string; artifact_root: string | null }, []>(
					"SELECT id, artifact_root FROM missions WHERE state IN ('active','suspended','frozen')",
				)
				.all();
			for (const mission of activeMissions) {
				try {
					if (!mission.artifact_root) continue;
					const wsPath = pathJoin(mission.artifact_root, "plan", "workstreams.json");
					if (!existsSync(wsPath)) continue;
					const parsed = JSON.parse(readFileSync(wsPath, "utf-8")) as {
						workstreams?: Array<{ id: string }>;
					};
					const workstreams = parsed.workstreams ?? [];
					const insertStmt = db.prepare(
						`INSERT OR IGNORE INTO workstream_status (mission_id, workstream_id, status, updated_at, updated_by)
						 VALUES ($missionId, $wsId, 'planned', $now, 'engine')`,
					);
					const now = new Date().toISOString();
					for (const ws of workstreams) {
						if (!ws.id) continue;
						insertStmt.run({ $missionId: mission.id, $wsId: ws.id, $now: now });
					}
				} catch (err) {
					// Log via stderr — migration framework captures startup errors.
					// Intentionally do not rethrow; partial backfill is acceptable.
					process.stderr.write(
						`[migrate v8] backfill_skipped: mission=${mission.id} error=${String(err)}\n`,
					);
				}
			}
		},
		detect: (db) => {
			// Detect v8 by presence of both: the 'merged' literal in workstream_status CHECK
			// AND the has_emitted_ws_producer_write column.
			const wsRow = db
				.prepare<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type='table' AND name='workstream_status'",
				)
				.get();
			const checkExtended = wsRow ? wsRow.sql.includes("'merged'") : false;
			return checkExtended && hasColumn(db, "missions", "has_emitted_ws_producer_write");
		},
	},
	{
		version: 9,
		description: "Add autonomy column to missions for intake-phase gate control",
		up: (db) => {
			if (!hasColumn(db, "missions", "autonomy")) {
				db.exec(
					"ALTER TABLE missions ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'supervised' " +
						"CHECK(autonomy IN ('supervised','auto-spec','auto-all'))",
				);
			}
		},
		detect: (db) => hasColumn(db, "missions", "autonomy"),
	},
	{
		version: 10,
		description: "Extend missions.phase CHECK to allow 'intake' (Stage A first phase)",
		up: (db) => {
			// CHECK constraint cannot be altered in place — rebuild the table.
			// Guard: skip if 'intake' is already in the CHECK clause.
			const schemaRow = db
				.prepare<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type='table' AND name='missions'",
				)
				.get();
			if (!schemaRow || schemaRow.sql.includes("'intake'")) {
				return;
			}
			// Rebuild missions table with the extended CHECK clause and new
			// 'intake' default for phase.
			rebuildTable({
				db,
				table: "missions",
				createSql: CREATE_TABLE.replace("CREATE TABLE IF NOT EXISTS", "CREATE TABLE"),
				columns: [
					"id",
					"slug",
					"objective",
					"run_id",
					"state",
					"phase",
					"first_freeze_at",
					"frozen_at",
					"pending_user_input",
					"pending_input_kind",
					"pending_input_thread_id",
					"reopen_count",
					"artifact_root",
					"paused_workstream_ids",
					"analyst_session_id",
					"execution_director_session_id",
					"coordinator_session_id",
					"architect_session_id",
					"paused_lead_names",
					"pause_reason",
					"current_node",
					"started_at",
					"completed_at",
					"created_at",
					"updated_at",
					"learnings_extracted",
					"tier",
					"has_emitted_ws_producer_write",
					"autonomy",
				],
			});
		},
		detect: (db) => {
			const row = db
				.prepare<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type='table' AND name='missions'",
				)
				.get();
			return row ? row.sql.includes("'intake'") : false;
		},
	},
	{
		version: 11,
		description:
			"Stage C: extend pending_input_kind CHECK to allow 'debug-escalation' + " +
			"add feature_branch column for integration-branch tracking",
		up: (db) => {
			// Step 1: ADD COLUMN feature_branch (cheap, no rebuild)
			if (!hasColumn(db, "missions", "feature_branch")) {
				db.exec("ALTER TABLE missions ADD COLUMN feature_branch TEXT");
			}

			// Step 2: rebuild table to extend pending_input_kind CHECK
			// Guard: skip if 'debug-escalation' already in CHECK clause
			const schemaRow = db
				.prepare<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type='table' AND name='missions'",
				)
				.get();
			if (!schemaRow || schemaRow.sql.includes("'debug-escalation'")) {
				return;
			}
			rebuildTable({
				db,
				table: "missions",
				createSql: CREATE_TABLE.replace("CREATE TABLE IF NOT EXISTS", "CREATE TABLE"),
				columns: [
					"id",
					"slug",
					"objective",
					"run_id",
					"state",
					"phase",
					"first_freeze_at",
					"frozen_at",
					"pending_user_input",
					"pending_input_kind",
					"pending_input_thread_id",
					"reopen_count",
					"artifact_root",
					"paused_workstream_ids",
					"analyst_session_id",
					"execution_director_session_id",
					"coordinator_session_id",
					"architect_session_id",
					"paused_lead_names",
					"pause_reason",
					"current_node",
					"started_at",
					"completed_at",
					"created_at",
					"updated_at",
					"learnings_extracted",
					"tier",
					"has_emitted_ws_producer_write",
					"autonomy",
					"feature_branch",
				],
			});
		},
		detect: (db) => {
			if (!hasColumn(db, "missions", "feature_branch")) return false;
			const row = db
				.prepare<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type='table' AND name='missions'",
				)
				.get();
			return row ? row.sql.includes("'debug-escalation'") : false;
		},
	},
	{
		version: 12,
		description: "Add mission_node_checkpoint_status side table for 2PC pending/confirmed tracking",
		up: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS mission_node_checkpoint_status (
					mission_id TEXT NOT NULL,
					node_id TEXT NOT NULL,
					status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed')),
					pending_handler TEXT,
					pending_recorded_at TEXT,
					updated_at TEXT NOT NULL,
					PRIMARY KEY (mission_id, node_id)
				)
			`);
		},
		detect: (db) => {
			const row = db
				.prepare<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='mission_node_checkpoint_status'",
				)
				.get();
			return row !== null;
		},
	},
	{
		version: 13,
		description:
			"Stage E: add parent_mission_id + learnings_extracted_at to missions; create mission_pr_state and mission_pr_comments tables",
		up: (db) => {
			if (!hasColumn(db, "missions", "parent_mission_id")) {
				db.exec("ALTER TABLE missions ADD COLUMN parent_mission_id TEXT REFERENCES missions(id)");
			}
			if (!hasColumn(db, "missions", "learnings_extracted_at")) {
				db.exec("ALTER TABLE missions ADD COLUMN learnings_extracted_at TEXT");
			}
			db.exec(`
				CREATE TABLE IF NOT EXISTS mission_pr_state (
					mission_id TEXT PRIMARY KEY,
					pr_number INTEGER NOT NULL,
					pr_url TEXT NOT NULL,
					branch TEXT NOT NULL,
					created_at TEXT NOT NULL,
					last_ci_status TEXT,
					last_review_decision TEXT,
					approved_head_sha TEXT,
					merged_at TEXT
				)
			`);
			db.exec(`
				CREATE TABLE IF NOT EXISTS mission_pr_comments (
					mission_id TEXT NOT NULL,
					pr_number INTEGER NOT NULL,
					comment_id TEXT PRIMARY KEY,
					author TEXT NOT NULL,
					body TEXT NOT NULL CHECK(length(body) <= 65536),
					action TEXT,
					status TEXT NOT NULL,
					fix_cycles INTEGER DEFAULT 0,
					detected_at TEXT NOT NULL,
					resolved_at TEXT
				)
			`);
		},
		detect: (db) => {
			if (!hasColumn(db, "missions", "parent_mission_id")) return false;
			if (!hasColumn(db, "missions", "learnings_extracted_at")) return false;
			const prState = db
				.prepare<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='mission_pr_state'",
				)
				.get();
			const prComments = db
				.prepare<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='mission_pr_comments'",
				)
				.get();
			return prState !== null && prComments !== null;
		},
	},
	{
		version: 14,
		description:
			"Widen missions.state CHECK to include 'superseded' and 'pr-phase' (Stage E continue-from flow)",
		up: (db) => {
			const schemaRow = db
				.prepare<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type='table' AND name='missions'",
				)
				.get();
			if (
				!schemaRow ||
				(schemaRow.sql.includes("'superseded'") && schemaRow.sql.includes("'pr-phase'"))
			) {
				return;
			}
			// Rebuild the table with the widened state CHECK.
			// Column list must match what exists after v13 (includes parent_mission_id + learnings_extracted_at).
			// FUTURE: v18+ rebuilds MUST include task_id (added by v17 ALTER).
			// Do NOT add task_id here — would brick legacy DBs at user_version < 14
			// (rebuild SELECT references column not yet added). See da-risk-11.
			rebuildTable({
				db,
				table: "missions",
				createSql: CREATE_TABLE.replace("CREATE TABLE IF NOT EXISTS", "CREATE TABLE"),
				columns: [
					"id",
					"slug",
					"objective",
					"run_id",
					"state",
					"phase",
					"first_freeze_at",
					"frozen_at",
					"pending_user_input",
					"pending_input_kind",
					"pending_input_thread_id",
					"reopen_count",
					"artifact_root",
					"paused_workstream_ids",
					"analyst_session_id",
					"execution_director_session_id",
					"coordinator_session_id",
					"architect_session_id",
					"paused_lead_names",
					"pause_reason",
					"current_node",
					"started_at",
					"completed_at",
					"created_at",
					"updated_at",
					"learnings_extracted",
					"tier",
					"has_emitted_ws_producer_write",
					"autonomy",
					"feature_branch",
					"parent_mission_id",
					"learnings_extracted_at",
				],
			});
		},
		detect: (db) => {
			const row = db
				.prepare<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type='table' AND name='missions'",
				)
				.get();
			return row ? row.sql.includes("'superseded'") && row.sql.includes("'pr-phase'") : false;
		},
	},
	{
		version: 15,
		description: "Indexes on mission_pr_comments for triage hot-path queries (#306, indexes-only)",
		up: (db) => {
			db.exec(
				"CREATE INDEX IF NOT EXISTS idx_mpc_mission_status_detected ON mission_pr_comments(mission_id, status, detected_at)",
			);
			db.exec(
				"CREATE INDEX IF NOT EXISTS idx_mpc_mission_author_status_detected ON mission_pr_comments(mission_id, author, status, detected_at)",
			);
		},
		detect: (db) => {
			const rows = db
				.prepare<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_mpc_mission_status_detected', 'idx_mpc_mission_author_status_detected')",
				)
				.all();
			return rows.length === 2;
		},
	},
	{
		version: 16,
		description: "Extend missions.phase CHECK to allow 'pr' and 'pre-pr' phases",
		up: (db) => {
			// CHECK constraint cannot be altered in place — rebuild the table.
			// Guard: skip if 'pre-pr' is already in the CHECK clause (idempotent).
			const schemaRow = db
				.prepare<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type='table' AND name='missions'",
				)
				.get();
			if (!schemaRow || schemaRow.sql.includes("'pre-pr'")) {
				return;
			}
			// FUTURE: v18+ rebuilds MUST include task_id (added by v17 ALTER).
			// Do NOT add task_id here — would brick legacy DBs at user_version < 14
			// (rebuild SELECT references column not yet added). See da-risk-11.
			rebuildTable({
				db,
				table: "missions",
				createSql: CREATE_TABLE.replace("CREATE TABLE IF NOT EXISTS", "CREATE TABLE"),
				columns: [
					"id",
					"slug",
					"objective",
					"run_id",
					"state",
					"phase",
					"first_freeze_at",
					"frozen_at",
					"pending_user_input",
					"pending_input_kind",
					"pending_input_thread_id",
					"reopen_count",
					"artifact_root",
					"paused_workstream_ids",
					"analyst_session_id",
					"execution_director_session_id",
					"coordinator_session_id",
					"architect_session_id",
					"paused_lead_names",
					"pause_reason",
					"current_node",
					"started_at",
					"completed_at",
					"created_at",
					"updated_at",
					"learnings_extracted",
					"tier",
					"has_emitted_ws_producer_write",
					"autonomy",
					"feature_branch",
					"parent_mission_id",
					"learnings_extracted_at",
				],
			});
		},
		detect: (db) => {
			const schemaRow = db
				.prepare<{ sql: string }, []>(
					"SELECT sql FROM sqlite_master WHERE type='table' AND name='missions'",
				)
				.get();
			return !!schemaRow && schemaRow.sql.includes("'pre-pr'");
		},
	},
	{
		version: 17,
		description: "Add task_id column to missions (auto-issue-link foundation)",
		up: (db) => {
			if (!hasColumn(db, "missions", "task_id")) {
				db.exec(
					"ALTER TABLE missions ADD COLUMN task_id TEXT CHECK (task_id IS NULL OR length(task_id) <= 64)",
				);
			}
		},
		detect: (db) => hasColumn(db, "missions", "task_id"),
	},
];

/** Convert a database row (snake_case) to a Mission object (camelCase). */
function rowToMission(row: MissionRow): Mission {
	return {
		id: row.id,
		slug: row.slug,
		objective: row.objective,
		runId: row.run_id,
		state: row.state as MissionState,
		phase: row.phase as MissionPhase,
		firstFreezeAt: row.first_freeze_at,
		pendingUserInput: row.pending_user_input === 1,
		pendingInputKind: row.pending_input_kind as PendingInputKind | null,
		pendingInputThreadId: row.pending_input_thread_id,
		reopenCount: row.reopen_count,
		artifactRoot: row.artifact_root,
		pausedWorkstreamIds: safeJsonParse(row.paused_workstream_ids, []),
		analystSessionId: row.analyst_session_id,
		executionDirectorSessionId: row.execution_director_session_id,
		coordinatorSessionId: row.coordinator_session_id,
		architectSessionId: row.architect_session_id,
		pausedLeadNames: safeJsonParse(row.paused_lead_names, []),
		pauseReason: row.pause_reason,
		currentNode: row.current_node ?? null,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		learningsExtracted: row.learnings_extracted === 1,
		tier: (row.tier as MissionTier | null) ?? null,
		hasEmittedWsProducerWrite: (row.has_emitted_ws_producer_write ?? 0) === 1,
		autonomy: (row.autonomy as MissionAutonomy | null) ?? "supervised",
		featureBranch: row.feature_branch ?? null,
		parentMissionId: row.parent_mission_id ?? null,
		taskId: row.task_id ?? null,
	};
}

interface MissionPrStateDbRow {
	mission_id: string;
	pr_number: number;
	pr_url: string;
	branch: string;
	created_at: string;
	last_ci_status: string | null;
	last_review_decision: string | null;
	approved_head_sha: string | null;
	merged_at: string | null;
}

function rowToPrState(r: MissionPrStateDbRow): MissionPrStateRow {
	return {
		missionId: r.mission_id,
		prNumber: r.pr_number,
		prUrl: r.pr_url,
		branch: r.branch,
		createdAt: r.created_at,
		lastCiStatus: r.last_ci_status,
		lastReviewDecision: r.last_review_decision,
		approvedHeadSha: r.approved_head_sha,
		mergedAt: r.merged_at,
	};
}

interface MissionPrCommentDbRow {
	mission_id: string;
	pr_number: number;
	comment_id: string;
	author: string;
	body: string;
	action: string | null;
	status: string;
	fix_cycles: number;
	detected_at: string;
	resolved_at: string | null;
}

function rowToPrComment(r: MissionPrCommentDbRow): MissionPrCommentRow {
	return {
		missionId: r.mission_id,
		prNumber: r.pr_number,
		commentId: r.comment_id,
		author: r.author,
		body: r.body,
		action: r.action,
		status: r.status,
		fixCycles: r.fix_cycles,
		detectedAt: r.detected_at,
		resolvedAt: r.resolved_at,
	};
}

/**
 * Create a new MissionStore backed by a SQLite database at the given path.
 *
 * Initializes with WAL mode and a 5-second busy timeout.
 * Creates the missions table and indexes if they do not already exist.
 */
export function createMissionStore(dbPath: string): MissionStore {
	const db = new Database(dbPath);

	// Configure for concurrent access from multiple agent processes.
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA busy_timeout = 5000");

	db.exec(CREATE_TABLE);

	// Run all migrations (idempotent — up() is guarded by column/constraint checks)
	ensureMigrations(db, MISSION_MIGRATIONS);

	db.exec(CREATE_INDEXES);

	const insertStmt = db.prepare<
		void,
		{
			$id: string;
			$slug: string;
			$objective: string;
			$run_id: string | null;
			$artifact_root: string | null;
			$started_at: string | null;
			$created_at: string;
			$updated_at: string;
			$tier: string | null;
			$autonomy: string;
			$feature_branch: string | null;
		}
	>(`
		INSERT INTO missions
			(id, slug, objective, run_id, artifact_root, started_at, created_at, updated_at, tier, autonomy, feature_branch)
		VALUES
			($id, $slug, $objective, $run_id, $artifact_root, $started_at, $created_at, $updated_at, $tier, $autonomy, $feature_branch)
	`);

	const getByIdStmt = db.prepare<MissionRow, { $id: string }>(`
		SELECT * FROM missions WHERE id = $id
	`);

	const getBySlugStmt = db.prepare<MissionRow, { $slug: string }>(`
		SELECT * FROM missions WHERE slug = $slug
	`);

	const getByRunIdStmt = db.prepare<MissionRow, { $run_id: string }>(`
		SELECT * FROM missions WHERE run_id = $run_id LIMIT 1
	`);

	const getActiveStmt = db.prepare<MissionRow, Record<string, never>>(`
		SELECT * FROM missions WHERE state = 'active' OR state = 'frozen'
		ORDER BY created_at DESC
		LIMIT 1
	`);

	const getActiveListStmt = db.prepare<MissionRow, Record<string, never>>(`
		SELECT * FROM missions WHERE state = 'active' OR state = 'frozen'
		ORDER BY created_at DESC
	`);

	const updateStateStmt = db.prepare<void, { $id: string; $state: string; $updated_at: string }>(`
		UPDATE missions SET state = $state, updated_at = $updated_at WHERE id = $id
	`);

	const deleteStmt = db.prepare<void, { $id: string }>(`
		DELETE FROM missions WHERE id = $id
	`);

	const updatePhaseStmt = db.prepare<void, { $id: string; $phase: string; $updated_at: string }>(`
		UPDATE missions SET phase = $phase, updated_at = $updated_at WHERE id = $id
	`);

	const freezeStmt = db.prepare<
		void,
		{
			$id: string;
			$kind: string;
			$thread_id: string | null;
			$updated_at: string;
		}
	>(`
		UPDATE missions
		SET state = 'frozen',
		    pending_user_input = 1,
		    pending_input_kind = $kind,
		    pending_input_thread_id = $thread_id,
		    first_freeze_at = COALESCE(first_freeze_at, $updated_at),
		    frozen_at = $updated_at,
		    updated_at = $updated_at
		WHERE id = $id
	`);

	const unfreezeStmt = db.prepare<void, { $id: string; $updated_at: string }>(`
		UPDATE missions
		SET state = 'active',
		    pending_user_input = 0,
		    pending_input_kind = NULL,
		    pending_input_thread_id = NULL,
		    frozen_at = NULL,
		    reopen_count = reopen_count + 1,
		    updated_at = $updated_at
		WHERE id = $id AND state = 'frozen'
	`);

	const updatePausedWorkstreamsStmt = db.prepare<
		void,
		{ $id: string; $paused_workstream_ids: string; $updated_at: string }
	>(`
		UPDATE missions
		SET paused_workstream_ids = $paused_workstream_ids, updated_at = $updated_at
		WHERE id = $id
	`);

	const updateArtifactRootStmt = db.prepare<
		void,
		{ $id: string; $artifact_root: string; $updated_at: string }
	>(`
		UPDATE missions SET artifact_root = $artifact_root, updated_at = $updated_at WHERE id = $id
	`);

	const bindSessionsStmt = db.prepare<
		void,
		{
			$id: string;
			$analyst_session_id: string | null;
			$execution_director_session_id: string | null;
			$coordinator_session_id: string | null;
			$architect_session_id: string | null;
			$updated_at: string;
		}
	>(`
		UPDATE missions
		SET analyst_session_id = COALESCE($analyst_session_id, analyst_session_id),
		    execution_director_session_id = COALESCE($execution_director_session_id, execution_director_session_id),
		    coordinator_session_id = COALESCE($coordinator_session_id, coordinator_session_id),
		    architect_session_id = COALESCE($architect_session_id, architect_session_id),
		    updated_at = $updated_at
		WHERE id = $id
	`);

	const bindCoordinatorSessionStmt = db.prepare<
		void,
		{ $id: string; $coordinator_session_id: string; $updated_at: string }
	>(`
		UPDATE missions
		SET coordinator_session_id = $coordinator_session_id, updated_at = $updated_at
		WHERE id = $id
	`);

	const updatePausedLeadsStmt = db.prepare<
		void,
		{ $id: string; $paused_lead_names: string; $updated_at: string }
	>(`
		UPDATE missions
		SET paused_lead_names = $paused_lead_names, updated_at = $updated_at
		WHERE id = $id
	`);

	const updatePauseReasonStmt = db.prepare<
		void,
		{ $id: string; $pause_reason: string | null; $updated_at: string }
	>(`
		UPDATE missions
		SET pause_reason = $pause_reason, updated_at = $updated_at
		WHERE id = $id
	`);

	const startStmt = db.prepare<void, { $id: string; $started_at: string; $updated_at: string }>(`
		UPDATE missions
		SET started_at = COALESCE(started_at, $started_at), updated_at = $updated_at
		WHERE id = $id
	`);

	const updateSlugStmt = db.prepare<void, { $id: string; $slug: string; $updated_at: string }>(`
		UPDATE missions SET slug = $slug, updated_at = $updated_at WHERE id = $id
	`);

	const updateObjectiveStmt = db.prepare<
		void,
		{ $id: string; $objective: string; $updated_at: string }
	>(`
		UPDATE missions SET objective = $objective, updated_at = $updated_at WHERE id = $id
	`);

	const updateCurrentNodeStmt = db.prepare<
		void,
		{ $id: string; $current_node: string; $updated_at: string }
	>(`
		UPDATE missions SET current_node = $current_node, updated_at = $updated_at WHERE id = $id
	`);

	const updateCurrentNodeWithPhaseStmt = db.prepare<
		void,
		{ $id: string; $current_node: string; $phase: string; $updated_at: string }
	>(`
		UPDATE missions SET current_node = $current_node, phase = $phase, updated_at = $updated_at WHERE id = $id
	`);

	const completeMissionStmt = db.prepare<
		void,
		{ $id: string; $completed_at: string; $updated_at: string }
	>(`
		UPDATE missions
		SET state = 'completed',
		    pending_user_input = 0,
		    pending_input_kind = NULL,
		    pending_input_thread_id = NULL,
		    frozen_at = NULL,
		    completed_at = $completed_at,
		    updated_at = $updated_at
		WHERE id = $id
	`);

	const markLearningsExtractedStmt = db.prepare<void, { $id: string; $updated_at: string }>(`
		UPDATE missions SET learnings_extracted = 1, updated_at = $updated_at WHERE id = $id
	`);

	const markProducerWrittenStmt = db.prepare<void, { $id: string; $updated_at: string }>(`
		UPDATE missions SET has_emitted_ws_producer_write = 1, updated_at = $updated_at WHERE id = $id
	`);

	return {
		create(mission: InsertMission): Mission {
			const now = new Date().toISOString();
			insertStmt.run({
				$id: mission.id,
				$slug: mission.slug,
				$objective: mission.objective,
				$run_id: mission.runId ?? null,
				$artifact_root: mission.artifactRoot ?? null,
				$started_at: mission.startedAt ?? null,
				$created_at: now,
				$updated_at: now,
				$tier: mission.tier ?? null,
				$autonomy: mission.autonomy ?? "supervised",
				$feature_branch: mission.featureBranch ?? null,
			});
			const row = getByIdStmt.get({ $id: mission.id });
			if (!row) {
				throw new Error(`Mission ${mission.id} not found after insert`);
			}
			return rowToMission(row);
		},

		getById(id: string): Mission | null {
			const row = getByIdStmt.get({ $id: id });
			return row ? rowToMission(row) : null;
		},

		getBySlug(slug: string): Mission | null {
			const row = getBySlugStmt.get({ $slug: slug });
			return row ? rowToMission(row) : null;
		},

		getByRunId(runId: string): Mission | null {
			const row = getByRunIdStmt.get({ $run_id: runId });
			return row ? rowToMission(row) : null;
		},

		getActive(): Mission | null {
			const row = getActiveStmt.get({});
			return row ? rowToMission(row) : null;
		},

		getActiveList(): Mission[] {
			const rows = getActiveListStmt.all({});
			return rows.map(rowToMission);
		},

		list(opts?: { state?: MissionState; limit?: number }): Mission[] {
			const hasState = opts?.state !== undefined;
			const hasLimit = opts?.limit !== undefined;

			if (hasState && hasLimit) {
				const rows = db
					.prepare<MissionRow, { $state: string; $limit: number }>(
						`SELECT * FROM missions WHERE state = $state ORDER BY created_at DESC LIMIT $limit`,
					)
					.all({ $state: opts?.state as string, $limit: opts?.limit as number });
				return rows.map(rowToMission);
			}
			if (hasState) {
				const rows = db
					.prepare<MissionRow, { $state: string }>(
						`SELECT * FROM missions WHERE state = $state ORDER BY created_at DESC`,
					)
					.all({ $state: opts?.state as string });
				return rows.map(rowToMission);
			}
			if (hasLimit) {
				const rows = db
					.prepare<MissionRow, { $limit: number }>(
						`SELECT * FROM missions ORDER BY created_at DESC LIMIT $limit`,
					)
					.all({ $limit: opts?.limit as number });
				return rows.map(rowToMission);
			}
			const rows = db
				.prepare<MissionRow, Record<string, never>>(
					`SELECT * FROM missions ORDER BY created_at DESC`,
				)
				.all({});
			return rows.map(rowToMission);
		},

		delete(id: string): void {
			deleteStmt.run({ $id: id });
		},

		updateState(id: string, state: MissionState): void {
			updateStateStmt.run({ $id: id, $state: state, $updated_at: new Date().toISOString() });
		},

		updatePhase(id: string, phase: MissionPhase): void {
			updatePhaseStmt.run({ $id: id, $phase: phase, $updated_at: new Date().toISOString() });
		},

		freeze(id: string, kind: PendingInputKind, threadId: string | null): void {
			const now = new Date().toISOString();
			freezeStmt.run({ $id: id, $kind: kind, $thread_id: threadId, $updated_at: now });
		},

		unfreeze(id: string): void {
			// Guard: AND state = 'frozen' ensures concurrent unfreezes are idempotent.
			// If the mission is not frozen, 0 rows are updated (no-op).
			unfreezeStmt.run({ $id: id, $updated_at: new Date().toISOString() });
		},

		updatePausedWorkstreams(id: string, ids: string[]): void {
			updatePausedWorkstreamsStmt.run({
				$id: id,
				$paused_workstream_ids: JSON.stringify(ids),
				$updated_at: new Date().toISOString(),
			});
		},

		updateArtifactRoot(id: string, path: string): void {
			updateArtifactRootStmt.run({
				$id: id,
				$artifact_root: path,
				$updated_at: new Date().toISOString(),
			});
		},

		bindSessions(
			id: string,
			sessions: {
				analystSessionId?: string;
				executionDirectorSessionId?: string;
				coordinatorSessionId?: string;
				architectSessionId?: string;
			},
		): void {
			bindSessionsStmt.run({
				$id: id,
				$analyst_session_id: sessions.analystSessionId ?? null,
				$execution_director_session_id: sessions.executionDirectorSessionId ?? null,
				$coordinator_session_id: sessions.coordinatorSessionId ?? null,
				$architect_session_id: sessions.architectSessionId ?? null,
				$updated_at: new Date().toISOString(),
			});
		},

		bindCoordinatorSession(id: string, sessionId: string): void {
			bindCoordinatorSessionStmt.run({
				$id: id,
				$coordinator_session_id: sessionId,
				$updated_at: new Date().toISOString(),
			});
		},

		updatePausedLeads(id: string, names: string[]): void {
			updatePausedLeadsStmt.run({
				$id: id,
				$paused_lead_names: JSON.stringify(names),
				$updated_at: new Date().toISOString(),
			});
		},

		updatePauseReason(id: string, reason: string | null): void {
			updatePauseReasonStmt.run({
				$id: id,
				$pause_reason: reason,
				$updated_at: new Date().toISOString(),
			});
		},

		start(id: string): void {
			const now = new Date().toISOString();
			startStmt.run({ $id: id, $started_at: now, $updated_at: now });
		},

		completeMission(id: string): void {
			const now = new Date().toISOString();
			completeMissionStmt.run({ $id: id, $completed_at: now, $updated_at: now });
		},

		updateSlug(id: string, slug: string): void {
			updateSlugStmt.run({ $id: id, $slug: slug, $updated_at: new Date().toISOString() });
		},

		updateObjective(id: string, objective: string): void {
			updateObjectiveStmt.run({
				$id: id,
				$objective: objective,
				$updated_at: new Date().toISOString(),
			});
		},

		updateCurrentNode(id: string, nodeId: string): void {
			const now = new Date().toISOString();
			// Auto-sync phase when nodeId is a lifecycle node (e.g., "plan:active", "execute:frozen").
			// Lifecycle nodes follow "phase:state" convention. Subgraph nodes use "phase-phase:name".
			const colonIdx = nodeId.indexOf(":");
			if (colonIdx > 0 && !nodeId.includes("-phase:")) {
				const possiblePhase = nodeId.slice(0, colonIdx);
				if (MISSION_PHASES.includes(possiblePhase as MissionPhase)) {
					updateCurrentNodeWithPhaseStmt.run({
						$id: id,
						$current_node: nodeId,
						$phase: possiblePhase,
						$updated_at: now,
					});
					return;
				}
			}
			updateCurrentNodeStmt.run({ $id: id, $current_node: nodeId, $updated_at: now });
		},

		markProducerWritten(id: string): void {
			markProducerWrittenStmt.run({
				$id: id,
				$updated_at: new Date().toISOString(),
			});
		},

		areAllWorkstreamsDone(missionId: string, plannedIds: readonly string[]): boolean {
			// Delegates to workstreams.ts helper; keeps the decision in one place.
			return areAllWorkstreamsDoneImpl(db, missionId, plannedIds);
		},

		markLearningsExtracted(id: string): void {
			markLearningsExtractedStmt.run({
				$id: id,
				$updated_at: new Date().toISOString(),
			});
		},

		updateWorkstreamStatus(
			missionId: string,
			workstreamId: string,
			status: string,
			updatedBy: string,
		): void {
			db.prepare(
				`INSERT INTO workstream_status (mission_id, workstream_id, status, updated_at, updated_by)
				 VALUES ($missionId, $wsId, $status, $now, $by)
				 ON CONFLICT(mission_id, workstream_id) DO UPDATE SET
				   status = $status, updated_at = $now, updated_by = $by`,
			).run({
				$missionId: missionId,
				$wsId: workstreamId,
				$status: status,
				$now: new Date().toISOString(),
				$by: updatedBy,
			});
		},

		checkpoints: createCheckpointStore(db),

		// === Gate state operations (for mission engine tick) ===
		// Prepared statements created once, matching the store's existing pattern.

		acquireTickLock: (() => {
			const clearStaleStmt = db.prepare(
				`DELETE FROM mission_tick_lock
				 WHERE mission_id = $id
				 AND (julianday($now) - julianday(locked_at)) * 86400 > $timeout`,
			);
			const acquireStmt = db.prepare(
				`INSERT OR IGNORE INTO mission_tick_lock (mission_id, locked_at, locked_by)
				 VALUES ($id, $now, $pid)`,
			);
			return (missionId: string, intervalMs: number): boolean => {
				const now = new Date().toISOString();
				const timeoutSec = (intervalMs * 2) / 1000;
				clearStaleStmt.run({ $id: missionId, $now: now, $timeout: timeoutSec });
				const result = acquireStmt.run({
					$id: missionId,
					$now: now,
					$pid: String(process.pid),
				});
				return result.changes > 0;
			};
		})(),

		releaseTickLock: (() => {
			const stmt = db.prepare("DELETE FROM mission_tick_lock WHERE mission_id = $id");
			return (missionId: string): void => {
				stmt.run({ $id: missionId });
			};
		})(),

		ensureGateState: (() => {
			const insertStmt = db.prepare(
				`INSERT OR IGNORE INTO mission_gate_state
				 (mission_id, node_id, entered_at, grace_ms, max_total_wait_ms)
				 VALUES ($missionId, $nodeId, $now, $graceMs, $maxTotalWaitMs)`,
			);
			const selectStmt = db.prepare<
				{
					entered_at: string;
					nudge_count: number;
					last_nudge_at: string | null;
					respawn_count: number;
					grace_ms: number;
					nudge_interval_ms: number;
					max_nudges: number;
					max_total_wait_ms: number;
					resolved_at: string | null;
					ceiling_emitted_at: string | null;
				},
				{ $missionId: string; $nodeId: string }
			>(
				`SELECT entered_at, nudge_count, last_nudge_at, respawn_count,
				        grace_ms, nudge_interval_ms, max_nudges, max_total_wait_ms,
				        resolved_at, ceiling_emitted_at
				 FROM mission_gate_state
				 WHERE mission_id = $missionId AND node_id = $nodeId`,
			);
			return (missionId: string, nodeId: string, graceMs: number, maxTotalWaitMs: number) => {
				insertStmt.run({
					$missionId: missionId,
					$nodeId: nodeId,
					$now: new Date().toISOString(),
					$graceMs: graceMs,
					$maxTotalWaitMs: maxTotalWaitMs,
				});
				const row = selectStmt.get({ $missionId: missionId, $nodeId: nodeId });
				if (!row) throw new Error(`Gate state not found for ${missionId}:${nodeId}`);
				return row;
			};
		})(),

		incrementNudgeCount: (() => {
			const stmt = db.prepare(
				`UPDATE mission_gate_state
				 SET nudge_count = nudge_count + 1, last_nudge_at = $now
				 WHERE mission_id = $missionId AND node_id = $nodeId`,
			);
			return (missionId: string, nodeId: string): void => {
				stmt.run({
					$missionId: missionId,
					$nodeId: nodeId,
					$now: new Date().toISOString(),
				});
			};
		})(),

		markCeilingEmitted: (() => {
			const stmt = db.prepare(
				`UPDATE mission_gate_state
				 SET ceiling_emitted_at = $now
				 WHERE mission_id = $missionId AND node_id = $nodeId`,
			);
			return (missionId: string, nodeId: string): void => {
				stmt.run({
					$missionId: missionId,
					$nodeId: nodeId,
					$now: new Date().toISOString(),
				});
			};
		})(),

		resolveGate: (() => {
			const stmt = db.prepare(
				`UPDATE mission_gate_state
				 SET resolved_at = $now, resolved_trigger = $trigger
				 WHERE mission_id = $missionId AND node_id = $nodeId`,
			);
			return (missionId: string, nodeId: string, trigger: string): void => {
				stmt.run({
					$missionId: missionId,
					$nodeId: nodeId,
					$now: new Date().toISOString(),
					$trigger: trigger,
				});
			};
		})(),

		resetGateState: (() => {
			const stmt = db.prepare(
				"DELETE FROM mission_gate_state WHERE mission_id = $missionId AND node_id = $nodeId",
			);
			return (missionId: string, nodeId: string): void => {
				stmt.run({ $missionId: missionId, $nodeId: nodeId });
			};
		})(),

		transaction<T>(fn: () => T): T {
			return db.transaction(fn)();
		},

		updateTier: (() => {
			const updateStmt = db.prepare(
				"UPDATE missions SET tier = $tier, updated_at = $now WHERE id = $id",
			);
			const logStmt = db.prepare(
				`INSERT INTO mission_tier_transitions (mission_id, from_tier, to_tier, triggered_by, created_at)
				 VALUES ($missionId, $fromTier, $toTier, $triggeredBy, $now)`,
			);
			return (id: string, newTier: MissionTier, triggeredBy?: string): void => {
				const row = getByIdStmt.get({ $id: id });
				if (!row) throw new Error(`Mission ${id} not found`);
				const currentTier = row.tier as MissionTier | null;
				if (currentTier !== null) {
					const currentOrder = TIER_ORDER[currentTier];
					const newOrder = TIER_ORDER[newTier];
					if (newOrder <= currentOrder) {
						throw new Error(`Cannot downgrade mission tier from ${currentTier} to ${newTier}`);
					}
				}
				const now = new Date().toISOString();
				updateStmt.run({ $id: id, $tier: newTier, $now: now });
				logStmt.run({
					$missionId: id,
					$fromTier: currentTier,
					$toTier: newTier,
					$triggeredBy: triggeredBy ?? null,
					$now: now,
				});
			};
		})(),

		clearGateStates: (() => {
			const stmt = db.prepare("DELETE FROM mission_gate_state WHERE mission_id = $missionId");
			return (missionId: string): void => {
				stmt.run({ $missionId: missionId });
			};
		})(),

		clearCheckpoints: (() => {
			const stmt = db.prepare("DELETE FROM mission_node_checkpoints WHERE mission_id = $missionId");
			return (missionId: string): void => {
				stmt.run({ $missionId: missionId });
			};
		})(),

		// === PR phase state (Stage E) ===

		getPrState: (() => {
			const stmt = db.prepare<MissionPrStateDbRow, { $missionId: string }>(
				"SELECT * FROM mission_pr_state WHERE mission_id = $missionId",
			);
			return (missionId: string): MissionPrStateRow | null => {
				const row = stmt.get({ $missionId: missionId });
				return row ? rowToPrState(row) : null;
			};
		})(),

		upsertPrState: (() => {
			const stmt = db.prepare<
				void,
				{
					$mission_id: string;
					$pr_number: number;
					$pr_url: string;
					$branch: string;
					$created_at: string;
					$last_ci_status: string | null;
					$last_review_decision: string | null;
					$approved_head_sha: string | null;
					$merged_at: string | null;
				}
			>(
				`INSERT OR REPLACE INTO mission_pr_state
				 (mission_id, pr_number, pr_url, branch, created_at, last_ci_status,
				  last_review_decision, approved_head_sha, merged_at)
				 VALUES ($mission_id, $pr_number, $pr_url, $branch, $created_at, $last_ci_status,
				  $last_review_decision, $approved_head_sha, $merged_at)`,
			);
			return (row: MissionPrStateRow): void => {
				stmt.run({
					$mission_id: row.missionId,
					$pr_number: row.prNumber,
					$pr_url: row.prUrl,
					$branch: row.branch,
					$created_at: row.createdAt,
					$last_ci_status: row.lastCiStatus,
					$last_review_decision: row.lastReviewDecision,
					$approved_head_sha: row.approvedHeadSha,
					$merged_at: row.mergedAt,
				});
			};
		})(),

		updatePrCiStatus: (() => {
			const stmt = db.prepare<void, { $status: string; $missionId: string }>(
				"UPDATE mission_pr_state SET last_ci_status = $status WHERE mission_id = $missionId",
			);
			return (missionId: string, status: string): void => {
				stmt.run({ $status: status, $missionId: missionId });
			};
		})(),

		updatePrReviewDecision: (() => {
			const stmt = db.prepare<void, { $decision: string; $missionId: string }>(
				"UPDATE mission_pr_state SET last_review_decision = $decision WHERE mission_id = $missionId",
			);
			return (missionId: string, decision: string): void => {
				stmt.run({ $decision: decision, $missionId: missionId });
			};
		})(),

		setApprovedHeadSha: (() => {
			const stmt = db.prepare<void, { $sha: string; $missionId: string }>(
				"UPDATE mission_pr_state SET approved_head_sha = $sha WHERE mission_id = $missionId",
			);
			return (missionId: string, sha: string): void => {
				stmt.run({ $sha: sha, $missionId: missionId });
			};
		})(),

		markPrMerged: (() => {
			const stmt = db.prepare<void, { $mergedAt: string; $missionId: string }>(
				"UPDATE mission_pr_state SET merged_at = $mergedAt WHERE mission_id = $missionId",
			);
			return (missionId: string, mergedAt: string): void => {
				stmt.run({ $mergedAt: mergedAt, $missionId: missionId });
			};
		})(),

		listPrComments: (() => {
			const stmt = db.prepare<MissionPrCommentDbRow, { $missionId: string }>(
				"SELECT * FROM mission_pr_comments WHERE mission_id = $missionId ORDER BY detected_at ASC",
			);
			return (missionId: string): MissionPrCommentRow[] => {
				return stmt.all({ $missionId: missionId }).map(rowToPrComment);
			};
		})(),

		countTriageSpawnsSince: (() => {
			const stmt = db.prepare<{ count: number }, { $missionId: string; $since: string }>(
				`SELECT COUNT(*) as count FROM mission_pr_comments
				 WHERE mission_id = $missionId AND status = 'in_progress' AND detected_at > $since`,
			);
			return (missionId: string, since: string): number => {
				const row = stmt.get({ $missionId: missionId, $since: since });
				return row?.count ?? 0;
			};
		})(),

		countTriagePerAuthorSince: (() => {
			const stmt = db.prepare<
				{ count: number },
				{ $missionId: string; $author: string; $since: string }
			>(
				`SELECT COUNT(*) as count FROM mission_pr_comments
				 WHERE mission_id = $missionId AND author = $author AND status = 'in_progress' AND detected_at > $since`,
			);
			return (missionId: string, author: string, since: string): number => {
				const row = stmt.get({ $missionId: missionId, $author: author, $since: since });
				return row?.count ?? 0;
			};
		})(),

		recordPrComment: (() => {
			const stmt = db.prepare<
				void,
				{
					$mission_id: string;
					$pr_number: number;
					$comment_id: string;
					$author: string;
					$body: string;
					$action: string | null;
					$status: string;
					$fix_cycles: number;
					$detected_at: string;
					$resolved_at: string | null;
				}
			>(
				`INSERT INTO mission_pr_comments
				 (mission_id, pr_number, comment_id, author, body, action, status, fix_cycles, detected_at, resolved_at)
				 VALUES ($mission_id, $pr_number, $comment_id, $author, $body, $action, $status, $fix_cycles, $detected_at, $resolved_at)
				 ON CONFLICT(comment_id) DO UPDATE SET
				   body = excluded.body,
				   author = excluded.author`,
			);
			return (row: MissionPrCommentRow): void => {
				stmt.run({
					$mission_id: row.missionId,
					$pr_number: row.prNumber,
					$comment_id: row.commentId,
					$author: row.author,
					$body: row.body,
					$action: row.action,
					$status: row.status,
					$fix_cycles: row.fixCycles,
					$detected_at: row.detectedAt,
					$resolved_at: row.resolvedAt,
				});
			};
		})(),

		updatePrCommentAction: (() => {
			const stmt = db.prepare<void, { $action: string; $status: string; $commentId: string }>(
				"UPDATE mission_pr_comments SET action = $action, status = $status WHERE comment_id = $commentId",
			);
			return (commentId: string, action: string, status: string): void => {
				stmt.run({ $action: action, $status: status, $commentId: commentId });
			};
		})(),

		tryClaimTriageSlot: (() => {
			const countStmt = db.prepare<
				{ count: number },
				{ $missionId: string; $since: string; $commentId: string }
			>(
				`SELECT COUNT(*) as count FROM mission_pr_comments
				 WHERE mission_id = $missionId
				   AND status = 'in_progress'
				   AND detected_at > $since
				   AND comment_id != $commentId`,
			);
			const updateStmt = db.prepare<void, { $commentId: string }>(
				`UPDATE mission_pr_comments
				 SET action = 'pending', status = 'in_progress'
				 WHERE comment_id = $commentId`,
			);
			return (missionId: string, commentId: string, prStart: string, cap: number): boolean => {
				const tx = db.transaction(() => {
					const row = countStmt.get({
						$missionId: missionId,
						$since: prStart,
						$commentId: commentId,
					});
					const count = row?.count ?? 0;
					if (count >= cap) return false;
					updateStmt.run({ $commentId: commentId });
					return true;
				});
				return tx();
			};
		})(),

		markPrCommentResolved: (() => {
			const stmt = db.prepare<void, { $resolvedAt: string; $commentId: string }>(
				"UPDATE mission_pr_comments SET resolved_at = $resolvedAt, status = 'responded' WHERE comment_id = $commentId",
			);
			return (commentId: string): void => {
				stmt.run({ $resolvedAt: new Date().toISOString(), $commentId: commentId });
			};
		})(),

		setParentMissionId: (() => {
			const stmt = db.prepare<void, { $id: string; $pmid: string; $updated_at: string }>(
				"UPDATE missions SET parent_mission_id = $pmid, updated_at = $updated_at WHERE id = $id",
			);
			return (missionId: string, parentMissionId: string): void => {
				stmt.run({ $id: missionId, $pmid: parentMissionId, $updated_at: new Date().toISOString() });
			};
		})(),

		setTaskId: (() => {
			const stmt = db.prepare<void, { $id: string; $task_id: string | null; $updated_at: string }>(
				"UPDATE missions SET task_id = $task_id, updated_at = $updated_at WHERE id = $id",
			);
			return (missionId: string, taskId: string | null): void => {
				stmt.run({ $id: missionId, $task_id: taskId, $updated_at: new Date().toISOString() });
			};
		})(),

		setSuperseded: (() => {
			const stmt = db.prepare<void, { $id: string; $updated_at: string }>(
				"UPDATE missions SET state = 'superseded', current_node = 'done:superseded', phase = 'done', updated_at = $updated_at WHERE id = $id",
			);
			return (missionId: string): void => {
				stmt.run({ $id: missionId, $updated_at: new Date().toISOString() });
			};
		})(),

		close(): void {
			try {
				db.exec("PRAGMA wal_checkpoint(PASSIVE)");
			} catch {
				// Best effort -- checkpoint failure is non-fatal
			}
			db.close();
		},
	};
}

/** Get the frozen_at timestamp for a mission. */
export function getMissionFrozenAt(dbPath: string, missionId: string): string | null {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 5000");
	try {
		const row = db
			.prepare<{ frozen_at: string | null }, { $id: string }>(
				"SELECT frozen_at FROM missions WHERE id = $id",
			)
			.get({ $id: missionId });
		return row?.frozen_at ?? null;
	} finally {
		db.close();
	}
}

/** Append a thread ID to the frozen mission's pending_input_thread_id (JSON array). */
export function appendMissionThreadId(dbPath: string, missionId: string, threadId: string): void {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 5000");
	try {
		const appendTx = db.transaction(() => {
			const row = db
				.prepare<{ pending_input_thread_id: string | null }, { $id: string }>(
					"SELECT pending_input_thread_id FROM missions WHERE id = $id",
				)
				.get({ $id: missionId });
			let ids: string[];
			const current = row?.pending_input_thread_id;
			if (!current) {
				ids = [];
			} else if (current.startsWith("[")) {
				ids = JSON.parse(current) as string[];
			} else {
				ids = [current];
			}
			if (!ids.includes(threadId)) {
				ids.push(threadId);
			}
			db.prepare(
				"UPDATE missions SET pending_input_thread_id = $thread_ids, updated_at = $updated_at WHERE id = $id",
			).run({
				$id: missionId,
				$thread_ids: JSON.stringify(ids),
				$updated_at: new Date().toISOString(),
			});
		});
		appendTx();
	} finally {
		db.close();
	}
}

/** Check if a frozen mission has exceeded its timeout. Returns info for caller to act on. */
export function checkMissionFreezeTimeout(
	dbPath: string,
	missionId: string,
	timeoutMs: number,
): { timedOut: boolean; frozenAt: string | null; elapsedMs: number } {
	const frozenAt = getMissionFrozenAt(dbPath, missionId);
	if (!frozenAt) {
		return { timedOut: false, frozenAt: null, elapsedMs: 0 };
	}
	const elapsedMs = Date.now() - new Date(frozenAt).getTime();
	return { timedOut: elapsedMs >= timeoutMs, frozenAt, elapsedMs };
}

/** Record a workstream dispatch event in the audit log. */
export function logMissionDispatch(dbPath: string, missionId: string, workstreamId: string): void {
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 5000");
	try {
		// Ensure table exists (idempotent)
		db.exec(`
			CREATE TABLE IF NOT EXISTS dispatch_log (
				mission_id TEXT NOT NULL,
				workstream_id TEXT NOT NULL,
				dispatched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
				PRIMARY KEY (mission_id, workstream_id)
			)
		`);
		db.prepare(
			"INSERT OR IGNORE INTO dispatch_log (mission_id, workstream_id) VALUES ($mission_id, $workstream_id)",
		).run({ $mission_id: missionId, $workstream_id: workstreamId });
	} finally {
		db.close();
	}
}
