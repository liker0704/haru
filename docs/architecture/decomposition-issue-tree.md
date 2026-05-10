# Ecosystem Decomposition: Issue Tree

**Companion to** `docs/architecture/adr-ecosystem-decomposition.md`. This file is the file-and-fork the project lead. Each item below maps to one issue in one repo. File order = recommended file order.

**Status**: Proposed (filed only after the parent ADR is Accepted).

**How to use**: Pick a section, copy the title and body skeleton verbatim, attach the labels, set priority, link the dependencies, file. Do not invent issues outside this list — if you find a gap, propose an addition by editing this file in a PR.

**Notation**: `[P0]` = blocker, `[P1]` = high, `[P2]` = medium, `[P3]` = low. `→ X` means "blocks X". `← X` means "blocked by X". `wave:N` indicates which strangler wave the issue belongs to (see "Wave-based execution order" below).

---

## 0. Wave-based execution order (READ FIRST)

The phase numbers (Phase 0..8) capture **architectural dependencies**. The waves below capture **execution order** — what we actually work on when, ordered by strangler-pattern priority. This is the section to plan against. **Issues are filed in wave order, not phase number order.**

Reference: ADR Section 2.4 (Strangler Pattern) and Section 4.4 (Strangler execution waves). Reviewer framing: "Не размоноличивать ради размоноличивания" — every architectural refactor must cite a user-visible capability it unblocks.

### Wave 1 — Foundations (no user-visible change yet)

Land all of these before any user-visible work. Goal: lock contracts and security primitives.

| Issue | Repo | Priority | Notes |
|---|---|---|---|
| OV-PHASE0 | haru | P0 | Contracts |
| KURA-1 | kura | P0 | Sanitization (security primitive) |
| TANE-1 | tane | P0 | Variable slot declaration (blocks Phase 2b) |

### Wave 2 — Vertical slice (demo-ready)

Goal: the 13-step vertical slice from ecosystem doc lines 367-381 works end-to-end. **The demo exists.**

| Issue | Repo | Priority | Notes |
|---|---|---|---|
| SUJI-1 | suji | P0 | Phase lifecycle |
| SUJI-2 | suji | P0 | spec/clarifications/artifacts fields |
| OV-PHASE1 | haru | P0 | Suji front-door + intake-phase |
| OV-PHASE2A | haru | P0 | **Tane emit shim only** — `ta emit` writes resolved tane output to `agents/*.md`; spawn.ts unchanged (split from old OV-PHASE2; see ADR Section 3.8) |
| OV-PHASE4 | haru | P0 | Debugger (Stage C) |
| OV-VERTICAL-SLICE | haru | P0 | Demo gate |

Phase 2b (the spawn.ts cutover) is in Wave 3, not Wave 2. TANE-1 (Wave 1) is required for Phase 2b but NOT for Phase 2a.

### Wave 3 — Production hardening

Goal: system becomes safe for unattended runs and public exposure.

| Issue | Repo | Priority | Notes |
|---|---|---|---|
| KURA-2 | kura | P0 | Schema fields + provenance |
| OV-PHASE2B | haru | P0 | **Spawn.ts cutover** to `ta render --json` (split from old OV-PHASE2; requires TANE-1 stable) |
| OV-PHASE5 | haru | P0 | Kura hardening (P0 SECURITY for public launch) |
| OV-PHASE6 | haru | P1 | PR lifecycle, Stage D/E reviewers |
| OV-PHASE7 | haru | P1 | Budget, permissions, sandbox |
| TANE-2 | tane | P0 | render --json + attribution |
| TANE-3 | tane | P1 | render --batch |
| KURA-3 | kura | P1 | Events stream |
| KURA-4 | kura | P2 | Outcome batch |
| KURA-5 | kura | P2 | Supersede / auto-deprecation |
| SUJI-3 | suji | P2 | Clarification timeout |
| SUJI-4 | suji | P2 | su mission alias |
| SUJI-5 | suji | P1 | Events stream |
| OV-LEARN | haru | P1 | Outcome attribution |

### Wave 4 — Architectural completion (deferred until vertical slice stable)

**Trigger to start Wave 4** (all three must hold; reference ADR Section 3.4.5):
1. ≥100 successful missions completed via the vertical-slice flow, AND
2. ≥30 days elapsed since the vertical slice was declared GA (Wave 2 GA criterion in ADR Section 4.4), AND
3. ≤5% mission failure rate in the trailing 30 days.

If any criterion fails, defer Wave 4 by another 30 days; reassess. **Do not start BEADS-* work or OV-PHASE3 until this trigger fires.**

| Issue | Repo | Priority | Notes |
|---|---|---|---|
| BEADS-1 | beads | P0 | Schema additions |
| BEADS-2 | beads | P0 | bd mission commands |
| BEADS-3 | beads | P0 | haru.async gate |
| BEADS-4 | beads | P1 | Events stream |
| BEADS-5 | beads | P1 | agent-as-bead validation |
| BEADS-6 | beads | P2 | Transactional event outbox |
| OV-PHASE3 | haru | P0 | Beads as execution graph (hybrid migration) |
| OV-PHASE8 | haru | P2 | Background autonomous maintenance |
| OV-DOCS | haru | P2 | Cleanup after Phase 2b ships |

### Why this ordering matters

The strangler pattern (ADR Section 2.4) demands that the vertical slice ships before the architectural completion. BEADS-* and OV-PHASE3 are **explicitly deferred** because they:
- Deliver no new user-visible capability (they make the system more correct, more queryable, more durable, but those are platform properties).
- Are the heaviest migration in the ADR (replacing a working subsystem).
- Risk drowning the team in schema/migration/graph complexity before any user value ships (`haru-ecosystem-autonomous-platform.md:351-359`).

If you find yourself wanting to start BEADS-1 work before Wave 2 ships, re-read ADR Section 2.4 and anti-pattern #1.

---

## 1. Umbrella

### `OV-DECOMP-EPIC` — [P0] Epic: Haru ecosystem decomposition (5-tool split)

**Repo**: haru

**Body**:
> Implement the ecosystem decomposition described in `docs/architecture/adr-ecosystem-decomposition.md` and tracked in `docs/architecture/decomposition-issue-tree.md`.
>
> Split Haru's monolith into five clearly-owned roles:
> - Suji owns intent
> - Tane owns prompts
> - Kura owns knowledge
> - Beads owns execution graph
> - Haru owns orchestration
>
> Acceptance criterion (from ecosystem doc, line 188): "По одному `mission_id` можно проследить seed, prompts, Beads graph, agents, memory records, PRs, checks и evals." Verifiable via the 5 queries in `ecosystem-contract-reference.md` Section 2.2.
>
> Phases 0–8 plus a vertical-slice demo gate after Phase 6 thin. Execution order is by strangler waves (see Section 0 of issue tree), NOT by phase number.

**Labels**: `epic`, `architecture`, `decomposition`, `wave:all`

**Children**: OV-PHASE0..OV-PHASE8 (with PHASE2 split into 2A and 2B), OV-LEARN, OV-VERTICAL-SLICE, plus all SUJI-*, TANE-*, KURA-*, BEADS-* issues

**Blocks**: nothing — this is the umbrella

---

## 2. Haru Issues

### `OV-PHASE0` — [P0] Phase 0: Lock ecosystem contracts (IDs, events, artifacts)

**Repo**: haru

