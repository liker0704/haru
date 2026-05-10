# Ecosystem Contract Reference

**Companion to** `docs/architecture/adr-ecosystem-decomposition.md`. This file is the implementer's quick lookup. It contains no rationale — only contracts, schemas, paths, and tables. For the why, read the ADR.

**Status**: Proposed (locked when the ADR moves to Accepted)

**Audience**: Anyone implementing a phase issue from `decomposition-issue-tree.md`. Read this once, keep it open.

---

## 1. Five-Role Boundary (one-liner per tool)

| Tool | Role | Don't put here |
|---|---|---|
| `su` (suji) | Product front-door: intent, clarifications, spec, phase | Dependency graphs, prompts, memory |
| `ta` (tane) | Prompt source-of-truth: bodies, versions, inheritance, schemas | Runtime templating (`{{var}}` interpolation) |
| `ku` (kura) | Knowledge ledger: conventions, patterns, failures, decisions, outcomes | System prompts, backlog |
| `bd` (beads) | Execution graph: workstreams, deps, leases, gates, artifacts, check_runs | Raw product inbox |
| `ov` (haru) | Orchestration runtime: mission engine, agents, mail-bus, worktrees, watchdog, merge, evals | Issue tracking, prompt DB, long-term memory |

**Invariants**:
- Each tool owns one data store. Cross-tool reads via CLI `--json` only.
- Mission engine is the only writer that crosses tools. No agent writes to two tools' authoritative state in one operation.
- Artifacts are the inter-phase API.
- Events are append-only and per-tool. No central event bus.

---

## 2. ID Format Reference

| ID | Format | Regex | Owner | Generator | Example |
|---|---|---|---|---|---|
| `seed_id` | `sd-<8hex>` | `^sd-[0-9a-f]{8}$` | suji | suji CLI | `sd-a1b2c3d4` |
| `mission_id` | `mission-<13digit>-<slug>` | `^mission-[0-9]{13}-[a-z0-9-]+$` | haru | `lifecycle-start.ts:58` | `mission-1774105629604-auth-mock` |
| `bead_id` | `bd-<4hex>(.\d+)*` | `^bd-[0-9a-f]{4}(\.\d+)*$` | beads | beads CLI | `bd-a3f8.execute.2` |
| `molecule_id` | `mol-<4hex>` | `^mol-[0-9a-f]{4}$` | beads | alias for top-level bead | `mol-a3f8` |
| `prompt_version` | `<name>@v<n>:<8hex>` | `^[a-z0-9-]+@v\d+:[0-9a-f]{8}$` | tane | tane CLI | `builder@v12:9d4e2a1b` |
| `memory_record_id` | `mx-<6hex>` | `^mx-[0-9a-f]{6}$` | kura | `kura/src/utils/expertise.ts:80` | `mx-3f4a90` |
| `artifact_id` | `<mission_id>/<kind>/<filename>` | path | haru | path = ID | `mission-...-auth-mock/plan/workstreams.json` |
| `pr_id` | `<owner>/<repo>#<number>` | `^[\w.-]+/[\w.-]+#\d+$` | github | github | `myorg/api#412` |
| `check_run_id` | `<pr_id>::<check_name>` | -- | beads (after PR ingest) | haru ingest | `myorg/api#412::ci/build` |
| `eval_run_id` | `eval-<YYYY-MM-DD>-<8hex>` | `^eval-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$` | haru | `src/eval/` | `eval-2026-05-09-3f4a90b1` |
| `agent_id` (worker) | `<capability>-<mission_short>-<3hex>` | -- | haru | `src/agents/identity.ts` | `builder-auth-mock-9d4` |
| `agent_id` (persistent root) | `<capability>` | -- | haru | `src/agents/identity.ts` | `coordinator` |

### 2.1 Cross-tool linkage

