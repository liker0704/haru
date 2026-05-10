# Merge System

This document is the contributor guide for Haru's merge system. It covers
the 4-tier conflict resolution algorithm, the merge queue, conflict history
tracking, compat checking, CLI usage, and instructions for extending the
resolver with new resolution strategies.

---

## 1. What `ha merge` Does

When agent workers complete tasks on separate branches, those branches need to be
integrated back into the canonical branch (typically `main`). `ha merge` handles
this integration through a **tiered conflict resolution pipeline** that escalates
from simple to complex approaches, stopping at the first tier that succeeds.

The merge pipeline:

1. Reads pending entries from the merge queue (`merge-queue.db`)
2. Checks compatibility between the incoming branch and canonical surfaces (`ha compat check`)
3. Attempts resolution through up to 4 tiers in order
4. Records conflict patterns to kura for future learning
5. Updates queue entry status and notifies the caller

---

## 2. Source Files

| File | Purpose |
|------|---------|
| `src/merge/types.ts` | Domain types: `MergeEntry`, `MergeResult`, `ConflictHistory`, `ResolutionTier` |
| `src/merge/queue.ts` | SQLite-backed FIFO queue: `createMergeQueue()` |
| `src/merge/resolver.ts` | 4-tier conflict resolution: `createMergeResolver()` |
| `src/commands/merge.ts` | CLI wiring for `ha merge` |
| `agents/merger.md` | Agent definition for merger workers |

---

## 3. Key Types

**Source:** `src/merge/types.ts:3`

```typescript
export type ResolutionTier = "clean-merge" | "auto-resolve" | "ai-resolve" | "reimagine";

export interface MergeEntry {
    branchName: string;
    taskId: string;
    missionId?: string | null;
    workstreamId?: string | null;
    agentName: string;
    filesModified: string[];
    enqueuedAt: string;
    status: "pending" | "merging" | "merged" | "conflict" | "failed" | "compat_failed";
    resolvedTier: ResolutionTier | null;
    compatReportPath?: string | null;
}

export interface MergeResult {
    entry: MergeEntry;
    success: boolean;
    tier: ResolutionTier;
    conflictFiles: string[];
    errorMessage: string | null;
    warnings: string[];
}
```

`warnings` is populated when auto-resolve skips files to prevent data loss (see
tier 2 below). `compat_failed` is a terminal status set when the compat gate
blocks the merge before any tier is attempted (`src/commands/merge.ts:175`).

`ConflictHistory` is assembled from kura records and used to skip tiers that
have historically failed for the same files:

```typescript
export interface ConflictHistory {
    skipTiers: ResolutionTier[];
    pastResolutions: string[];
    predictedConflictFiles: string[];
}
```

---

## 4. The 4-Tier Resolution Algorithm

**Source:** `src/merge/resolver.ts:676` (`createMergeResolver`)

Tiers are attempted in order. Each tier either succeeds (returns a `MergeResult`
with `success: true`) or leaves conflicts for the next tier. All tiers are run
inside a single `resolve()` call. If all enabled tiers fail, `git merge --abort`
is called and the entry is marked `failed`.

### Pre-flight

Before any tier runs, the resolver:

1. Checks out the canonical branch (skips if already on it)
2. Detects dirty tracked files — auto-commits os-eco runtime state files
   (`.overstory/`, `.suji/`, `.kura/`, etc.) and stashes any remaining dirty
   files so the merge can start cleanly (`src/merge/resolver.ts:710-741`)
3. Removes untracked files that would be overwritten by the incoming branch
4. Queries kura for conflict history (`queryConflictHistory`, line 625)

### Tier 1: Clean Merge

**Source:** `src/merge/resolver.ts:235` (`tryCleanMerge`)

```
git merge --no-edit <branchName>
```

If exit code is 0, the merge is clean. No conflict markers are present. The
resolver returns immediately with `tier: "clean-merge"`.

**Skip condition:** Never skipped. Always attempted first.

### Tier 2: Auto-Resolve

**Source:** `src/merge/resolver.ts:256` (`tryAutoResolve`)

Parses conflict markers (`<<<<<<< HEAD` / `=======` / `>>>>>>> branch`) file by
file. Two strategies are available:

- **Union** (`merge=union` gitattribute): keeps all lines from both sides
  concatenated. Used for append-only files (e.g., SQLite WAL logs).