**Body**:
> Implement the contract reference at `docs/architecture/ecosystem-contract-reference.md` as code:
> - `src/types/ids.ts` — TypeScript types for `SeedId`, `MissionId`, `BeadId`, `MoleculeId`, `PromptVersion`, `MemoryRecordId`, `ArtifactId`, `PrId`, `CheckRunId`, `EvalRunId`, `AgentId` with branded types and validators.
> - `src/types/events.ts` — Event union type covering Section 3 of the contract reference.
> - `src/types/artifacts.ts` — Artifact schema interfaces (intent, product-spec, technical-plan, test-report, MRP) with `schema_version` field.
> - `src/missions/artifact-paths.ts` — path construction helpers per Section 4.
> - Tests for every validator (round-trip parse/serialize, edge cases).
>
> No behavior change. Pure types and helpers.
>
> Acceptance: 100% of new types match `ecosystem-contract-reference.md` Section 2 and 5; CI fails on contract drift via golden-file tests.

**Labels**: `phase-0`, `contracts`, `breaking-change-prep`, `wave:1`

**Priority**: P0

**Blocks**: every other phase issue

**Blocked by**: none

---

### `OV-PHASE1` — [P0] Phase 1: Suji front-door + intake-phase

**Repo**: haru

**Body**:
> Implement Stage A from `haru-autonomous-dev-roadmap.md` and Phase 1 from `haru-ecosystem-autonomous-platform.md:190-202`.
>
> Deliverables:
> 1. `src/missions/cells/intake-phase.ts` — subgraph: `ingest-intent → clarifier-dispatch → await-clarifications → spec-draft → human-spec-review → ready`.
> 2. `agents/product-clarifier.md` — new role (read `haru-autonomous-dev-roadmap.md:80-91`).
> 3. `src/agents/capabilities.ts` — register `product-clarifier`.
> 4. `src/commands/mission.ts` — add `ha mission start --from-seed <seed_id>` and `--interactive`.
> 5. Artifact contract: produce `<artifactRoot>/intake/intent.md` and `<artifactRoot>/intake/product-spec.md` per `ecosystem-contract-reference.md` Section 5.
> 6. `src/missions/risk-tier.ts` — deterministic classifier (`direct|planned|full`) based on spec content (heuristics + override).
> 7. Wire to suji: read seed via `su show --json`, write back `seed.artifacts.mission_id` on creation.
> 8. Feature flag `mission.intakePhaseEnabled` default false; flip to true after vertical-slice demo passes.
>
> Acceptance: `su create "feature X"` → `ha mission start --from-seed <id>` → clarifier asks ≤5 questions → product-spec.md approved → understand phase begins. Seed `phase` advances `idea → clarifying → spec_ready → mission_created`.

**Labels**: `phase-1`, `intake-phase`, `clarifier`, `wave:2`

**Priority**: P0

**Blocks**: OV-VERTICAL-SLICE

**Blocked by**: OV-PHASE0, SUJI-1, SUJI-2

---

### `OV-PHASE2A` — [P0] Phase 2a: Tane emit shim (tane as source-of-truth, no spawn.ts change)

**Repo**: haru

**Body**:
> **Strangler step.** Per ADR Section 3.8 (Phase 2a) and Section 2.4 (strangler pattern). This issue lands BEFORE OV-PHASE2B (the spawn.ts cutover).
>
> Goal: tane becomes the source-of-truth for prompts, but Haru's spawn path is **unchanged**. Zero breaking changes to the orchestration loop.
>
> Deliverables:
> 1. Migrate the 32 `agents/*.md` files into tane via `ta import`. Use a shared base prompt for `shared-mandate.md`-style content. Tane stores the prompts with `{{var}}` literals intact (Tane does NOT interpolate).
> 2. Add `ta emit --all` command (tane-side; coordinate with tane maintainers): writes resolved tane output for every prompt back to `agents/<name>.md` — i.e., the existing file paths Haru already reads.
> 3. Pre-commit hook (`.git/hooks/pre-commit`) and CI step that runs `ta emit --check`: fails if any `agents/*.md` differs from `ta emit --all` output.
> 4. Operator workflow change: prompts are edited via `ta create` / `ta edit`, then `ta emit --all` regenerates the markdown files. Direct hand-edits to `agents/*.md` are caught by the drift-detection CI.
> 5. **`src/agents/overlay.ts` is UNCHANGED.** `loadBaseAgentDefinition()` keeps reading `agents/*.md` directly via `Bun.file()`.
>
> Acceptance:
> - All 32 prompts imported into tane and round-trip via `ta emit`.
> - Drift-detection CI green for 14 consecutive days.
> - Operators have switched to tane-edit workflow (verified by zero direct edits to `agents/*.md` in those 14 days).
>
> Open question (carry to tane team): does `ta emit` exist today, or does this require a new tane command? If new, file tane issue alongside this one.

**Labels**: `phase-2a`, `tane`, `prompts`, `strangler-shim`, `wave:2`

**Priority**: P0

**Blocks**: OV-VERTICAL-SLICE (only the 3 demo prompts), OV-PHASE2B

**Blocked by**: OV-PHASE0

---

### `OV-PHASE2B` — [P0] Phase 2b: Tane spawn.ts cutover (read prompts via `ta render --json`)

**Repo**: haru

**Body**:
> **Strangler cutover.** Per ADR Section 3.8 (Phase 2b) and Section 2.4. Lands AFTER OV-PHASE2A is stable for ≥14 days and TANE-1 (variable slot declaration) is shipped.
>
> Goal: switch `src/agents/overlay.ts` to render via `ta render --json` instead of reading `agents/*.md`.
>
> Per ADR Decision 8: Tane stores bodies with literal `{{var}}` slots. Haru's `buildTemplateReplacements()` (`src/agents/overlay.ts:163-170, 369-399`) stays in Haru and runs on the rendered output.
>
> Deliverables:
> 1. `src/agents/tane-loader.ts` — replaces `loadBaseAgentDefinition()`. Calls `ta render <name> --mission <id> --by <agent_id> --json`, expects `CnRenderOutput` schema.
> 2. Persist `prompt_version` in session metadata (`src/sessions/store.ts` migration: add `prompt_version TEXT` column).
> 3. Validate slot completeness pre-spawn: `ta render --list-vars` → cross-check against `buildTemplateReplacements()` keys; fail spawn with clear error if mismatch.
> 4. Feature flag `mission.canopyPrompts`. When false, falls back to reading `agents/*.md` from disk (which is now produced by `ta emit` from Phase 2a — same content, different load path). Run in shadow mode (compare outputs) for 14 days before flipping default.
> 5. Once flag is true and stable for 30 days with zero rollbacks, remove the `agents/` directory and disable `ta emit --check` in CI (issue OV-DOCS).
>
> Acceptance:
> - Every `ha sling` records the resolved `prompt_version` in session metadata.
> - `ta history <name> --filter mission_id=<id>` returns the prompts used by that mission.
> - 14-day shadow comparison: zero diff between `agents/*.md` content (from `ta emit`) and `ta render --json` output.
> - 30 days post-flip with zero rollbacks before declaring complete.

**Labels**: `phase-2b`, `tane`, `prompts`, `cutover`, `wave:3`

**Priority**: P0

**Blocks**: OV-DOCS (deletion of `agents/` directory)

**Blocked by**: OV-PHASE0, OV-PHASE2A (must be stable 14 days), **TANE-1 (P0 BLOCKER)**, TANE-2

---

### `OV-PHASE3` — [P0] Phase 3: Beads as execution graph (hybrid migration) — **WAVE 4, GATED**

**Repo**: haru

