# Test Leakage Audit — `Bun.spawn` Callsites in `*.test.ts`

_Generated 2026-05-20 for haru gh #395._

---

## Methodology

This audit was performed by running `grep -rl "Bun\.spawn" src/ --include="*.test.ts"` to locate all 33
test files that reference `Bun.spawn`, then reading each file in full to classify every callsite. A
**callsite** is any invocation `Bun.spawn(…)` that creates a real OS process; type references
(`typeof Bun.spawn`, `ReturnType<typeof Bun.spawn>`), mock assignments (`Bun.spawn = mock(…)`), `spyOn`
interceptions, and occurrences inside comments are noted but do not count toward severity totals.
`Bun.spawnSync` callsites are recorded per-file and marked **excluded-by-design** — the synchronous,
blocking API guarantees the process has exited before the test can advance, so no leak path exists.

**Severity rubric:**

| Level | Criteria |
|---|---|
| **HIGH** | Spawns a daemon-class process (watchdog, mission coordinator) or creates a tmux session without any explicit kill in the test body or lifecycle hooks; sqlite handle not released; worktree not removed |
| **MEDIUM** | Long-lived or SIGTERM-resistant process with `kill()` that is outside a `try/finally`; tmux session created before the enclosing `try/finally` block; daemon cleanup relying on a PID file with a race-condition window |
| **LOW** | Process is short-lived and awaited synchronously; cleanup is explicit, just missing a defensive `try/finally` |

**D2 cleanup primitives matrix:**

| Primitive | Use for |
|---|---|
| `unref()` + finally-kill | Detached daemons — call `proc.unref()` to decouple from parent, then `proc.kill()` in a `finally` block |
| `await proc.exited` + `closeSync(fd)` | Synchronous subprocess — await exit before proceeding, close all piped FD handles |
| `using` declaration / scoped resource | SQLite handles, tmux sessions managed via a `Disposable` wrapper |
| `cleanupTempDir` (existing helper) | Filesystem fixtures — removes temp directories including any worktrees inside them |

---

## Summary Table

| File | Spawns | HIGH | MED | LOW |
|---|---|---|---|---|
| src/agents/hooks-deployer.test.ts | 6 | 0 | 0 | 6 |
| src/beads/client.test.ts | 1 | 0 | 0 | 1 |
| src/beads/molecules.test.ts | 0 | 0 | 0 | 0 |
| src/canopy/client.test.ts | 1 | 0 | 0 | 1 |
| src/commands/completions.test.ts | 2 | 0 | 0 | 2 |
| src/commands/coordinator.test.ts | 0 | 0 | 0 | 0 |
| src/commands/log.test.ts | 2 | 0 | 0 | 2 |
| src/commands/prime.test.ts | 1 | 0 | 0 | 1 |
| src/commands/sling.test.ts | 4 | 0 | 0 | 4 |
| src/commands/status.test.ts | 3 | 0 | 1 | 2 |
| src/commands/worktree.test.ts | 2 | 0 | 0 | 2 |
| src/doctor/consistency.test.ts | 0 | 0 | 0 | 0 |
| src/e2e/agent-env-file.test.ts | 2 | 0 | 0 | 2 |
| src/e2e/runtime-deploy-e2e.test.ts | 8 | 0 | 0 | 8 |
| src/e2e/tmux-pane-query.test.ts | 2 | 0 | 0 | 2 |
| src/logging/color.test.ts | 2 | 0 | 0 | 2 |
| src/merge/resolver.test.ts | 0 | 0 | 0 | 0 |
| src/missions/cells/debug-loop-handlers.test.ts | 0 | 0 | 0 | 0 |
| src/missions/cells/done-phase.test.ts | 0 | 0 | 0 | 0 |
| src/missions/cells/intake-phase.test.ts | 0 | 0 | 0 | 0 |
| src/missions/cells/pr-phase.test.ts | 0 | 0 | 0 | 0 |
| src/missions/cells/spawn-helpers.test.ts | 0 | 0 | 0 | 0 |
| src/missions/predecessor.test.ts | 0 | 0 | 0 | 0 |
| src/mulch/client.test.ts | 25 | 0 | 0 | 25 |
| src/test-helpers.test.ts | 4 | 0 | 0 | 4 |
| src/tracker/beads.test.ts | 0 | 0 | 0 | 0 |
| src/tracker/github.test.ts | 0 | 0 | 0 | 0 |
| src/tracker/seeds.test.ts | 0 | 0 | 0 | 0 |
| src/watchdog/control.test.ts | 6 | 0 | 3 | 3 |
| src/watchdog/e2e-swap.test.ts | 9 | 0 | 0 | 9 |
| src/worktree/manager.test.ts | 1 | 0 | 0 | 1 |
| src/worktree/process.test.ts | 1 | 0 | 0 | 1 |
| src/worktree/tmux.test.ts | 0 | 0 | 0 | 0 |
| **TOTALS** | **82** | **0** | **4** | **78** |

---

## Per-File Sections

---

## src/agents/hooks-deployer.test.ts

Six callsites, all inside the `describe("buildTrackerCloseGuardScript")` group (lines 2465–2638) and the
`describe("escapeForSingleQuotedShell")` group (line 2638). All spawn `sh -c <script>` to validate the
behaviour of compiled hook guard scripts. Every spawn is immediately awaited via `await proc.exited`
after consuming stdout. The enclosing `describe` blocks have `beforeEach`/`afterEach` using `mkdtemp`
and `cleanupTempDir`.

### blocks sd close with wrong ID

- **Location:** `src/agents/hooks-deployer.test.ts:2468`
- **Test:** `describe("buildTrackerCloseGuardScript") > test("blocks sd close with wrong ID")`
- **What spawns:** `sh -c <tracker-close-guard-script>` — a short shell one-liner that reads stdin JSON and decides whether to block a `sd close` invocation
- **What leaks if cleanup missing:** Shell process FD (stdin pipe); at most one shell instance per test, exits in <10ms once stdin is closed
- **Severity:** LOW
- **D2 primitive:** `await proc.exited` + `closeSync(fd)` — already applied
- **Fix sketch:** Already correct; defensively could wrap in `try/finally { /* nothing to clean */ }` but stdin is consumed inline so no FD leak exists.

