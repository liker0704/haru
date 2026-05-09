# Recovery System

This document is the contributor guide for Overstory's swarm recovery system.
It covers the snapshot bundle format, the restore algorithm, the reconciliation
report, CLI usage, and failure modes.

---

## 1. What `ha snapshot` and `ha recover` Do

**`ha snapshot`** captures the full state of a running swarm into a portable
bundle on disk. The bundle includes all SQLite data and file-based agent state.
It is the primary mechanism for creating a recovery point before risky operations
or when diagnosing a degraded swarm.

**`ha recover`** restores a swarm from a snapshot bundle. It re-populates the
SQLite stores, writes agent file state, and reconciles the bundle against live
external state (tmux sessions and git worktrees). A reconciliation report
describes what was restored and lists operator actions for anything that could
not be restored automatically.

Typical workflow:

```
ha snapshot                       # Create recovery bundle
# ... disaster or migration ...
ha recover --bundle .overstory/snapshots/<id>
```

---

## 2. Source Files

| File | Purpose |
|------|---------|
| `src/recovery/types.ts` | `SwarmSnapshot`, `RecoveryBundleManifest`, `ReconciliationReport`, and option types |
| `src/recovery/snapshot.ts` | `createSnapshot()`, `exportSnapshotBundle()` |
| `src/recovery/restore.ts` | `restoreBundle()` and per-component restore functions |
| `src/recovery/reconcile.ts` | `reconcileSnapshot()` — external state validation |

---

## 3. Key Types

**Source:** `src/recovery/types.ts`

### `SwarmSnapshot`

```typescript
export interface SwarmSnapshot {
    snapshotId: string;           // "snap-" + ISO timestamp (colons/dots replaced)
    formatVersion: 1;
    createdAt: string;
    projectRoot: string;
    runId: string | null;
    missionId: string | null;     // First active mission at snapshot time
    sessions: AgentSession[];
    runs: Run[];
    missions: Mission[];
    mail: MailMessage[];
    mergeQueue: MergeEntry[];
    checkpoints: Record<string, SessionCheckpoint>;  // keyed by agentName
    handoffs: Record<string, SessionHandoff[]>;       // keyed by agentName
    identities: Record<string, AgentIdentity>;        // keyed by agentName
    worktreeStatus: WorktreeStatus[];
    metadata: {
        currentRunFile: string | null;    // content of current-run.txt
        sessionBranchFile: string | null; // content of session-branch.txt
        configHash: string | null;        // SHA-256 of config.yaml
    };
}
```

### `WorktreeStatus`

```typescript
export interface WorktreeStatus {
    path: string;
    branch: string;
    head: string;
    exists: boolean;
    hasUncommittedChanges: boolean;
}
```

### `ReconciliationReport`

```typescript
export type ComponentRestoreStatus = "restored" | "degraded" | "missing" | "skipped";
export type ReconciliationStatus = "restored" | "partial" | "failed";

export interface ReconciliationReport {
    bundleId: string;
    restoredAt: string;
    components: Array<{
        name: string;
        status: ComponentRestoreStatus;
        details: string;
    }>;
    overallStatus: ReconciliationStatus;
    operatorActions: string[];
}
```

`operatorActions` is a list of human-readable strings describing manual steps
the operator must take after restore (e.g., re-spawning missing agents).

---

## 4. Snapshot Bundle Format

**Source:** `src/recovery/snapshot.ts:292` (`exportSnapshotBundle`)

A bundle is a directory at `.overstory/snapshots/<snapshotId>/` (or a custom
output path). The manifest is written last as an atomicity signal — if
`manifest.json` exists, the bundle is complete.

```
.overstory/snapshots/snap-2026-05-09T.../
  manifest.json        # RecoveryBundleManifest (written last)
  snapshot.json        # Full SwarmSnapshot (all data)
  sessions.json        # { sessions, runs } extract
  mail.json            # { messages } extract
  merge-queue.json     # { entries } extract
```

`snapshot.json` contains the canonical data. The per-component extracts
(`sessions.json`, etc.) are convenience files for inspection — they are not used
during restore.

### What gets captured