**Body**:
> **Wave 4 (deferred until vertical slice GA).** This is the heaviest migration in the ADR. **Do NOT start work on this issue until the Wave 4 trigger fires** (see ADR Section 3.4.5):
>
> 1. ≥100 successful missions completed via the vertical-slice flow, AND
> 2. ≥30 days elapsed since vertical slice declared GA, AND
> 3. ≤5% mission failure rate in the trailing 30 days.
>
> Reference: `haru-ecosystem-autonomous-platform.md:351-359` ("Beads мощнее Suji, но если начать с него, ты можешь утонуть в schema/migration/graph complexity до того, как появится пользовательский end-to-end loop").
>
> Replace `workstreams.json` + `workstream_status` table as the execution-graph source of truth with a beads molecule. Use the `false → shadow → primary` migration model (ADR Decision 4.4 / 3.4.5).
>
> Deliverables:
> 1. `src/beads/client.ts` — programmatic wrapper around `bd cook`, `bd pour`, `bd ready`, `bd close`, `bd dep add`, `bd gate close`. CLI subprocess only; no direct DB.
> 2. `src/beads/snapshot.ts` — read cache (`beads_mol_snapshot` table in `sessions.db`). Refreshed every M ticks (default 2). Engine reads snapshot, never CLI on hot path.
> 3. Mission formula templates: `formulas/haru-mission-direct.toml`, `formulas/haru-mission-planned.toml`, `formulas/haru-mission-full.toml` (registered with beads via `bd cook` at init time).
> 4. `src/missions/workstreams.ts` — extend `updateWorkstreamStatus()` to also call `bd close` (when `mission.beadsBacked != false`).
> 5. Gate evaluators: extend `gate-evaluators.ts` to consult beads snapshot for completion (in `primary` mode) and emit `engine.beads_divergence` events when local status disagrees with beads.
> 6. Plan-phase analyst: after writing `workstreams.json`, also call `bd pour haru-mission-<tier>` and add workstream beads via `bd dep add`. Emit `bead.poured`.
> 7. Feature flag `mission.beadsBacked`: `false | shadow | primary`. Default `false`. CI runs both `false` and `shadow` modes for the test suite.
> 8. Beads-down resilience: if `bd` calls fail for > 3 ticks, emit `engine.beads_offline` and fall back to local snapshot (no hard fail).
>
> **Trigger to advance `shadow` → `primary`** (all four must hold):
> - 7 consecutive days of zero `engine.beads_divergence` events, AND
> - All beads operations under p99 50ms latency, AND
> - No critical bugs filed against the beads integration in the trailing 14 days, AND
> - `bd mission graph <mission_id>` returns the same workstream tree as `workstreams.json` for 100% of completed missions in the trailing 7-day window.
>
> **Trigger to delete `workstreams.json`** (all three must hold):
> - 30 days in `primary` mode with zero rollbacks, AND
> - Zero `engine.beads_divergence` incidents in those 30 days, AND
> - Operator runs `ha mission migrate --strip-workstreams-json` with explicit confirmation.
>
> Acceptance:
> - `shadow` mode: zero divergence events for 7 consecutive days on dogfood missions.
> - `primary` mode: triggers above hold.
> - `mission.beadsBacked = primary` is the default for new projects after 30 days primary stable.
>
> Open questions to resolve during implementation:
> - `MissionRevision` semantics (when to bump). See ADR Section 7 question 3.
> - Atomicity of `mission.completed` + `bd mission close`. See ADR Section 7 question 4.

**Labels**: `phase-3`, `beads`, `execution-graph`, `wave:4`, `gated:wait-for-vertical-slice-stability`

**Priority**: P0

**Blocks**: OV-PHASE6 (PR lifecycle uses beads `check_runs` table) — note: Wave 3's OV-PHASE6 ships first; the beads-`check_runs` integration is added in Wave 4 as a follow-up

**Blocked by**: OV-PHASE0, **BEADS-1 (P0)**, **BEADS-2 (P0)**, **BEADS-3 (P0)**, **Wave 4 trigger (Section 0 / ADR 3.4.5)**

---

### `OV-PHASE4` — [P0] Phase 4: Debug loop (Stage C)

**Repo**: haru

**Body**:
> Implement Stage C from `haru-autonomous-dev-roadmap.md:108-130`. This is the highest-ROI new agent per the roadmap (line 7).
>
> Deliverables:
> 1. `agents/debugger.md` (or tane prompt `debugger@v1` if Phase 2a has shipped). Read constraints from `haru-autonomous-dev-roadmap.md:122-129`: `max-iterations=3`, no test edits except `@autogenerated`, worktree-local only.
> 2. `src/agents/capabilities.ts` — register `debugger`.
> 3. `src/missions/cells/debug-phase.ts` — subgraph: `await-test-results → analyze-failures → dispatch-debugger → await-fix → re-run-gates → fixed | stuck`.
> 4. `src/missions/cells/execute-phase.ts` — insert `verify-merge-quality` before `ws_merged` (per `haru-autonomous-dev-roadmap.md:117`); on `failed`, transition to debug-phase.
> 5. `src/missions/handlers.ts` — deterministic handlers `analyze-failures`, `re-run-gates`.
> 6. `<artifactRoot>/<workstream_id>/test-report.json` schema enforced (per contract reference Section 5.3).
> 7. Consultation Request Pack on max-iterations escalation: a structured human-readable artifact with root-cause hypothesis, attempted fixes, gate results.
> 8. `evals/debug-loop.scenario.yaml` — regression eval where a planted broken test must be auto-fixed.
> 9. Feature flag `mission.debugPhaseEnabled`.
>
> Acceptance: a deliberately broken test in a fixture project triggers debug-phase, debugger produces a fix commit, gates re-run green, mission proceeds to merge — with 0 operator intervention.

**Labels**: `phase-4`, `debug-phase`, `debugger`, `stage-c`, `wave:2`

**Priority**: P0

**Blocks**: OV-VERTICAL-SLICE, OV-PHASE6

**Blocked by**: OV-PHASE0 (artifact contracts). Does NOT depend on OV-PHASE2A/2B or OV-PHASE3 — Stage C can ship in parallel.

---

### `OV-PHASE5` — [P0] Phase 5: Kura hardening + outcome plumbing

**Repo**: haru

**Body**:
> Per ADR Decision 7 and `haru-ecosystem-autonomous-platform.md:153-173`. **THIS IS A P0 SECURITY ISSUE.** Persistent prompt injection across sessions and agents is the #1 named risk in the source doc.
>
> The kura-side work is in **KURA-1**. This issue covers the Haru side:
>
> Deliverables:
> 1. After every merged PR, walk the mission's session logs to identify kura records consulted (via `ku prime` calls captured in tool events) and call `ku outcome --status success --record-id <id> --mission-id <id>`.
> 2. After every escalated debug-phase failure, call `ku record <domain> --type failure --description "..." --resolution "..." --provenance agent_quality_gate --mission-id <id>`.
> 3. After every nontrivial merger or architect decision, call `ku record <domain> --type decision --provenance agent_self_recorded --mission-id <id>`.
> 4. Pass `--mission-id`, `--agent-id`, `--provenance`, `--by` flags to all `ku record` calls (requires KURA-2).
> 5. Read-time integration: `src/agents/overlay.ts` documents the `<expertise untrusted>` wrapper in agent prompts. The wrapper is added by `ku prime` (KURA-1), but Haru needs to ensure agents have the meta-instruction to treat it as data, not commands. This goes in `agents/shared-mandate.md` (or its tane equivalent).
> 6. Feature flag `mission.mulchSanitization` = `off | warn | enforce`. Production default = `enforce`.
>
> Acceptance:
> - Adversarial test: a seed with embedded prompt-injection attempt in description must NOT result in a kura record that successfully injects future agents.
> - Outcome attribution: 80%+ of kura records consulted by an agent during a successful mission have an outcome recorded after merge.
>
> **GATE: this issue MUST be resolved before any public exposure of the system.**