- **Keep-incoming**: discards the canonical (HEAD) side, keeps the agent's
  changes.

**Data-loss guard:** Before applying keep-incoming, `hasContentfulCanonical()`
(`src/merge/resolver.ts:193`) checks whether the canonical side has non-whitespace
content. If it does, the file is escalated to higher tiers instead of silently
discarding canonical work. This produces a `warning` in `MergeResult.warnings`.

If any files remain after auto-resolve, they are passed to tier 3.

**Skip condition:** Skipped if `conflictHistory.skipTiers` includes `"auto-resolve"`
(i.e., this tier has failed >= 2 times for these files without ever succeeding).

### Tier 3: AI-Resolve

**Source:** `src/merge/resolver.ts:340` (`tryAiResolve`)

Enabled only when `config.merge.aiResolveEnabled` is `true` (configured in
`config.yaml`).

For each conflicted file, spawns `claude --print` (or the configured
`runtime.printCommand`) with a prompt containing:

- The raw file content including conflict markers
- Historical context from `ConflictHistory.pastResolutions`
- Instructions to output only resolved file content with no explanation

**Prose detection guard:** `looksLikeProse()` (`src/merge/resolver.ts:314`)
validates that the LLM response looks like code, not conversational prose. Common
patterns like `"I need permission"`, `"Here's the resolved..."`, or leading
markdown fencing cause the file to be escalated to tier 4.

**Skip condition:** Skipped if `aiResolveEnabled` is false, or if
`conflictHistory.skipTiers` includes `"ai-resolve"`.

### Tier 4: Reimagine

**Source:** `src/merge/resolver.ts:415` (`tryReimagine`)

Enabled only when `config.merge.reimagineEnabled` is `true`.

This is a last resort. The algorithm:

1. Aborts the current in-progress merge (`git merge --abort`)
2. For each file in `entry.filesModified`:
   - File deleted on branch → `git rm`
   - File new on branch → write and `git add`
   - Both sides exist → prompts the LLM with both full file versions to
     reimplement the agent's intent on top of canonical
3. Commits the reimagined changes with message:
   `Reimagine merge: <branch> onto <canonicalBranch>`

**Skip condition:** Skipped if `reimagineEnabled` is false, or if
`conflictHistory.skipTiers` includes `"reimagine"`.

### Failure

If all enabled tiers fail, any in-progress merge is aborted and the final
`MergeResult` has `success: false` with `errorMessage` describing which tier was
last attempted.

---

## 5. Merge Queue

**Source:** `src/merge/queue.ts:23` (`MergeQueue` interface)

The merge queue is a SQLite-backed FIFO store at `.overstory/merge-queue.db`.
WAL mode and 5-second busy timeout support concurrent access from multiple agents.

### Schema

```sql
CREATE TABLE merge_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_name TEXT NOT NULL,
  task_id TEXT NOT NULL,
  mission_id TEXT,
  workstream_id TEXT,
  agent_name TEXT NOT NULL,
  files_modified TEXT NOT NULL DEFAULT '[]',
  enqueued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','merging','merged','conflict','failed','compat_failed')),
  resolved_tier TEXT
    CHECK(resolved_tier IS NULL OR
          resolved_tier IN ('clean-merge','auto-resolve','ai-resolve','reimagine')),
  compat_report_path TEXT
)
```

`files_modified` is stored as a JSON array string. `workstream_id` is backfilled
from `.overstory/specs/<taskId>.meta.json` during migration v3 for gate evaluator
compatibility (`src/merge/queue.ts:139`).

### Public API

```typescript
export interface MergeQueue {
    enqueue(entry): MergeEntry;
    dequeue(): MergeEntry | null;        // FIFO, removes entry
    peek(): MergeEntry | null;            // FIFO, non-destructive
    list(status?: MergeEntry["status"]): MergeEntry[];
    listByMission(missionId: string): MergeEntry[];
    dequeueByMission(missionId: string): MergeEntry | null;
    updateStatus(branchName, status, tier?): void;
    updateCompatReportPath(branchName, reportPath): void;
    close(): void;
}
```

Factory: `createMergeQueue(dbPath: string, projectRoot?: string): MergeQueue`

Pass `projectRoot` when creating from a live session so migration v3 can backfill
`workstream_id`. Omit it in snapshot/restore contexts.

---

## 6. Conflict History Tracking

