# ADR: Stage E Lifecycle Refactor — Arch-Review Extraction, Pre-PR Phase, MRP-Bodied PRs

**Status**: Accepted

**Date**: 2026-05-16

**Deciders**: Haru core team

**References**: Epic #344, Sub-issues #345, #346, #347, #348, #349. Shipping commits: `8db536d0`, `85cb4212`, `91252b41`, `4652e59e`, `8e2cabb8`, `4609e8c3`, `3a651cd3`, `eda42bba`, `bcbce835`.

---

## Context

The mission lifecycle prior to Stage E ended at `execute` for planned/full tiers and lacked a clean handoff into PR creation. Three problems forced the refactor:

1. **Architecture review was tangled with execute-phase.** Arch-review ran as a sub-handler inside `execute-phase.ts`, making the phase responsible for both work dispatch and reviewer convergence. A timeout during review blocked the entire execute phase; there was no way to target the stall without touching execute-phase internals.

2. **No artifact-assembly phase before PR creation.** A mission could complete execute without ever materializing a Merge Readiness Pack (MRP). PR bodies were ad-hoc strings with no guaranteed content.

3. **PR bodies could not carry the MRP.** `gh pr create --body` is subject to shell argument-length limits; a real MRP can exceed those limits, silently truncating content that human reviewers depend on.

Stage E introduced two new lifecycle phases (`arch-review`, `pre-pr`) and refactored `pr-phase:create` to consume a file-written MRP rather than an in-line string.

---

## Decision

Three decisions were made and shipped together as Epic #344.

### Decision 1: Extract `arch-review-phase` from `execute-phase` (full tier only) [#345]

**Statement.** Architecture review is moved into its own lifecycle phase between `execute` and `pre-pr`, running for full-tier missions only.

**Rationale.** Isolating the convergence-style review loop from work dispatch lets watchdog target arch-review stalls (`arch-review-stall` mission_finding) without entangling execute-phase gate evaluators. Direct and planned tiers skip `arch-review` entirely.

**Implementation.** `src/missions/cells/arch-review-phase.ts` — 6-node subgraph. Phase wiring lives in `src/missions/graph.ts:47-57`; tier filtering (full-tier-only inclusion) is enforced in `src/missions/engine-wiring.ts:134-164` (`getTierPhases()` / `TIER_PHASES`), where only the `full` tier's phase list contains `"arch-review"`. Shipped via `85cb4212` and `91252b41`.

**Rejected alternative.** Leaving arch-review as a sub-handler of execute-phase. Rejected because review timeouts blocked work dispatch and complicated gate-evaluator semantics.

**Confidence.** High.

### Decision 2: Introduce `pre-pr-phase` between `execute` (or `arch-review` for full tier) and `pr` [#346]

**Statement.** A new lifecycle phase finalizes mission artifacts, evaluates quality gates, and writes a Merge Readiness Pack (MRP) JSON to `<artifactRoot>/merge-readiness-pack.json`.

**Rationale.** Decoupling PR-body generation from mission orchestration guarantees an MRP exists before any PR is opened and makes the MRP a first-class lifecycle artifact rather than an opaque side-effect of pr-phase.

**Implementation.** `src/missions/cells/pre-pr-phase.ts` — 6-node subgraph. The `finalize` handler writes placeholder `quality-gates.json` + `test-report.json` (commit `bcbce835`) so the v1 cell can run end-to-end before full holdout integration. The `write-mrp` handler (`pre-pr-phase.ts:232-239`) calls `assembleMrp()` from `src/merge/mrp-assembler.ts` (shipped via `4652e59e`), sanity-renders via `renderMrpMarkdown()` from `src/merge/mrp-renderer.ts` (the markdown output is **discarded** — the call is a bug-detection probe), and persists the assembled `MergeReadinessPack` as JSON. Markdown rendering for the PR body is deferred to `pr-phase:create` (Decision 3). Cell shipped in `8db536d0`.

**Important nuance.** The `escalate → paused` terminal within the cell is **informational only**. Subgraph-terminal completion bubbles `status=completed` to the parent lifecycle, which auto-advances. Hard-halt semantics are deferred to debug-loop integration.

**Rejected alternative.** Generating the MRP inside `pr-phase:create`. Rejected because it conflates artifact assembly with PR creation and makes recovery from a failed MRP assembly harder to isolate.

**Confidence.** High.

### Decision 3: Refactor `pr-phase:create` to render the MRP as the PR body via `--body-file` [#348]

**Statement.** `pr-phase` reads the MRP JSON written by `pre-pr-phase`, renders it to markdown via `renderMrpMarkdown()`, writes the markdown to a temp file, and passes that file to `gh pr create --body-file <tmp>`.

**Rationale.** Sidesteps shell argument-length limits. Makes the PR body a faithful, machine-rendered view of the mission's actual artifacts (mission, sessions, git stats), not an ad-hoc string.