### allows sd close with matching ID

- **Location:** `src/agents/hooks-deployer.test.ts:2485`
- **Test:** `describe("buildTrackerCloseGuardScript") > test("allows sd close with matching ID")`
- **What spawns:** Same guard script, empty-output path
- **What leaks if cleanup missing:** None — trivially exits after reading empty JSON
- **Severity:** LOW
- **D2 primitive:** `await proc.exited` — already applied
- **Fix sketch:** None required.

### blocks bd close with wrong ID

- **Location:** `src/agents/hooks-deployer.test.ts:2499`
- **Test:** `describe("buildTrackerCloseGuardScript") > test("blocks bd close with wrong ID")`
- **What spawns:** Same guard script, `bd close` command
- **Severity:** LOW
- **D2 primitive:** `await proc.exited` — already applied
- **Fix sketch:** None required.

### blocks sd update --status with wrong ID

- **Location:** `src/agents/hooks-deployer.test.ts:2515`
- **Test:** `describe("buildTrackerCloseGuardScript") > test("blocks sd update --status with wrong ID")`
- **What spawns:** Guard script, `sd update` command
- **Severity:** LOW
- **D2 primitive:** `await proc.exited` — already applied
- **Fix sketch:** None required.

### exits early when HARU_TASK_ID is empty

- **Location:** `src/agents/hooks-deployer.test.ts:2531`
- **Test:** `describe("buildTrackerCloseGuardScript") > test("exits early when HARU_TASK_ID is empty (coordinator/monitor)")`
- **What spawns:** Guard script, early-exit path
- **Severity:** LOW
- **D2 primitive:** `await proc.exited` — already applied
- **Fix sketch:** None required.

### blockGuard shell command outputs valid JSON when executed

- **Location:** `src/agents/hooks-deployer.test.ts:2638`
- **Test:** `describe("escapeForSingleQuotedShell") > test("blockGuard shell command outputs valid JSON when executed")`
- **What spawns:** `sh -c <capability-guard-command>` stripped of the ENV_GUARD prefix
- **What leaks if cleanup missing:** One shell process; exits as soon as it writes JSON to stdout
- **Severity:** LOW
- **D2 primitive:** `await proc.exited` — already applied
- **Fix sketch:** None required.

---

## src/beads/client.test.ts

One real `Bun.spawn` callsite (the `initBeads` helper). One `Bun.spawnSync` callsite (availability probe) — **excluded-by-design**.

### Bun.spawnSync: isBdAvailable

- **Location:** `src/beads/client.test.ts:53`
- **Severity:** excluded-by-design — `Bun.spawnSync` blocks until `bd --version` exits; result is synchronously available, no async leak path.

### initBeads helper — bd init

- **Location:** `src/beads/client.test.ts:67`
- **Test:** `describe("createBeadsClient (integration)") > beforeAll` (called via `initBeads`)
- **What spawns:** `bd init` — initialises issue tracking in the temp git repo
- **What leaks if cleanup missing:** `bd` is a short-lived CLI tool; exits as soon as the command completes. FD handles (stdout/stderr) are piped and consumed.
- **Severity:** LOW
- **D2 primitive:** `await proc.exited` — already applied; `afterAll` destroys the temp dir.
- **Fix sketch:** None required; `afterAll` already calls `cleanupTempDir(tempDir)`.

---

## src/beads/molecules.test.ts

Zero real `Bun.spawn()` invocations. All references are global mock assignments (`Bun.spawn = mock(…)`)
used to simulate the `bd mol` CLI. The outer `beforeEach` (file level, line 54) saves `originalSpawn`;
the inner `beforeEach` and `afterEach` inside `describe("molecules")` (lines 60, 65) restore it.
Double-guarded restoration prevents mock leakage across tests. No real OS process is created.

---

## src/canopy/client.test.ts

### Module-level availability probe — which ta

- **Location:** `src/canopy/client.test.ts:55`
- **Test:** Module-level guard (outside any describe block) — sets `hasCanopy` flag
- **What spawns:** `which ta` — probes for the canopy CLI binary
- **What leaks if cleanup missing:** `which` exits in <5ms; no persistent state
- **Severity:** LOW
- **D2 primitive:** `await proc.exited` — already applied
- **Fix sketch:** None required.

---

## src/commands/completions.test.ts

### should exit with error for missing shell argument

- **Location:** `src/commands/completions.test.ts:213`
- **Test:** `describe("completionsCommand") > it("should exit with error for missing shell argument")`
- **What spawns:** `bun -e "import completionsCommand …; completionsCommand([])"` — evaluates a one-shot module import and immediately exits with code 1
- **What leaks if cleanup missing:** Bun runtime exits immediately after printing to stderr; no persistent state
- **Severity:** LOW
- **D2 primitive:** Awaited via `Promise.all([new Response(proc.stderr).text(), proc.exited])` — already applied
- **Fix sketch:** None required.

### should exit with error for unknown shell

- **Location:** `src/commands/completions.test.ts:232`
- **Test:** `describe("completionsCommand") > it("should exit with error for unknown shell")`
- **What spawns:** Same one-shot bun eval, `powershell` argument path
- **Severity:** LOW
- **D2 primitive:** `Promise.all([…stderr, proc.exited])` — already applied
- **Fix sketch:** None required.

---

## src/commands/coordinator.test.ts

Zero real `Bun.spawn()` invocations. Line 348 is a JSDoc comment explaining that fakes are injected to
prevent real `Bun.spawn(["haru", …])` calls. No process creation occurs in this test file.

---

## src/commands/log.test.ts

Both callsites are inside the `runLogWithStdin` helper and a standalone "empty stdin" sub-test. Each
spawns a `bun run <script>` subprocess to exercise the `logCommand --stdin` integration path (because
`Bun.stdin.stream()` cannot be injected in-process).

### runLogWithStdin helper — bun run script

- **Location:** `src/commands/log.test.ts:1547`
- **Test:** `describe("logCommand --stdin integration")` — shared by all sub-tests that call `runLogWithStdin`
- **What spawns:** `bun run <tempScript>` with piped stdin/stdout/stderr
- **What leaks if cleanup missing:** `proc.stdin.write(…)` + `proc.stdin.end()` ensures stdin is closed; `await proc.exited` blocks until the subprocess exits. The temp script file is cleaned up by `afterEach(cleanupTempDir)`.
- **Severity:** LOW
- **D2 primitive:** `await proc.exited` + `proc.stdin.end()` — already applied
- **Fix sketch:** None required; stdin is explicitly closed and exit is awaited.