**Source:** `src/merge/resolver.ts:518` (`parseConflictPatterns`,
`buildConflictHistory`)

After each non-clean merge, the resolver records a pattern to kura via
`recordConflictPattern()` (line 643). The description follows a fixed format so
`parseConflictPatterns()` can regex-extract it on future merges:

```
Merge conflict resolved at tier auto-resolve. Branch: haru/agent/task-id.
Agent: my-builder. Conflicting files: src/foo.ts, src/bar.ts.
```

On subsequent merges involving the same files, `buildConflictHistory()` (line 566)
assembles a `ConflictHistory` by:

1. Filtering patterns to those sharing files with the current entry
2. Counting successes and failures per tier
3. Adding any tier with `failures >= 2 && successes === 0` to `skipTiers`
4. Collecting descriptions of successful resolutions into `pastResolutions` for
   AI prompt enrichment

This makes the resolver progressively smarter without any manual configuration.

---

## 7. Compat Check Integration

**Source:** `src/commands/merge.ts:175` (`compatConfig`)

Before calling the resolver, `ha merge` runs a compatibility gate via
`runCompatGate()` from `src/compat/gate.ts`. The gate compares the incoming
branch's surface hashes against canonical, scoring conflicts by semantic
similarity.

If the gate blocks:
- The queue entry status is set to `compat_failed`
- `updateCompatReportPath()` stores the path of the written report
- The compat report is printed in human-readable form via `formatCompatReport()`

Config keys that control compat behavior (`src/commands/merge.ts:176`):

| Key | Default | Effect |
|-----|---------|--------|
| `compat.enabled` | `true` | Enable/disable the gate |
| `compat.skipPatterns` | os-eco paths | Glob patterns to ignore |
| `compat.aiThreshold` | `3` | Minimum AI conflict score to block |
| `compat.strictMode` | `false` | Block on any conflict vs. threshold |

---

## 8. CLI Usage

```bash
# Merge a specific branch
ha merge --branch haru/my-agent/task-123

# Merge all pending branches from the queue
ha merge --all

# Merge into a specific target branch (default: canonical from config)
ha merge --branch haru/my-agent/task-123 --into main

# Preview what would be merged without making changes
ha merge --all --dry-run

# JSON output for scripting
ha merge --all --json
```

`ha compat check <branch>` can be run independently to inspect compatibility
before merging:

```bash
ha compat check haru/my-agent/task-123
```

---

## 9. Adding a New Resolution Strategy (Contributor Guide)

### Step 1: Implement the tier function

Add a new `try<Name>` async function in `src/merge/resolver.ts`. The function
receives the conflict files and repo root, writes resolved content to disk, and
calls `git add`. Return `{ success: boolean, remainingConflicts: string[] }`.

```typescript
async function tryMyStrategy(
    conflictFiles: string[],
    repoRoot: string,
): Promise<{ success: boolean; remainingConflicts: string[] }> {
    // Resolve each file...
    // Call: await runGit(repoRoot, ["add", file])
    // If all resolved: await runGit(repoRoot, ["commit", "--no-edit"])
    return { success: true, remainingConflicts: [] };
}
```

### Step 2: Add a new tier value

In `src/merge/types.ts:3`, add the new tier to `ResolutionTier`:

```typescript
export type ResolutionTier =
    | "clean-merge"
    | "auto-resolve"
    | "ai-resolve"
    | "reimagine"
    | "my-strategy";
```

Update the SQL CHECK constraint in `src/merge/queue.ts:69` to include the new
value, and add a migration version to `MIGRATIONS` so existing databases are
updated.

### Step 3: Wire into the resolver

In `createMergeResolver()` (`src/merge/resolver.ts:676`), add a new option for
the tier and call your function between the existing tiers. Follow the same
pattern: check `options.myStrategyEnabled && !history.skipTiers.includes(...)`,
call your function, return on success, pass remaining conflicts forward.

### Step 4: Expose the option

Add `myStrategyEnabled: boolean` to the options parameter of
`createMergeResolver()` and thread it through from `src/commands/merge.ts`, which
reads it from `config.merge`.

### Step 5: Write tests

Add test cases to `src/merge/resolver.test.ts` covering:
- Tier succeeds: returns correct `MergeResult` with your tier name
- Tier fails: falls through to next tier
- Skip-tier logic: skipped when included in `history.skipTiers`
