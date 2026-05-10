# Tracker Adapters

This document is the contributor guide for Haru's task tracker subsystem.
It covers the `TrackerClient` interface, the three built-in adapters (suji,
beads, GitHub), the factory and auto-detection logic, the GitHub poller, and
a walkthrough for adding a new adapter.

---

## 1. Architecture Overview

Every tracker operation in Haru goes through a unified `TrackerClient`
interface. The orchestrator never calls tracker CLIs directly — it obtains a
client from the factory and calls interface methods.

```
src/tracker/
  types.ts          # TrackerClient interface + TrackerIssue type
  factory.ts        # createTrackerClient() + resolveBackend()
  suji.ts          # Suji adapter (su CLI)
  beads.ts          # Beads adapter (bd CLI via createBeadsClient)
  github.ts         # GitHub Issues adapter (gh CLI)
  github-poller.ts  # Background GitHub → coordinator dispatch daemon
```

The factory is the only module that imports concrete adapter implementations.
Everything else depends on `TrackerClient` via the interface.

---

## 2. The TrackerClient Interface

**Source:** [`src/tracker/types.ts`](../src/tracker/types.ts)

```typescript
export interface TrackerClient {
  /** List issues that are ready for work (open, unblocked). */
  ready(): Promise<TrackerIssue[]>;

  /** Show details for a specific issue. */
  show(id: string): Promise<TrackerIssue>;

  /** Create a new issue. Returns the new issue ID. */
  create(
    title: string,
    options?: { type?: string; priority?: number; description?: string },
  ): Promise<string>;

  /** Claim an issue (mark as in_progress). */
  claim(id: string): Promise<void>;

  /** Close an issue with an optional reason. */
  close(id: string, reason?: string): Promise<void>;

  /** List issues with optional filters. */
  list(options?: { status?: string; limit?: number }): Promise<TrackerIssue[]>;

  /** Sync tracker state with git (if supported). */
  sync(): Promise<void>;
}
```

### TrackerIssue Type

```typescript
export interface TrackerIssue {
  id: string;
  title: string;
  status: string;
  priority: number;
  type: string;
  assignee?: string;
  description?: string;
  blocks?: string[];
  blockedBy?: string[];
}
```

All adapters normalize their native issue format into this shape. Adapters that
lack a concept (e.g. GitHub has no `blocks`/`blockedBy`) leave those fields as
`undefined`.

---

## 3. Factory and Auto-Detection

**Source:** [`src/tracker/factory.ts`](../src/tracker/factory.ts)

### createTrackerClient

```typescript
function createTrackerClient(backend: TrackerBackend, cwd: string): TrackerClient
```

`TrackerBackend` is `"suji" | "beads" | "github"`. The factory delegates to the
appropriate adapter constructor:

| Backend | Adapter |
|---------|---------|
| `"suji"` | `createSujiTracker(cwd)` |
| `"beads"` | `createBeadsTracker(cwd)` |
| `"github"` | `createGitHubTracker(cwd)` |

TypeScript's exhaustive-check pattern (`const _exhaustive: never = backend`) ensures
the factory fails at compile time if a new `TrackerBackend` value is added without
a corresponding case.

### resolveBackend

```typescript
async function resolveBackend(
  configBackend: TaskTrackerBackend,
  cwd: string,
): Promise<TrackerBackend>
```

`TaskTrackerBackend` includes `"auto"` in addition to the three concrete values.
Auto-detection probes the filesystem and git remote in this order:

1. `"beads"` if `configBackend === "beads"` (pass-through)
2. `"suji"` if `configBackend === "suji"` (pass-through)
3. `"github"` if `configBackend === "github"` (pass-through)
4. `"suji"` if `.suji/` directory exists
5. `"beads"` if `.beads/` directory exists
6. `"github"` if `git remote get-url origin` returns a URL containing `github.com`
7. `"suji"` as the default fallback (preferred tracker for new projects)

### Configuration

The backend is configured in `.overstory/config.yaml`:

```yaml
taskTracker:
  enabled: true
  backend: auto   # "suji" | "beads" | "github" | "auto"
```

Local overrides belong in `.overstory/config.local.yaml` (not committed to git).

---

## 4. Suji Adapter

**Source:** [`src/tracker/suji.ts`](../src/tracker/suji.ts)

The suji adapter invokes the `su` CLI via `Bun.spawn`. Suji uses a
`{ success, command, ...data }` JSON envelope for all responses.

### CLI Invocation Pattern

```typescript
async function runSd(args, cwd, context): Promise<{ stdout, stderr }>
```

Exit code non-zero → throws `AgentError` with detail from stderr (or the envelope's
`error` field as fallback). Suji may emit non-JSON lines before the JSON object;
`parseSdJson()` finds the first `{` or `[` and parses from there.

### Method Mapping

| TrackerClient method | `su` command |
|---------------------|-------------|
| `ready()` | `su list --status ready --json` |
| `show(id)` | `su show <id> --json` |
| `create(title, opts)` | `su create <title> --json [--type ...] [--priority ...]` |
| `claim(id)` | `su claim <id>` |
| `close(id, reason)` | `su close <id> [--reason ...]` |
| `list(opts)` | `su list [--status ...] [--limit ...] --json` |
| `sync()` | `su sync` |

Priority normalization: Suji issues with no explicit priority get `priority: 3`
as the default.

---

## 5. Beads Adapter

**Source:** [`src/tracker/beads.ts`](../src/tracker/beads.ts)

The beads adapter wraps `src/beads/client.ts` (the beads-specific client) rather
than calling the `bd` CLI directly. `createBeadsTracker(cwd)` creates a
`BeadsClient` and delegates all `TrackerClient` method calls to the corresponding
`BeadsClient` methods, returning results cast as `TrackerIssue`.

`sync()` is implemented directly in the adapter by spawning `bd sync`, since the
`BeadsClient` does not expose a sync method.

---

## 6. GitHub Issues Adapter

**Source:** [`src/tracker/github.ts`](../src/tracker/github.ts)

The GitHub adapter invokes the `gh` CLI (GitHub CLI) via `Bun.spawn`. Unlike
suji, `gh --json` returns clean JSON arrays/objects with no envelope.

### Fields and Normalization

`gh issue list --json number,title,state,labels,assignees,body`

```typescript
function normalizeIssue(raw: GhRawIssue): TrackerIssue
```

GitHub has no native priority or type fields. The adapter extracts them from
issue labels by convention:
- `priority:<N>` label → `priority: N` (defaults to `3` if absent)
- `type:<name>` label → `type: name` (defaults to `"task"` if absent)
- `state: "OPEN"` → `status: "open"`, anything else → `status: "closed"`

### Comment Support

`close()` uses `gh issue close <id>` with an optional `--comment <reason>` flag
when a reason is provided. This creates a visible audit trail on the GitHub issue.

```typescript
async close(id, reason?) {
  const args = ["issue", "close", id];
  if (reason) args.push("--comment", reason);
  await runGh(args, cwd, `close ${id}`);
}
```

### `sync()` Is a No-Op

GitHub is the canonical store; there is nothing to sync locally. The `sync()`
method returns immediately without error for compatibility with callers that call
`sync()` on all adapters.

---

## 7. GitHub Poller

**Source:** [`src/tracker/github-poller.ts`](../src/tracker/github-poller.ts)

The GitHub poller is a background daemon that watches GitHub Issues for issues
bearing a configured `readyLabel`, claims them (swaps label), and dispatches them
to the coordinator via the mail store. It runs as a standalone process started
by `ha coordinator start --auto-pull` (or when `coordinator.autoPull: true` in
config).

### Configuration

```yaml
coordinator:
  autoPull: true
  github:
    owner: my-org
    repo: my-repo
    readyLabel: "ov:ready"     # Issues bearing this label get dispatched
    activeLabel: "ov:active"   # Applied when claimed, removed when done
    pollIntervalMs: 30000      # How often to poll GitHub (default 30s)
```