**Labels**: `phase-5`, `kura`, `security`, `p0-security`, `wave:3`

**Priority**: P0

**Blocks**: public demo, public deploy

**Blocked by**: OV-PHASE0, **KURA-1 (P0)**, KURA-2

---

### `OV-PHASE6` — [P1] Phase 6: PR lifecycle and CI ingest

**Repo**: haru

**Body**:
> Implement Stages D and E from `haru-autonomous-dev-roadmap.md:131-158` and Phase 6 from the ecosystem doc.
>
> Deliverables:
> 1. `agents/security-reviewer.md`, `agents/perf-reviewer.md` — Stage D reviewers with structured verdicts (`haru-autonomous-dev-roadmap.md:135-141`).
> 2. `<artifactRoot>/<workstream_id>/mrp.json` produced after all reviewers pass (per contract reference Section 5.4).
> 3. `src/github/pr-lifecycle.ts` — `gh pr create` with MRP attached as PR body, ingest checks, poll/webhook for review comments.
> 4. `src/mail/types.ts` — add `pr_review_comment` mail type; debug-phase reacts to review comments.
> 5. Beads integration (Wave 4): write check_runs to beads via `bd` command (requires `check_runs` table from BEADS-1). PR ID stored in `bead.artifacts`. **Until Wave 4 lands, this integration is a no-op stub** — PR data is stored only in Haru's session metadata.
> 6. Suji back-fill: `pr.created` event triggers suji update of `seed.artifacts.pr_ids`.
> 7. Auto-merge policy:
>    - `direct` tier with `--auto-merge`: yes after MRP green.
>    - `planned`/`full`: human approval required (per anti-pattern 5).
> 8. `src/notifications/external.ts` — Slack/Discord/email notification "PR ready for review".
> 9. Feature flag `mission.prLifecycle`.
>
> Acceptance: end-to-end mission produces a PR with MRP, ingests CI checks, dispatches debug-phase on review comments, hands off to operator on planned/full tier or auto-merges on direct tier with explicit flag.

**Labels**: `phase-6`, `pr-lifecycle`, `github`, `stage-de`, `wave:3`

**Priority**: P1

**Blocks**: OV-PHASE7 (budget enforcement applies across PR loop), OV-PHASE8

**Blocked by**: OV-PHASE4 (debug loop must work before PRs ship), OV-PHASE5 (sanitization). Does NOT block on OV-PHASE3 — beads check_runs integration is added later in Wave 4.

---

### `OV-PHASE7` — [P1] Phase 7: Budget, permissions, sandbox

**Repo**: haru

**Body**:
> Per Stage F + G from roadmap and Phase 7 from ecosystem doc.
>
> Deliverables:
> 1. `src/budget/policy.ts` — per-mission, per-runtime, per-day caps. Schema in `.overstory/policies/budget.yaml`.
> 2. `src/budget/enforcer.ts` — hard stop / pause / downgrade-model / escalate. Wired into mission tick.
> 3. `src/permissions/policy.ts` — capability-level allowlists for shell commands and network hosts. Default deny.
> 4. PreToolUse-style enforcement in runtime adapters (`src/runtimes/`).
> 5. `src/sandbox/` — `local`, `docker` adapters in v1. Spec for `gvisor`/`firecracker` (deferred but designed-for).
> 6. `ha sling --sandbox=docker` flag.
> 7. Eval-as-CI: GitHub Action runs `evals/`, stores baseline; regression blocks autonomous merge.
> 8. Webserver auth (`src/webserver/auth.ts`).
> 9. Feature flags `mission.budgetEnforcement`, `mission.sandbox`.
>
> Acceptance: runaway-loop fixture (mission that spawns infinite agents) is killed by budget enforcement within 5 minutes; unauthorized network call fixture is blocked at the sandbox layer.

**Labels**: `phase-7`, `budget`, `sandbox`, `permissions`, `stage-fg`, `wave:3`

**Priority**: P1

**Blocks**: OV-PHASE8

**Blocked by**: OV-PHASE6

---

### `OV-PHASE8` — [P2] Phase 8: Background autonomous maintenance

**Repo**: haru

**Body**:
> Per Phase 8 from ecosystem doc and Stage H from roadmap. **Wave 4** — runs after Phase 3 lands.
>
> Deliverables:
> 1. `agents/cve-watcher.md` — periodic OSV/Trivy scan → seed (or directly mission for direct-tier patches).
> 2. `agents/dependency-updater.md` — produces PR with eval evidence.
> 3. `agents/doc-sync.md` — public API diff → docs PR.
> 4. `agents/flaky-test-monitor.md` — tracks test reliability over time.
> 5. `agents/incident-responder.md` — alert webhook → reproduction → fix candidate.
> 6. `agents/deployer.md` — staging/canary/prod with hard human-gate.
> 7. Cron-style scheduling layer (or use existing watchdog tick).
>
> Acceptance: each agent independently produces an end-to-end output without operator initiation. Human approval is still required for production deploys (anti-pattern 5).

**Labels**: `phase-8`, `autonomous-maintenance`, `stage-h`, `wave:4`

**Priority**: P2

**Blocks**: nothing (terminal phase)

**Blocked by**: OV-PHASE7, OV-PHASE3 (Wave 4)

---

### `OV-VERTICAL-SLICE` — [P0] Vertical slice demo: end-to-end seed → PR

**Repo**: haru

**Body**:
> Per ADR Decision 12. Smallest working version of the 13-step demo from `haru-ecosystem-autonomous-platform.md:367-379`.
>
> Scope (mocked vs real per ADR table):
> - Real: Phase 0, Phase 1, Phase 4, Phase 2a (3 prompts only via `ta emit` shim), thin Phase 6 (basic PR creation, no review-comment loop).
> - Mocked: Phase 5 sanitization (test repo only — **NOT public**), Phase 6 reviewers (stub passing).
> - **NOT included**: Phase 2b (spawn cutover), Phase 3 (beads). Those are Wave 3/4 and ship later.
>
> Deliverables:
> 1. Test repo: `evals/demo-vertical-slice/` with one fixture broken test.
> 2. `evals/scenarios/vertical-slice.scenario.yaml` — orchestrates the 13 steps as an automated eval.
> 3. Recording / `ha replay` published.
>
> Acceptance:
> - 5 successful end-to-end runs in a row.
> - Wall-clock under 15 minutes per run.
> - Operator interventions: only the 3 clarifying-question answers and the final PR approval.
>
> **DO NOT GO PUBLIC WITH THIS UNTIL OV-PHASE5 IS DONE.**

**Labels**: `vertical-slice`, `demo`, `eval`, `wave:2`

**Priority**: P0

**Blocks**: public launch, Wave 4 trigger countdown

**Blocked by**: OV-PHASE1, OV-PHASE4, OV-PHASE2A (3 prompts via emit shim)

---

### `OV-LEARN` — [P1] Cross-cutting: outcome attribution and learn loop closure

**Repo**: haru

**Body**:
> Per ADR Section 3.11 step 4 and ADR Open Question 5. The learn loop's weak link is outcome attribution: after a kura record influences an agent and the mission succeeds (or fails), `ku outcome` should be called.
>
> Today, `ku prime` is called by agents but the link from "I used record X" to "record X helped" is not tracked.
>
> Deliverables:
> 1. Tool-event capture: when an agent invokes `ku prime` or `ku query`, parse the JSON output and record the consulted record IDs in the agent's session log (`src/events/store.ts`).
> 2. Post-mission cleanup step (in `done-phase` cell): walk session logs of all mission agents, collect consulted record IDs, call `ku outcome` for each with `--mission-id` and a status derived from the mission outcome.
> 3. Optional: agent-side discipline (in `agents/shared-mandate.md`): "after using a kura record's guidance, mention the record ID in your worker_done message". This is voluntary and brittle — the deterministic capture (step 1) is the primary mechanism.
> 4. Tests with fixture sessions.
>
> Acceptance: 80%+ of records consulted during a mission have an outcome recorded after the mission concludes.

