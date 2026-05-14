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

`ha doctor --category watchdog` reports liveness (pid-alive + heartbeat-fresh);
`--fix` invokes the hardened `start()` to recover a missing or wedged daemon.

---

## 4. Recovery Procedures

### 4a. Standard check and fix

```bash
ha doctor --category watchdog --fix
```

This checks pid-alive + heartbeat-fresh and, if the daemon is absent or wedged,
invokes the hardened `start()` automatically.

### 4b. Manual kill-and-restart

```bash
# confirm what is running
pgrep -af 'ha watch'

# kill all ha watch processes
pkill -f 'ha watch'

# restart via doctor (uses hardened start)
ha doctor --category watchdog --fix
```

### 4c. After repo relocation

```bash
ha init
ha doctor --category watchdog --fix
```

Re-running `ha init` refreshes `config.yaml` with the correct `project.root`.

### 4d. Inspect the spawn failure reason

```bash
cat .overstory/state/watchdog.stderr.log | head -40
```

The log is truncated on each new `start()` attempt. Read it immediately after a
failed start to capture the error.

---

## 5. Future Follow-Up

- **Option C (systemd / launchd)** deferred per D5. Blocker: `src/commands/watch.ts:121`
  reads `process.cwd()` — requires `--project <path>` plumbing through `runWatch`
  before a system-level service unit can target an arbitrary project root.

---

## Reference

- Research §6 (hypotheses): `missions/.../research/_summary.md` §6 "Verified gaps"
- Research §8 (current state): `missions/.../research/current-state.md` §8
- Architecture r2: `missions/.../plan/architecture.md` — Key invariants §5–§9, concurrency model, stderr capture flow
- Decision D5: `missions/.../decisions.md` — Option C out of scope
