# Dashboard

This document is the contributor guide for the `ha dashboard` command. It covers
panel layout, data sources, refresh mechanics, CLI flags, performance
considerations, and instructions for modifying the dashboard.

---

## 1. What `ha dashboard` Does

`ha dashboard` renders a live, multi-panel terminal UI using raw ANSI escape codes
(no runtime UI library dependency). It polls multiple SQLite stores and subprocess
outputs on a configurable interval and overwrites the terminal frame in place using
cursor-control sequences.

```bash
ha dashboard                  # Refresh every 2000ms, scope to current run
ha dashboard --interval 500   # Refresh every 500ms (minimum)
ha dashboard --all            # Show all runs, not just current-run.txt
```

---

## 2. Panel Layout

The dashboard is divided into seven named panels. Row positions are computed
dynamically from terminal dimensions (`process.stdout.rows`, `process.stdout.columns`).

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ha dashboard v1.x.x                      HH:MM:SS [run: abc12345] | 2000ms  │
├──────────────────────────────────────────────────────────────────────────────┤
│ Mission: my-mission [active/execute]   (optional — present when mission active)
├──────────────────────────────────────────────────────────────────────────────┤
│ Quota Headroom: claude: 72% requests remaining  (optional — if headroom.db)  │
├──────────────────────────────────────────────────────────────────────────────┤
│ Agents (N)                                                                   │
│  St Name            Capability    Runtime   State      Status       Duration  │
│  ─────────────────────────────────────────────────────────────────────────── │
│  ● builder-abc123   builder       claude    working    task-001     00:03:12  │
│  ○ reviewer-xyz     reviewer      claude    completed  task-002     00:01:45  │
├──────────────────────────────────────────────────────────────────────────────┤
│ Feed (live)                     │ Tasks (N)                                  │
│ [events stream here]            │ [tracker issues here]                      │
├─────────────────────────────────┼──────────────────────────────────────────┤
│ Mail (N unread)                 │ Merge Queue (N)                            │
│ [recent messages]               │ [pending branches]                         │
├──────────────────────────────────────────────────────────────────────────────┤
│ Metrics  Total: 12 | Avg: 00:04:30 | builder:8, reviewer:4                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Panel Summary

| Panel | Location | Renderer function |
|-------|----------|-------------------|
| Header | Row 1–2 | `renderHeader()` |
| Mission strip | Row 3+ (optional) | `renderMissionsStrip()` / `renderMissionStrip()` |
| Quota Headroom | Below missions (optional) | `renderHeadroomStrip()` |
| Agents | Full width, dynamic height | `renderAgentPanel()` |
| Feed | Left 60% of middle zone | `renderFeedPanel()` |
| Tasks | Right 40% of middle zone | `renderTasksPanel()` |
| Mail | Bottom-left 50%, fixed 5 rows | `renderMailPanel()` (internal) |
| Merge Queue | Bottom-right 50%, fixed 5 rows | `renderMergeQueuePanel()` (internal) |
| Metrics | Footer strip, 3 rows | `renderMetricsPanel()` (internal) |

All renderer functions write to a single `output` string and are flushed to
`process.stdout` in one `write()` call per tick (`CURSOR.clear + all panels`).

---

## 3. Data Sources Per Panel

**Source:** [`src/dashboard/data.ts`](../src/dashboard/data.ts)

All data is collected in `loadDashboardData()` and returned as `DashboardData`.

| Panel | Source |
|-------|--------|
| Header | Clock (`new Date()`), `current-run.txt`, `package.json` version |
| Mission strip | `sessions.db` via `createMissionStore()` (open/close per tick) |
| Quota Headroom | `headroom.db` via pre-opened `HeadroomStore` |
| Agents | `sessions.db` via pre-opened `SessionStore` + `getCachedWorktrees()` + `getCachedTmuxSessions()` |
| Feed | `events.db` via pre-opened `EventStore`, buffered via `EventBuffer` |
| Tasks | `sd`/`bd`/`gh` CLI via `TrackerClient`, cached 10s |
| Mail | `mail.db` via pre-opened `MailStore` |
| Merge Queue | `merge-queue.db` via pre-opened `MergeQueue` |
| Metrics | `metrics.db` via pre-opened `MetricsStore` |

---

## 4. Store Lifecycle (Pre-Opened Handles)

**Source:** `openDashboardStores()` and `closeDashboardStores()` in
[`src/dashboard/data.ts`](../src/dashboard/data.ts)

Stores that must survive across poll ticks are opened once before the poll loop
starts and closed on process exit or interrupt. This avoids the `PRAGMA WAL` and
`PRAGMA busy_timeout` overhead on every tick.

```
openDashboardStores(root)
  → DashboardStores {
      sessionStore,   // always present
      mailStore,      // null if mail.db does not exist
      mergeQueue,     // null if merge-queue.db does not exist
      metricsStore,   // null if metrics.db does not exist
      eventStore,     // null if events.db does not exist
      headroomStore,  // null if headroom.db does not exist
    }
```

The mission store and resilience store are **not** pre-opened. They are opened and
closed per tick because their schemas co-reside in `sessions.db` and are accessed
via short-lived reads.

---

## 5. Refresh Mechanics

### Poll Loop

The command file (`src/commands/dashboard.ts`) runs a `setInterval()` loop at
`--interval` milliseconds. On each tick:

1. `readCurrentRunId(overstoryDir)` — re-reads `current-run.txt` to detect run changes.
2. `loadDashboardData(root, stores, runId, ...)` — loads all data from pre-opened stores.
3. `renderDashboard(data, interval)` — writes the full frame to stdout.

### Event Buffer (Incremental)

The Feed panel uses `EventBuffer` (a rolling window of up to 100 events) to avoid
re-querying all events on every tick. `EventBuffer.poll(eventStore)` fetches only
events with `id > lastSeenId` since the last minute, merges them into the buffer,
and updates the agent color map incrementally.

### Tracker Cache (10-second TTL)

Tracker data (task list) is cached in a module-level `trackerCache` variable with
a 10-second TTL. CLI subprocess spawning is expensive; this avoids spawning `sd
list` on every 500ms tick.

### Session Fallback Cache

If `stores.sessionStore.getAll()` throws (SQLite lock contention or I/O error),
the dashboard falls back to `sessionDataCache` — the last successful session
read. This prevents a blank Agents panel during brief lock windows.

### Health Reconciliation

On each tick, `evaluateHealth()` is called for every non-completed session to
detect stall and zombie transitions. If the health evaluation disagrees with the
stored state, `validateTransition()` with `force: true` is used to apply the
correction in-place. Failures are swallowed (`best effort`) to prevent health
checks from crashing the render loop.

---

## 6. Agent Panel Specifics

Agents are sorted for display: active states (`working`, `booting`, `waiting`,
`stalled`) first, then completed, then zombie.

The panel height is computed by `computeAgentPanelHeight(height, agentCount)`:
- Minimum: 8 rows
- Maximum: `floor(height * 0.35)` (35% of terminal height)
- Grows with agent count (each agent row + 4 chrome rows)

Columns displayed per agent row:

| Column | Width | Source |
|--------|-------|--------|
| State icon | 2 | `stateIcon(agent.state)` |
| Name | 15 | `agent.agentName` (truncated) |
| Capability | 12 | `agent.capability` |
| Runtime | 8 | Resolved from `runtimeConfig` via `resolveRuntimeName()` |
| State | 10 | `agent.state` |
| Status | 25 | `agent.statusLine` if set, else `agent.taskId` |
| Duration | 9 | Time since `agent.startedAt` (or until `lastActivity` for completed) |
| Live dot | 1 | Green `>` if tmux session alive or headless PID running, red `x` otherwise |

Circuit breaker markers (`⚡` in red) appear after the live dot when a
capability's breaker is open (sourced from `resilience.openBreakers`).

---

## 7. `--interval` and `--all` Flags

**`--interval <ms>`** (default: `2000`)

Minimum value is `500ms` — lower values raise a `ValidationError`. Values above
30 seconds are accepted but may feel unresponsive for interactive use. The
interval is displayed in the header right-side alongside the current time.

**`--all`**

Without `--all`, all panels are filtered to agents whose `runId` matches the
current run ID from `current-run.txt`. Agents with `runId === null` (coordinator)
are always shown regardless of run scope (SQL `WHERE run_id = ?` never matches
NULL).

With `--all`, `readCurrentRunId()` is still called but ignored — the `runId`
passed to `loadDashboardData()` is set to `null`, which disables all run filters
in `filterAgentsByRun()`.

---

## 8. Keybindings

The dashboard has no interactive keybindings. It is a read-only render loop. To
interact with agents or send commands, open a new terminal and use the `ov` CLI
directly.

Press `Ctrl+C` to exit. The signal handler calls `closeDashboardStores()` and
restores the terminal cursor (`CURSOR.showCursor`) before exiting.

---

## 9. Performance Considerations

- **Read-only access:** The dashboard never writes to any SQLite store (except the
  session state reconciliation, which uses `updateState()` — a lightweight single-row
  update). No locks are held across ticks.
- **WAL mode:** All pre-opened stores use WAL mode, allowing concurrent reads
  alongside writes from live agents without blocking.
- **Single stdout write per tick:** All panel output is concatenated into one
  string and written via a single `process.stdout.write()` call to avoid
  interleaved ANSI sequences.
- **Subprocess caching:** `getCachedWorktrees()` and `getCachedTmuxSessions()`
  cache subprocess results for a short TTL to avoid spawning `git worktree list`
  and `tmux ls` on every tick.
- **Tracker 10s cache:** `sd`/`bd`/`gh` CLI calls are expensive; the 10-second
  cache prevents excessive subprocess spawning during short refresh intervals.

---

## 10. Contributing: Adding a New Panel

1. Add a `renderMyPanel()` function in `src/dashboard/render.ts`. Follow the
   existing pattern: accept `DashboardData`, dimensions, and position parameters;
   return a string of ANSI sequences.
2. Add the required data fields to `DashboardData` in `src/dashboard/data.ts`.
3. Populate the fields in `loadDashboardData()`. Open the data source via a
   pre-opened store if the data is needed every tick, or use the mission/resilience
   open-per-tick pattern if it is infrequent.
4. Call `renderMyPanel()` inside `renderDashboard()` in `render.ts`, adjusting
   the row offset tracking (`agentPanelStart`, `middleStart`, etc.) to allocate
   space.
5. Export the renderer from `src/commands/dashboard.ts` if it needs to be used
   by other modules (e.g. the webserver panel endpoint).
