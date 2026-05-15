# Watchdog Recovery Runbook

Applies to: haru watchdog daemon (`ha watch`). Covers the gaps diagnosed in issue #325
and the recovery semantics introduced by ws-control-hardening.

---

## 1. Symptoms

- Missions stall with no tick activity despite `tier0Enabled: true` in config.
- `ha status` shows agents in `waiting` or `working` with no progression.
- `ha doctor --category watchdog` reports the daemon absent or wedged.
- `ha mission start` / `ha sling` print `Watchdog failed to start` (or no hint at all).
- Multiple `ha watch --background` processes visible in `pgrep -af 'ha watch'` output.

---

## 2. Root Cause Hypotheses

Ranked by likelihood as observed on this system:

### H1 — Silent spawn failure (high — resolved)

The outer `Bun.spawn` call in `control.ts:start()` used `stdio: "pipe"` with no
`detached`/`unref()`. The daemon's spawn failure was silently swallowed; the
outer process exited non-zero but callers had no way to read the reason.

**Resolved by:** outer spawn now uses `stdout: "ignore"`, `stdin: "ignore"`,
`stderr` redirected to `<haruDir>/state/watchdog.stderr.log`, `detached: true`,
`proc.unref()`, and `resolveOverstoryBin()` to eliminate bare PATH dependency.
Callers use **sibling `getLastStartError()`** to surface the captured reason.

### H2 — PID-claim race (high — resolved)

`control.ts:start()` performed a read-PID / check-alive / spawn sequence with no
atomic ownership gate. Concurrent callers (e.g., parallel `ha sling` invocations)
all observed `isRunning() === false` and each spawned a daemon. The last writer
to the PID file won, orphaning the others. Up to 8 duplicate daemons were observed.

**Resolved by:** **daemon self-claim** — the daemon process itself opens the PID
file with `O_CREAT | O_EXCL` before `startDaemon()` runs; race losers
`process.exit(0)`. The outer `start()` no longer writes the PID file.

### H3 — Stale `project.root` in config (medium — mitigated)

`.overstory/config.yaml` retained an old `project.root` value
(`/home/liker/projects/os-eco/overstory`) after the repo was relocated.
If any code path consumed the config value rather than the resolved filesystem
root, the inner daemon ran in the wrong `cwd`.

**Mitigated by:** `ha doctor --category watchdog` now derives
`projectRoot = dirname(overstoryDir)` from the filesystem anchor, not from the
config field. **Operator action required after relocation: re-run `ha init`.**

---

## 3. What Changed

### Heartbeat freshness

The daemon writes a timestamp to `<haruDir>/state/watchdog.heartbeat` at the top
of every tick (fire-and-forget; errors swallowed). `isRunning()` implements
**heartbeat freshness**: it returns `true` only when the PID is alive (`kill -0`)
AND the heartbeat file mtime is within `2 × tier0IntervalMs` of now
(default 60 s window). A live PID with a stale or missing heartbeat is treated as
a wedged daemon.

### Stop-before-respawn

**stop-before-respawn** — when `start()` sees a PID alive but heartbeat stale, it
`stop()`s it (SIGTERM, then SIGKILL fallback after 2 s) before spawning a fresh
one. This eliminates orphaned daemon ticks running alongside a replacement.

### Sibling error helper

**sibling `getLastStartError()`** — `start()` signature is unchanged
(`Promise<{ pid: number } | null>`); the new sibling helper reads up to 2 KB of
`state/watchdog.stderr.log` so callers can surface the spawn-failure cause in
their warning output.

### Auto-spawn coverage

`ha sling` now mirrors `ha mission start` / `ha mission resume` and auto-spawns
the watchdog when `tier0Enabled` is true, before the agent worktree is created.

### Doctor integration

`ha doctor --category watchdog` reports liveness via three checks:
`watchdog-pid` (PID file present + pid alive), `watchdog-heartbeat`
(heartbeat mtime within `2 * tier0IntervalMs`), and `watchdog-singleton`
(only one `ha watch --background` process). All three are non-fixable
(`fixable: false`) — `ha doctor --fix` is a no-op for this category.
Operators must restart the watchdog manually using the procedures in
§4 "Recovery Procedures" below. See also
[`docs/doctor.md`](../doctor.md) § 4.12 `watchdog`.