### Claim Mechanism

When a ready issue is found, `claimIssue()` performs two atomic label edits:
1. `gh issue edit --remove-label <readyLabel>` — remove the ready label
2. `gh issue edit --add-label <activeLabel>` — apply the active label

This swap is the "claim" that prevents other pollers (or concurrent instances)
from dispatching the same issue twice.

### Dispatch

Claimed issues are dispatched to the coordinator via `mailClient.send()` with
`type: "dispatch"`. The coordinator's existing mail-processing loop picks up the
dispatch message and spawns a lead agent for the issue.

Dispatched issue state is persisted to `.overstory/github-poller-state.json`
(keyed by issue number). On each poll tick, `pruneDispatched()` removes entries
for issues that no longer carry the `activeLabel`, allowing re-dispatch if an
issue is manually reset to `readyLabel`.

### Polling Interval

The `pollIntervalMs` config controls how often `gh issue list --label <readyLabel>`
is called. The default is 30 seconds. Values below 5 seconds are not recommended
and may trigger GitHub API rate limits.

---

## 8. Bidirectional Sync (Suji ↔ GitHub)

When `github_enabled: true` and `github_sync_on_write: true` are set in
`.suji/config.yaml`, the suji CLI mirrors create/close/status-change operations
to GitHub Issues automatically. This bidirectional sync is handled entirely inside
the `su` CLI and is transparent to Haru's tracker adapter layer.

From Haru's perspective, the suji adapter always calls `su <command>` and
suji handles propagation to GitHub. The GitHub adapter is used independently
when the project's primary tracker is GitHub Issues (no suji layer).

---

## 9. Adding a New Tracker Adapter

### Step 1: Implement the adapter

Create `src/tracker/<name>.ts`. Export a factory function that returns a
`TrackerClient`:

```typescript
// src/tracker/mytracker.ts
import type { TrackerClient, TrackerIssue } from "./types.ts";

export function createMyTracker(cwd: string): TrackerClient {
  return {
    async ready() {
      // Call your CLI and return TrackerIssue[]
    },
    async show(id) {
      // Return a single TrackerIssue
    },
    async create(title, options) {
      // Return the new issue ID as string
    },
    async claim(id) {
      // Mark issue as in-progress
    },
    async close(id, reason) {
      // Close or resolve the issue
    },
    async list(options) {
      // Return TrackerIssue[] with optional status/limit filters
    },
    async sync() {
      // Sync local state with remote, or no-op if not applicable
    },
  };
}
```

All methods must normalize issue data to `TrackerIssue`. Use `Bun.spawn` for CLI
invocations; never import or bundle the tracker tool as a library dependency.

### Step 2: Register in the factory

Add the new backend to `TrackerBackend` in `src/tracker/types.ts`:

```typescript
export type TrackerBackend = "beads" | "suji" | "github" | "mytracker";
```

Add the import and case to `src/tracker/factory.ts`:

```typescript
import { createMyTracker } from "./mytracker.ts";

export function createTrackerClient(backend: TrackerBackend, cwd: string): TrackerClient {
  switch (backend) {
    // ...existing cases...
    case "mytracker":
      return createMyTracker(cwd);
    // exhaustive check keeps working automatically
  }
}
```

Update `resolveBackend()` to handle the new backend as a pass-through:

```typescript
if (configBackend === "mytracker") return "mytracker";
```

Add auto-detection logic inside the `"auto"` block if the tracker has a
detectable presence (e.g. a config directory):

```typescript
if (await dirExists(join(cwd, ".mytracker"))) return "mytracker";
```

### Step 3: Update config types

Add `"mytracker"` to the `TaskTrackerBackend` type in `src/config-types.ts`.

### Step 4: Write tests

Colocate tests at `src/tracker/mytracker.test.ts`. Use real temporary directories
with real CLI invocations for integration tests. Use `Bun.spawn` mock patterns
only for error-path testing where the CLI cannot be present in CI.
