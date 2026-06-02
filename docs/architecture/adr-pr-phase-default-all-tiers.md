# ADR: pr-phase as Default for All Mission Tiers

**Status**: Proposed

**Date**: 2026-06-02

**Deciders**: Haru core team

**References**: Issue #342, Parent #283 (Stage E PR Lifecycle), Epic #204

---

## 1. Context & Problem

### Background

The pr-phase was introduced as part of the Stage E PR Lifecycle (issue #283) to give
haru missions a consistent delivery path: create a PR, wait for CI, triage comments,
await approval, then merge. Planned and full tiers include it by default. Direct tier
does not.

### Decision da-01: Why Direct Tier Opts Out

Decision da-01 is recorded in the comment block at `src/missions/engine-wiring.ts:152-157`:

> Direct tier opts OUT by default (per da-01: prevents direct missions from stalling
> on `gh_auth_missing` when GitHub is not configured). To enable pr-phase for direct
> tier, the operator must set ALL of:
> - `config.pr.enabled !== false`
> - `config.pr.operatorGithubLogin` (truthy)
> - `config.pr.directTierIncludesPr === true`

The rationale was conservative: direct tier is the "quick fix" tier. Operators invoking
it often do so in environments without a GitHub remote (local-only repos, air-gapped
machines, personal experiments). Requiring all three opt-in flags was a backstop against
missions silently stalling at `pr-phase:preflight` with a `gh_auth_missing` trigger that
routes to `pr-phase:paused` (a terminal state requiring manual intervention).

### The Problem

da-01 was appropriate when pr-phase was new and edge cases were poorly understood.
It has two growing costs:

1. **Inconsistency.** Operators expect parity across tiers. A direct mission on the same
   repo as a planned mission must be explicitly opted in to the same delivery path. This
   causes support noise and missed PR coverage on quick fixes.

2. **Friction.** The three-flag opt-in (`pr.enabled`, `pr.operatorGithubLogin`,
   `pr.directTierIncludesPr`) is non-obvious. Most operators discover it only after
   their direct mission silently skips PR creation.

The goal of issue #342 is to flip the default: make pr-phase active for direct tier when
GitHub is available, and gracefully degrade when it is not — eliminating stall risk
while removing the opt-in friction.

---

## 2. Current Behavior

### TIER_PHASES constant (deprecated path)

`src/missions/engine-wiring.ts:132-147`:

```
TIER_PHASES.direct  = ["intake", "execute", "pre-pr", "done"]
TIER_PHASES.planned = ["intake", "understand", "plan", "execute", "pre-pr", "pr", "done"]
TIER_PHASES.full    = ["intake", "understand", "align", "decide", "plan",
                        "execute", "arch-review", "pre-pr", "pr", "done"]
```

Direct omits `"pr"` entirely.

### getTierPhases() (live path)

`src/missions/engine-wiring.ts:164-193` — the three conditions that must all be true
for direct tier to include pr-phase:

```
const prEnabled      = config.pr?.enabled !== false;          // line 179
const prRequiresLogin = !!config.pr?.operatorGithubLogin;     // line 180
const includeDirect  = prEnabled && prRequiresLogin           // line 181
                       && config.pr?.directTierIncludesPr === true;
```

If any condition is false, direct tier returns `baseDirect` — no pr-phase.

### Preflight handler

`src/missions/cells/pr-phase.ts:193-201`: when pr-phase does run, its preflight node
checks `gh auth status`. Exit code ≠ 0 returns `{ trigger: "gh_auth_missing" }`, which
routes to `pr-phase:paused` (terminal) via `src/missions/cells/pr-phase.ts:113`. The
mission then requires manual operator intervention to resume.

This stall risk is why da-01 kept direct tier out by default.

---

## 3. Proposed Default

Change `TIER_PHASES.direct` and the `getTierPhases` logic so that direct tier includes
`"pr"` in the same position as planned/full tiers:

```
TIER_PHASES.direct = ["intake", "execute", "pre-pr", "pr", "done"]
```

The `getTierPhases` function's `includeDirect` condition becomes:

```
const includeDirect = prEnabled && !operatorOptedOut;
```

where `operatorOptedOut` is resolved by a new `--no-pr` flag (see §5).

The three-flag opt-in is removed. `operatorGithubLogin` and `directTierIncludesPr` are
no longer required for direct tier to enter pr-phase. Instead, the preflight node is
extended with a graceful-degradation decision tree (§4) that eliminates stall risk.

---

## 4. Graceful Degradation Design

The stall risk from da-01 is real. Removing the opt-in guards requires the preflight
node to handle all missing-GitHub scenarios as clean exits rather than `paused` terminals.

### Preflight Decision Tree

```
preflight()
  ├─ config.pr.enabled === false          → trigger: pr_phase_disabled   (existing)
  ├─ mission.noPr === true                → trigger: pr_phase_skipped    (NEW, reason: operator_opt_out)
  ├─ no git remote on repo                → trigger: pr_phase_skipped    (NEW, reason: no_remote)
  ├─ gh auth status exit ≠ 0             → trigger: pr_phase_skipped    (NEW, reason: gh_auth_missing)
  └─ all checks pass                     → trigger: preflight_passed     (existing)
```

### New trigger: `pr_phase_skipped`

Add `"pr_phase_skipped"` to `PR_PHASE_TRIGGERS` in
`src/missions/cells/pr-phase-triggers.ts`. The trigger carries a structured payload:

```typescript
{ trigger: "pr_phase_skipped"; reason: "operator_opt_out" | "no_remote" | "gh_auth_missing" }
```

The `reason` is written to a new `pr_skip_reason` field in the MRP (Mission Result
Payload) or mission artifact, making skip decisions auditable.

### Edge routing

Add a single new edge from `preflight` to `done` (the success terminal, not `paused`):

```
edge("preflight", "done", "pr_phase_skipped")
```

This replaces the existing `gh_auth_missing → paused` routing **for the new skip cases**.
The `gh_auth_missing` trigger from the current preflight still routes to `paused` for
the explicit-opt-in path (planned/full tiers where auth failure is unexpected).

For direct tier, when environment is incomplete, the mission advances to `done` cleanly
— the deliverable is the committed code on the feature branch. The operator can run `ha
mission pr` manually if they later authenticate.

### No-remote detection

Before calling `gh auth status`, check:

```
git remote -v
```

If no remote is configured, emit `pr_phase_skipped` with `reason: no_remote`. This avoids
a `gh` CLI call that would succeed but create a PR against no upstream.

---

## 5. Per-Mission Opt-Out Mechanism

Three options, evaluated against the use case "operator explicitly does not want a PR
for this one mission":

### Option A — `--no-pr` flag on `ha mission start`

```
ha mission start "fix typo" --no-pr
```

Stored as `mission.noPr: boolean` in the missions table. Checked during preflight.

**Pros:** Explicit, per-mission, visible in `ha mission show` output.
**Cons:** Requires schema migration (new column). `ha mission start` already has many
flags; adds one more.

### Option B — Infer from `featureBranch` push target

If `featureBranch` matches a pattern like `local/*` or is missing a remote tracking ref,
skip PR creation automatically.

**Pros:** Zero operator friction — works silently for local branches.
**Cons:** Unreliable heuristic. Local branches that should become PRs are common.
Branch naming conventions vary by project. Silent skips with no stated reason are
harder to audit.

### Option C — Config-level `pr.skipForDirect: true`

```yaml
pr:
  skipForDirect: true
```

Reverts the default for the whole project.

**Pros:** Simple to reason about; one switch for all direct missions.
**Cons:** Per-mission granularity is impossible. The operator who wants most direct
missions to produce PRs but needs to skip one cannot do so without removing the flag
for all.

### Recommended: Option A

`--no-pr` gives per-mission control with a clear audit trail. Option C is a valid
companion for projects that categorically never want direct-tier PRs (add it as an
alias for `pr.skipForDirect: true` → sets `directTierIncludesPr: false` to preserve
backwards compatibility). Option B should not be implemented; silent heuristic skips
are a maintenance hazard.

---

## 6. Cost / Latency Tradeoff for Direct Tier

pr-phase adds wall-clock time: CI (minutes), comment await (hours), approval await (up
to `approvalTimeoutMs` = 48 h default). This is acceptable for planned/full tiers where
the mission is already long-running. For direct tier — typically a single-workstream,
sub-5-minute execution — waiting 48 hours for approval is disproportionate.

### Fast-path signals

A direct mission qualifies for fast-path (skip `await-comments` and `await-approval`)
when **all** of:

| Signal | Threshold |
|---|---|
| File count changed | ≤ 5 files |
| No API surface change | No changes to `*.d.ts`, public `export` additions, route handlers |
| No migration | No files matching `**/migrations/**` or `*.migration.*` |
| Diff line count | ≤ 150 lines changed |

### Fast-path behavior

When fast-path signals are met, the preflight (or a new `classify` node) emits
`preflight_fast_path`. The phase graph routes:

```
preflight → create → await-ci → [ci_passed] → merge → done
```

Skipping `await-comments` and `await-approval` entirely. CI gate is still enforced
— the fast-path is not a bypass of correctness checks.

### Trade-offs

**Risk:** A "small" change that touches a public API (missed by heuristics) merges
without approval. Mitigated by the API-surface signal being explicit (export additions,
route handlers).

**Benefit:** Direct missions remain fast for their primary use case. The opt-out signals
are deterministic, not ML-based, so behavior is predictable.

If any fast-path signal fails, the mission falls back to the full pr-phase graph
(comments + approval). Operators can force full review with `--full-review` flag.

---

## 7. `operatorGithubLogin` Requirement

Currently `operatorGithubLogin` (`src/config-types.ts:278`) is optional and required
only for the direct-tier opt-in guard. With the default flipped, its role changes: it
controls comment-triage author filtering and prevents the operator from triaging their
own PR comments.

Three approaches:

### Option A — Required at `ha init`

`ha init` prompts for `operatorGithubLogin` and refuses to proceed without it, or
auto-derives it via `gh api user --jq .login`.

**Pros:** Guaranteed availability. No triage-noise risk.
**Cons:** `ha init` runs in environments without GitHub (CI bootstraps, local-only
repos). Making it blocking increases friction for non-GitHub workflows.

### Option B — `ha doctor` warning

`ha doctor` emits a `WARN` when `operatorGithubLogin` is unset and `pr.enabled` is not
false. The mission proceeds but triage logic uses a fallback (skip self-filter).

**Pros:** Non-blocking. Operators who never use PR features are unaffected.
**Cons:** The triage-noise problem remains until the operator addresses the warning.
Triage agents might classify the operator's own approval comments as "new comment
requiring triage," causing spurious coordinator resumes.

### Option C — Auto-derive from `gh api user --jq .login` at preflight

When `operatorGithubLogin` is unset and `gh auth status` passes, preflight calls
`gh api user --jq .login`, caches the result in config for the session, and proceeds.

**Pros:** Zero friction; value is always present when GitHub is available.
**Cons:** Adds a `gh` API call to every preflight (mitigated by session-level caching).
Slightly increases preflight latency (~100–200 ms).

### Recommended: Option C

Auto-derive at preflight when auth is available. Persist to `config.local.yaml` so
subsequent missions skip the API call. Surface a `ha doctor` warning (Option B) when
auth is unavailable so operators in mixed-auth environments know why triage filtering
is degraded. Option A (blocking init) is too aggressive for non-GitHub users.

---

## 8. Migration / Rollout

### Existing missions in the database

Missions already in-flight when the default flips will have their phase chain stored
in `mission_graph_nodes` (or reconstructed via `getTierPhases` on resume). Two risks:

1. A direct mission already past `execute` but before `done` will not have a `pr` node
   — it was built without one. Adding pr-phase retroactively would corrupt the graph.
2. A direct mission that completed without a PR should not re-run pr-phase.

**Safe approach:** `getTierPhases` reads `mission.createdAt` or a new
`mission.phaseChainVersion` column. Missions created before the rollout commit SHA
(recorded in a migration comment) use the old chain. New missions use the new default.
Alternatively: check whether `pr-phase` nodes exist in `mission_graph_nodes` for the
mission; if absent, skip insertion.

### Config flag to preserve old behavior

Add `pr.skipDirectTier: boolean` (default `false` after rollout) as a project-level
escape hatch:

```yaml
pr:
  skipDirectTier: true   # preserves pre-342 behavior for this project
```

This maps to `includeDirect = false` in `getTierPhases`, giving projects that relied on
the old default a non-breaking path. The flag is documented as deprecated from day one
with a target removal version.

### Schema migration

If Option A (§5) is chosen, add `no_pr BOOLEAN NOT NULL DEFAULT 0` to the missions
table. Standard idempotent migration via `src/db/migrate.ts` framework. `schema-
consistency.test.ts` must be updated to include the new column (per convention
`mx-3ef5aa`).

---

## 9. Open Questions

1. **Fast-path threshold values** — the file-count (≤5) and line-count (≤150) thresholds
   in §6 are proposals, not measured values. Should be validated against a sample of
   past direct missions before hardcoding.

2. **`pr_phase_skipped` payload schema** — should the `reason` be a free string or a
   typed union? If future degradation reasons are added, a union prevents drift.

3. **Manual PR recovery** — when a direct mission skips pr-phase with `no_remote` and
   the operator later adds a remote, should `ha mission pr` be a new subcommand to
   re-enter pr-phase post-hoc? Out of scope for this ADR but surfaces naturally.

4. **`phaseChainVersion` migration column** — exact column name, type, and migration
   version number deferred to the implementing PR.

5. **Interaction with `pre-pr` phase** — `pre-pr` already runs for direct tier. Its
   relationship to the new graceful-degradation path (does it still run before a skip?)
   is unspecified here. Likely: `pre-pr` runs unconditionally; pr-phase skip is decided
   in pr-phase's own preflight.

---

## 10. Acceptance Signals

The following observable changes confirm the proposal is implemented correctly:

| Signal | Observable |
|---|---|
| New config key | `pr.skipDirectTier: boolean` in `config-types.ts` and `config-schema.ts` |
| New config key | `pr.skipForDirect: boolean` (alias, deprecated) documented in schema |
| New trigger | `"pr_phase_skipped"` present in `PR_PHASE_TRIGGERS` (`pr-phase-triggers.ts`) |
| New trigger payload field | `reason: "operator_opt_out" \| "no_remote" \| "gh_auth_missing"` |
| New graph edge | `edge("preflight", "done", "pr_phase_skipped")` in `pr-phase.ts` |
| New MRP field | `pr_skip_reason` written to mission artifacts when skip occurs |
| `getTierPhases` output | `getTierPhases("direct", config)` returns chain including `"pr"` when `pr.enabled !== false` and no opt-out |
| `TIER_PHASES.direct` | Updated to `["intake", "execute", "pre-pr", "pr", "done"]` |
| `ha init` behavior | Auto-derives `operatorGithubLogin` via `gh api user` when unset and auth available |
| `ha doctor` | Warns `operatorGithubLogin` missing when `pr.enabled` not false |
| `ha mission start --no-pr` | Sets `mission.noPr = true`; preflight emits `pr_phase_skipped` with `reason: operator_opt_out` |
| Fast-path edge | New edge from preflight/classify to merge (skipping comments + approval) when fast-path signals met |