```
seed (sd-a1b2c3d4)
  └─ artifacts: { mission_id, molecule_id, pr_ids[] }

mission (mission-...-auth-mock)
  ├─ source: { seed_id }
  ├─ exec: { molecule_id }
  └─ prompts: [{ capability, prompt_version }]

bead (mol-a3f8 / bd-a3f8.*)
  ├─ mission_id (column)
  ├─ artifacts (table): [{ kind, value }]
  └─ check_runs (table)

prompt (<name>@v<n>:<hash>)
  └─ used_by event: { mission_id, agent_id, by }

mulch_record (mx-3f4a90)
  ├─ mission_id, agent_id (fields)
  └─ provenance, trust_level (fields)
```

### 2.2 The 5 queries that close the loop

```bash
su show <seed_id> --json                                        # → mission_id, molecule_id, pr_ids
bd show <molecule_id> --json                                    # → check_runs, artifacts, beads
ta history <prompt-name> --filter mission_id=<id> --json        # → prompt versions used
ku query --mission <mission_id> --json                          # → records consulted/written
gh pr view <pr_id>                                              # → PR state
```

---

## 3. Event Catalog

**Format**: `<system>.<action>` (snake_case). Each tool writes its own `<.tool>/events.jsonl`. No central bus.

**JSONL line** (canonical):
```json
{"ts":"<ISO-8601-ms>","event":"<system>.<action>","schema_version":1,"data":{...}}
```

### 3.1 Producer matrix

| Event | Producer (tool) | Stream path |
|---|---|---|
| `seed.*` | suji | `.suji/events.jsonl` |
| `prompt.*` | tane | `.tane/events.jsonl` |
| `mission.*` | haru | `.overstory/events.db` (existing) + `.overstory/events.jsonl` (new export) |
| `bead.*` | beads | `.beads/events.jsonl` |
| `memory.*` | kura | `.kura/events.jsonl` |
| `pr.*`, `check.*` | haru (PR lifecycle) | haru events |

### 3.2 Event reference

| Event | Producer | Required `data` fields |
|---|---|---|
| `seed.created` | suji | `seed_id`, `title`, `type`, `created_at` |
| `seed.clarification_asked` | suji | `seed_id`, `question_id`, `text` |
| `seed.clarification_answered` | suji | `seed_id`, `question_id`, `answer` |
| `seed.spec_ready` | suji | `seed_id`, `spec_artifact_id` |
| `seed.mission_created` | suji | `seed_id`, `mission_id` |
| `seed.shipped` | suji | `seed_id`, `pr_id`, `merged_at` |
| `prompt.created` | tane | `prompt_version`, `name` |
| `prompt.resolved` | tane | `prompt_version`, `name`, `mission_id?`, `agent_id?`, `by?` |
| `prompt.locked` | tane | `prompt_version`, `name`, `frozen_sections` |
| `mission.created` | haru | `mission_id`, `seed_id?`, `tier` |
| `mission.phase_advanced` | haru | `mission_id`, `from_phase`, `to_phase` |
| `mission.suspended` | haru | `mission_id`, `reason`, `node_id` |
| `mission.completed` | haru | `mission_id`, `outcome` |
| `bead.poured` | beads | `mission_id`, `molecule_id`, `formula`, `step_count` |
| `bead.claimed` | beads | `bead_id`, `mission_id`, `agent_id`, `lease_until` |
| `bead.lease_expired` | beads | `bead_id`, `mission_id`, `previous_holder` |
| `bead.ready` | beads | `bead_id`, `mission_id` |
| `bead.closed` | beads | `bead_id`, `mission_id`, `outcome` |
| `bead.gate_open` | beads | `bead_id`, `gate_type` |
| `bead.gate_closed` | beads | `bead_id`, `gate_type`, `trigger` |
| `memory.recorded` | kura | `memory_record_id`, `domain`, `agent_id`, `mission_id`, `provenance` |
| `memory.outcome_added` | kura | `memory_record_id`, `status`, `mission_id` |
| `memory.record_rejected_sanitization` | kura | `domain`, `agent_id`, `reason`, `pattern_matched` |
| `pr.created` | haru | `mission_id`, `pr_id`, `branch`, `mrp_artifact_id` |
| `pr.checks_ingested` | haru | `pr_id`, `checks` (array) |
| `pr.review_comment` | haru | `pr_id`, `comment_id`, `body`, `author` |
| `check.failed` | haru | `pr_id`, `check_name`, `details` |
| `check.passed` | haru | `pr_id`, `check_name` |
| `engine.beads_divergence` | haru | `mission_id`, `local_status`, `beads_status` |
| `engine.beads_offline` | haru | `mission_id`, `since` |
| `engine.agent_state_drift` | haru | `mission_id`, `agent_id`, `process_state`, `logical_state` |

