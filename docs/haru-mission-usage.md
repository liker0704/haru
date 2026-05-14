# `ha mission` Operator Guide

`ha mission v1` is implemented and no longer experimental.
Use this document for day-to-day operation.

Related references:

- [Design / RFC context](./haru-mission.md)
- [Implementation / acceptance contract](./haru-mission-implementation.md)

## Your Identity

You are **operator**. The coordinator and other mission agents send messages to
`operator`. Always check mail as:

```bash
ha mail check --agent operator
```

Do NOT check other agents' mail (`--agent coordinator`, `--agent mission-analyst`,
etc.) — that is their private inter-agent communication.

## When To Use `ha mission`

Use `ha mission` for larger tasks where you want the system to:

1. clarify the objective first
2. build mission artifacts and workstreams
3. dispatch execution only after handoff
4. keep mission state durable across runtime interruptions

Use the fast-path `ha coordinator` flow when the task is already clear and you
do not need mission-level freeze / handoff discipline.

## Mission Tiers

Missions run at one of three tiers. The tier determines which phases are active
and which roles are spawned.

| Tier | Phases | Roles Spawned | When To Use |
|------|--------|---------------|-------------|
| **direct** | intake → execute → done (+ optional pr) | Coordinator + Leads (no analyst, no ED by default) | Task is already clear. Intake phase still runs (product-clarifier + tier-classifier) to materialize a spec. |
| **planned** | intake → understand → plan → execute → pr → done | Coordinator + Analyst + ED | Moderate complexity. System explores, plans, and produces a single PR for the whole mission. |
| **full** | intake → understand → align → decide → plan → execute → pr → done | Coordinator + Analyst + ED + (optional) Architect | Complex or ambiguous. Full phase discipline with alignment and decision steps. |

### Intake phase (always runs)

Every mission now starts with `intake-phase`. It runs in this order:

1. **mission-analyst-intake** — researches the codebase (spawns 2–5 scouts), materializes
   `.overstory/missions/<id>/research/_summary.md`.
2. **product-clarifier** — reads intent + research, asks operator up to 5 clarifying
   questions (skipped when `--autonomy auto-spec` or `auto-all`), writes
   `product-spec.md`.
3. **human-spec-review** gate — operator approves the spec (`ha mission spec approve`).
   Skipped automatically for `--autonomy auto-spec` / `auto-all`.
4. **tier-classifier** — reads spec + research, picks a tier, persists a
   `kura tier-classifier` observational record, sets `ha mission tier set <tier>`.

Bypass intake by starting with a pre-written spec: `ha mission start --spec spec.md
--tier planned`.

### PR phase (planned / full tiers)

For `planned`/`full` tiers (and opt-in `direct`), execute is followed by `pr-phase`
which packages the mission into a single GitHub PR:

1. `pr-phase:preflight` — checks `gh auth status` and `config.pr.enabled`.
2. `pr-phase:create` — `gh pr create --head <mission.feature_branch> --base main`.
3. `pr-phase:await-ci` / `await-comments` / `await-approval` — gates the PR
   through CI green, reviewer comments, and approval.
4. `pr-phase:merge` — auto-merge once gates pass.
5. `pr-phase:done` — transition to `done-phase`.

Disable pr-phase entirely with `config.pr.enabled: false`. See
`docs/architecture/adr-pr-phase.md` for failure-mode details (triage spawns,
coordinator-resume, debug-loop integration).

### Tier Selection Guidance

- **direct**: objective already decomposed, no research needed, fastest path
- **planned**: needs exploration, standard mission flow with analyst
- **full**: ambiguous, multi-subsystem, needs alignment, architectural decisions

### Tier Auto-Classification

Tier is no longer "assessed" by the coordinator. The `tier-classifier` agent
runs at the end of intake-phase, reads `product-spec.md` + research, applies
heuristics (file count, breaking changes, auth/billing/security signals,
ambiguity), and calls `ha mission tier set <tier>`. The classification is
persisted as a kura observational record:

```bash
ku query tier-classifier --limit 5   # see recent classifications
```

Override manually if needed:

```bash
ha mission tier show
ha mission tier set planned          # escalation only — never downgrade
```

Tiers escalate upward (`direct` → `planned` → `full`), never downward.
Escalation kills active leads, clears gate states and checkpoints, and restarts
from the appropriate phase.

### Autonomy Modes

Pass `--autonomy <mode>` at `ha mission start`. Default is `supervised`.

| Mode | What it Skips | When To Use |
|------|---------------|-------------|
| `supervised` | nothing — operator confirms spec + handoff + plan revisions | Production work, real PRs |
| `auto-spec`  | `human-spec-review` gate (clarifier writes spec, no operator approval) | Trusted intent, dev iteration |
| `auto-all`   | spec gate + coordinator handoff confirmation | Fully unattended runs (CI, batch fixes) |

Autonomy is a snapshot at coordinator spawn time. To change it mid-mission,
`ha stop coordinator-<slug>` and re-spawn after `ha mission update --autonomy <mode>`.

---

## Core Lifecycle

### 1. Start a mission

```bash
ha mission start "Stabilize the auth mission — fix JWT refresh under concurrent load"
```

Modern form — pass the **intent as a positional argument**, no flags needed.
`--slug` and `--objective` are auto-derived from the intent during intake.
Optional flags:

```bash
ha mission start "fix auth bug" --autonomy auto-spec     # skip spec approval
ha mission start "fix auth bug" --autonomy auto-all      # fully unattended
ha mission start --spec spec.md --tier planned           # skip intake, use pre-written spec
```

What this does immediately:

- creates a mission-owned run + per-mission feature branch (see #321)
- writes `.overstory/current-mission.txt` and `.overstory/current-run.txt`
- creates `.overstory/missions/<mission-id>/...`
- starts the `mission-analyst-intake` (long-lived; swaps to `mission-analyst-planned`
  or `mission-analyst` after tier-classifier sets the tier)

Execution does **not** start yet.
`execution-director` starts only at `ha mission handoff` (auto-issued at end of
plan-phase unless `--autonomy supervised`).

### 2. Answer pending mission questions

If the mission is waiting on clarification, answer through:

```bash
ha mission answer --body "Admin-only. Keep passwords. No external provider."
```

Or:

```bash
ha mission answer --file answers.md
```

Useful inspection commands while the mission is forming:

```bash
ha mission status
ha mission output
ha mission artifacts
```

## Mission Artifacts

The important paths are:

```text
.overstory/current-mission.txt
.overstory/current-run.txt
.overstory/missions/<mission-id>/
.overstory/missions/<mission-id>/plan/workstreams.json
.overstory/specs/<task-id>.md
.overstory/specs/<task-id>.meta.json
```

`current-mission.txt` is only a convenience pointer.
Mission-aware recovery now falls back to the durable `missions` table when that
pointer is stale or missing.

## Handoff And Execution

Once planning artifacts are ready, hand off execution:

```bash
ha mission handoff
```

Runtime requirements enforced by `v1`:

- every workstream in `plan/workstreams.json` must have a canonical `taskId`
- dispatch happens against the canonical task before runtime spawn
- `execution-director` can spawn only `lead`
- mission `builder` / `reviewer` dispatch requires `--spec`
- stale or missing mission spec metadata blocks spawn / resume
  (Caveat: this guard is bypassed when `current-mission.txt` is missing or
  when builders are spawned without `--spec`. See
  [verification review](./epic-13-verification-review.md) finding #2.)

After handoff, monitor the mission with:

```bash
ha mission status
ha mission output
ha status
ha dashboard
```

Shared `ha status` and `ha dashboard` now show mission runtime presence for:

- coordinator
- mission analyst
- execution director

## Refresh Briefs And Resume Workstreams

When a brief changes, refresh the affected workstream:

```bash
ha mission refresh-briefs --workstream ws-auth
```

Effect:

- the workstream is paused at mission level
- the current spec metadata is marked stale
- missing metadata is treated as regeneration-required, not as a pass

To make the workstream resumable again, regenerate the current spec from the
current brief:

```bash
ha spec write task-auth --agent lead-auth --workstream-id ws-auth --brief-path .overstory/missions/<mission-id>/plan/ws-auth.md < auth-spec.md
```

Then resume:

```bash
ha mission resume ws-auth
```

`ha mission resume` will refuse to continue if the workstream has no current
spec metadata.

If you need a manual operator pause without changing runtime agent state:

```bash
ha mission pause ws-auth --reason "Waiting on product clarification"
```

## Finish Or Abort

The mission completes itself when the engine reaches the terminal node of
`done-phase`. The operator should **not** call `ha mission complete` to end a
mission that's still running — that path is reserved for two situations:

1. **Force-completion of a wedged mission** that genuinely cannot finish on its
   own (e.g., infrastructure outage left phase state inconsistent). Investigate
   first via `ha mission output`, `ha errors`, `ha trace`.
2. **Test runs** where you want to short-circuit the pipeline.

```bash
ha mission complete             # ONLY for genuinely-wedged missions
ha mission stop                 # operator-initiated suspension (preserves state for resume)
```

Both terminal paths export a mission result bundle. Force-regenerate later:

```bash
ha mission bundle --mission <mission-id> --force
```

## Review Commands

Mission review now has command-level proof for both list and single-mission
paths:

```bash
ha review missions
ha review mission <mission-id-or-slug>
```

Add `--json` when you want machine-readable output.

## Recommended Operator Loop

For most real missions, the operator-facing loop is:

```bash
# 1. Start
ha mission start "<intent>" [--autonomy supervised|auto-spec|auto-all]

# 2. Watch the autonomous pipeline (intake → understand → plan → execute → pr → done)
ha mission status              # snapshot
ha mission output              # narrative
ha status                      # active agents
ha dashboard                   # live TUI
ha mail check --agent operator # questions for you

# 3. Answer questions ONLY when the mission asks
ha mission answer --body "..."         # for spec / handoff / decision gates
ha mission spec approve|reject         # intake-phase human-spec-review

# 4. (rare) Operator-sanctioned interventions
ha mission pause <workstream-id>
ha mission resume <workstream-id>
ha mission refresh-briefs --workstream <id>
ha spec write <task-id> --agent <lead-name> --workstream-id <id> < spec.md
ha mission workstream-complete <workstream-id>   # last resort

# 5. The mission completes itself — do NOT call `ha mission complete` yourself
ha review mission <mission-id-or-slug>           # after engine completes it
ha mission bundle --mission <id> --force         # regenerate result bundle later
```

### What the engine does, so you don't have to

| Activity | Owner | Operator's role |
|----------|-------|-----------------|
| Spec writing | product-clarifier | Approve via `ha mission spec approve` (or auto-skip with `--autonomy auto-spec`) |
| Tier selection | tier-classifier | None — auto-set; override via `ha mission tier set` only if needed |
| Plan + workstream decomposition | mission-analyst | None — confirm via answer at gate (or auto-skip with `--autonomy auto-all`) |
| Plan review (multi-critic) | plan-review-lead | None — runs up to 3 rounds, then approves or escalates |
| Workstream dispatch | execution-director | None |
| Per-workstream build + review | lead / builder / reviewer | None |
| Branch merging | execution-director via `ha merge` | **DO NOT MERGE MANUALLY** |
| PR creation, CI watch, auto-merge | pr-phase cell | None — operator may comment on PR for code feedback |
| Holdout validation + summary | done-phase | None |
| Mission completion | engine (terminal node) | Read the result bundle |

## Graph Engine & Waiting State

The mission graph engine runs inside the watchdog daemon (`ha watch`), one tick
per interval. It is the runtime controller for automated phase transitions and
agent lifecycle management.

**What it does:**

- Evaluates graph gates each tick and auto-advances phases when conditions are
  met (e.g., scout finishes → advance to next step)
- Nudges stuck agents when their grace period expires
- Detects dead agents (zombie tmux sessions) and auto-resumes them
- Enforces timeout ceilings (`maxTotalWaitMs`) and escalates when exceeded

**Configuration in `config.yaml`:**

```yaml
mission:
  graphExecution: true          # Enable/disable engine (default: true)
  maxConcurrent: 1              # Max active missions (default: 1)
  freezeTimeoutMs: 1800000      # Frozen mission auto-unfreeze (default: 30 min)
```

Set `graphExecution: false` to disable automatic phase transitions and rely on
manual advancement instead.

**Grace period overrides:**

The engine waits a grace period before nudging a stuck agent. Defaults range
from 2 minutes (general) to 10 minutes (long-running gates). Override in config:

```yaml
mission:
  gates:
    gracePeriods:
      await-plan: 300000        # 5 min
      await-ws-completion: 600000  # 10 min
    maxTotalWaitMs:
      await-ws-completion: 14400000  # 4 hours
```

### Phase Subgraphs

Each lifecycle phase has an internal subgraph that automates its step-by-step
flow. Gates are either `async` (resolved by mail/artifact detection) or `human`
(resolved by operator via `ha mission answer`).

- **understand-phase**: ensure-coordinator → await-research → evaluate →
  (frozen if user input needed) → complete
- **plan-phase**: dispatch-planning → await-plan → check-tdd →
  (optional architect-design) → review → await-handoff → complete
- **execute-phase** (planned/full): ensure-ed → dispatch-ready →
  await-ws-completion → update-status → check-remaining → (loop or complete).
  Includes optional architecture review path for TDD missions. Workstream
  merges land on `mission.feature_branch` (per #321), not on `main`.
- **execute-direct-phase** (direct tier only): dispatch-leads → await-leads-done
  → merge-all → (loop or complete). Simplified — no Execution Director.
- **pr-phase** (planned/full, opt-in for direct): preflight → create →
  await-ci → await-comments → await-approval → merge → done. Includes a
  debug-loop that spawns `debugger` on CI failure (Stage E).
- **done-phase**: summary → holdout → cleanup → complete

For architecture-level graph engine internals, see
`docs/architecture/adr-graph-engine-lifecycle.md`.

### Agent Waiting State

When agents dispatch sub-agents (scouts, builders), they set `state=waiting`
before stopping. The system keeps them alive:

- Agents are NOT marked completed while in `waiting` state
- When sub-agents send results, the waiting agent is auto-resumed
- The watchdog skips stale/zombie escalation for waiting agents

If an agent gets stuck in `waiting` for too long, the graph engine's
`maxTotalWaitMs` ceiling triggers escalation.

### Manual Workstream Completion

If the engine's automatic workstream status tracking fails, operators can
manually mark a workstream as completed:

```bash
ha mission workstream-complete <workstream-id>
```

## Autonomous Operation

Missions run autonomously. The operator monitors progress via a sleep-based
polling loop — no manual intervention unless agents ask questions.

```bash
# Typical autonomous monitoring loop (max 15 min sleep between checks)
while true; do
  ha mission status
  ha mail check --agent operator
  sleep 900   # 15 minutes max between checks
done
```

Shorter sleep intervals (60-300s) are appropriate during active phases like
handoff and early execution. Use 900s (15 min) for steady-state monitoring.

Answer agent questions promptly via `ha mission answer` or `ha mail reply` —
agents block until they get a response.

### What NOT to Do

The operator's job is **monitoring and answering questions** — nothing else.
The mission is autonomous; the coordinator owns the lifecycle. Doing the
coordinator's work by hand corrupts state and skips quality gates.

**Hard rules:**

- **Do NOT manually merge workstream branches.** When a lead emits `merge_ready`,
  the execution-director is the agent responsible for `ha merge --branch <name>`.
  If you race it and merge yourself:
  - You bypass the per-mission feature branch (#321) — your commits land on `main`
    instead of `mission/<slug>`, and pr-phase has nothing to PR from.
  - The coordinator and ED no longer see the branch in their merge queue → they
    sit in `waiting` for a merge that already happened.
  - You miss the deterministic merge ordering and conflict resolution that the
    merge queue provides.
- **Do NOT call `ha mission complete` to "finish" a mission you think is done.**
  Completion is a terminal transition emitted by the engine when `done-phase`
  reaches its terminal node. Manual `complete` truncates artifacts (review bundle,
  holdout, summary) and skips post-mission cleanup.
- **Do NOT `git push` to `main` from the canonical repo while a mission is active.**
  The ED owns merge → push. Pushes from outside the merge queue race with workstream
  merges and can lose commits.
- **Do NOT manually re-spawn coordinator / analyst / ED if you think they died.**
  The watchdog auto-resumes waiting agents on mail arrival. If they're truly dead,
  use `ha mission resume` — it re-attaches to existing session, doesn't fork.
- **Do NOT close GitHub issues that a mission is fixing.** The lead closes them
  after merge. Closing yourself loses the lead's tracking signal.
- Don't read other agents' mail (`--agent coordinator`, `--agent mission-analyst`).
- Don't `ha mail list` to snoop on inter-agent communication.
- Don't nudge agents unless they're clearly stuck (15+ min no progress).

**If the mission appears stuck and you're tempted to intervene:**

1. First check why — `ha mission output`, `ha errors`, `sqlite3 mail.db` for
   recent traffic.
2. If a gate hit its `maxTotalWaitMs` ceiling, the engine has already escalated.
3. If you truly need to unstick: use `ha mission resume`, `ha mission pause`,
   `ha mission refresh-briefs`, `ha mission workstream-complete` — the operator-
   sanctioned escape hatches. They keep the engine consistent. Manual SQL,
   manual merge, and manual `git push` corrupt state.

### Status Interpretation

`ha status` reports several fields you should be able to read at a glance:

| Field | Meaning |
|-------|---------|
| `Agents: N active` | Running agent count |
| `> name [capability] working \| task \| duration` | Individual agent |
| `Worktrees: N` | Git worktrees in use |
| `Merge queue: N pending` | Branches waiting to merge |
| `Mission: name (state/phase)` | Current state |
| `Pending: question` | YOU need to answer something |
| `frozen` | Mission paused waiting for input |

### Linking GitHub Issues

When the mission intent comes from one or more GitHub issues, reference them
explicitly in the intent — the mission-analyst-intake will `gh issue view` each
one during research:

```bash
ha mission start "Implement HTTP server foundation per #47. Read the issue \
body for requirements, file scope, acceptance criteria."
```

For batch bug-fix missions, list all issues in the intent so the analyst can
cluster them into workstreams:

```bash
ha mission start "Fix 6 open bugs:
- #313 autonomy doesn't skip understand-phase Q
- #314 plan_review_consolidated convergence
- #315 mail banner numbering
- #280 daemon_source_drift event missing
- #258 holdout snapshot-diff wiring
- #305 pr-phase triage CAS race
Read each issue first. Group by file proximity." --autonomy auto-all
```

## Monitoring Operator Mail

Agents (coordinator, analyst, leads) send mail to `operator` for questions,
status updates, and results. Check it regularly during a mission:

```bash
# Check for new unread messages addressed to operator
ha mail check --agent operator

# List all messages sent to operator (including already read)
ha mail list --to operator

# Read a specific message
ha mail read <message-id>

# Reply to an agent's question
ha mail reply <message-id> --body "Your answer here"
```

Typical mail you will receive:

- **question** (HIGH priority) — agent needs clarification to proceed
- **status** — progress update from coordinator or execution-director
- **result** — mission or workstream completion report
- **error** — something broke, agent needs help

Tip: run `ha mail check --agent operator` between lifecycle commands
(`status`, `output`, `handoff`) to catch pending questions early.

## Troubleshooting

- `ha mission handoff` fails:
  check that `plan/workstreams.json` is valid, every workstream has a canonical
  `taskId`, and each dispatchable workstream has a real `briefPath`.
- `ha mission resume` fails:
  the workstream still has stale or missing `.overstory/specs/<task-id>.meta.json`;
  regenerate the spec with `ha spec write`.
- `builder` / `reviewer` spawn fails under mission mode:
  supply `--spec`, and make sure the spec metadata matches the task being
  dispatched.
