# ADR: Hierarchical Planning — Sub-Architects, Lead-as-Reviewer, Haiku Builders

**Status**: Proposed

**Date**: 2026-06-02

**Deciders**: Haru core team

**References**: Issue #312, Epic #204, Stage E v2 mission `mission-1778699081737-stage-e-v2`,
prereq issues #284 (done), #286, #299, #300, #301, #303

---

## 1. Context & Problem

### 1.1 Observed Pain From Stage E v2

The Stage E v2 mission (`mission-1778699081737-stage-e-v2`) revealed three compounding
inefficiencies in haru's current flat agent model:

**Architecture bottleneck.** The solo principal architect produced a single
`architecture.md` that grew to approximately 90 KB across a mission with 13 workstreams
and 11 builders. One agent, one context window, one bottleneck. Builders with questions
had to queue for responses from the same architect handling design revisions and post-merge
reviews in parallel.

**Cost concentration.** The Stage E v2 mission ended at a total cost of **$925**.
The lead coordinator alone accounted for **$375** — 40.5% of total mission cost.
Eleven Sonnet builders totaled ~**$37** combined. The remaining **$513** was spread
across the architect, dedicated reviewers, scouts, and overhead. The
dedicated reviewer-per-workstream model (13 workstreams) contributed a substantial
share of that remainder.

**Uniform builder quality allocation.** All 11 builders ran on Sonnet regardless of
workstream complexity. Refactor-mode and documentation workstreams are structurally
simpler than greenfield API workstreams but pay the same per-token rate. The current
architecture provides no mechanism to right-size builder capability to task difficulty.

### 1.2 Root Causes

1. **Single-architect context limit.** One architect per mission cannot hold 11
   workstream designs in working memory without context compression artifacts.
   The 90 KB `architecture.md` was itself a symptom: a document that large cannot
   be read or updated efficiently.

2. **Lead cost is planning overhead.** A $375 lead spend is mostly coordination work —
   spawning scouts, writing specs, triaging builder mail — not engineering. Hierarchical
   delegation would distribute this across specialist sub-leads.

3. **Fixed reviewer slot per workstream.** Spawning a dedicated reviewer for every
   workstream regardless of change risk doubles the agent count and adds latency
   without proportional quality benefit for low-risk workstreams.

4. **No capability-based builder selection.** `ha sling` dispatches all builders at the
   configured default runtime model (`src/commands/sling.ts:1049`). There is no signal
   in the brief that tells the dispatcher to downgrade for mechanically simple workstreams.

---

## 2. Four Proposed Changes

### Change A — Hierarchical Planning (Planner Sub-Agents)

When the mission analyst detects that a mission crosses a complexity threshold
(`complexity_signals.needs_distributed_architecting` — see §3), it spawns one
**planner sub-agent** per workstream cluster (2-4 related workstreams) rather than
producing a single monolithic plan.

Each planner owns:
- A scoped `plan/ws-<cluster-id>.md` (interfaces and contracts for its cluster)
- A `plan/workstreams-<cluster-id>.json` (workstream list for its cluster)

The principal analyst synthesizes cluster plans into a top-level `plan/workstreams.json`
and `plan/architecture.md` index. The principal holds only the coordination layer;
the detail lives in cluster documents.

**Threshold trigger**: see §3.

### Change B — Hierarchical Architecting (Sub-Architect Per Sub-System)

When the architect phase begins for a mission that triggered
`needs_distributed_architecting`, the principal architect spawns **sub-architects**
(one per sub-system cluster, up to 5). Each sub-architect:

- Receives a scoped brief covering only its sub-system boundary
- Writes to `plan/arch-<cluster-id>.md` (not `architecture.md` directly)
- Communicates with the principal via the coordination protocol (§4)

The principal architect stitches cluster documents into `architecture.md` via an
index-with-includes format. Builders reference both the top-level index and their
cluster doc. This keeps each context window focused below ~20 KB.

