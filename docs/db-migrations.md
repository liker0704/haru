# Database Migrations

This document is the contributor guide for Haru's SQLite migration
framework. It covers the framework API, PRAGMA user_version versioning, the
shared-version constraint for co-resident stores, idempotency requirements,
WAL mode setup, and walkthroughs for adding migrations to existing stores
and bootstrapping new stores.

---

## 1. Overview

All SQLite stores in Haru use a shared migration framework in
`src/db/migrate.ts`. Migrations are defined as a `Migration[]` array with
a `version` number, a description, an `up()` function, and an optional
`detect()` function for bootstrapping pre-versioned databases.

The framework provides two migration runners:

| Runner | When to use |
|--------|------------|
| `applyMigrations()` | Stores with independent `user_version` (most stores) |
| `ensureMigrations()` | Stores with idempotent `up()` functions that may run repeatedly |

Both runners use `BEGIN IMMEDIATE` to hold an exclusive lock for the minimum
possible duration and set `user_version` atomically with the DDL.

---

## 2. Mandatory Store Setup

Every store, without exception, must execute these two pragmas immediately after
opening the database:

```typescript
import { Database } from "bun:sqlite";

const db = new Database(dbPath);
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA busy_timeout=5000");
```

**WAL mode** enables concurrent reads from multiple agent processes without
blocking writes. Haru agents read and write concurrently; the default
journal mode causes deadlocks under load.

**busy_timeout=5000** instructs SQLite to retry for up to 5 seconds when it
encounters a locked database, rather than returning `SQLITE_BUSY` immediately.
This handles transient lock contention between the watchdog daemon, agent hooks,
and dashboard poll loop.

Omitting either pragma is a bug. Tests will pass but production deployments will
experience intermittent errors.

---

## 3. The Migration Array Format

**Source:** [`src/db/migrate.ts`](../src/db/migrate.ts)

```typescript
export interface Migration {
  version: number;
  description: string;
  up: (db: Database) => void;
  detect?: (db: Database, columns: Set<string>) => boolean;
}
```

- **`version`** — monotonically increasing integer. The framework applies only
  migrations with `version > current_user_version`.
- **`description`** — human-readable description for logging and debugging.
- **`up(db)`** — DDL and DML to apply. Called inside `BEGIN IMMEDIATE`.
- **`detect?(db, columns)`** — optional. Called by `bootstrapSchemaVersion()` to
  detect whether a pre-versioned database already has this migration applied.
  Receives the current column set for the target table as a convenience.

### Example Migration Array

```typescript
const MY_MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "initial schema",
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS my_table (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
    },
    detect: (_db, columns) => columns.has("id"),
  },
  {
    version: 2,
    description: "add status column",
    up: (db) => {
      if (!hasColumn(db, "my_table", "status")) {
        db.exec("ALTER TABLE my_table ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
      }
    },
    detect: (_db, columns) => columns.has("status"),
  },
];
```

---

## 4. PRAGMA user_version

The framework uses SQLite's built-in `PRAGMA user_version` integer field to track
which migrations have been applied. No separate `schema_migrations` table is used.

```typescript
// Read current version
function getSchemaVersion(db: Database): number {
  const row = db.prepare("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

// Write version
function setSchemaVersion(db: Database, version: number): void {
  db.exec(`PRAGMA user_version = ${version}`);
}
```

`user_version` is set inside the `BEGIN IMMEDIATE` transaction after each
migration's `up()` completes. If the process crashes mid-migration, `user_version`
is left at the last successfully completed migration — the framework will resume
from that point on next startup.

---

## 5. Critical: Shared user_version in sessions.db

Several stores co-reside in a single database file — `sessions.db`:

- **SessionStore** (`sessions` table, `state_log` table)
- **RunStore** (`runs` table)
- **MissionStore** (`missions` table, `mission_gate_state` table,
  `mission_checkpoints` table, `mission_workstreams` table, etc.)

Because all three stores open the same `sessions.db` file, they share a single
`user_version` integer. This has one critical implication:

**Every `up()` function for co-resident stores MUST be idempotent.**

If `SessionStore` sets `user_version = 7` and `MissionStore` later runs its
migration 3 and sets `user_version = 3`, it would corrupt version tracking.
In practice, all stores in `sessions.db` use `ensureMigrations()` (which runs
all `up()` functions unconditionally) rather than `applyMigrations()` (which
skips migrations below the current version).

**Rules for co-resident stores:**