### tool-start with --stdin handles empty stdin gracefully — bun run script

- **Location:** `src/commands/log.test.ts:1736`
- **Test:** `describe("logCommand --stdin integration") > test("tool-start with --stdin handles empty stdin gracefully")`
- **What spawns:** Same pattern — `bun run <emptyStdinScript>` with `proc.stdin.end()` called immediately
- **Severity:** LOW
- **D2 primitive:** `proc.stdin.end()` + `await proc.exited` — already applied
- **Fix sketch:** None required.

---

## src/commands/prime.test.ts

### shows session branch in context when different from canonical

- **Location:** `src/commands/prime.test.ts:337`
- **Test:** `describe("primeCommand output") > test("shows session branch in context when different from canonical")`
- **What spawns:** `git checkout -b feature/my-work` in a temporary git repo
- **What leaks if cleanup missing:** Git exits after branch creation; no persistent process. The git repo is cleaned up by the `finally` block that calls `cleanupTempDir(gitRepoDir)`.
- **Severity:** LOW
- **D2 primitive:** `await proc.exited` inside a `try/finally { cleanupTempDir }` — already applied
- **Fix sketch:** None required.

---

## src/commands/sling.test.ts

Four callsites in the `describe("slingCommand circuit breaker gate")` block and its `afterEach`.

### returns feature branch name after checkout — git checkout

- **Location:** `src/commands/sling.test.ts:1754`
- **Test:** `describe("getCurrentBranch") > test("returns feature branch name after checkout")`
- **What spawns:** `git checkout -b feature/test-branch` — switches to a new branch in the temp repo
- **Severity:** LOW
- **D2 primitive:** `await proc.exited` — already applied; `afterEach(cleanupTempDir)` removes the repo
- **Fix sketch:** None required.

### returns null for detached HEAD — git rev-parse

- **Location:** `src/commands/sling.test.ts:1765`
- **Test:** `describe("getCurrentBranch") > test("returns null for detached HEAD")`
- **What spawns:** `git rev-parse HEAD` — reads the current commit SHA
- **Severity:** LOW
- **D2 primitive:** `await hashProc.exited` — already applied
- **Fix sketch:** None required.

### returns null for detached HEAD — git checkout

- **Location:** `src/commands/sling.test.ts:1772`
- **Test:** `describe("getCurrentBranch") > test("returns null for detached HEAD")`
- **What spawns:** `git checkout <hash>` — enters detached HEAD state
- **Severity:** LOW
- **D2 primitive:** `await proc.exited` — already applied
- **Fix sketch:** None required.

### afterEach cleanup — tmux session sweep

- **Location:** `src/commands/sling.test.ts:1862`
- **Test:** `describe("slingCommand circuit breaker gate") > afterEach`
- **What spawns:** `sh -c "tmux list-sessions -F '#S' … | xargs … tmux kill-session …"` — belt-and-braces cleanup of any tmux sessions created by `slingCommand` before they could be registered in `sessions.db`
- **What leaks if cleanup missing:** This IS the cleanup; it runs in `afterEach`. The shell script uses `true` as a final no-op so it always exits 0. Awaited via `.exited`.
- **Severity:** LOW
- **D2 primitive:** `await Bun.spawn({cmd: …}).exited` — already applied
- **Fix sketch:** None required; this is itself the cleanup primitive.

---

## src/commands/status.test.ts

### Module-level tmux availability probe

- **Location:** `src/commands/status.test.ts:18`
- **Test:** Module-level guard — sets `tmuxAvailable` flag via `.exited.then(code => code === 0)`
- **What spawns:** `tmux -V` — probes for the tmux binary
- **Severity:** LOW
- **D2 primitive:** `proc.exited.then(…)` — already applied
- **Fix sketch:** None required.

### gatherStatus preserves a live rate-limited worker — tmux new-session

- **Location:** `src/commands/status.test.ts:433`
- **Test:** `describeTmux("rate-limited session reconciliation") > test("gatherStatus preserves a live rate-limited worker…")`
- **What spawns:** `tmux new-session -d -s <sessionName> "sleep 300"` — creates a real 300-second tmux session to simulate a live agent
- **What leaks if cleanup missing:** A 300-second `sleep` process persists inside a named tmux session. Without cleanup, the session outlives the test by up to 5 minutes.
- **Severity:** **MEDIUM** — The tmux kill is inside the second `try/finally` block. Between session creation (line 433) and the entry of that block there is a separate `try { store.upsert(…) } finally { store.close() }`. If `store.upsert()` throws, the outer test exits without running the tmux kill.
- **D2 primitive:** `using` scoped resource wrapping tmux session, or move session creation inside the outer `try`.
- **Fix sketch:**
  ```typescript
  // src/commands/status.test.ts:430–465
  // Move the Bun.spawn new-session INSIDE the outer try block so
  // the kill-session finally always covers it:
  try {
    const proc = Bun.spawn(["tmux", "new-session", "-d", "-s", sessionName, "sleep 300"], …);
    expect(await proc.exited).toBe(0);
    store.upsert(makeAgent({…, tmuxSession: sessionName, …}));
    // ...assertions...
  } finally {
    await Bun.spawn(["tmux", "kill-session", "-t", sessionName], …).exited;
    invalidateStatusCache();
    await cleanupTempDir(tempDir);
  }
  ```

### gatherStatus rate-limited session — tmux kill-session

- **Location:** `src/commands/status.test.ts:461`
- **Test:** Same test as above — this is the cleanup spawn inside the `finally` block
- **What spawns:** `tmux kill-session -t <sessionName>` — terminates the test session
- **Severity:** LOW
- **D2 primitive:** `await proc.exited` inside `finally` — already applied
- **Fix sketch:** See fix sketch above; the kill itself is correct.

---

## src/commands/worktree.test.ts

### worktreeCommand clean removes completed worktrees — git branch --list