---

## 4. Artifact Path Reference

All paths relative to repo root. `<MID>` = `mission_id`.

| Artifact | Path | Producer | Consumer | Phase |
|---|---|---|---|---|
| Intent | `.overstory/artifacts/<MID>/intake/intent.md` | operator / intake-phase | clarifier | 1 |
| Product spec | `.overstory/artifacts/<MID>/intake/product-spec.md` | clarifier | architect, planner | 1 |
| Workstreams | `.overstory/artifacts/<MID>/plan/workstreams.json` | planner (analyst) | engine, ED | exists |
| Architecture | `.overstory/artifacts/<MID>/plan/architecture.md` | architect | reviewers, builders | exists |
| Test plan | `.overstory/artifacts/<MID>/plan/test-plan.yaml` | architect (TDD) | tester | exists |
| Technical plan | `.overstory/artifacts/<MID>/plan/technical-plan.md` | architect | builders | 1 |
| Test report | `.overstory/artifacts/<MID>/<WS>/test-report.json` | tester / quality gate | debugger | 4 |
| MRP | `.overstory/artifacts/<MID>/<WS>/mrp.json` | reviewers/merger | PR creator | 6 |
| Diff | `.overstory/artifacts/<MID>/<WS>/diff.patch` | builder | reviewers | 4 |
| Trace | `.overstory/artifacts/<MID>/<WS>/trace.jsonl` | haru | debugger | 4 |

### 4.1 Artifact frontmatter (markdown artifacts only)

Every markdown artifact starts with YAML frontmatter:
```yaml
---
schema_version: 1
mission_id: <MID>
seed_id: <seed_id>            # if applicable
status: draft | reviewed | approved
created_at: <ISO-8601>
created_by: <agent_id> | operator
prompt_versions: [<prompt_version>, ...]
---
```

### 4.2 Schema versioning rule

- Adding optional fields: no bump.
- Removing or repurposing a field: bump `schema_version` and document the migration.
- Engine validates `schema_version` on read; unknown versions fail hard.

---

## 5. Schemas (JSON / YAML)

### 5.1 `intent.md`
```yaml
---
schema_version: 1
seed_id: ...
mission_id: null
created_at: ...
created_by: operator | clarifier
risk_tier: direct | planned | full | unknown
---

# Intent
<verbatim user request>

## Constraints
## Out of scope
```

### 5.2 `product-spec.md`
```yaml
---
schema_version: 1
seed_id: ...
mission_id: ...
spec_id: <artifact_id>
status: draft | reviewed | approved
clarification_round: 0..N
prompt_versions: [...]
created_at: ...
approved_at: null | ...
approved_by: null | ...
---

# Product Spec
## Goal
## Non-goals
## User stories
## Acceptance criteria          # MUST be structured: one bullet per criterion, each verb-led, IDs AC-1..N
## Constraints
## Risk tier
## Suggested workstreams
```

### 5.3 `test-report.json`
```json
{
  "schema_version": 1,
  "mission_id": "...",
  "workstream_id": "...",
  "produced_by": "tester|quality-gate",
  "produced_at": "...",
  "gates": [
    {"name":"unit","status":"pass|fail","duration_ms":N,"details":{}}
  ],
  "acceptance_criteria_results": [
    {"id":"AC-1","status":"pass|fail|unknown","evidence":"..."}
  ]
}
```