**Non-goal**: sub-architects do NOT span workstream execution; they are ephemeral
design-phase agents. The principal remains the single design authority for revision
and post-merge review.

### Change C — Lead-as-Reviewer (Drop Dedicated Reviewer Per Workstream)

Replace the dedicated reviewer agent per workstream with one of two alternatives
(operator-selectable):

- **Option C1 (lead self-review)**: The lead reads the builder diff, runs quality gates,
  and approves without spawning a reviewer. Suitable for low-risk, well-specced workstreams.
- **Option C2 (peer-lead review)**: The lead delegates review to a sibling lead running
  a different workstream. The reviewing lead reads the diff, checks interface conformance,
  and sends `merge_ready` or a revision request. This preserves independence without the
  cost of a dedicated reviewer instance.

Analysis: see §5.

### Change D — Builder Model Downgrade (Sonnet → Haiku for Contract-Quality Workstreams)

When a workstream's test-plan meets the "contract-quality" bar (§6), the brief flag
`builderModel: "haiku"` is set, and `ha sling` dispatches a Haiku builder instead of
Sonnet. The builder still runs `bun test` / `bun run lint` / `bun run typecheck` as
quality gates; the only change is the per-token model rate.

---

## 3. Trigger Signal: `complexity_signals.needs_distributed_architecting`

### 3.1 Proposed Output Schema

The tier-classifier already emits a structured `signals` map (see
`docs/architecture/tier-classification-schema.md`). This ADR proposes extending the
schema with a second-pass enrichment field:

```json
{
  "complexity_signals": {
    "needs_distributed_architecting": true,
    "file_count": 42,
    "workstream_count": 11,
    "sub_system_count": 4,
    "has_breaking_change": true,
    "cross_component_coupling": 7,
    "rationale": "file_count>30 + 3 independent sub-systems + breaking API change"
  }
}
```

The `complexity_signals` object is emitted by the **mission analyst** (not the
tier-classifier) at the end of the research phase, before the plan phase begins.
The tier-classifier continues to emit `signals` only (it is a fast Haiku pass and
should not be burdened with deep sub-system analysis).

### 3.2 Triggering Rules

`needs_distributed_architecting` is `true` when **two or more** of the following hold:

| Rule | Threshold | Rationale |
|------|-----------|-----------|
| `file_count > 30` | 30 files | Proxy for scope; a single architect context gets stressed above this |
| `workstream_count >= 7` | 7 workstreams | Empirically: Stage E v2 had 11 and hit the bottleneck |
| `sub_system_count >= 3` | 3 distinct sub-systems | Independent modules with separate ownership boundaries |
| `has_breaking_change === true` | any | Breaking changes require careful cross-subsystem contract review |
| `cross_component_coupling > 5` | 5 edges | High coupling amplifies architect coordination cost |

A single rule in isolation should NOT trigger distributed architecting; the coordination
overhead must be justified by genuine scope.

### 3.3 Integration Point

The analyst writes the `complexity_signals` block to `plan/complexity-signals.json`
(alongside `plan/workstreams.json`). The coordinator reads this file to decide whether
to dispatch the principal architect with `mode: "distributed"` or `mode: "single"`.

**Agent to modify**: `agents/tier-classifier.md:67-93` — add a discussion note pointing to
`plan/complexity-signals.json` as the authoritative source (the analyst owns it, not
the classifier). The classifier continues to emit the simpler `signals` map; the analyst
enriches it.

---

## 4. Sub-Architect Coordination Protocol

When `mode: "distributed"`, the principal architect must coordinate with 2-5 sub-architects
over interface contracts. Three options are compared:

### Option 1 — Reuse `clarifier_question` / `clarifier_answer` Pattern