- **Location:** `src/commands/worktree.test.ts:338`
- **Test:** `describe("worktreeCommand clean") > test("removes completed worktrees and their branches")`
- **What spawns:** `git branch --list haru/completed-agent/*` — verifies branch was deleted after clean
- **Severity:** LOW
- **D2 primitive:** Awaited via `new Response(branchListProc.stdout).text()` — already applied
- **Fix sketch:** None required.

### worktreeCommand clean preserves .seeds changes — git show

- **Location:** `src/commands/worktree.test.ts:869`
- **Test:** `describe("worktreeCommand clean") > test("lead worktree with .seeds/ changes preserves them to main")`
- **What spawns:** `git show main:.seeds/issues/test-issue.yaml` — verifies that seeds files were cherry-picked to main during clean
- **Severity:** LOW
- **D2 primitive:** `await showProc.exited` — already applied
- **Fix sketch:** None required.

---

## src/doctor/consistency.test.ts

Zero real `Bun.spawn()` invocations. Two `Bun.spawnSync` callsites:

- **Line 23:** `Bun.spawnSync(["git", …])` inside `runGit` helper — **excluded-by-design** (synchronous)
- **Line 44:** `Bun.spawnSync(["git", "worktree", "add", …])` inside `addWorktree` helper — **excluded-by-design** (synchronous)

Both return synchronously; the caller proceeds only after the subprocess has exited.

---

## src/e2e/agent-env-file.test.ts

### runGuardScript helper — sh -c guard script

- **Location:** `src/e2e/agent-env-file.test.ts:100`
- **Test:** `describe("ENV_GUARD file fallback in hook scripts")` — multiple sub-tests call `runGuardScript`
- **What spawns:** `sh -c <hook-guard-script>` with minimal env (no HARU_* vars) to test env-file fallback
- **What leaks if cleanup missing:** Guard script exits immediately after reading stdin JSON. Stdout/stderr are piped and consumed via `Promise.all`. `cleanupTempDir` in `afterEach` removes the temp dir.
- **Severity:** LOW
- **D2 primitive:** `Promise.all([new Response(proc.stdout).text(), proc.exited])` — already applied
- **Fix sketch:** None required.

### runGuardInDir helper — sh -c guard script

- **Location:** `src/e2e/agent-env-file.test.ts:249`
- **Test:** `describe("ENV_GUARD file fallback") > test("guard deactivates after env file is removed")`
- **What spawns:** Same shell guard script pattern, called at the bottom of the test file as a module-level helper
- **Severity:** LOW
- **D2 primitive:** `Promise.all([new Response(proc.stdout).text(), proc.exited])` — already applied
- **Fix sketch:** None required.

---

## src/e2e/runtime-deploy-e2e.test.ts

Eight callsites, all in the `describe("guard script validation")` block. The outer describe uses
`beforeEach(createTempGitRepo)` and `afterEach(cleanupTempDir)` for full lifecycle management.
Each spawn runs `bash -n -c <cmd>` (syntax-only check) or `bash -c <guardCmd>` (functional check)
against a compiled hook guard command string. All are immediately awaited.

### guard scripts are valid shell — bash -n syntax check loop

- **Location:** `src/e2e/runtime-deploy-e2e.test.ts:445`
- **Test:** `describe("guard script validation") > test("guard scripts are valid shell (no syntax errors)")`
- **What spawns:** `bash -n -c <hookCmd>` — per guard command inside a loop; exits after syntax check
- **Severity:** LOW
- **D2 primitive:** `Promise.all([new Response(proc.stderr).text(), proc.exited])` — already applied
- **Fix sketch:** None required.

### path boundary guard denies writes outside worktree

- **Location:** `src/e2e/runtime-deploy-e2e.test.ts:493`
- **Test:** `describe("guard script validation") > test("path boundary guard denies writes outside worktree")`
- **What spawns:** `bash -c <writeFileGuardCmd>` with `/etc/passwd` as file_path — should output `deny`
- **Severity:** LOW
- **D2 primitive:** `Promise.all([new Response(proc.stdout).text(), proc.exited])` — already applied
- **Fix sketch:** None required.

### path boundary guard allows writes inside worktree

- **Location:** `src/e2e/runtime-deploy-e2e.test.ts:542`
- **Test:** `describe("guard script validation") > test("path boundary guard allows writes inside worktree")`
- **What spawns:** Same guard with an in-worktree path — should allow
- **Severity:** LOW
- **D2 primitive:** Already applied
- **Fix sketch:** None required.

### bash danger guard blocks git push

- **Location:** `src/e2e/runtime-deploy-e2e.test.ts:591`
- **Test:** `describe("guard script validation") > test("bash danger guard blocks git push")`
- **What spawns:** `bash -c <bashDangerGuardCmd>` with `git push` as command
- **Severity:** LOW
- **D2 primitive:** Already applied
- **Fix sketch:** None required.

### bash danger guard allows safe commands

- **Location:** `src/e2e/runtime-deploy-e2e.test.ts:638`
- **Test:** `describe("guard script validation") > test("bash danger guard allows safe commands")`
- **What spawns:** `bash -c <bashDangerGuardCmd>` with `ls -la` as command
- **Severity:** LOW
- **D2 primitive:** Already applied
- **Fix sketch:** None required.

### scout bash file guard blocks file-modifying commands

- **Location:** `src/e2e/runtime-deploy-e2e.test.ts:688`
- **Test:** `describe("guard script validation") > test("scout bash file guard blocks file-modifying commands")`
- **What spawns:** `bash -c <scoutBashGuardCmd>` with a file-modifying command
- **Severity:** LOW
- **D2 primitive:** Already applied
- **Fix sketch:** None required.

### tracker close guard blocks closing wrong task

- **Location:** `src/e2e/runtime-deploy-e2e.test.ts:737`
- **Test:** `describe("guard script validation") > test("tracker close guard blocks closing wrong task")`
- **What spawns:** `bash -c <trackerGuardCmd>` with wrong task ID
- **Severity:** LOW
- **D2 primitive:** Already applied
- **Fix sketch:** None required.

### tracker close guard allows closing own task

- **Location:** `src/e2e/runtime-deploy-e2e.test.ts:787`
- **Test:** `describe("guard script validation") > test("tracker close guard allows closing own task")`
- **What spawns:** `bash -c <trackerGuardCmd>` with matching task ID
- **Severity:** LOW
- **D2 primitive:** Already applied
- **Fix sketch:** None required.