### 5.4 `merge-readiness-pack.json`
```json
{
  "schema_version": 1,
  "mission_id": "...",
  "workstream_id": "...",
  "branch": "...",
  "test_report": {"$ref": "..."},
  "reviews": [
    {"capability":"security-reviewer","verdict":"pass|fail|waive","details":"...","prompt_version":"...","reviewer_session_id":"..."}
  ],
  "evidence": {"diff_path":"...","trace_path":"..."},
  "decision": "ready_for_pr | needs_debug | escalate",
  "produced_by": "...",
  "produced_at": "..."
}
```

### 5.5 Suji issue (extended)
```json
{
  "id": "sd-a1b2c3d4",
  "schema_version": 2,
  "title": "...",
  "type": "feature|bug|task",
  "status": "open|in_progress|closed",
  "priority": 0..4,
  "phase": "idea|clarifying|spec_ready|mission_created|in_progress|shipped|closed",
  "spec": {
    "path": ".overstory/artifacts/.../intake/product-spec.md",
    "summary": "...",
    "approved_at": null | "...",
    "approved_by": null | "...",
    "version_hash": "..."
  },
  "clarifications": [
    {
      "id": "q1",
      "question": "...",
      "asked_by": "...",
      "asked_at": "...",
      "answer": null | "...",
      "answered_by": null | "...",
      "answered_at": null | "..."
    }
  ],
  "artifacts": {
    "mission_id": null | "...",
    "molecule_id": null | "...",
    "spec_artifact_id": null | "...",
    "pr_ids": [],
    "eval_run_ids": []
  },
  "...existing suji fields..."
}
```

### 5.6 Tane `ta render --json` output
```json
{
  "schema_version": 1,
  "name": "builder",
  "version": 12,
  "version_hash": "9d4e2a1b",
  "prompt_version": "builder@v12:9d4e2a1b",
  "sections": [{"name":"role","body":"..."}, ...],
  "frontmatter": {...},
  "resolved_from": ["base-agent@v3","trait-cautious@v1"],
  "rendered_at": "..."
}
```

### 5.7 Kura record (extended, `schema_version=2`)
```json
{
  "id": "mx-3f4a90",
  "schema_version": 2,
  "domain": "...",
  "type": "convention|pattern|failure|decision|reference|guide",
  "classification": "foundational|tactical|observational",
  "agent_id": "...",
  "mission_id": "...",
  "provenance": "agent_self_recorded|agent_quality_gate|operator_manual|system_imported",
  "trust_level": "untrusted|trusted_source",
  "outcomes": [...],
  "...type-specific fields..."
}
```

---

## 6. Gate Mapping (Haru ↔ Beads)

| Haru gate (`gate-evaluators.ts`) | Beads representation | Resolution mechanism |
|---|---|---|
| `await-research` | bead with `gate.type=haru.async` | mail (analyst result) |
| `await-plan` | bead with `gate.type=haru.async` | filesystem (workstreams.json populated) |
| `architect-design` | bead with `gate.type=haru.async` | filesystem (architecture.md, optional test-plan.yaml) |
| `await-ws-completion` | derived from bead `status=closed` | mail + git evidence |
| `await-handoff` | bead with `gate.type=haru.async` | mission state (phase changed) |
| Plan-review collect-verdicts | bead with `gate.type=haru.async` + `waits_for=[critic-1..N]` | mail (multiple critics) |
| Architecture-review collect-verdicts | same | mail |
| Holdout / human approval | bead with `gate.type=human` (native) | beads CLI |
| CI check pass | bead with `gate.type=github` (native) | github webhook ingest |
| PR merge | bead with `gate.type=github` (native) | github webhook ingest |

### 6.1 New beads gate type to be added: `haru.async`

```toml
[[steps]]
id = "..."
[steps.gate]
type = "haru.async"
description = "..."   # optional, for human-readable bd show
```