1. Use `ensureMigrations()`, not `applyMigrations()`.
2. Guard every schema change with a `hasColumn()` check or `CREATE TABLE IF NOT
   EXISTS` / `CREATE INDEX IF NOT EXISTS`.
3. Do not assume `user_version` accurately reflects which migrations from your
   store have run — it may reflect a version set by another co-resident store.

Standalone stores (`mail.db`, `metrics.db`, `events.db`, `merge-queue.db`,
`headroom.db`, `resilience.db`) have their own `user_version` and may safely use
either runner.

---

## 6. Migration Runners

### `applyMigrations(db, migrations)`

```typescript
function applyMigrations(db: Database, migrations: Migration[]): void
```

Applies only migrations with `version > current_user_version`. Wraps the entire
run in `BEGIN IMMEDIATE`. Sets `user_version` after each migration so a crash
leaves version at the last completed step.

Use for standalone stores where `user_version` is owned exclusively by this store.

**Pattern reference:** `src/mail/store.ts`

### `ensureMigrations(db, migrations)`

```typescript
function ensureMigrations(db: Database, migrations: Migration[]): void
```

Runs all `up()` functions unconditionally, then sets `user_version` to the latest
version. Safe only when all `up()` functions are idempotent (guarded by
`hasColumn()` or `IF NOT EXISTS`).

Use for co-resident stores in `sessions.db` (sessions, runs, missions).

**Pattern reference:** `src/sessions/store.ts`

---

## 7. Helper Functions

```typescript
// Check if a column exists in a table
function hasColumn(db: Database, table: string, column: string): boolean

// Get all column names for a table as a Set
function getColumns(db: Database, table: string): Set<string>

// Rebuild a table using rename-create-insert-drop (for CHECK constraint changes)
function rebuildTable(opts: RebuildOpts): void
```

### rebuildTable

SQLite does not support modifying CHECK constraints or dropping columns via `ALTER
TABLE`. Use `rebuildTable()` when the schema change requires replacing an existing
table:

```typescript
rebuildTable({
  db,
  table: "sessions",
  createSql: `CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    agent_name TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('booting','working','waiting','completed','stalled','zombie'))
  )`,
  columns: ["id", "agent_name", "state"],
  // Optional: map old column values during INSERT...SELECT
  selectExprs: {
    state: `CASE WHEN state = 'old_value' THEN 'new_value' ELSE state END`,
  },
});
```

### bootstrapSchemaVersion

```typescript
function bootstrapSchemaVersion(db: Database, table: string, migrations: Migration[]): void
```

Sets `user_version` for an existing database that was created before versioning
was introduced. It calls each migration's `detect()` callback to determine how
far the schema already is, then sets `user_version` to the highest detected
version. If `user_version` is already non-zero, it is a no-op.

---

## 8. How to Add a Migration to an Existing Store

### Step 1: Determine the runner type

- Standalone store (has its own `.db` file) → use `applyMigrations()`
- Co-resident in `sessions.db` → use `ensureMigrations()` and make `up()`
  idempotent

### Step 2: Add the migration to the array

Append an entry with `version = previous_max + 1`:

```typescript
// Existing array for a standalone store
const MY_MIGRATIONS: Migration[] = [
  // ...existing migrations...
  {
    version: 5,
    description: "add retry_count column to jobs table",
    up: (db) => {
      if (!hasColumn(db, "jobs", "retry_count")) {
        db.exec(
          "ALTER TABLE jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0",
        );
      }
    },
  },
];
```

For co-resident stores, the guard (`hasColumn` check) is mandatory, not optional.

### Step 3: Call the runner in the store's initializer

The runner is called once when the store is opened. If you are using `applyMigrations`,
also call `bootstrapSchemaVersion` before it if the store predates versioning:

```typescript
function openMyStore(dbPath: string): MyStore {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");

  // For standalone stores that predate user_version tracking:
  bootstrapSchemaVersion(db, "my_table", MY_MIGRATIONS);
  applyMigrations(db, MY_MIGRATIONS);

  // For co-resident stores:
  // ensureMigrations(db, MY_MIGRATIONS);

  return { /* store methods */ close: () => db.close() };
}
```

### Step 4: Write a test

Add a migration test in the store's test file that:
1. Creates an in-memory database (`:memory:`) or temp file with the old schema
2. Calls `applyMigrations()` / `ensureMigrations()`
3. Asserts the new column or constraint exists

---

## 9. How to Bootstrap a New Store

### Step 1: Define the initial schema and migrations