---

## src/e2e/tmux-pane-query.test.ts

### tmuxAvailable — tmux -V probe

- **Location:** `src/e2e/tmux-pane-query.test.ts:34`
- **Test:** `tmuxAvailable()` helper — called inside `beforeAll`
- **What spawns:** `tmux -V` — checks tmux binary availability; exits immediately
- **Severity:** LOW
- **D2 primitive:** `await proc.exited` — already applied
- **Fix sketch:** None required.

### tmuxRun helper — tmux [command]

- **Location:** `src/e2e/tmux-pane-query.test.ts:23`
- **Test:** `describe("E2E: tmux pane width/activity queries")` — used in `beforeAll` (session create), `afterAll` (session kill), and test bodies (resize/width queries)
- **What spawns:** Various `tmux` subcommands: `new-session`, `kill-session`, `resize-window`, `display-message`, etc. The single named session `"haru-test-pane-query"` is created in `beforeAll` and destroyed in `afterAll`.
- **What leaks if cleanup missing:** If `afterAll` does not run (e.g., process SIGKILL during tests), the named tmux session and its `sleep`-based window remain alive until the tmux server exits. Under normal test failure, `afterAll` is guaranteed to run.
- **Severity:** LOW
- **D2 primitive:** `afterAll` kill already applied; optionally wrap `beforeAll` session create in its own try/finally for belt-and-braces.
- **Fix sketch:** None required under normal failure modes; already correctly cleaned up.

---

## src/logging/color.test.ts

### NO_COLOR env causes chalk.level to be 0

- **Location:** `src/logging/color.test.ts:73`
- **Test:** `describe("chalk env vars") > test("NO_COLOR env causes chalk.level to be 0")`
- **What spawns:** `bun -e 'import chalk …; console.log(JSON.stringify({level: chalk.level}))'` with `NO_COLOR=1`
- **What leaks if cleanup missing:** One-shot bun process that prints JSON and exits; no persistent state
- **Severity:** LOW
- **D2 primitive:** `await proc.exited` — already applied
- **Fix sketch:** None required.

### FORCE_COLOR overrides NO_COLOR

- **Location:** `src/logging/color.test.ts:93`
- **Test:** `describe("chalk env vars") > test("FORCE_COLOR overrides NO_COLOR")`
- **What spawns:** Same one-shot bun process with `FORCE_COLOR=1`
- **Severity:** LOW
- **D2 primitive:** `await proc.exited` — already applied
- **Fix sketch:** None required.

---

## src/merge/resolver.test.ts

Zero real `Bun.spawn()` invocations in the test file. All references are `spyOn(Bun, "spawn").mockImplementation(…)`
interceptions. The selective mock passes `claude` calls to a fake and routes all other commands (git operations)
through `originalSpawn.apply(Bun, args)`. Every spy is created inside a `try/finally { spawnSpy.mockRestore() }`
block. No OS process is created by the test file itself; real git processes are created by the production
`MergeResolver` under test, which awaits them.

---

## src/missions/cells/debug-loop-handlers.test.ts

Zero real `Bun.spawn()` invocations. Three describe blocks each use `beforeEach`/`afterEach` to monkey-patch
`(Bun as any).spawn` with a stub that intercepts `git rev-parse`, `git worktree list/add`, and `ha sling`
without creating real processes. The `ha sling` stub returns `exited: new Promise<number>(() => {})` (a
never-resolving promise) to simulate a detached agent; this causes no OS resource leak since no real process
is spawned. `afterEach` unconditionally restores `origSpawn`.

---

## src/missions/cells/done-phase.test.ts

Zero real `Bun.spawn()` invocations. One describe block monkey-patches `(Bun as any).spawn` similarly to
`debug-loop-handlers.test.ts`. `origSpawn = Bun.spawn` is saved in `beforeEach` and restored in
`afterEach`. No real processes are created.

---

## src/missions/cells/intake-phase.test.ts

Zero real `Bun.spawn()` invocations. All occurrences are type casts of the form
`}) as unknown as typeof Bun.spawn` inside mock factory functions that return a fake spawn handle.
No OS process creation occurs.

---

## src/missions/cells/pr-phase.test.ts

Zero real `Bun.spawn()` invocations. All occurrences are type casts —
`ReturnType<typeof Bun.spawn>` and `typeof Bun.spawn` — used as helper type annotations in mock
factory functions at lines 82–83, 472, 623, 655–656, etc. No OS process creation occurs.

---

## src/missions/cells/spawn-helpers.test.ts

Zero real `Bun.spawn()` invocations. All occurrences are dependency-injection casts —
`{ spawn: stub as unknown as typeof Bun.spawn }` — passing a pre-built stub object as the spawn
dependency. No OS process creation occurs.

---

## src/missions/predecessor.test.ts

Zero real `Bun.spawn()` invocations. Line 426 is a comment in a test assertion:
`// (CT-7: no raw Bun.spawn(['gh', ...]) anywhere in applyContinueFrom)`. The test VERIFIES the
absence of raw spawn calls, using an injected `runGh` dependency; no spawn occurs.

---

## src/mulch/client.test.ts

Twenty-five callsites across two helper functions (`initGit`, `initMulch`) and per-test `ku add` calls.
All follow the same pattern: `const proc = Bun.spawn([…], {cwd: tempDir, stdout: "pipe", stderr: "pipe"})`,
followed immediately by `await proc.exited`. `afterEach` calls `cleanupTempDir(tempDir)`.
All are LOW severity; representative entries are documented below; the pattern is identical for all 25.

### initGit helper — git init

- **Location:** `src/mulch/client.test.ts:76`
- **Test:** `initGit()` helper called from tests requiring a git repo
- **What spawns:** `git init` — creates a new git repo in `tempDir`
- **Severity:** LOW
- **D2 primitive:** `await initProc.exited` — already applied
- **Fix sketch:** None required.

### initGit helper — git config user.name

- **Location:** `src/mulch/client.test.ts:83`
- **Severity:** LOW — `await configNameProc.exited`

### initGit helper — git config user.email