Sub-architects send `clarifier_question` mail to the principal when they need a cross-
subsystem contract decision (e.g., "Which module owns the `MissionGraphNode` union —
mine or ws-2?"). The principal replies with `clarifier_answer`. This is the pattern
already used between the product-clarifier and analyst (`src/mail/types.ts:37-38`).

**Pros**: Zero new mail types. Existing gate evaluators and convergence logic apply.
**Cons**: `clarifier_question` was designed for Haiku-to-Opus calls in Stage A
(clarification of operator intent). Reusing it for architect-to-architect coordination
adds semantic ambiguity — a `clarifier_question` in Stage C (design) can be misrouted
by observability tools that assume it belongs in Stage A.
**Mail cost**: 1 round-trip per cross-boundary question (2 messages).

### Option 2 — New `arch_sync` / `arch_sync_reply` Mail Types

Add two new mail types to the `MailProtocolType` union in `src/mail/types.ts:10`:

```typescript
| "arch_sync"        // sub-architect → principal: contract question or proposal
| "arch_sync_reply"  // principal → sub-architect: decision or counter-proposal
```

The `arch_sync` payload carries `{ clusterId, interfaceName, question, draft?: string }`.
The `arch_sync_reply` payload carries `{ decision, rationale, affectedClusters: string[] }`.

**Pros**: Semantically unambiguous. Easy to filter in observability (`ha feed --type arch_sync`).
Allows broadcasting decisions to multiple sub-architects via `affectedClusters`.
**Cons**: Two new mail types in `src/mail/types.ts`; `CONVERGENCE_MAIL_TYPES` must be
updated in `src/mail/client.ts:173` and `src/mail/store.ts:451` (see mulch record `mx-d11589`
for the literal-array constraint).
**Mail cost**: 1 round-trip per question; principal can broadcast to N sub-architects
in one reply.

### Option 3 — Single Shared Document With Owned Sections

Each sub-architect writes to a shared `plan/interfaces.md`, with one section per cluster
(headed `## Cluster: ws-<id>`). The principal reviews and arbitrates conflicts in a
`## Principal Decisions` section. No back-and-forth mail; coordination is through
document editing.

**Pros**: Zero mail cost. All decisions visible in one file.
**Cons**: Requires locking or sequential write coordination (no concurrent edits to
the same file). The current worktree model assigns files to one agent; shared file
ownership violates the `OVERLAPPING_FILE_SCOPE` constraint in `agents/lead.md:39`.
In practice this would require the principal to be the sole writer, receiving proposals
via a different channel — which collapses into Option 1 or 2 anyway.
**Mail cost**: 0 direct messages, but requires sequential turn-taking (latency rises).

### Recommendation

**Option 2** (`arch_sync` / `arch_sync_reply`). The semantic clarity and broadcast
capability justify two new mail types. Option 1 is workable but pollutes Stage A
observability. Option 3 is unworkable with the current worktree-isolated write model.

**Mail cost estimate per mission**: 4 sub-architects × 3 cross-boundary questions avg
= 12 `arch_sync` + 12 `arch_sync_reply` = 24 messages. At the current mail store
latency (~1-5ms/query per `src/mail/store.ts:467`), this is negligible. Token cost is
the relevant metric: 24 lightweight messages vs. 1 principal architect spending O(N²)
re-reading all cluster docs to detect conflicts.

---

## 5. Lead-as-Reviewer Trade-Off Analysis

### 5.1 Current Model

Every workstream spawns a dedicated reviewer agent (`agents/reviewer.md:124-136`). The reviewer
reads the builder diff, checks conformance against `architecture.md`, runs no additional
tests, and sends `merge_ready` or revision requests. At ~$10 per reviewer × 13 workstreams,
dedicated reviewers total ~$130 per mission — a standalone cost line comparable in size
to the entire builder fleet.

### 5.2 Option C1 — Lead Self-Review

The lead reads `git diff` for its assigned builder(s), checks against the spec,
runs `bun test && bun run lint && bun run typecheck` in the worktree, and sends
`merge_ready` without spawning a reviewer.

**Independence risk**: The lead wrote the spec the builder implemented. Self-review
introduces confirmation bias — the lead is reviewing against its own assumptions.
For specification-heavy workstreams with complex interfaces, this is a meaningful
regression in quality. For simple, well-constrained workstreams (refactor, docs,
config changes), the risk is low.

**Cost saving**: ~$10 per workstream × 13 workstreams = **~$130 saved per mission**.
At Stage E v2 scale this reduces total cost by ~14%.

### 5.3 Option C2 — Peer-Lead Review (Recommended Middle Ground)

The lead delegates review to a **sibling lead** running a different workstream. The
reviewing lead is already running and has a live context; the marginal cost of adding
a review task is low (read diff, check interfaces, send verdict).

Concretely: Lead-A reviews Lead-B's builder output and vice versa.

**Pros**: Independence is preserved (reviewer did not write the spec). Cost is
incremental (no new agent spawn; reviewing lead runs inside its existing session).
**Cons**: Adds latency if the reviewing lead is busy with its own builders. Requires
careful orchestration to avoid deadlock (A reviews B while B reviews A — both can
stall if their own builders are still in-flight).

**Deadlock mitigation**: Reviews are dispatched only after the reviewing lead has
sent its own `merge_ready` for all its own builders. The coordinator enforces this
sequencing.

**Cost saving**: ~$10 per workstream × 13 workstreams = **~$130 saved per mission**
(same as C1). The savings come from eliminating the dedicated reviewer spawn, not
from reducing review work.

### 5.4 Quantified Comparison

| Model | Cost/workstream | 13-workstream mission | Independence |
|-------|----------------|----------------------|--------------|
| Dedicated reviewer (current) | +$10 | +$130 | Full (separate agent) |
| Lead self-review (C1) | +$0 | +$0 | None |
| Peer-lead review (C2) | +$0* | +$0* | Partial (different author) |

*Incremental cost only; reviewing lead already running.

**Recommendation**: Default to C2 for planned/full tier. C1 remains available for
direct tier or workstreams with `risk: low` in their brief.

---

## 6. Haiku Builder Feasibility

### 6.1 What "Contract-Quality Test-Plan" Means

A test-plan meets the contract-quality bar when a builder can implement against it
**without judgment calls**. This requires:

1. **Every assertion is explicit**: test-plan.yaml specifies exact expected values,
   not fuzzy descriptions ("should return the user" → must become "returns
   `{ id: 'u1', name: 'Alice' }` from `getUser('u1')`").
2. **Every edge case is enumerated**: null inputs, empty arrays, type mismatches,
   concurrent access — all named with expected outcomes.
3. **File scope is bounded**: the test-plan names exactly which files the builder
   will touch. No open-ended "find and update all callers."
4. **Interfaces are fully typed**: every function signature referenced in the
   test-plan includes its TypeScript signature, not just a description.
5. **No conditional logic left to builder**: no "if the store exists, do X; otherwise Y"
   without specifying the observable behavior of each branch.

A test-plan that fails any of these criteria requires Sonnet-level judgment to
execute. A test-plan that passes all five can safely run on Haiku.

### 6.2 Explicit Acceptance Criteria for Haiku Dispatch

The tester agent (which writes the actual test files in TDD `full` mode) should
output a `test-plan-quality.json` alongside `test-plan.yaml`:

```json
{
  "workstreamId": "ws-3",
  "contractQualityGates": {
    "assertionsExplicit": true,
    "edgeCasesEnumerated": true,
    "fileScopeBounded": true,
    "interfacesFullyTyped": true,
    "noBuilderJudgmentCalls": true
  },
  "contractQualityScore": 5,
  "builderModelRecommendation": "haiku"
}
```

The brief template (`templates/overlay.md.tmpl`) gains a new optional field
`builderModel: "haiku" | "sonnet"` (default `"sonnet"`). The coordinator reads
`test-plan-quality.json` and sets `builderModel: "haiku"` in the brief when
`contractQualityScore === 5`. The `ha sling` command (`src/commands/sling.ts:146`, `SlingOptions`)
reads this field and selects the runtime accordingly.

### 6.3 Paired-Comparison Evaluation Plan

To validate before making Haiku the default:

1. Select 3 workstreams from a planned-tier mission where `contractQualityScore === 5`.
2. Run each workstream **twice**: once with the Sonnet builder, once with a Haiku builder,
   against the same pre-written tests.
3. Measure: (a) pass-rate on first attempt, (b) number of revision cycles, (c) wall-clock
   time, (d) token cost.
4. Report a **rework rate** = (revision cycles on Haiku) / (revision cycles on Sonnet).
   Target threshold: rework rate ≤ 1.5× is acceptable; > 1.5× means the test-plan
   criteria above are insufficient.

This eval should run as an `ha eval` scenario in `evals/` before Phase 2 default rollout.

---

## 7. Phased Rollout

Matching the three phases in issue #312:

### Phase 1 — Opt-In (No defaults changed)

- **Sub-architect protocol**: add `arch_sync` / `arch_sync_reply` mail types.
  Principal architect reads `plan/complexity-signals.json` and, if
  `needs_distributed_architecting === true`, spawns sub-architects with explicit
  `ha sling --capability architect --scope <cluster>` when the operator passes
  `--distributed-arch` flag to `ha mission start`.
- **Planner sub-agents**: add `plannerMode: "distributed"` to mission config.
  Analyst spawns planner sub-agents when `ha mission start --planner distributed`.
- **Haiku option**: add `builderModel` to brief template. Operator can set
  `--builder-model haiku` per-workstream via `ha sling`. No automatic selection yet.
- **Peer-lead review**: add C2 as a dispatch override in the lead overlay:
  `PEER_REVIEW: <sibling-lead-name>`. Coordinator can enable per-workstream.

### Phase 2 — Default for Full Tier

- Sub-architects **on by default** when `needs_distributed_architecting === true`
  (no operator flag required).
- Lead-as-reviewer **trial on planned tier**: peer-lead review becomes the default
  for planned-tier missions; dedicated reviewer remains default for full tier.
- Haiku builders remain opt-in (evaluation data from Phase 1 not yet sufficient).
- Run paired-comparison eval (§6.3) during this phase.

### Phase 3 — New Defaults

- **Haiku builders** become default for refactor-mode workstreams where
  `contractQualityScore === 5`. Sonnet remains default for greenfield.
- **Peer-lead review** becomes default for planned tier; full tier default remains
  dedicated reviewer with option to switch to peer-lead via config flag.
- **Distributed planning/architecting** on by default for full tier when signals
  threshold is crossed.

---

## 8. Prerequisite Mechanism Work

Issues that must close before safe Phase 1 rollout:

| Issue | Description | Status | Dependency |
|-------|-------------|--------|------------|
| #284 | Sub-architect mail routing | Done | Unblocked for Phase 1 |
| #286 | Worktree cleanup on ephemeral agent exit | Open | Required: sub-architects are ephemeral; stale worktrees will accumulate without this |
| #299 | Workstream ID propagation in spec-meta | Open | Required: planner sub-agents must propagate `workstreamId` to briefs |
| #300 | Brief flag schema extension | Open | Required: `builderModel` and `plannerMode` fields need schema support |
| #301 | `ha sling` capability scoping | Open | Required: dispatching sub-architects by sub-system scope |
| #303 | Mission artifact path registry | Open | Required: `plan/arch-<cluster-id>.md` paths must be registered for lifecycle tracking |

**Not redesigned here**: the internal mechanics of #286-#303 are out of scope for this
ADR. They are referenced only as blockers.

---

## 9. Cost Model

Using Stage E v2 as the baseline ($925 total, 13 workstreams, 11 builders, Sonnet
throughout):

| Component | Today (Stage E v2) | Phase 1 (opt-in) | Phase 3 (defaults) |
|-----------|-------------------|------------------|--------------------|
| Lead coordinator | $375 | $375 | $220 (distributed leads, narrower scope) |
| 11 builders (Sonnet) | $37 total | ~$29 (8 Sonnet + 3 Haiku opt-in) | ~$21 (5 Sonnet + 6 Haiku) |
| Solo architect | $75 (est.) | $75 | $75 (principal $45 + 3×$10 sub-architects) |
| Dedicated reviewers (13 ws) | $130 (~$10×13) | $65 (50% peer-lead) | $0 (peer-lead default) |
| Scouts / overhead | $308 (remainder) | $280 (~9% reduction) | $230 (~25% reduction) |
| **Total** | **$925** | **~$824** | **~$546** |
| **vs. baseline** | — | **-11%** | **-41%** |

**Notes**:
- Phase 3 architect cost is flat (sub-architect spawns add ~$30 but principal scope
  shrinks proportionally); total mission cost falls because builder and reviewer savings
  dominate.
- Haiku builders (×11) estimated at ~$5-10 total vs. ~$37 total for Sonnet — roughly
  5-7× cheaper per token at equivalent output. Exact rate depends on workstream token
  consumption; the paired-comparison eval (§6.3) will produce empirical numbers.
- Lead cost reduction in Phase 3 assumes distributed leads with narrower coordination
  scope per lead; this is speculative without Phase 1/2 empirical data.

---

## 10. Risks & Mitigations

### Risk 1 — Coordination Overhead From Sub-Architects

Adding 3-5 sub-architects per mission adds ~24 `arch_sync` messages and multiple
parallel context windows. If sub-architects produce conflicting interface proposals,
the principal architect must arbitrate — which can take longer than writing the section
directly.

**Mitigation**: Only trigger distributed architecting when `needs_distributed_architecting
=== true` (§3). For missions that do not cross the threshold, the single-architect model
remains the default. Add a hard timeout of 2 `arch_sync` round-trips before the principal
issues a unilateral decision.

### Risk 2 — Sub-Architect Design Drift

Sub-architects operate independently and may produce cluster designs that are internally
consistent but mutually incompatible at the seams.

**Mitigation**: The principal architect owns a `plan/arch-contracts.md` that lists all
cross-cluster interface contracts. Sub-architects must read this before writing their
cluster doc. The principal writes initial contracts before dispatching sub-architects;
sub-architects send `arch_sync` to propose changes, not to discover interfaces.

### Risk 3 — Quality Regression From Dropping Dedicated Reviewer

Peer-lead review has conflict-of-interest risk when leads share a coordinator and want
to unblock each other quickly. A reviewer with no stake in the workstream can be more
rigorous.

**Mitigation**: Peer-lead review only for planned tier in Phase 2/3. Full-tier missions
retain dedicated reviewers by default (high-risk changes need independence). Add a
`reviewDepth: "peer"` flag to the merge readiness pack so post-mission audits can
correlate review mode with defect rate.

### Risk 4 — Haiku Builder Rework Rate

Haiku may miss subtle edge cases that a Sonnet builder would catch during implementation,
even with a contract-quality test-plan. Rework cycles are expensive (re-read spec,
re-implement, re-run quality gates).

**Mitigation**: The paired-comparison eval (§6.3) is a hard gate before Phase 3. If
rework rate exceeds 1.5×, Haiku dispatch is not promoted to default. Per-workstream
opt-out via `builderModel: "sonnet"` remains available at all phases.

### Risk 5 — Agent-Type Sprawl

Adding sub-architects, planner sub-agents, and peer-review roles increases the number
of distinct agent types visible in `ha status` and `ha dashboard`. Operators and leads
already manage complex multi-agent missions.

**Mitigation**: Sub-architects and planner sub-agents are **ephemeral** — they spawn,
produce artifacts, and exit. They do not appear in long-lived `ha status` output after
their task completes. The `ha status` display already handles ephemeral agents via the
`waiting` → `complete` → cleanup path.

---

## 11. Open Questions

1. **Sub-architect cluster partitioning algorithm**: How does the analyst decide which
   workstreams belong to which cluster? Manual (operator-specified) vs. automatic
   (based on file-overlap or sub-system tag)? A bad partition forces more `arch_sync`
   round-trips.

2. **Principal architect context sharing**: Sub-architects need the full mission brief.
   Does the principal summarize and send, or do sub-architects read `plan/workstreams.json`
   directly? Sending a large brief in a mail message has cost; direct filesystem access
   has no guard rail.

3. **Deadlock risk in peer-lead review**: If Lead-A is waiting for Lead-B's review and
   Lead-B is waiting for Lead-A's, the mission stalls. The "reviews after own `merge_ready`"
   sequencing constraint (§5.3) prevents this but may add wall-clock latency. Is there a
   better scheduling model?

4. **`contractQualityScore` writer**: This ADR assigns it to the tester agent. If TDD
   mode is `light` or `skip`, there is no tester. Who evaluates contract quality then?
   Options: the architect, the lead, or skip Haiku dispatch entirely for non-TDD-full
   workstreams.

5. **Haiku capability for TypeScript strict mode**: The codebase enforces
   `noUncheckedIndexedAccess` and `noExplicitAny`. Will Haiku reliably satisfy these
   constraints against a contract-quality spec? This is an empirical question for the
   Phase 1/2 eval.

6. **Phase 2 lead-reviewer trial scope**: Should peer-lead review be trialled on all
   planned-tier missions or only on missions that opted in to hierarchical architecting?
   Mixing the two variables makes it harder to attribute quality changes to the correct
   feature.

---

## 12. Acceptance Signals

Concrete observable changes that indicate each phase is implemented:

### Phase 1

- `src/mail/types.ts:10` exports `"arch_sync"` and `"arch_sync_reply"` as valid
  `MailProtocolType` values; `CONVERGENCE_MAIL_TYPES` arrays at `src/mail/client.ts:173`
  and `src/mail/store.ts:451` updated.
- `templates/overlay.md.tmpl` includes `builderModel: {{ builderModel | default "sonnet" }}`.
- `src/commands/sling.ts:146` (`SlingOptions`) gains a `builderModel` field;
  `--builder-model haiku|sonnet` flag selects runtime accordingly.
- `plan/complexity-signals.json` is written by the analyst and readable by `ha mission show`.
- `agents/tier-classifier.md:67-93` contains a discussion note pointing to
  `plan/complexity-signals.json`.
- `ha sling --capability architect --scope <cluster>` succeeds without error.

### Phase 2

- `ha mission start` without `--distributed-arch` flag automatically activates
  sub-architects when `complexity_signals.needs_distributed_architecting === true`
  for full-tier missions.
- `ha status` shows `sub-architect-<cluster>` agents during the design phase of
  a qualifying mission and does not show them after they exit.
- `ha config get missions.plannerMode` returns `"distributed"` as the full-tier default.
- Peer-lead review is enabled by default for new planned-tier missions
  (`ha config get missions.reviewMode` returns `"peer-lead"` for `planned`).

### Phase 3

- `ha costs` breakdown shows Haiku and Sonnet builders as separate line items.
- Mission with 6 refactor-mode, contract-quality workstreams shows `builderModel:haiku`
  in `ha status`.
- `evals/haiku-builder-rework.ts` scenario exists and reports rework rate ≤ 1.5×.
- `ha config get missions.reviewMode` returns `"peer-lead"` for `planned` and
  `"dedicated"` for `full` by default, both overridable per-workstream.