**Labels**: `learn-loop`, `kura`, `cross-cutting`, `wave:3`

**Priority**: P1

**Blocks**: nothing direct, but un-closing the learn loop reduces autonomous-system value over time

**Blocked by**: OV-PHASE5 (provenance fields), KURA-2

---

### `OV-DOCS` — [P2] Cross-cutting: update CLAUDE.md, agent-manifest semantics, ADR updates

**Repo**: haru

**Body**:
> Once Phase 2b ships, `agents/*.md` no longer exists (or is auto-generated and not source-of-truth). Update:
> - Root `CLAUDE.md` (project agnostic guidance — keep as-is, just remove specific agent counts).
> - `docs/architecture/overview.md` — refresh metrics, update directory layout, note that base prompts now come from tane.
> - `agent-manifest.json` — semantics: now references prompt names, not file paths.
> - This issue tree itself — strike completed items.

**Labels**: `docs`, `cleanup`, `wave:4`

**Priority**: P2

**Blocked by**: OV-PHASE2B (must ship first)

---

## 3. Suji Issues

### `SUJI-1` — [P0] Add `phase` lifecycle field with state-machine validation

**Repo**: suji

**Body**:
> Per ADR Section 3.9.1.
>
> Add `phase` field to seed records. Values: `idea | clarifying | spec_ready | mission_created | in_progress | shipped | closed`.
>
> Add `su phase` command:
> - `su phase <id>` — show current phase.
> - `su phase <id> --to <target>` — transition with validation.
>
> Validation rules per ADR table 3.9.1:
> - `clarifying → spec_ready` requires `spec` field populated and all `clarifications[*].answer` filled.
> - `spec_ready → mission_created` requires `artifacts.mission_id` populated.
> - `in_progress → shipped` requires PR merge events.
> - Forward-edge skipping disallowed; backward edges to `clarifying` allowed (re-clarification).
>
> Schema bump: `schema_version: 2` on seed records.
>
> Acceptance: `su phase --help` documents transitions; invalid transitions return error JSON; `su list --phase clarifying` filters by phase.

**Labels**: `front-door`, `phase`, `state-machine`, `wave:2`

**Priority**: P0

**Blocks**: OV-PHASE1, SUJI-2

---

### `SUJI-2` — [P0] Add `spec`, `clarifications`, `artifacts` fields + `su ask`/`su answer`

**Repo**: suji

**Body**:
> Per ADR Section 3.9 and `haru-ecosystem-autonomous-platform.md:86-94`.
>
> Add fields to seed schema:
> - `spec`: object `{path, summary, approved_at, approved_by, version_hash}` or null. See contract reference Section 5.5.
> - `clarifications`: array of `{id, question, asked_by, asked_at, answer, answered_by, answered_at}`.
> - `artifacts`: `{mission_id, molecule_id, spec_artifact_id, pr_ids[], eval_run_ids[]}`.
>
> Add commands:
> - `su ask <seed_id> --question "..."` — appends a new clarification with no answer.
> - `su answer <seed_id> <q_id> --answer "..."` — fills the answer.
> - `su spec set <seed_id> --path <path>` — sets spec link.
> - `su spec check <seed_id>` — validates spec frontmatter against contract.
>
> Acceptance: `su ask` + `su answer` round-trip works; `su phase --to spec_ready` rejects when any clarification has no answer; `su show --json` includes new fields.

**Labels**: `front-door`, `spec`, `clarifications`, `wave:2`

**Priority**: P0

**Blocks**: OV-PHASE1

**Blocked by**: SUJI-1 (phase field)

---

### `SUJI-3` — [P2] Configurable clarification timeout + auto-action

**Repo**: suji

**Body**:
> Per ADR Open Question 6. Per-project config: if a seed sits in `phase=clarifying` for N days with no operator answer, what happens?
>
> Default: no auto-action (configurable, default `null`). Optional: warn-only, auto-close, notify.
>
> Add to `.suji/config.yaml`:
> ```yaml
> clarification_timeout:
>   days: 14
>   action: none | warn | close | notify
>   notify_target: null | "<email>" | "<slack-channel>"
> ```
>
> Acceptance: documented; default behavior is no auto-action.

**Labels**: `front-door`, `timeout`, `config`, `wave:3`

**Priority**: P2

**Blocked by**: SUJI-2

---

### `SUJI-4` — [P2] `su mission` convenience alias

**Repo**: suji

**Body**:
> Per `haru-ecosystem-autonomous-platform.md:93`. Add `su mission <seed_id>` as a convenience that shells out to `ha mission start --from-seed <seed_id>` if Haru is installed; otherwise prints helpful error.
>
> Optional. Pure UX sugar. Not required for any phase to ship.

**Labels**: `front-door`, `convenience`, `wave:3`

**Priority**: P2

**Blocked by**: SUJI-1

---

### `SUJI-5` — [P1] Event stream: `.suji/events.jsonl`

**Repo**: suji

**Body**:
> Per ADR Section 3.2 and `haru-ecosystem-autonomous-platform.md:104` (analogous proposal for tane is at line 104).
>
> Append to `.suji/events.jsonl` on every state-changing command:
> - `seed.created` on `su create`.
> - `seed.clarification_asked` on `su ask`.
> - `seed.clarification_answered` on `su answer`.
> - `seed.spec_ready` on `su phase --to spec_ready`.
> - `seed.mission_created` on `su update --mission <id>`.
> - `seed.shipped` on `su phase --to shipped`.
>
> Format: see contract reference Section 3.
>
> Acceptance: events file appended to atomically; `su events --tail` command for inspection (optional).

**Labels**: `events`, `observability`, `wave:3`

**Priority**: P1

**Blocked by**: SUJI-1, SUJI-2

---

## 4. Tane Issues

### `TANE-1` — [P0] **BLOCKER** Variable slot declaration + `ta render --list-vars`

**Repo**: tane

**Body**:
> **THIS BLOCKS PHASE 2B OF THE OVERSTORY DECOMPOSITION.** No spawn.ts cutover can happen without it. Phase 2a (the `ta emit` shim) does NOT depend on this issue and can ship in parallel.
>
> Per ADR Decision 8. Tane stores prompts with literal `{{VAR}}` slots intact. Tane does not interpolate. But tane MUST validate that:
> 1. Every `{{X}}` in the body is declared in frontmatter `vars: [X, ...]`.
> 2. Every `vars` entry actually appears at least once.
> 3. The list of slots is queryable via CLI for downstream tools.
>
> Deliverables:
> 1. New frontmatter field `vars: string[]` on prompts.
> 2. `ta validate` checks slot/declaration consistency. Hard reject (with `--allow-unknown-vars` opt-in for legacy migration).
> 3. `ta render --list-vars [name]` returns just the slot names (JSON array).
> 4. `ta render --json` output adds `vars: string[]` field (the slots present in the rendered body).
>
> Open question (carry forward to design discussion): hard-reject vs warn for undeclared `{{X}}`. ADR proposal: hard-reject.
>
> Acceptance: a prompt with `{{TRACKER_CLI}}` in body but no `vars: [TRACKER_CLI]` declaration fails `ta validate`. `ta render --list-vars builder` returns the array Haru's `buildTemplateReplacements()` keys.

**Labels**: `prompt-authority`, `variables`, `p0-blocker`, `wave:1`

**Priority**: P0