- **Location:** `src/mulch/client.test.ts:90`
- **Severity:** LOW — `await configEmailProc.exited`

### initMulch helper — ku init

- **Location:** `src/mulch/client.test.ts:104`
- **Test:** `initMulch()` helper called from tests that need a mulch store
- **What spawns:** `ku init` — initialises `.kura/` directory in `tempDir`
- **Severity:** LOW
- **D2 primitive:** `await proc.exited` — already applied
- **Fix sketch:** None required.

### Per-test ku add [domain] — lines 125–790 (21 callsites)

- **Locations:** `src/mulch/client.test.ts:125, 146, 169, 186, 260, 279, 297, 319, 338, 359, 385, 407, 429, 451, 479, 497, 527, 559, 632, 756, 790`
- **Test:** Various tests in `describe("prime")`, `describe("search")`, `describe("diff")`, etc.
- **What spawns:** `ku add <domain>` — creates a domain directory inside the temp mulch store so subsequent client method calls have content to work with
- **What leaks if cleanup missing:** `ku` is a short-lived CLI tool; exits after creating the directory entry. All are awaited with `await addProc.exited`. `afterEach(cleanupTempDir)` removes the entire temp tree.
- **Severity:** LOW (all 21 callsites)
- **D2 primitive:** `await proc.exited` — already applied
- **Fix sketch:** None required.

---

## src/test-helpers.test.ts

Four callsites, all inside `describe("createTempGitRepo")` and `describe("commitFile")` tests that
validate the test helper utilities themselves. Each spawns a git command, awaits exit, and operates
on a temp repo cleaned up in `afterEach`.

### repo has at least one commit — git rev-parse HEAD

- **Location:** `src/test-helpers.test.ts:26`
- **Test:** `describe("createTempGitRepo") > test("repo has at least one commit (HEAD exists)")`
- **Severity:** LOW — `await proc.exited`

### repo is on a branch — git symbolic-ref HEAD

- **Location:** `src/test-helpers.test.ts:39`
- **Test:** `describe("createTempGitRepo") > test("repo is on a branch (not detached HEAD)")`
- **Severity:** LOW — `await proc.exited`

### creates file and commits it — git log --oneline

- **Location:** `src/test-helpers.test.ts:72`
- **Test:** `describe("commitFile") > test("creates file and commits it")`
- **Severity:** LOW — `await proc.exited`

### commitFile with message — git log --oneline -1

- **Location:** `src/test-helpers.test.ts:96`
- **Test:** `describe("commitFile") > test("uses provided commit message")`
- **Severity:** LOW — `await proc.exited`

---

## src/tracker/beads.test.ts

Zero real `Bun.spawn()` invocations. All mentions are in test names (`"propagates cwd to Bun.spawn"`,
line 291), comments (`"sync() calls Bun.spawn directly"`, line 388), or helper documentation. The test
file uses `spyOn(beads, "run")` to intercept the beads client, not Bun directly.

---

## src/tracker/github.test.ts

Zero real `Bun.spawn()` invocations. Line 4 is a comment explaining the mock strategy; line 54 is a
test name. The test uses spyOn-style interception of the internal `run` helper.

---

## src/tracker/seeds.test.ts

Zero real `Bun.spawn()` invocations. All mentions are in comments (lines 530, 582, 600) or test names
(lines 348, 508, 611, 618) documenting the mock contract. The actual seeds client uses `Bun.spawn`
internally; the test intercepts via the exported `run` function mock.

---

## src/watchdog/control.test.ts

Six callsites. Three are MEDIUM severity: two because the daemon cleanup relies on a PID-file race
window, one because the victim process cleanup is not wrapped in `try/finally`.

### start() with two concurrent outer spawns — daemon spawn #1

- **Location:** `src/watchdog/control.test.ts:285`
- **Test:** `describe("inner-daemon stderr capture (so-r2-impl-13)") > test("start() with two concurrent outer spawns leaves exactly one daemon")`
- **What spawns:** `bun run overstoryBin watch --background` — outer launcher that acquires a file lock, forks the inner watchdog daemon with `detached: true` + `proc.unref()`, writes the daemon's PID to a file, then exits
- **What leaks if cleanup missing:** The outer launcher exits immediately (awaited via `p1.exited`). The inner daemon continues in background. `afterEach` reads `readWatchdogPid(tempRoot)` and sends `SIGKILL` to the daemon. **Race condition:** a `Bun.sleep(500)` pause is used to let the daemon settle, but if the inner daemon writes its PID after the 500 ms window, `afterEach` reads `null` and silently skips the kill — leaving the daemon running for up to the daemon's own timeout.
- **Severity:** **MEDIUM**
- **D2 primitive:** `unref()` + finally-kill — `unref()` is already applied inside the launcher; the issue is in test cleanup.
- **Fix sketch:**
  ```typescript
  // src/watchdog/control.test.ts:258–265 (afterEach)
  // Replace fixed Bun.sleep with polling loop:
  for (let i = 0; i < 20; i++) {
    const pid = await readWatchdogPid(tempRoot);
    if (pid !== null) { try { process.kill(pid, "SIGKILL"); } catch {} break; }
    await Bun.sleep(100);
  }
  cleanupProject(tempRoot);
  ```

### start() with two concurrent outer spawns — daemon spawn #2

- **Location:** `src/watchdog/control.test.ts:291`
- **Test:** Same test as above — second concurrent launcher
- **What spawns:** Identical pattern to line 285
- **Severity:** **MEDIUM** — same race-condition analysis; only one PID file is written (the winner), so the loser daemon may exit on its own, but its race window is the same.
- **D2 primitive:** Same as line 285
- **Fix sketch:** Same polling fix as above covers both spawns.

### SIGKILL fallback after 2s when process survives SIGTERM — victim process