Gate is opened only when an external system calls `bd gate close <bead_id> --trigger=<reason>`. Issue: BEADS-3.

---

## 7. Mission Lifecycle Phase Reference

(From `adr-graph-engine-lifecycle.md` plus this ADR's intake-phase and debug-phase additions.)

```
intake → understand → align → decide → plan → execute ↻ debug → done
                                                     ↑
                                              loop back if test failure
```

| Phase | Tier participation | Subgraph file | Key gates |
|---|---|---|---|
| `intake` (NEW, Phase 1) | planned, full | `src/missions/cells/intake-phase.ts` | `await-clarifications`, `human-spec-review` |
| `understand` | planned, full | `src/missions/cells/understand-phase.ts` | `await-research`, `evaluate` |
| `align` | full | (auto-advance) | (currently unused in production) |
| `decide` | full | (auto-advance) | (currently unused in production) |
| `plan` | planned, full | `src/missions/cells/plan-phase.ts` | `await-plan`, `architect-design`, `review` |
| `execute` | direct, planned, full | `src/missions/cells/execute-phase.ts` (planned/full) or `execute-direct-phase.ts` (direct) | `await-ws-completion`, `arch-review` |
| `debug` (NEW, Phase 4) | direct, planned, full | `src/missions/cells/debug-phase.ts` | `analyze-failures`, `await-fix`, `re-run-gates` |
| `done` | all | `src/missions/cells/done-phase.ts` | `summary`, `holdout`, `cleanup` |

### 7.1 Tier → phases mapping (extended)

| Tier | Active phases |
|---|---|
| `direct` | execute, debug, done |
| `planned` | intake, understand, plan, execute, debug, done |
| `full` | intake, understand, align, decide, plan, execute, debug, done |

Source for current tiers: `src/missions/engine-wiring.ts:78-82`. `intake` and `debug` are new (this ADR).

### 7.2 Seed phase ↔ mission phase

| seed.phase | mission.phase (typical) | Trigger |
|---|---|---|
| `idea` | (no mission) | `su create` |
| `clarifying` | `intake:active` (if mission exists) | `su ask` |
| `spec_ready` | `understand:active` or first plan | `su phase --to spec_ready` |
| `mission_created` | (any) | `ha mission start --from-seed` |
| `in_progress` | execute or debug | first `bead.claimed` event |
| `shipped` | done:completed | `pr.merged` for all `pr_ids` |
| `closed` | n/a | `su close` |

---

## 8. Tool Capability Matrix (today vs target)

Legend: ✅ exists, 🚧 partial, ❌ missing, 🔒 P0 blocker.

### 8.1 Suji

| Capability | Today | Target | Issue |
|---|---|---|---|
| `su create / list / show / update / close` | ✅ | ✅ | — |
| `su dep add/remove` | ✅ | ✅ (kept for non-mission lightweight tasks) | — |
| `su phase` | ❌ | ✅ | SUJI-1 |
| `spec` field | ❌ | ✅ | SUJI-2 |
| `clarifications` field | ❌ | ✅ | SUJI-2 |
| `su ask` / `su answer` | ❌ | ✅ | SUJI-2 |
| `artifacts` field | ❌ | ✅ | SUJI-2 |
| `su mission` (alias for `ha mission start --from-seed`) | ❌ | ✅ (optional convenience) | SUJI-4 |
| Events to `.suji/events.jsonl` | ❌ | ✅ | SUJI-5 |

### 8.2 Tane

| Capability | Today | Target | Issue |
|---|---|---|---|
| `ta create / show / render / emit` | ✅ | ✅ | — |
| Inheritance (`extends`, `mixins`) | ✅ | ✅ | — |
| Schema validation | ✅ | ✅ | — |
| `ta render --json` | ✅ | ✅ (with `prompt_version` in output) | TANE-2 |
| Variable slot declaration in frontmatter | ❌ 🔒 | ✅ | TANE-1 (BLOCKS PHASE 2B) |
| `ta render --list-vars` | ❌ 🔒 | ✅ | TANE-1 |
| `ta render --batch` | ❌ | ✅ | TANE-3 |
| `ta render --mission --by` (attribution) | ❌ | ✅ | TANE-2 |
| Frozen sections / `ta lock` | ❌ | ✅ | TANE-4 |
| Events to `.tane/events.jsonl` | ❌ | ✅ | TANE-2 |
| `ta emit --all` (tane → `agents/*.md` shim, Phase 2a) | (verify with tane team) | ✅ | OV-PHASE2A |

### 8.3 Kura

| Capability | Today | Target | Issue |
|---|---|---|---|
| `ku record / query / prime / search` | ✅ | ✅ | — |
| `ku outcome` | ✅ | ✅ | — |
| Append-time sanitization (deny patterns + length cap) | ❌ 🔒 | ✅ | KURA-1 (P0 SECURITY) |
| Read-time `<expertise untrusted>` wrapper in `ku prime` | ❌ 🔒 | ✅ | KURA-1 |
| `provenance`, `agent_id`, `mission_id`, `tenant`, `trust_level` fields | ❌ | ✅ | KURA-2 |
| Events to `.kura/events.jsonl` | ❌ | ✅ | KURA-3 |
| `ku outcome batch --from quality-gate-report.json` | ❌ | ✅ | KURA-4 |
| `ku supersede` / auto-deprecation by low success rate | 🚧 (`ku prune` exists) | ✅ | KURA-5 |

### 8.4 Beads

| Capability | Today | Target | Issue |
|---|---|---|---|
| `bd create / show / update / close` | ✅ | ✅ | — |
| `bd ready` | ✅ | ✅ | — |
| `bd dep add/remove/list` | ✅ | ✅ | — |
| `bd cook / pour / mol` (formulas/molecules) | ✅ | ✅ | — |
| Native gates (human, timer, github) | ✅ | ✅ | — |
| `mission_id` column on issue | ❌ | ✅ | BEADS-1 (P0) |
| `lease_holder`, `lease_until` columns | ❌ | ✅ | BEADS-1 |
| `review_state` column | ❌ | ✅ | BEADS-1 |
| `blocker_reason` column | ❌ | ✅ | BEADS-1 |
| `artifacts` table | ❌ | ✅ | BEADS-1 |
| `check_runs` table | ❌ | ✅ | BEADS-1 |
| `event_outbox` table (transactional) | ❌ | ✅ | BEADS-1 |
| `bd mission seed/graph/progress/close` | ❌ | ✅ | BEADS-2 |
| `haru.async` gate type | ❌ | ✅ | BEADS-3 |
| Events to `.beads/events.jsonl` | 🚧 | ✅ (extended with new events) | BEADS-4 |
| `agent-as-bead` validation for persistent agents | ❌ | ✅ | BEADS-5 |

### 8.5 Haru

See `decomposition-issue-tree.md` Section 2 for the full Haru issue list. Key blockers absorbed into Phase 0:

| Capability | Today | Target | Issue |
|---|---|---|---|
| Phase 0 contracts doc + locked schemas | ❌ | ✅ | OV-PHASE0 |
| `intake-phase` cell | ❌ | ✅ | OV-PHASE1 |
| `product-clarifier` agent definition | ❌ | ✅ | OV-PHASE1 |
| `ha mission start --from-seed <seed_id>` | ❌ | ✅ | OV-PHASE1 |
| Tane as source-of-truth via `ta emit` shim (no spawn.ts change) | ❌ | ✅ | OV-PHASE2A |
| Tane-backed prompt loading in `overlay.ts` (spawn.ts cutover) | ❌ | ✅ | OV-PHASE2B |
| Beads-backed mission graph (shadow→primary) | ❌ | ✅ | OV-PHASE3 (Wave 4) |
| `debug-phase` cell + `debugger` agent | ❌ | ✅ | OV-PHASE4 |
| Kura sanitization integration (write outcomes) | ❌ | ✅ | OV-PHASE5 |
| PR lifecycle (`src/github/pr-lifecycle.ts`) | ❌ | ✅ | OV-PHASE6 |
| Budget enforcer + permission policies | 🚧 (cost tracking exists) | ✅ | OV-PHASE7 |
| Sandbox adapters (docker → gvisor) | ❌ | ✅ | OV-PHASE7 |
| Background autonomous agents | ❌ | ✅ | OV-PHASE8 |

---

## 9. Migration Feature Flags

All under `.overstory/config.yaml` `mission:` block.

| Flag | Values | Default | Phase |
|---|---|---|---|
| `mission.beadsBacked` | `false \| shadow \| primary` | `false` | 3 (Wave 4) |
| `mission.canopyPrompts` | `false \| true` (no shadow — render or don't) | `false` | 2b |
| `mission.intakePhaseEnabled` | `false \| true` | `false` | 1 |
| `mission.debugPhaseEnabled` | `false \| true` | `false` | 4 |
| `mission.mulchSanitization` | `off \| warn \| enforce` | `off` | 5 |
| `mission.prLifecycle` | `false \| true` | `false` | 6 |
| `mission.budgetEnforcement` | `off \| soft \| hard` | `off` | 7 |
| `mission.sandbox` | `local \| docker \| gvisor` | `local` | 7 |

### 9.1 Rollback

Every flag flip is a one-line config change. `git revert` works. The mission engine reads the flag at the start of each tick, so a flip takes effect within one tick (~5 seconds).

---

## 10. Anti-Pattern Quick Reference

(From ADR Section 5; also enforced where possible by CI. Anti-pattern #1 is the "decomposition without user-visible delivery" rule — promoted to first position because it is the most-cited reviewer concern about this ADR's own failure mode.)

1. ❌ **Decomposition without user-visible delivery** — refactoring just because the architecture is "cleaner", without enabling a user-visible capability. Every architectural refactor must cite the capability it unblocks; if none, defer indefinitely. (Reference: ADR Section 2.4.3; reviewer "не размоноличивать ради размоноличивания".)
2. ❌ Rewrite mission engine on LangGraph
3. ❌ Make vector DB mandatory
4. ❌ Skip clarification before code execution (planned/full)
5. ❌ Auto-merge planned/full missions
6. ❌ Build web UI before pipeline reliability
7. ❌ Unbounded parallel agents
8. ❌ Add new persistent state to Haru without ADR
9. ❌ Couple tool release cycles
10. ❌ Skip Phase 5 kura sanitization before public exposure
11. ❌ Trust agent self-recorded kura entries
12. ❌ Write to two tools' authoritative state in one operation
13. ❌ Fork the engine into a separate process

---

## 11. Implementer Checklist (per phase)

For any phase issue, verify:

- [ ] Feature flag added with default `false` (Section 9)
- [ ] Rollback procedure documented in PR description
- [ ] Telemetry event(s) added (Section 3)
- [ ] Schema versioned if mutating an artifact (Section 4)
- [ ] Cross-tool calls go through CLI `--json` (no direct DB reads)
- [ ] No new persistent state in Haru unless explicitly approved by an ADR
- [ ] Anti-patterns 1–13 not violated
- [ ] Issue carries the correct `wave:N` label (see issue tree Section 0)
- [ ] If a refactor, cites the user-visible capability it unblocks (anti-pattern #1)
- [ ] Acceptance criterion from `decomposition-issue-tree.md` met

---

## 12. References

- ADR: `docs/architecture/adr-ecosystem-decomposition.md`
- Issue tree: `docs/architecture/decomposition-issue-tree.md`
- Engine ADR: `docs/architecture/adr-graph-engine-lifecycle.md`
- Haru architecture overview: `docs/architecture/overview.md`
- Sister repos: `suji/README.md`, `tane/README.md`, `kura/README.md`, `beads/README.md`
- Beads workflow docs: `beads/website/docs/workflows/{index,molecules,formulas,gates,wisps}.md`