```typescript
// src/myfeature/store.ts

import { Database } from "bun:sqlite";
import { applyMigrations, hasColumn, type Migration } from "../db/migrate.ts";

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS my_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const MY_MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "initial schema",
    up: (db) => {
      db.exec(CREATE_TABLE);
      db.exec("CREATE INDEX IF NOT EXISTS idx_my_items_status ON my_items(status)");
    },
    detect: (db) => {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='my_items'")
        .get() as { name: string } | null;
      return !!row;
    },
  },
];
```

### Step 2: Write the factory function

```typescript
export interface MyStore {
  insert(item: { id: string; name: string }): void;
  getAll(): MyItem[];
  close(): void;
}

export function createMyStore(dbPath: string): MyStore {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  applyMigrations(db, MY_MIGRATIONS);

  return {
    insert(item) {
      db.prepare("INSERT INTO my_items (id, name) VALUES (?, ?)").run(item.id, item.name);
    },
    getAll() {
      return db.prepare("SELECT * FROM my_items").all() as MyItem[];
    },
    close() {
      db.close();
    },
  };
}
```

### Step 3: Add to ha init

If the store should be created when `ha init` runs, add the DB path to the init
command in `src/commands/init.ts`. The file is created lazily on first `Database()`
call — `ha init` only needs to list it so users know it exists.

---

## 10. Reference: mail.ts Migration Example

`src/mail/store.ts` is the most mature example. Key patterns it demonstrates:

- Version 1: detect-only migration (initial schema, `detect` checks table existence)
- Version 2: `rebuildTable()` to change CHECK constraints and add columns, with
  `selectExprs` for mapping old state values during `INSERT...SELECT`
- Version 3: `ALTER TABLE ADD COLUMN` with `hasColumn()` guard for the
  `mission_id` column
- Version 4: add a separate `mail_check_state` table for debounce tracking

It uses `ensureMigrations()` despite being a standalone store because its
`up()` functions were made idempotent early in development. Standalone stores
may use either runner as long as the idempotency contract matches the runner
choice.

The `rebuildTable()` call in version 2 demonstrates the correct pattern for
schema changes that SQLite's `ALTER TABLE` cannot express:

```typescript
up: (db) => {
  // Check if the rebuild is needed (idempotency guard)
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'").get();
  if (!row) return;
  // Check if current schema already matches the target
  const alreadyCurrent = /* inspect row.sql for required constraints */;
  if (alreadyCurrent) return;
  // Rebuild the table
  rebuildTable({ db, table: "messages", createSql: CREATE_TABLE, columns: [...] });
},
```

---

## 11. Reference: sessions.db Migration List

`src/sessions/store.ts` is the canonical example of co-resident migrations
sharing a single `user_version` in `sessions.db`. Three arrays combine via
`ensureMigrations()` in `createSessionStore()`: `SESSION_MIGRATIONS`,
`RUNS_MIGRATIONS`, and `STATE_LOG_MIGRATION`. Because all three stores share
one `PRAGMA user_version`, the idempotency contract from Section 5 applies in
full: every migration `up()` function must be idempotent.

### Version 12 — add tool_in_flight tracking columns

Version 12 adds `tool_in_flight_name TEXT` and `tool_in_flight_started_at
TEXT` to the `sessions` table via `ALTER TABLE ADD COLUMN`. Both additions are
guarded by `hasColumn()` — the mandatory pattern for all `ALTER TABLE` changes
in co-resident `sessions.db` stores.

**Source:** `src/sessions/store.ts` lines 364--377, description `"add
tool_in_flight tracking columns"`. The `detect` callback verifies that both
columns are present (`cols.has("tool_in_flight_started_at") &&
cols.has("tool_in_flight_name")`).

The columns are written by the tool-start hook handler (`setToolInFlight` in
`src/sessions/store.ts`, called from `src/commands/log.ts`) and cleared in two
situations: on tool-end (same handler nulls both columns) and on any transition
to `booting`, via the `CASE WHEN $state = 'booting' THEN NULL` expression in
`updateStateStmt` (`src/sessions/store.ts` lines 605--611).

The columns support the watchdog tool-hang rung. The hang threshold
(`toolHangMs`) is a daemon-option parameter only, defaulting to 900&thinsp;000 ms
(`src/watchdog/daemon.ts:1086`); it is not a `config.yaml` knob.

See also: [runbooks/watchdog-recovery.md](runbooks/watchdog-recovery.md)
section Tool-hang rung.