- **Location:** `src/watchdog/control.test.ts:337`
- **Test:** `describe("stop()") > test("SIGKILL fallback after 2s when process survives SIGTERM")`
- **What spawns:** `sh -c "trap '' TERM; sleep 30"` — a SIGTERM-resistant process that ignores SIGTERM and sleeps for 30 seconds
- **What leaks if cleanup missing:** The test calls `victim.kill()` at the end. There is **no** `try/finally` wrapping this kill. If any assertion between line 337 (spawn) and line 358 (`victim.kill()`) throws — particularly the `expect(elapsed).toBeGreaterThan(1800)` timing assertion — the victim leaks and holds a process slot for up to 30 seconds.
- **Severity:** **MEDIUM**
- **D2 primitive:** `unref()` + finally-kill
- **Fix sketch:**
  ```typescript
  // src/watchdog/control.test.ts:337–358
  const victim = Bun.spawn(["sh", "-c", "trap '' TERM; sleep 30"], { … });
  try {
    const victimPid = victim.pid;
    writePidFile(tempRoot, victimPid);
    // … rest of test body …
    expect(isProcessRunning(victimPid)).toBe(false);
  } finally {
    victim.kill();  // ← move into finally
  }
  ```

### real-process race — daemon spawn #1

- **Location:** `src/watchdog/control.test.ts:371`
- **Test:** `test("real-process race: concurrent 'watch --background' → exactly one daemon (so-test-05)")`
- **What spawns:** Same launcher pattern as lines 285/291
- **Severity:** LOW — the test body is enclosed in `try/finally` that uses a `/proc`-walk to SIGKILL all matching processes before calling `cleanupProject`.
- **D2 primitive:** `try/finally` with `/proc` sweep — already applied
- **Fix sketch:** None required.

### real-process race — daemon spawn #2

- **Location:** `src/watchdog/control.test.ts:377`
- **Severity:** LOW — covered by same `try/finally` as line 371.
- **Fix sketch:** None required.

### stress: 10 concurrent control.start() calls — daemon spawns (Array.from)

- **Location:** `src/watchdog/control.test.ts:527`
- **Test:** `test("stress: 10 concurrent control.start() calls → at most one daemon survives (haru-orphan-fix)")`
- **What spawns:** `Array.from({ length: 10 }, () => Bun.spawn(["bun", "run", …, "watch", "--background"], …))` — spawns 10 concurrent launcher processes
- **What leaks if cleanup missing:** The test is wrapped in `try/finally` with PID-file kill plus a `/proc`-walk sweep for stragglers.
- **Severity:** LOW — comprehensive cleanup via `try/finally`
- **D2 primitive:** `try/finally` with `/proc` sweep — already applied
- **Fix sketch:** None required.

---

## src/watchdog/e2e-swap.test.ts

Nine callsites across two `describeE2E` blocks. Both have `afterEach` that calls `killSession(tmuxSessionName)`
(kills the agent tmux session) and `rmSync(tempDir, { recursive: true, force: true })`. All short-lived
`git` and `chmod` operations are awaited; the `tmux capture-pane` calls inside DI callbacks are awaited
within the callback.

### Module-level tmux availability probe

- **Location:** `src/watchdog/e2e-swap.test.ts:21`
- **Test:** Module-level guard — sets `tmuxAvailable` flag
- **What spawns:** `tmux -V` — availability probe
- **Severity:** LOW
- **D2 primitive:** `.exited.then(code => code === 0)` — already applied
- **Fix sketch:** None required.

### beforeEach git init (rate-limit block)

- **Location:** `src/watchdog/e2e-swap.test.ts:49`
- **Test:** `describeE2E("E2E: rate limit detection + swap") > beforeEach`
- **What spawns:** `git init` in the worktree directory
- **Severity:** LOW — `await …exited`
- **Fix sketch:** None required.

### beforeEach git commit (rate-limit block)

- **Location:** `src/watchdog/e2e-swap.test.ts:50`
- **Test:** Same `beforeEach`
- **What spawns:** `git commit --allow-empty -m init` — makes an initial commit so git context works
- **Severity:** LOW — `await …exited`
- **Fix sketch:** None required.

### beforeEach chmod +x fake agent script

- **Location:** `src/watchdog/e2e-swap.test.ts:82`
- **Test:** Same `beforeEach`
- **What spawns:** `chmod +x fakeAgentScript`
- **Severity:** LOW — `await …exited`
- **Fix sketch:** None required.

### rate-limit test — tmux capture-pane DI callback

- **Location:** `src/watchdog/e2e-swap.test.ts:178`
- **Test:** `describeE2E("E2E: rate limit detection + swap") > test("detects rate limit…")`
- **What spawns:** `tmux capture-pane -t <name> -p -S -<lines>` — reads pane content; called from the `_capturePaneContent` DI hook passed to `runDaemonTick`
- **What leaks if cleanup missing:** `capture-pane` exits immediately after writing content; awaited via `await proc.exited`. The tmux session itself is cleaned up in `afterEach(killSession)`.
- **Severity:** LOW
- **D2 primitive:** `await proc.exited` inside DI callback — already applied
- **Fix sketch:** None required.

### rate-limit test — tmux ls session verification

- **Location:** `src/watchdog/e2e-swap.test.ts:233`
- **Test:** Same test — verifies swap created the new runtime session
- **What spawns:** `tmux ls -F #{session_name}` — lists all sessions to confirm the new session exists
- **Severity:** LOW — `await lsProc.exited`
- **Fix sketch:** None required.

### wait behavior test — tmux capture-pane DI callback

- **Location:** `src/watchdog/e2e-swap.test.ts:307`
- **Test:** `describeE2E("E2E: rate limit detection + swap") > test("wait behavior…")`
- **What spawns:** `tmux capture-pane -t <name> -p -S -100` — same pattern as line 178
- **Severity:** LOW
- **D2 primitive:** `await proc.exited` inside DI callback — already applied
- **Fix sketch:** None required.

### beforeEach git init (failure_reroute block)

- **Location:** `src/watchdog/e2e-swap.test.ts:355`
- **Test:** `describeE2E("E2E: failure_reroute swap") > beforeEach`
- **Severity:** LOW — `await …exited`
- **Fix sketch:** None required.

### beforeEach git commit (failure_reroute block)

- **Location:** `src/watchdog/e2e-swap.test.ts:356`
- **Test:** Same `beforeEach`
- **Severity:** LOW — `await …exited`
- **Fix sketch:** None required.

---

## src/worktree/manager.test.ts

### git helper function — git [args]

