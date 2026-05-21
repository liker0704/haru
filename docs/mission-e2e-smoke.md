# Mission E2E Smoke Verification Note

> **This is a smoke note, not an integration test suite.** See
> [What this doc is NOT](#what-this-doc-is-not) before acting on any
> evidence listed here.

Last verified: 2026-05-21 against `main` after PR #446.

Related docs:
- [Operator guide](./haru-mission-usage.md) — day-to-day usage reference
- [Design / RFC](./haru-mission.md) — product model and rationale
- [Implementation contract](./haru-mission-implementation.md) — acceptance criteria
- [Graph engine ADR](./architecture/adr-graph-engine-lifecycle.md) — lifecycle design

---

## Architecture at a glance

The autonomous mission pipeline is driven by three co-operating components:

1. **Watchdog daemon** (`ha watch`) — always-on Tier 0 health controller. Runs
   the graph execution engine each tick. Never restart manually; let it respawn
   agents, advance gates, and escalate blockers on its own cadence.

2. **Graph execution engine** (`src/missions/engine.ts`) — runs inside the
   watchdog tick. Evaluates each phase gate (`evaluateGate()`), nudges agents
   past their grace window, and respawns dead agents. Phase transitions are
   fully automatic once the daemon is running.

3. **Coordinator agent** — long-lived Claude Code session that owns mission
   intent, communicates with the operator, dispatches the Execution Director
   (ED), and holds freeze/resume authority. The coordinator does not drive phase
   transitions — the engine does.

Agent hierarchy for a `full`-tier mission:

```
Operator
  └── Coordinator  (depth 0)
        └── Execution Director  (depth 1)
              ├── Architect
              ├── Plan-review lead
              └── Builder / Reviewer leads  (depth 2)
                    └── Specialist workers  (depth 3)
```

Depth limit defaults to 3 (configurable). Tier affects which roles are spawned;
`direct` skips analyst and ED by default.

---

## Pipeline exercised

The phases below cover the `full` tier. `planned` omits `align`/`decide`.
`direct` omits `understand` through `plan`. Intake always runs.

### intake-phase

**CLI trigger:** `ha mission start "<intent>"`

Sub-steps executed by the graph engine in order:

1. `intake:research` — `mission-analyst-intake` spawns 2–5 scout agents, reads
   the codebase, and writes `research/_summary.md`.
2. `intake:clarify` — `product-clarifier` reads intent + research summary, asks
   the operator up to 5 clarifying questions (via `ha mail`), and writes
   `product-spec.md`. Skipped when `--autonomy auto-spec` or `auto-all`.
3. `intake:human-spec-review` — gate waits for `ha mission spec approve`.
   Skipped automatically under `auto-spec` / `auto-all`.
4. `intake:tier-classify` — `tier-classifier` reads spec + research, picks
   `direct` / `planned` / `full`, and calls `ha mission tier set <tier>`. Result
   is persisted as a kura observational record.

Operator commands used during this phase:
```bash
ha mission answer --body "<clarification>"   # answer clarifier question
ha mission spec approve                      # approve spec and advance gate
ha mission tier set planned                  # override tier if needed (escalate only)
```

### understand-phase

**Driver:** ED dispatches a `mission-analyst-planned` or `mission-analyst-full`
agent, which researches deep technical context and appends to `research/`.

Gate clears automatically when `research/_summary.md` is updated with
understand-phase findings.

### align-phase / decide-phase

Both are **auto-advance phases** (no dedicated cell file). The graph engine
advances them in the next tick without spawning any agent. They exist as
explicit graph nodes so operators can inspect the mission graph and understand
where the mission is in the lifecycle.

### plan-phase

**Driver:** ED spawns the architect and plan-review-lead.

Sub-steps:
1. `plan:architect` — produces `plan/architecture.md` and
   `plan/workstreams.json`.
2. `plan:review` — plan-review-lead (with optional critic sub-agents: security,
   performance, architecture, devil-advocate) reviews the plan and either
   approves or sends revision requests.
3. `plan:human-plan-review` — gate in `supervised` mode waits for operator
   approval of the plan. Skipped under `auto-all`.

Gate clears once plan is approved.

### execute-phase

**Driver:** ED dispatches builder + reviewer leads per workstream entry in
`plan/workstreams.json`.

Each lead spawns specialist builders, runs quality gates, and calls
`ha mission workstream-complete <ws-id>` when done. The execute gate clears
once all workstreams report complete.

Operator commands:
```bash
ha mission workstream-complete <ws-id>     # called by lead, not operator normally
ha mission refresh-briefs --workstream <id> # regenerate briefs after spec change
ha mission pause <ws-id> --reason "..."   # pause a specific workstream
ha mission resume <ws-id>                 # resume a paused workstream
ha mission handoff                        # confirm execute handoff (supervised mode)
```

### pre-pr phase

**Driver:** graph engine node `pre-pr:create-feature-branch`.

Creates the mission's feature branch off `origin/main` using git plumbing
(not local main, to prevent divergence). This is the branch that `gh pr create`
will use as `--head`.

No operator interaction required. Fails fast if `origin` is unreachable.

### pr-phase

**Driver:** `pr-phase:create` — runs `gh pr create --head <feature_branch>
--base main` after verifying `gh auth status` and `config.pr.enabled`.

Sub-steps:
1. `pr-phase:preflight` — `gh auth status` + config guard.
2. `pr-phase:create` — creates the PR.
3. `pr-phase:await-ci` — gate waits for all required GitHub checks to pass.
4. `pr-phase:await-comments` — gate waits for reviewer comments to be
   resolved (configurable; may be skipped).
5. `pr-phase:await-approval` — gate waits for at least one approving review.
6. `pr-phase:merge` — auto-merges the PR once all gates pass.
7. `pr-phase:done` — transitions to `done-phase`.

Disable pr-phase: set `config.pr.enabled: false` in `.overstory/config.yaml`.

### done-phase

**Driver:** graph engine node `done-phase:cleanup`.

1. Deletes the local feature branch (`git branch -D <feature_branch>`).
2. Runs `git fetch --prune` to remove stale remote-tracking refs.
3. Sets mission state to `complete`.

No operator interaction required.

---

## Operator-facing commands verified

### Start a mission

```bash
ha mission start "<intent>"
```

Recommended: pass free-text intent (2–5 sentences describing what + why).
The intake phase reads the *style* of intent, not just the words.

```bash
# Supervised — operator confirms spec and plan
ha mission start "Fix the auth service JWT refresh race under concurrent load"

# Auto-spec — skip human-spec-review gate
ha mission start "Fix JWT refresh race" --autonomy auto-spec

# Fully unattended — skip spec gate + coordinator handoff confirmation
ha mission start "Fix JWT refresh race" --autonomy auto-all

# Power user: pre-baked spec (narrow use cases only)
ha mission start --spec ./product-spec.md --tier planned

# Force a tier (skips tier-classifier)
ha mission start "<intent>" --tier direct
```

### List missions

```bash
ha mission list
ha mission list --json   # machine-readable
```

Shows all missions with slug, tier, current phase, state, and timestamps.
States: `active`, `frozen`, `suspended`, `complete`, `superseded`.

### Inspect a single mission

```bash
ha mission show <slug>
ha mission show <slug> --graph     # include phase graph with gate states
ha mission graph --mission <slug>  # standalone graph view
ha mission output                  # full coordinator stdout/stderr tail
ha mission artifacts               # list mission artifact paths
ha mission status                  # one-line summary
```

### Stop a mission

```bash
ha mission stop --kill --mission <slug>
```

Terminates all active agents for the mission (coordinator + any workers).
`--kill` sends SIGTERM to tmux panes immediately. Without `--kill`, agents
are asked to wind down gracefully (they may take several minutes).

Mission state is set to `suspended`. Artifacts are preserved. To resume:

```bash
ha mission start --continue <slug>
```

### Override a gate manually

```bash
ha mission override --node <node-id> --trigger <trigger-name>
```

Forces a gate to advance regardless of its normal evaluation conditions.
Use when a gate is stuck due to a transient failure and you have manually
verified the underlying condition is actually met (e.g., CI passed but the
poller missed it).

Find valid `--node` values:

```bash
ha mission graph --mission <slug>   # lists all nodes with current state
```

Common trigger names: `gate_passed`, `human_approved`, `spec_approved`,
`plan_approved`. Trigger names are defined per-gate in
`src/watchdog/gate-evaluators.ts`.

### Other frequently-used operator commands

```bash
ha mission answer --body "<answer>"          # answer a frozen-mission question
ha mission answer --file answers.md          # bulk answers from a file
ha mission tier show                         # current tier
ha mission tier set planned                  # escalate tier (never downgrade)
ha mission handoff                           # confirm execute-phase handoff
ha mission refresh-briefs --workstream <ws>  # regenerate agent briefs after spec change
ha mission pause <ws-id> --reason "..."      # pause a workstream
ha mission resume <ws-id>                    # resume a paused workstream
ha mission workstream-complete <ws-id>       # mark workstream done (called by lead)
ha mission bundle --mission <id> --force     # pack artifacts for recovery/transfer
ha mission extract-learnings                 # run mulch extract after mission complete
ha mission complete                          # force-complete a wedged mission (last resort)
```

---

## Recent regression fixes confirmed

The following PRs merged between 2026-05-19 and 2026-05-21, all on `main` as
of this note. The one-liner per row is the commit subject.

| PR | Fix |
|----|-----|
| **#421** | `fix(pr-phase)`: push feature branch to `origin` before `gh pr create` — without this the remote had no branch to open a PR against |
| **#424** | `fix(watchdog)`: file lock serializes concurrent `watchdog.start()` calls — prevents orphan daemon processes when two sessions race on startup |
| **#426** | `fix(lifecycle)`: propagate resume errors to operator; restart ED correctly for execute-tier phases; distinguish OOM vs. fresh-restart log messages |
| **#428** | `fix(coordinator)`: record mulch learnings before worktree cleanup so insights survive the done-phase teardown |
| **#433** | `fix(watchdog)`: drain tailer registry on daemon `stop()` — prevents file-handle leak accumulation across daemon restarts |
| **#434** | `fix(pr-phase, gate-evaluators)`: two intake/pr regressions that blocked the full auto-PR flow end-to-end |
| **#435** | `fix(watchdog, events, tracker)`: four backlog bugs — watchdog stale-agent false-positive, events DB schema gap, tracker adapter edge case, health-eval loop |
| **#436** | `fix(missions)`: mulch `extract-learnings` pre-cleanup order restored; CLI mutex deadlock resolved |
| **#437** | `feat(agents)`: wire `HARU_MISSION_TASK_ID` env var into agent spawn so sub-issues auto-link to the parent mission tracker issue |
| **#438** | `fix`: five quick-win backlog issues — minor guard/validation regressions identified during smoke runs (#410, #381, #382, #384, #398) |
| **#439** | `fix`: `--spec --tier` flag combo now correctly spawns roles; `ha mission override` CLI wired up end-to-end (#351, #352) |
| **#440** | `test(config)`: regression tests for watchdog `rpcTimeoutMs`, `triageTimeoutMs`, `maxEscalationLevel`, `triageMaxConcurrent` config fields (#385) |
| **#442** | `docs(research)`: Bun.spawn test-leakage audit added to research corpus (#395) |
| **#444** | `fix(pr-phase)`: feature branch built off `origin/main` via git plumbing — prevents divergence when local `main` lags remote (#443) |
| **#446** | `fix(done-phase)`: auto-delete local feature branch + `git fetch --prune` at mission completion to keep worktree state clean (#445) |

All 15 fixes are exercised by the smoke walkthrough below. If any step fails,
check `ha errors` and `ha doctor --fix` before bisecting.

---

## What this doc is NOT

- **Not an integration test suite.** There are no assertions here. To run
  the automated suite: `bun test`.

- **Not a comprehensive architecture reference.** For that, see:
  - [`docs/architecture/adr-graph-engine-lifecycle.md`](./architecture/adr-graph-engine-lifecycle.md) — graph engine design decisions
  - [`docs/architecture/overview.md`](./architecture/overview.md) — system-level module map and metrics
  - [`docs/architecture/workflows.md`](./architecture/workflows.md) — event flow diagrams
  - [`docs/haru-mission.md`](./haru-mission.md) — design RFC and product model
  - [`docs/haru-mission-usage.md`](./haru-mission-usage.md) — full operator guide
  - [`docs/haru-mission-implementation.md`](./haru-mission-implementation.md) — acceptance contract

- **Not a runbook.** For incident response procedures, see
  [`docs/runbooks/`](./runbooks/).

- **Not a live health monitor.** Use `ha health`, `ha doctor`, and
  `ha dashboard` for real-time operational status.

- **Not a substitute for `ha doctor --fix`.** This doc records what was
  observed at a point in time. If your environment diverges (stale worktrees,
  locked daemon, schema drift), run `ha doctor` for a live diagnosis rather
  than grepping this file.

- **Not authoritative on config schema.** Config fields mentioned here
  (e.g., `config.pr.enabled`) are illustrative. Run `ha config list` for the
  current schema, and `ha doctor --category config` if something looks off.

---

## Smoke walkthrough

When validating a fresh checkout or verifying a release candidate, follow
these steps in order. Each step matches a phase in the pipeline above.

```bash
# 0. Prerequisites: clean tree, quality gates green
bun test && bun run lint && bun run typecheck

# 1. Start the watchdog daemon (required for lifecycle engine)
ha watch

# 2. Start a minimal mission — direct tier, fully unattended, smoke intent
ha mission start "smoke: verify e2e pipeline is healthy on fresh checkout" \
  --autonomy auto-all --tier direct

# 3. Confirm intake is running
ha mission list                         # mission appears with state=active
ha mission show <slug>                  # phase=intake, coordinator active

# 4. Watch it advance through execute → done
ha mission output                       # tail coordinator output
ha dashboard                            # optional TUI overview

# 5. Confirm done state
ha mission show <slug>                  # state=complete, phase=done
ha mission artifacts                    # artifacts present under .overstory/missions/<id>/

# 6. Verify post-done cleanup
git branch | grep <feature-branch>      # should be absent (deleted by done-phase)
git fetch --dry-run 2>&1 | grep prune   # no stale refs (fetch --prune ran)
```

If any step fails before the mission reaches `done`:

```bash
ha errors                       # recent error events
ha logs --level error           # structured error log
ha doctor                       # full health check
ha doctor --fix                 # attempt auto-remediation
ha mission override --node <node> --trigger gate_passed   # manual gate advance (last resort)
```