**Blocks**: OV-PHASE2B (Phase 2a does NOT block on this)

---

### `TANE-2` — [P0] `ta render --json` schema with `prompt_version` + attribution

**Repo**: tane

**Body**:
> Per ADR Decision 8 and contract reference Section 5.6.
>
> Deliverables:
> 1. `ta render --json` output schema (lock and version):
>    ```json
>    {"schema_version":1,"name":"...","version":N,"version_hash":"...","prompt_version":"<name>@vN:<hash>","sections":[...],"frontmatter":{...},"resolved_from":[...],"rendered_at":"..."}
>    ```
> 2. Compute `version_hash` = sha256(joined sections, pre-substitution)[:8 hex].
> 3. New flags `--mission <id>` and `--by <agent_id>`. When set, append `prompt.resolved` event with these fields.
> 4. `ta history <name>` accepts `--filter mission_id=<id>`.
> 5. Append events to `.tane/events.jsonl` (analogous to KURA-3, SUJI-5).
>
> Acceptance: `ta render builder --mission <id> --by builder-mock-1 --json` returns the schema and writes a `prompt.resolved` event.

**Labels**: `prompt-authority`, `events`, `attribution`, `wave:3`

**Priority**: P0

**Blocks**: OV-PHASE2B

**Blocked by**: TANE-1

---

### `TANE-3` — [P1] `ta render --batch`

**Repo**: tane

**Body**:
> Per `haru-ecosystem-autonomous-platform.md:104`. Resolve multiple prompts in one call to amortize startup cost.
>
> `ta render --batch '{"prompts":["builder","architect","tester"]}'` → JSON map of prompt_version → CnRenderOutput.

**Labels**: `prompt-authority`, `performance`, `wave:3`

**Priority**: P1

**Blocked by**: TANE-2

---

### `TANE-4` — [P2] Frozen sections / `ta lock`

**Repo**: tane

**Body**:
> Per `haru-ecosystem-autonomous-platform.md:106`. Allow marking sections as frozen (e.g., security constraints) so child prompts cannot override them.
>
> Frontmatter: `frozen: [section_name, ...]`.
>
> If a child prompt's `extends` chain or own sections override a frozen section, `ta render` fails.
>
> Useful in Phase 7 (locked critical prompts).

**Labels**: `prompt-authority`, `safety`, `wave:3`

**Priority**: P2

**Blocked by**: TANE-2

---

## 5. Kura Issues

### `KURA-1` — [P0] **P0 SECURITY** Append-time sanitization + read-time `<expertise untrusted>` wrapper

**Repo**: kura

**Body**:
> **PERSISTENT PROMPT INJECTION VULNERABILITY. P0.**
>
> Per ADR Decision 7 and `haru-ecosystem-autonomous-platform.md:172-173`. User-controlled strings recorded via `ku record` and later returned by `ku prime` are injected into agents' system prompts.
>
> Threat model in ADR Section 3.7. Read it before implementing.
>
> Deliverables:
> 1. **Append-time sanitization** in `recordExpertise` / `appendRecord` (`kura/src/utils/expertise.ts`):
>    - Length cap: any single string field > 8KB is rejected.
>    - Deny patterns (regex; `i` flag where applicable):
>      - `(?i)ignore (all |any |the )?previous (instructions|prompts|rules)`
>      - `(?i)you are now`
>      - `(?i)system prompt`
>      - `(?i)disregard the above`
>      - `<\|im_(start|end)\|>`
>      - `<system>`, `<assistant>`, `</?(human|user|tool)>`
>      - `^# CRITICAL OVERRIDE` and similar capitalized override markers
>    - Control character strip: drop ` -` (preserve `\n\t`).
>    - **Hard reject** on deny pattern hit. Do NOT silently sanitize. Emit `memory.record_rejected_sanitization` event.
> 2. **Read-time wrapper** in `ku prime`: every record body wrapped in `<expertise untrusted source="<agent_id>:<mission_id>">...</expertise>` (when `trust_level=untrusted`, which is the default).
> 3. CLI flag `--trusted-source` on `ku record`: requires double confirmation (TTY) and fixed-string typing ("I confirm this content is from a trusted human source"). Audit log of all `trusted_source` records in a separate `.kura/trusted-source-audit.jsonl` file.
> 4. Test corpus: a fixture set of 50+ adversarial strings that MUST be rejected. CI runs them.
>
> Acceptance:
> - All adversarial test strings rejected.
> - `ku prime` output for an `untrusted` record is wrapped.
> - `ku prime` output for a `trusted_source` record is NOT wrapped.

**Labels**: `security`, `p0-security`, `sanitization`, `wave:1`

**Priority**: P0

**Blocks**: OV-PHASE5, public launch of any project using kura

---

### `KURA-2` — [P0] Schema fields: `agent_id`, `mission_id`, `tenant`, `provenance`, `trust_level`, `schema_version`

**Repo**: kura

**Body**:
> Per ADR Decision 7 and `haru-ecosystem-autonomous-platform.md:159`.
>
> Add fields to `ExpertiseRecord` (bump `schema_version` to 2):
> - `schema_version: number` (default 2 for new records, 1 for migrated).
> - `agent_id?: string`.
> - `mission_id?: string`.
> - `tenant?: string` (multi-tenant scoping; reserved for later).
> - `provenance: 'agent_self_recorded' | 'agent_quality_gate' | 'operator_manual' | 'system_imported'`.
> - `trust_level: 'untrusted' | 'trusted_source'` (default `untrusted`).
>
> CLI flags on `ku record`: `--mission-id`, `--agent-id`, `--provenance`, `--by`, `--trusted-source`.
>
> Acceptance: `ku record api --type convention --content "..." --mission-id <id> --agent-id <id> --provenance agent_self_recorded` round-trips; `ku query --mission <id>` filters by mission.

**Labels**: `schema`, `provenance`, `wave:3`

**Priority**: P0

**Blocks**: OV-PHASE5, OV-LEARN

**Blocked by**: KURA-1 (sanitization needs to know `trust_level`)

---

### `KURA-3` — [P1] Event stream: `.kura/events.jsonl`

**Repo**: kura

**Body**:
> Per ADR Section 3.2.
>
> Append events on every state-changing command:
> - `memory.recorded` on `ku record`.
> - `memory.outcome_added` on `ku outcome`.
> - `memory.record_rejected_sanitization` on append-time deny-pattern hit (KURA-1).
>
> Format: see contract reference Section 3.

**Labels**: `events`, `observability`, `wave:3`

**Priority**: P1

**Blocked by**: KURA-1, KURA-2

---

### `KURA-4` — [P2] `ku outcome batch --from quality-gate-report.json`

**Repo**: kura

**Body**:
> Per `haru-ecosystem-autonomous-platform.md:163`. Batch outcome recording from a quality-gate JSON. Reduces N CLI invocations to 1.
>
> Schema input: `{outcomes: [{record_id, status, mission_id, agent_id, notes?}, ...]}`.

**Labels**: `outcomes`, `performance`, `wave:3`

**Priority**: P2

**Blocked by**: KURA-2

---

### `KURA-5` — [P2] `ku supersede` + auto-deprecation by low success rate

**Repo**: kura

**Body**:
> Per `haru-ecosystem-autonomous-platform.md:164` and `kura/README.md:235` (confirmation score).
>
> Deliverables:
> 1. `ku supersede <old_id> --with <new_id>` — explicit supersedes link (already in record schema; expose CLI).
> 2. Auto-deprecation: when a record's success rate (computed from outcomes) drops below threshold and is observed N times, mark `classification: observational` and add a deprecation note.
> 3. `ku prune --auto-deprecated` — separate pass for auto-deprecated records.