| Data | Source | Captured |
|------|--------|---------|
| `AgentSession[]` | `sessions.db` SessionStore | Yes (by default, excludes completed) |
| `Run[]` | `sessions.db` RunStore | Yes |
| `Mission[]` | `sessions.db` MissionStore | Yes |
| `MailMessage[]` | `mail.db` MailStore | Yes (all states) |
| `MergeEntry[]` | `merge-queue.db` | Yes (all statuses) |
| `SessionCheckpoint` | `.overstory/agents/{name}/checkpoint.json` | Yes |
| `SessionHandoff[]` | `.overstory/agents/{name}/handoffs.json` | Yes |
| `AgentIdentity` | `.overstory/agents/{name}/identity.yaml` | Yes |
| git worktree content | git repo | No (not captured) |
| tmux session state | tmux | No (not captured) |
| Agent log files | `.overstory/logs/` | No (not captured) |

**Not captured:** git worktrees and tmux sessions are external state that cannot
be portably captured. The reconciliation step detects what is missing after restore
and tells the operator which agents need to be re-spawned.

### `SnapshotOptions`

```typescript
export interface SnapshotOptions {
    outputDir?: string;       // Override default snapshot directory
    agentFilter?: string[];   // Only capture sessions for these agent names
    includeCompleted?: boolean; // Include completed sessions (default: false)
}
```

By default, completed sessions are excluded to keep snapshot size manageable.
(`src/recovery/snapshot.ts:161`)

---

## 5. Restore Algorithm

**Source:** `src/recovery/restore.ts:279` (`restoreBundle`)

Restore runs in a fixed order designed to respect inter-store dependencies:

1. **Load bundle**: Reads `manifest.json` and validates `formatVersion === 1`.
   Then reads `snapshot.json`. Fails fast if either file is missing or corrupt.

2. **Sessions** → `sessions.db` via `store.upsert()`. Upsert is idempotent —
   safe to re-run if the database already has entries.

3. **Runs** → `sessions.db` via `store.createRun()`. Skips on primary key
   conflict (existing run IDs preserved).

4. **Missions** → `sessions.db`. Creates each mission, then updates `state` and
   `phase` if they differ from the defaults. Skips on ID conflict.

5. **Mail** → `mail.db` via `store.insert()`. Skips on ID conflict.

6. **Merge queue** → `merge-queue.db`. Only `pending` entries are re-enqueued;
   terminal entries (`merged`, `failed`, `conflict`, `compat_failed`) are
   intentionally not restored (`src/recovery/restore.ts:183`).

7. **Agent files** (parallel):
   - Checkpoints: `saveCheckpoint(agentsDir, checkpoint)` per agent
   - Handoffs: write `handoffs.json` per agent
   - Identities: `createIdentity(agentsDir, identity)` per agent

8. **Metadata files**: writes `current-run.txt` and `session-branch.txt` if
   present in snapshot.

9. **Reconciliation**: calls `reconcileSnapshot()` to check live external state
   (tmux, worktrees, PIDs) against snapshot sessions. Appends reconciliation
   components and operator actions to the report.

### `RestoreOptions`

```typescript
export interface RestoreOptions {
    bundlePath: string;
    skipWorktrees?: boolean;  // (reserved, not yet implemented)
    dryRun?: boolean;         // Validate + reconcile only, no data written
}
```

With `dryRun: true`, only bundle validation and reconciliation run. No SQLite
writes occur. Useful to inspect what a restore would do before committing.

---

## 6. Reconciliation

**Source:** `src/recovery/reconcile.ts:58` (`reconcileSnapshot`)

After data is restored, reconciliation checks whether the live external state
matches the snapshot. For each non-completed agent session:

- **tmux check**: `tmux has-session -t <tmuxSession>` (exit code 0 = alive)
- **Worktree check**: `existsSync(session.worktreePath)`
- **PID check**: `process.kill(pid, 0)` signal probe (null PID = skipped)

Component status per agent:

| tmux alive | Worktree exists | Status |
|-----------|-----------------|--------|
| Yes | Yes | `restored` |
| No | No | `missing` |
| One of each | — | `degraded` |

For `missing` agents: `operatorActions` includes `ha sling <task-id> --name <agentName>`.
For `degraded` agents: `operatorActions` includes `ha inspect <agentName>`.