**Implementation.** `src/missions/cells/pr-phase.ts:225` writes `pr-body-<missionId>.md` to `tmpdir()` and invokes `gh pr create --title <title> --body-file <tmp> --head <branch> --base main`. Shipped in `8e2cabb8`. A fallback remains: if `pre-pr-phase` did not write an MRP, the body falls back to `"Automated PR for mission: <title>\n\n(MRP unavailable — pre-pr-phase may have failed to write it)"`. The happy path exercises the real-MRP branch.

**Rejected alternative.** Posting the MRP as a follow-up PR comment. Rejected because the MRP is the PR's primary description for human reviewers, not supplemental content.

**Confidence.** High.

---

## Architecture Overview

Phase flow before and after Stage E:

```text
Before Stage E:
  ... execute (with embedded arch-review handler) → done

After Stage E:
  ... execute → [arch-review*] → pre-pr → [pr**] → done
                * full tier only       ** planned/full only
```

Component inventory:

| Component                   | File                                        |
|-----------------------------|---------------------------------------------|
| arch-review-phase cell      | `src/missions/cells/arch-review-phase.ts`   |
| pre-pr-phase cell           | `src/missions/cells/pre-pr-phase.ts`        |
| pr-phase cell               | `src/missions/cells/pr-phase.ts`            |
| MRP assembler               | `src/merge/mrp-assembler.ts`                |
| MRP renderer                | `src/merge/mrp-renderer.ts`                 |
| Phase wiring                | `src/missions/graph.ts:47-57`               |
| Predecessor MRP enforcement | `src/missions/predecessor.ts:50-60`         |

---

## Detailed Design

### arch-review-phase (Decision 1)

The 6-node subgraph in `src/missions/cells/arch-review-phase.ts`:

```text
dispatch-architect  (async gate, 900 s)
  → await-arch-review  (async gate, 3600 s)
  → check-refactor  (handler)
    --refactor_needed→ await-refactor  (async gate, 14400 s)
    --no_refactor→ await-arch-final
  → await-arch-final  (async gate, 3600 s)
  → complete  (terminal)
```

No `escalate` handler or `paused` terminal are present in the cell. Operator escalation for stalls lives at the watchdog level (`src/watchdog/mission-tick.ts`) via the `arch-review-stall` mission_finding. This was intentional: the flat-keyspace `HandlerRegistry` would have collided with handler keys already in use by `pr-phase`, `pre-pr-phase`, `intake-phase`, and `debug-loop-handlers`.

Phase inclusion is gated exclusively in `src/missions/engine-wiring.ts:134-164`. The `TIER_PHASES` constant maps `"full"` to a phase list that includes `"arch-review"`, while `"direct"` and `"planned"` do not. Commits `85cb4212` (cell) and `91252b41` (lifecycle wiring) shipped this.

### pre-pr-phase (Decision 2)

The 6-node subgraph in `src/missions/cells/pre-pr-phase.ts`:

```text
finalize       (handler — writes quality-gates.json, test-report.json)
  → check-gates  (handler)
  → write-mrp    (handler — calls assembleMrp(), sanity-renders, writes JSON)
  → complete     (terminal)
  → escalate     (handler — informational mission_finding)
  → paused       (terminal)
```