**Labels**: `quality`, `lifecycle`, `wave:3`

**Priority**: P2

**Blocked by**: KURA-2

---

## 6. Beads Issues — **WAVE 4 (DEFERRED)**

**All BEADS-* issues are deferred to Wave 4.** Do not start work on them until the Wave 4 trigger fires (see Section 0 / ADR Section 3.4.5):

1. ≥100 successful missions completed via the vertical-slice flow, AND
2. ≥30 days elapsed since vertical slice declared GA, AND
3. ≤5% mission failure rate in the trailing 30 days.

Reference: `haru-ecosystem-autonomous-platform.md:351-359`. The risk of starting beads-heavy migration before the vertical slice is stable is the explicit reason for this gate.

### `BEADS-1` — [P0] Schema additions: mission fields, lease, review_state, blocker_reason, artifacts, check_runs, event_outbox

**Repo**: beads

**Body**:
> **WAVE 4 / GATED.** Do not start until Wave 4 trigger fires.
>
> Per ADR Section 3.10 and `haru-ecosystem-autonomous-platform.md:121-130`.
>
> Add columns to issue schema:
> - `mission_id TEXT` (indexed, optional).
> - `mission_revision INTEGER` (optional; semantics in OV-PHASE3 / ADR Open Question 3).
> - `lease_holder TEXT`.
> - `lease_until TIMESTAMP`.
> - `review_state TEXT CHECK(review_state IN ('none','requested','changes_requested','approved','merged'))`.
> - `blocker_reason TEXT CHECK(blocker_reason IN ('dep','review','human','external','ci','race_lost','escalated'))`.
>
> Add tables:
> - `artifacts(bead_id, kind, value, recorded_at)` — kind ∈ `{pr, commit, eval, trace, build, deploy, doc, mrp}`.
> - `check_runs(bead_id, pr_id, check_name, status, details_json, recorded_at)`.
> - `event_outbox(id, event_type, payload_json, created_at, sent_at NULLABLE)` — transactional with issue writes (Outbox Pattern).
>
> CLI surface for new fields: extend `bd update` flags. Read in `bd show --json`.
>
> Acceptance: full migration over Dolt; `bd ready --mission <id>` returns mission-scoped ready list.

**Labels**: `schema`, `p0`, `mission-fields`, `wave:4`, `gated:wait-for-vertical-slice-stability`

**Priority**: P0

**Blocks**: OV-PHASE3

---

### `BEADS-2` — [P0] `bd mission seed/graph/progress/close` commands

**Repo**: beads

**Body**:
> **WAVE 4 / GATED.** Do not start until Wave 4 trigger fires.
>
> Per `haru-ecosystem-autonomous-platform.md:128`.
>
> Deliverables:
> - `bd mission seed <mission_id> --formula <name> --var ...` — wraps `bd cook` + `bd pour` + sets `mission_id` on all generated beads.
> - `bd mission graph <mission_id>` — returns the workstream tree as JSON.
> - `bd mission progress <mission_id>` — returns counts by status.
> - `bd mission close <mission_id> --outcome <success|failure|abandoned>` — marks all open beads in the mission as closed with outcome.
> - `bd dep add` programmatic surface (verify it works without TTY for OV-PHASE3 use).
>
> Acceptance: end-to-end test creates a mission, pours formula, adds workstream beads, queries progress, closes mission.

**Labels**: `mission`, `cli`, `wave:4`, `gated:wait-for-vertical-slice-stability`

**Priority**: P0

**Blocks**: OV-PHASE3

**Blocked by**: BEADS-1

---

### `BEADS-3` — [P0] New gate type: `haru.async`

**Repo**: beads

**Body**:
> **WAVE 4 / GATED.** Do not start until Wave 4 trigger fires.
>
> Per ADR Section 3.4.3.
>
> Add gate type `haru.async` (alongside existing `human`, `timer`, `github` per `website/docs/workflows/gates.md`).
>
> Semantics: passive gate. Closes only on explicit `bd gate close <bead_id> --trigger=<reason>`.
>
> No timer, no built-in resolution. Used by Haru's mission engine to externalize gate evaluation while keeping beads as the durable graph.
>
> CLI:
> - `bd gate close <bead_id> --trigger <reason>` — already exists for human gates; extend to haru.async.
> - `bd gate state <bead_id>` (or `bd show --json | .gate`) — exposes current state.
>
> Events: emit `bead.gate_open` on entry (when `needs` are satisfied), `bead.gate_closed` on close.
>
> Acceptance: a formula with an `haru.async` gate blocks until external close; `bd ready` does not surface dependents until gate is closed.

**Labels**: `gates`, `mission`, `wave:4`, `gated:wait-for-vertical-slice-stability`

**Priority**: P0

**Blocks**: OV-PHASE3

**Blocked by**: BEADS-1

---

### `BEADS-4` — [P1] Extended event stream

**Repo**: beads

**Body**:
> **WAVE 4 / GATED.**
>
> Per ADR Section 3.2. Beads already has some events; extend to cover the full vocabulary:
> - `bead.poured` (new on `bd pour`).
> - `bead.claimed` (existing? verify).
> - `bead.lease_expired` (new; emitted by tick that clears stale leases).
> - `bead.ready` (new; emitted when needs are satisfied).
> - `bead.closed` (existing? verify).
> - `bead.gate_open` / `bead.gate_closed`.
>
> Format per contract reference Section 3.
>
> Acceptance: `tail -f .beads/events.jsonl` shows the events during a typical mission flow.

**Labels**: `events`, `observability`, `wave:4`

**Priority**: P1

**Blocked by**: BEADS-1, BEADS-2, BEADS-3

---

### `BEADS-5` — [P1] Validate `agent-as-bead` for persistent agents

**Repo**: beads (with haru)

**Body**:
> **WAVE 4 / GATED.**
>
> Per ADR Section 3.6 and Open Question 7. The doc references "agent-as-bead" (`haru-ecosystem-autonomous-platform.md:130`) — verify this pattern works for Haru's persistent agents (coordinator, analyst, exec-director, architect).
>
> Concerns:
> - Persistent agents live across phases; their bead status would change repeatedly (`claimed → in_progress → idle → in_progress`).
> - Conflict with the workstream-bead pattern (3.5).
>
> Deliverables:
> 1. Discovery: read beads' agent-as-bead docs/code; confirm the model.
> 2. Decision: do persistent agents get one bead per mission, or one bead per role globally?
> 3. Test: simulate persistent-agent lifecycle and verify state transitions are clean.
> 4. Document the decision in beads docs.

**Labels**: `mission`, `agent-as-bead`, `discovery`, `wave:4`

**Priority**: P1

**Blocked by**: BEADS-1

---

### `BEADS-6` — [P2] Transactional event outbox drain

**Repo**: beads

**Body**:
> **WAVE 4 / GATED.**
>
> Per ADR Decision 10.4. The Outbox Pattern requires a drain process or a tick that converts `event_outbox` rows into `.beads/events.jsonl` lines.
>
> v1: simple drain on every `bd` invocation (cheap; serializes with the issue write transaction).
>
> v2: optional `bd events drain --watch` daemon for higher throughput.
>
> Acceptance: events appear in `.beads/events.jsonl` within 1 second of the issue write that produced them; no events lost on crash.

**Labels**: `events`, `reliability`, `wave:4`

**Priority**: P2

**Blocked by**: BEADS-1, BEADS-4

---

## 7. Cross-Repo Coordination

### Critical-path graph (strangler-execution order)

The graph below is the **execution order** by strangler wave, NOT the architectural-dependency graph. BEADS-* and OV-PHASE3 are explicitly deferred to Wave 4 with a "wait for vertical slice stability" gate.