- **Location:** `src/worktree/manager.test.ts:25`
- **Test:** `git()` helper called throughout all `describe` blocks
- **What spawns:** Various `git` subcommands (`worktree add`, `log`, `branch`, etc.) used to set up and verify worktree state
- **What leaks if cleanup missing:** Git exits after each command. `afterEach(cleanupTempDir)` removes the repo.
- **Severity:** LOW
- **D2 primitive:** `await proc.exited` inside `try/catch` — already applied
- **Fix sketch:** None required.

---

## src/worktree/process.test.ts

### redirects stdout to file — sh -c true probe

- **Location:** `src/worktree/process.test.ts:51`
- **Test:** `describe("spawnHeadlessAgent") > it("redirects stdout to file when stdoutFile is provided")`
- **What spawns:** `sh -c "true"` — a trivial no-op process used to flush OS buffers before reading the output file
- **What leaks if cleanup missing:** `true` exits immediately (exit code 0); `await exitProc.exited` ensures cleanup before the test reads the file.
- **Severity:** LOW
- **D2 primitive:** `await exitProc.exited` — already applied
- **Fix sketch:** None required.

---

## src/worktree/tmux.test.ts

Zero real `Bun.spawn()` invocations. Line 24 and line 29 are comments explaining the mock strategy:
"tmux tests use Bun.spawn mocks — legitimate exception to 'never mock what you can use for real'."
The actual spawn calls live inside `src/worktree/tmux.ts`; the tests intercept at the module boundary.

---

## Aggregate Findings

### Totals

| Severity | Count |
|---|---|
| HIGH | 0 |
| MEDIUM | 4 |
| LOW | 78 |
| **Total real callsites** | **82** |

Additionally, 3 `Bun.spawnSync` callsites (2 in `doctor/consistency.test.ts`, 1 in `beads/client.test.ts`)
are excluded-by-design.

### MEDIUM-severity callsites

| # | Location | Issue |
|---|---|---|
| 1 | `src/commands/status.test.ts:433` | `tmux new-session "sleep 300"` created before the outer `try/finally`; `store.upsert()` failure between creation and the kill-block leaves session alive |
| 2 | `src/watchdog/control.test.ts:285` | Daemon spawn + PID-file cleanup with a fixed 500 ms race window; `afterEach` may read `null` PID if daemon writes late |
| 3 | `src/watchdog/control.test.ts:291` | Same race as above (concurrent second launcher in the same test) |
| 4 | `src/watchdog/control.test.ts:337` | SIGTERM-resistant `sleep 30` victim; `victim.kill()` is outside any `try/finally` — a failing timing assertion leaks a 30-second process |

### Common Patterns

1. **Short-lived CLI subprocess (most common — 67 / 82 callsites):** `git`, `ku`, `bash -n`, `which`, `bd`
   commands in helper functions. Always awaited with `await proc.exited`. afterEach/afterAll cleanup removes
   the temp directory. Pattern is correct; no action needed.

2. **Subprocess for stdin injection (4 callsites in log.test.ts and completions.test.ts):** `bun run <script>`
   or `bun -e <expr>` used because in-process stdin injection is not possible. Each test correctly calls
   `proc.stdin.end()` and awaits exit. Pattern is correct.

3. **Guard script functional validation (12 callsites in hooks-deployer.test.ts and e2e/runtime-deploy-e2e.test.ts):**
   Spawns the compiled hook command string via `sh -c` or `bash -c` with controlled stdin and env. Short-lived;
   all awaited. Pattern is correct.

4. **Daemon-class spawns for concurrency/race tests (4 callsites in watchdog/control.test.ts):**
   The two tests that use a try/finally with `/proc`-walk cleanup (so-test-05 and haru-orphan-fix) are correct.
   The "inner-daemon stderr capture" describe relies on PID-file polling with a fixed delay — a pattern that
   is fragile under slow CI environments.

5. **Global Bun.spawn monkey-patching (in debug-loop-handlers.test.ts, done-phase.test.ts, beads/molecules.test.ts):**
   Each file saves `origSpawn` in `beforeEach` and restores in `afterEach`. No real OS processes are created.
   Pattern is correct but note that mock.module() leakage (kura record `mx-56558b`) does not apply here since
   these are direct property assignments, not module mocks.

6. **spyOn interception (in merge/resolver.test.ts):** Uses `spyOn(Bun, "spawn").mockImplementation(…)` with
   `try/finally { spawnSpy.mockRestore() }`. Passes real git commands through to `originalSpawn.apply`.
   Pattern is correct.

### Top 3 Systemic Recommendations

**1. Introduce a `withTmuxSession` fixture helper for status.test.ts (and future tmux-creating tests).**

The MEDIUM at `status.test.ts:433` arises because the tmux session is created outside the `try/finally`.
A reusable helper that wraps creation and destruction in a single scoped resource would eliminate this
class of bug:

```typescript
// Proposed helper in src/test-helpers.ts
async function withTmuxSession<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  await Bun.spawn(["tmux", "new-session", "-d", "-s", name, "sleep 300"], {
    stdout: "pipe", stderr: "pipe",
  }).exited;
  try {
    return await fn();
  } finally {
    await Bun.spawn(["tmux", "kill-session", "-t", name], {
      stdout: "pipe", stderr: "pipe",
    }).exited;
  }
}
```

**2. Replace fixed `Bun.sleep(500)` in `watchdog/control.test.ts` afterEach with a PID-file polling loop.**

The MEDIUM at lines 285/291 is a time-dependent race that becomes flaky under CI load. A polling loop
with a configurable timeout (e.g., 3 s with 100 ms intervals) makes cleanup deterministic:

```typescript
// src/watchdog/control.test.ts afterEach (~line 258)
async function waitForPidAndKill(root: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await readWatchdogPid(root);
    if (pid !== null) { try { process.kill(pid, "SIGKILL"); } catch {} return; }
    await Bun.sleep(100);
  }
}
```

**3. Wrap all `victim.kill()` calls in `try/finally` in `watchdog/control.test.ts`.**

The MEDIUM at line 337 is a simple missing `try/finally`. As the test suite grows more watchdog tests,
the pattern of spawning a SIGTERM-resistant process to test SIGKILL fallback will recur. A lint rule or
code convention requiring `try/finally { victim.kill() }` for all long-lived victim processes would prevent
future occurrences. In the immediate term, the three-line fix shown in the per-file section above is
sufficient.