The `write-mrp` handler at `pre-pr-phase.ts:232-239` calls `assembleMrp()` from `src/merge/mrp-assembler.ts` (partial #347, `4652e59e`), invokes `renderMrpMarkdown()` as a bug-detection probe (result discarded), and persists the `MergeReadinessPack` object as JSON to `<artifactRoot>/merge-readiness-pack.json`. Markdown rendering for the PR body is delegated to `pr-phase:create`.

### pr-phase:create (Decision 3)

The `create` handler at `src/missions/cells/pr-phase.ts:225` executes:

```bash
gh pr create --title <title> --body-file /tmp/pr-body-<missionId>.md --head <branch> --base main
```

The markdown file is written by `renderMrpMarkdown()` from `src/merge/mrp-renderer.ts` on the MRP JSON previously persisted by `pre-pr-phase`. Using `--body-file` instead of `--body` sidesteps shell argument-length limits that would otherwise silently truncate large MRP payloads. Shipped in `8e2cabb8`.

---

## Tier Variants

Tier-phase wiring lives in `src/missions/engine-wiring.ts:134-164` (`getTierPhases()`). The tier name alone does **not** determine the phase list — three `config.pr` keys modulate whether `pr-phase` is included:

- `config.pr.enabled !== false` — must be truthy for any tier to include `pr-phase`.
- `config.pr.operatorGithubLogin` — must be truthy for the direct tier to include `pr-phase`.
- `config.pr.directTierIncludesPr === true` — direct tier additionally requires this opt-in.

**Direct tier** — default phase sequence: `intake → execute → pre-pr → done`. Skips `arch-review` and `pr`. `pre-pr-phase` still runs, but its `write-mrp` handler short-circuits in two cases (`src/missions/cells/pre-pr-phase.ts:206-230`): (a) when `!mission.featureBranch && tier === 'direct'` (no branch by design for ad-hoc direct work), and (b) when `!deps.assembleMrp && tier === 'direct'` (DI not wired for direct-tier context). In both cases the handler returns `mrp_written` **without writing anything** — a legitimate skip. When direct tier opts into `pr-phase` via all three `config.pr` keys and does have a feature branch plus wired DI, an MRP is written; otherwise no MRP exists. Any future successor mission that attempts to continue from a no-MRP predecessor will hit `PREDECESSOR_MRP_MISSING` (see Consequences).

**Planned tier** — phase sequence when `pr.enabled !== false`: `intake → understand → plan → execute → pre-pr → pr → done`. Skips `arch-review`. This is the tier exercising this mission.

**Full tier** — phase sequence when `pr.enabled !== false`: `intake → understand → align → decide → plan → execute → arch-review → pre-pr → pr → done`. Runs all Stage E phases.

For all tiers, when `config.pr.enabled === false`, `pr-phase` is omitted and the mission transitions `pre-pr → done` directly.

---

## Consequences

- **`predecessor.ts` MRP enforcement.** Commit `eda42bba` tightened `src/missions/predecessor.ts:50-60` to require an MRP and drop the `"No MRP available"` fallback. Any mission that attempts to continue from a predecessor that did not complete `pre-pr-phase` now throws `PREDECESSOR_MRP_MISSING`. This is the enforcement consequence of Decision 2 making MRP a first-class lifecycle artifact.
- **New mission_finding type.** Watchdog gained `arch-review-stall` as a new `mission_finding` category. Operator-facing escalation paths increased by one.
- **`tmpdir()` write dependency.** PR creation now explicitly requires write permission to the system temp directory. (Was always implicitly the case; now surfaced in `pr-phase:create`.)
- **Increased gate-evaluator surface.** The mission lifecycle gained two phases (`arch-review`, `pre-pr`), adding switch-case entries to `src/watchdog/gate-evaluators.ts`.
- **Agent-prompt correction required.** Commit `3a651cd3` removed premature `ha mission complete` calls from coordinator prompts that were pre-empting `pre-pr` and `pr` phases. This was a necessary condition for the end-to-end pipeline to run.

---

## Alternatives Considered

- **Keep arch-review inside execute-phase.** Rejected — see Decision 1. Review timeouts blocked work dispatch and could not be targeted independently.
- **Generate MRP inside pr-phase.** Rejected — see Decision 2. Conflates artifact assembly with PR creation; harder to recover from MRP assembly failures.
- **Use `gh pr create --body` with truncation.** Rejected — see Decision 3. Would silently drop MRP content, defeating the purpose of machine-rendered PR bodies.
- **`pr-direct` (#349): lightweight PR flow for direct tier.** Deferred follow-up. Direct-tier missions do not open a PR today; #349 proposes a lightweight variant. Out of scope for this ADR — mention as future work only.

---

## Status / Implementation

Shipped 2026-05-16 per commit `4609e8c3` (`docs(roadmap): announce Stage E PR lifecycle shipped`). Sub-issues #345, #346, #348 closed by shipping. Sub-issue #347 is partially shipped: `assembleMrp()` landed via `4652e59e` and is consumed by `pre-pr-phase:write-mrp`; execute-finalizer-artifacts and holdout-migration portions remain open. Sub-issue #349 (`pr-direct`) remains open as a related follow-up.

---

## References

- Epic #344 — Lifecycle refactor: extract arch-review phase, introduce pre-pr, close MRP pipeline
- Sub-issue #345 — Extract arch-review into its own phase (full tier)
- Sub-issue #346 — New pre-pr-phase cell with finalize + write-mrp handlers
- Sub-issue #347 — `assembleMrp()` function + execute finalizer artifacts + holdout migration
- Sub-issue #348 — `pr-phase:create` refactor: render MRP as PR body
- Sub-issue #349 — `pr-direct`: lightweight PR flow for direct tier
- Shipping commits:
  - `8db536d0` — pre-pr-phase cell (#346)
  - `85cb4212` — extract arch-review-phase cell from execute-phase (#345)
  - `91252b41` — register arch-review-phase in lifecycle wiring (#345)
  - `4652e59e` — implement `assembleMrp()` pure aggregator (partial #347)
  - `8e2cabb8` — pr-phase renders MRP as PR body via `--body-file` (#348)
  - `4609e8c3` — roadmap announcement: Stage E PR lifecycle shipped (#344)
  - `3a651cd3` — agent-prompt fix: removed premature `ha mission complete` calls pre-empting pre-pr/pr
  - `eda42bba` — predecessor requires MRP, drops `"No MRP available"` fallback (Stage E acceptance #7)
  - `bcbce835` — pre-pr finalize writes placeholder `quality-gates.json` + `test-report.json`
- Related ADR: [adr-graph-engine-lifecycle.md](./adr-graph-engine-lifecycle.md) — graph execution engine that runs these phases