```
Wave 1 (Foundations — no user-visible change yet)
  ├─ OV-PHASE0          (haru: contracts)
  ├─ KURA-1            (kura: sanitization, P0 SECURITY)
  └─ TANE-1           (tane: variable slots, P0 BLOCKER for Phase 2b)

Wave 2 (Vertical slice — demo-ready)
  ├─ SUJI-1, SUJI-2   (suji: phase, spec, clarifications)
  ├─ OV-PHASE1          (haru: intake-phase)
  ├─ OV-PHASE2A         (haru: ta emit shim — strangler step, no spawn.ts change)
  ├─ OV-PHASE4          (haru: debugger, Stage C)
  └─ OV-VERTICAL-SLICE  (haru: 13-step demo)
                         └─→ "Ship the demo" gate fires
                              └─→ countdown begins for Wave 4 trigger

Wave 3 (Production hardening — safe for unattended)
  ├─ KURA-2            (kura: schema fields)
  ├─ OV-PHASE2B         (haru: spawn.ts cutover ← TANE-1)
  ├─ OV-PHASE5          (haru: kura hardening, P0 SECURITY for public)
  ├─ TANE-2, TANE-3, TANE-4
  ├─ KURA-3, KURA-4, KURA-5
  ├─ SUJI-3, SUJI-4, SUJI-5
  ├─ OV-LEARN           (haru: outcome attribution)
  ├─ OV-PHASE6          (haru: PR lifecycle ← OV-PHASE4, OV-PHASE5)
  └─ OV-PHASE7          (haru: budget, sandbox ← OV-PHASE6)

Wave 4 (Architectural completion — GATED on vertical slice stability)
  GATE: ≥100 missions + ≥30 days vertical-slice GA + ≤5% failure rate
  │     If any criterion fails, defer 30 days. Reference ADR Section 3.4.5.
  ↓
  ├─ BEADS-1, BEADS-2, BEADS-3  (beads: schema + commands + gate type)
  ├─ BEADS-4, BEADS-5, BEADS-6  (beads: events, agent-as-bead, outbox)
  ├─ OV-PHASE3          (haru: beads as execution graph)
  ├─ OV-PHASE8          (haru: background autonomous)
  └─ OV-DOCS            (haru: cleanup after Phase 2b)
```

### Architectural dependency graph (for reference only — NOT execution order)

For completeness, the pure architectural-dependency view (which phases require which):

```
OV-PHASE0  (haru)
  ├─→ OV-PHASE1   (← SUJI-1, SUJI-2)
  ├─→ OV-PHASE2A  (no external blockers; just `ta import`)
  ├─→ OV-PHASE2B  (← TANE-1 BLOCKER, TANE-2, OV-PHASE2A stable 14d)
  ├─→ OV-PHASE3   (← BEADS-1, BEADS-2, BEADS-3, **Wave 4 trigger**)
  ├─→ OV-PHASE4   (no external blockers)
  ├─→ OV-PHASE5   (← KURA-1 P0 SECURITY, KURA-2)
  ├─→ OV-PHASE6   (← OV-PHASE4, OV-PHASE5)
  ├─→ OV-PHASE7   (← OV-PHASE6)
  └─→ OV-PHASE8   (← OV-PHASE7, OV-PHASE3)

OV-VERTICAL-SLICE (← OV-PHASE1, OV-PHASE4, OV-PHASE2A thin)
                    Public-launch gate: requires OV-PHASE5
```

### Parallelizable work within each wave

**Wave 1**: OV-PHASE0, KURA-1, TANE-1 — all parallel.

**Wave 2**: SUJI-1+SUJI-2, OV-PHASE1, OV-PHASE2A, OV-PHASE4 — all parallel after Wave 1 lands. OV-VERTICAL-SLICE integrates them.

**Wave 3**: KURA-2, OV-PHASE2B (after TANE-1 stable), TANE-2/3/4, KURA-3/4/5, SUJI-3/4/5, OV-LEARN, OV-PHASE5, OV-PHASE6, OV-PHASE7 — large parallel work; OV-PHASE6 ← OV-PHASE5; OV-PHASE7 ← OV-PHASE6.

**Wave 4**: BEADS-1/2/3 → OV-PHASE3, BEADS-4/5/6 alongside, OV-PHASE8 ← OV-PHASE7+OV-PHASE3, OV-DOCS ← OV-PHASE2B.

### Why ship Phase 3 (beads migration) AFTER the vertical slice demo

The source doc's reasoning is explicit (`haru-ecosystem-autonomous-platform.md:351-357`):
> "Beads мощнее Suji, но если начать с него, ты можешь утонуть в schema/migration/graph complexity до того, как появится пользовательский end-to-end loop."

Reviewer reinforcement: "Если сейчас начать резко разносить всё по Tane/Kura/Suji/Beads, можно сломать главный asset: рабочий orchestration loop."

We follow this. Phase 3 is the heaviest migration in the ADR. The Wave 4 trigger (Section 0; ADR 3.4.5) is non-negotiable.

---

## 8. Filing Checklist

Before filing each issue:

- [ ] Title matches the heading exactly (e.g., `BEADS-1: ...`).
- [ ] Body skeleton copied verbatim with the relevant ADR/contract-reference section quoted.
- [ ] Labels attached (each section's italic labels list, **including the `wave:N` label**).
- [ ] Priority set.
- [ ] Dependencies linked using the issue tracker's "blocks/blocked by" mechanism.
- [ ] Repo is correct (haru vs suji vs tane vs kura vs beads).
- [ ] If the issue is P0, an explicit acceptance criterion is in the body.
- [ ] If the issue is `breaking-change-prep` or affects an external CLI surface, mention deprecation strategy.
- [ ] If the issue carries `gated:wait-for-vertical-slice-stability`, the gate criterion (Section 0 / ADR 3.4.5) is referenced in the body.

---

## 9. Estimated Counts

| Repo | P0 | P1 | P2 | Total |
|---|---|---|---|---|
| haru | 7 (PHASE0, PHASE1, PHASE2A, PHASE2B, PHASE3, PHASE4, PHASE5, VERTICAL-SLICE) | 3 (PHASE6, LEARN) | 3 (PHASE7, PHASE8, DOCS) | ~12 + epic |
| suji | 2 (SUJI-1, SUJI-2) | 1 (SUJI-5) | 2 (SUJI-3, SUJI-4) | 5 |
| tane | 2 (TANE-1, TANE-2) | 1 (TANE-3) | 1 (TANE-4) | 4 |
| kura | 2 (KURA-1, KURA-2) | 1 (KURA-3) | 2 (KURA-4, KURA-5) | 5 |
| beads | 3 (BEADS-1, BEADS-2, BEADS-3) | 2 (BEADS-4, BEADS-5) | 1 (BEADS-6) | 6 |
| **Total** | **16** | **8** | **9** | **~33 issues** |

By wave:
- Wave 1: 3 issues (OV-PHASE0, KURA-1, TANE-1)
- Wave 2: 6 issues (SUJI-1, SUJI-2, OV-PHASE1, OV-PHASE2A, OV-PHASE4, OV-VERTICAL-SLICE)
- Wave 3: 14 issues
- Wave 4: 9 issues (all BEADS-* + OV-PHASE3 + OV-PHASE8 + OV-DOCS)

---

## 10. References

- ADR: `docs/architecture/adr-ecosystem-decomposition.md`
- Contract reference: `docs/architecture/ecosystem-contract-reference.md`
- Source vision: `docs/research/haru-ecosystem-autonomous-platform.md`
- Source roadmap: `docs/research/haru-autonomous-dev-roadmap.md`