The reconciler accepts injectable `deps` for testing:

```typescript
export interface ReconcileDeps {
    checkTmuxSession(sessionName: string): Promise<boolean>;
}
```

`overallStatus` is:
- `"restored"` if all active components are `restored` or `skipped`
- `"partial"` otherwise (never `"failed"` — partial is the worst outcome from
  `restoreBundle`)

(`src/recovery/reconcile.ts:42`)

---

## 7. CLI Usage

```bash
# Create a recovery bundle (default location: .overstory/snapshots/<id>/)
ha snapshot

# Create bundle with custom output directory
ha snapshot --output /tmp/my-bundle

# Snapshot only specific agents
ha snapshot --agent my-builder --agent my-scout

# Include completed sessions (excluded by default)
ha snapshot --include-completed

# Restore from a bundle
ha recover --bundle .overstory/snapshots/snap-2026-05-09T14-30-00-000Z

# Dry run: validate and reconcile without writing
ha recover --bundle .overstory/snapshots/snap-... --dry-run

# JSON output
ha snapshot --json
ha recover --bundle .overstory/snapshots/snap-... --json
```

---

## 8. Failure Modes

### What is restored vs. what is not

| Item | Restored | Notes |
|------|---------|-------|
| Agent sessions (non-completed) | Yes | Upsert, safe to re-run |
| Runs and missions | Yes | Skip on conflict |
| Mail messages | Yes | Skip on conflict; claimed/acked state preserved |
| Pending merge queue entries | Yes | Only `pending`; others skipped |
| Agent checkpoints and handoffs | Yes | Overwritten if already exist |
| Agent identities | Yes | May fail silently on permission errors |
| `current-run.txt`, `session-branch.txt` | Yes | Overwritten |
| git worktrees | No | Must be re-created manually or via `ha sling` |
| tmux sessions | No | Must be re-spawned via `ha sling` or `ha resume` |
| Agent log files | No | Logs are ephemeral; not captured |
| Events database (`events.db`) | No | Not captured in snapshot |
| Metrics database (`metrics.db`) | No | Not captured in snapshot |

### Common failure scenarios

**Bundle incomplete** (manifest.json missing): Indicates the snapshot process
was interrupted before completion. The bundle cannot be used for restore.
`restoreBundle` throws a `RecoveryError` at the `loadBundle` step.

**Mission restore with complex state**: Missions with `pending_user_input` or
`paused_workstreams` fields may need manual state correction after restore.
The reconciliation report always includes an operator action note when missions
are present in the snapshot (`src/recovery/restore.ts:338`).

**Non-pending merge entries not restored**: Entries in `merged`, `failed`,
`conflict`, or `compat_failed` status represent completed or terminal operations.
Re-enqueueing them would create duplicate merges. The reconciliation report notes
how many were skipped (`src/recovery/restore.ts:352`).

**Agent files partial restore**: If writing checkpoints or identities fails (e.g.,
permission denied), the `agent-files` component is marked `degraded`. The
`operatorActions` list directs the operator to inspect agent file state. Agent
processes that need their checkpoint restored can be re-synced via `ha snapshot`
on a healthy peer and selectively restored.

**Tmux and worktrees missing**: This is the normal post-restore state. `missing`
agents require `ha sling <task-id> --name <agentName>` to re-spawn. The
reconciliation report lists the exact commands needed.

---

## 9. Integration with `.overstory/` State

The recovery system reads from and writes to the standard `.overstory/` structure:

```
.overstory/
  sessions.db         ← sessions, runs, missions
  mail.db             ← mail messages
  merge-queue.db      ← merge queue
  agents/{name}/
    checkpoint.json   ← agent progress
    handoffs.json     ← session handoff records
    identity.yaml     ← agent identity
  current-run.txt     ← current run ID
  session-branch.txt  ← session branch name
  snapshots/          ← snapshot bundles
    snap-<id>/
      manifest.json
      snapshot.json
      sessions.json
      mail.json
      merge-queue.json
```

The snapshot directory is excluded from git by `.overstory/.gitignore` (wildcard
model). Snapshot bundles should be copied to external storage if they need to
survive beyond the local machine.