---

## 4. Recovery Procedures

There is no auto-fix path for the watchdog. `ha doctor --category watchdog`
diagnoses the problem; recovery is always a manual restart.

### 4a. Manual restart (programmatic — preferred)

The hardened `start()` / `stop()` lifecycle in `src/watchdog/control.ts`
exposes the canonical restart sequence. `stop()` SIGTERMs the daemon (SIGKILL
fallback after 2 s); `start()` performs a daemon self-claim of the PID file
with `O_CREAT | O_EXCL`, so race losers `process.exit(0)`. From a project
root:

```bash
ha watch --stop           # stops via control.ts; safe if not running
ha watch --background     # detached spawn + atomic PID claim
```

### 4b. Manual restart (POSIX fallback)

When the CLI itself is wedged or unavailable, drop to raw process tools:

```bash
# confirm what is running
pgrep -af 'watch --background'

# kill all ha watch processes
pkill -f 'watch --background'

# delete a stale PID file if pgrep shows nothing but the file remains
rm -f .overstory/watchdog.pid

# restart
ha watch --background
```

### 4c. After repo relocation

```bash
ha init
ha watch --background
```

Re-running `ha init` refreshes `config.yaml` with the correct `project.root`.

### 4d. Inspect the spawn failure reason

```bash
cat .overstory/state/watchdog.stderr.log | head -40
```

The log is truncated on each new `start()` attempt. Read it immediately after
a failed start to capture the error. The `getLastStartError()` helper exposed
by `createWatchdogControl()` reads up to 2 KB of this file for programmatic
callers.

---

## 5. Host suspend detection

### Why this matters

When the host sleeps (laptop lid closed, OS suspend, container paused), the
watchdog's `setInterval` callback does not fire for the duration of the
suspend. On wake, `last_activity` timestamps on running sessions are now
arbitrarily far in the past — every active session looks stale or zombie, and
the next tick would mass-escalate them. The host-suspend detector prevents
this false-stale storm.

### Detection formula

Inside the interval callback at `src/watchdog/daemon.ts:790-816`, the daemon
tracks `lastIntervalFire` (updated at the **start** of each callback so a
slow tick's `.finally()` can't overwrite the gap baseline) and computes:

```
gapMs = now - lastIntervalFire
```

with threshold from `src/watchdog/daemon.ts:754`:

```
gapThresholdMs = Math.min(5 * intervalMs, Math.floor(staleThresholdMs / 2))
```

With the default `watchdog.tier0IntervalMs = 30_000` ms and default
`watchdog.staleThresholdMs = 300_000` ms, the default
`gapThresholdMs = min(150_000, 150_000) = 150_000` ms (150 s / 2.5 min).
Both terms tie at the defaults; tightening `staleThresholdMs` shrinks the
gap window in lockstep.

### On detection

When `gapMs > gapThresholdMs`, the daemon:

1. Emits a custom event `{ type: 'daemon_stall_detected', gapMs, thresholdMs }`
   on the gap event store (level `warn`, `agentName = '_watchdog'`).
2. Opens a short-lived `SessionStore` and invokes
   `rebaseLastActivity(new Date(now).toISOString())`.

The rebase scope is narrow — see `src/sessions/store.ts:685`:

```sql
UPDATE sessions
   SET last_activity = $now
 WHERE state IN ('booting', 'working', 'waiting')
```

Only sessions in `booting`, `working`, or `waiting` are touched. Sessions
in `completed`, `stalled`, or `zombie` are left at their original
timestamps — those terminal/escalated states should not be retroactively
forgiven just because the host went to sleep. The full session state enum is
the CHECK constraint at `src/sessions/store.ts:309`:
`'booting','working','waiting','completed','stalled','zombie'`. There is no
`wedged-recoverable` value.

### How to verify from logs

After a suspected suspend (laptop wake, VM resume, etc.), look for the
`daemon_stall_detected` event:

```bash
ha logs --agent _watchdog --level warn | grep daemon_stall_detected
```

Or query the event store directly:

```bash
sqlite3 .overstory/events.db "SELECT created_at, data FROM events WHERE event_type='custom' AND data LIKE '%daemon_stall_detected%' ORDER BY created_at DESC LIMIT 10;"
```

A run of these events clustered around a known wake time confirms the
detector fired.

---

## 6. Tool-hang rung

### What it is

The tool-hang rung is one of the rungs in `evaluateTimeBased`
(`src/watchdog/health.ts:104-131`). It terminates a session whose single
in-flight tool call has been running longer than `toolHangMs` — independent
of `lastActivity`, because `last_activity` is touched by every event, so
a genuinely hung tool call may keep the session looking 'fresh' while making
no progress.

**Tool-hang is a rung, not a health-score input.** It returns a terminal
verdict directly; it does not feed into the weighted health score.

### Position in the rung ladder

In `evaluateTimeBased`, the rung order is:

1. **Waiting short-circuit** (line 106) — if `state === 'waiting'`, return
   `action: 'none'`. Waiting sessions are mail-driven, not time-driven.
2. **Tool-hang rung** (lines 116-131) — checked next, **before** stale and
   zombie thresholds.
3. **Zombie threshold** (`elapsedMs > zombieMs`).
4. **Stale threshold** (`elapsedMs > staleMs`).

Because tool-hang is checked before stale/zombie, a long-running tool call
short-circuits straight to termination without first graduating through
`stalled` -> `zombie`. There is **no intermediate `wedged-recoverable`
state** — the session state enum (CHECK constraint at
`src/sessions/store.ts:309`) contains only
`'booting','working','waiting','completed','stalled','zombie'`.

### Trigger condition

```
session.toolInFlightStartedAt !== null
  AND Date.now() - new Date(session.toolInFlightStartedAt).getTime() > toolHangMs
```

### Rung return shape

```typescript
{
    state: 'zombie',
    action: 'terminate',
    reconciliationNote: `tool_hang_terminate: tool "<name>" in flight for <m>m — exceeds toolHangMs (<m>m)`,
}
```

The `tool_hang_terminate:` prefix on `reconciliationNote` is the canonical
marker — grep for it in event logs to find tool-hang-driven terminations.

### Threshold source

`toolHangMs` is supplied by the daemon caller, not by `config.yaml`. There
is **no corresponding field in `src/config-schema.ts`** — do not look for
one.

| Caller | `toolHangMs` value | Reference |
|--------|---------------------|-----------|
| Watchdog daemon | `toolHangThresholdMs ?? 900_000` (15 min default) | `src/watchdog/daemon.ts:1086` |
| Non-daemon callers | `Number.POSITIVE_INFINITY` | `src/watchdog/health.ts:118` |

`POSITIVE_INFINITY` means non-daemon callers (tests, one-shot health checks)
never trigger the rung, even on sessions with a long-running tool.

### Schema dependency

The rung reads two columns from the session row:

- `tool_in_flight_name` — the tool currently executing (e.g. `Bash`, `Read`).
- `tool_in_flight_started_at` — ISO timestamp when the tool started.

Both are written by `setToolInFlight` (tool-start hook) and cleared by
`clearToolInFlight` (tool-end hook). The underlying schema is owned by
`ws-health-observability` — see that workstream's `db-migrations.md`
entry for the migration that introduced these columns.

---

## 7. Future Follow-Up

- **Option C (systemd / launchd)** deferred per D5. Blocker: `src/commands/watch.ts:121`
  reads `process.cwd()` — requires `--project <path>` plumbing through `runWatch`
  before a system-level service unit can target an arbitrary project root.

---

## Reference

- Research §6 (hypotheses): `missions/.../research/_summary.md` §6 "Verified gaps"
- Research §8 (current state): `missions/.../research/current-state.md` §8
- Architecture r2: `missions/.../plan/architecture.md` — Key invariants §5–§9, concurrency model, stderr capture flow
- Decision D5: `missions/.../decisions.md` — Option C out of scope
