# ADR: Mission Autonomy Modes A/B/C/D

- **Status:** Proposed
- **Issue:** [#234](https://github.com/liker0704/haru/issues/234) (Epic [#204](https://github.com/liker0704/haru/issues/204))
- **Substrate:** Stage A `mission.autonomy` field (#223), already landed
- **Scope:** Design only. No code, no tests, no agent `.md` changes.

## 1. Context & vision

Missions today run one way: every human-in-the-loop gate fires. The operator
approves the spec, approves the plan, and approves the PR. That is the right
default while the planner and debug loop are still earning trust — but it makes
the operator the bottleneck on every mission, including trivial ones the swarm
could finish unattended.

Issue #234 proposes **four product modes** that pick a human-in-the-loop level:

| Mode | Name         | Human touches |
|------|--------------|---------------|
| A    | Dark factory | PR review only (everything else autonomous, no questions surfaced) |
| B    | Dev factory  | PR review only (questions surfaced when blocking) |
| C    | Spec-driven  | Plan review + PR review (spec auto-approved) |
| D    | Supervised   | Spec + plan + PR review (today's default) |

The **substrate already exists**. `MissionAutonomy` is a three-value enum at
`src/missions/types.ts:388`:

```ts
export type MissionAutonomy = "supervised" | "auto-spec" | "auto-all";
```

The gate-skipping is wired through the watchdog gate evaluator at
`src/watchdog/gate-evaluators.ts:1004`: non-supervised missions auto-approve the
`human-spec-review` gate. The CLI already accepts `--autonomy` at
`src/commands/mission.ts:93-96`, defaulting to `supervised`.

This ADR's job is **not** to re-design that substrate. It is to:

1. Define the **user-facing behavior** of each mode (audience, gates, clarifier
   visibility, PR review, CLI, default).
2. Decide how Mode A suppresses **user-facing questions** without losing
   technical clarification (the clarifier filter).
3. Decide whether Mode C is a real mode or folds into B.
4. Decide the **per-project default** mechanism and a maturity-based switching
   criterion.
5. Decide **notification UX** in autonomous modes.
6. Lay out **phasing** against the existing Stage A–E roadmap.

**Core tradeoff threaded throughout:** more autonomy = less safety. The further
left we push the gates, the more the operator trusts machine judgement. The
closing safety summary names where the operator's *last line of defense* sits in
each mode.

## 2. The four modes

The substrate is a 3-value enum but there are 4 product modes. The key insight:
**A and B share the same gate configuration (`auto-all`)** and differ only in
*clarifier question visibility* and *future auto-merge*. C maps to `auto-spec`,
D maps to `supervised`. No new enum value is required to ship A–D.

| Product mode | `autonomy` value | Clarifier questions | Spec gate | Plan gate | PR gate |
|--------------|------------------|---------------------|-----------|-----------|---------|
| A Dark       | `auto-all`       | suppressed (tech-only to analyst) | skip | skip | **human** |
| B Dev        | `auto-all`       | surfaced when blocking | skip | skip | **human** |
| C Spec       | `auto-spec`      | surfaced | skip | **human** | **human** |
| D Supervised | `supervised`     | surfaced | **human** | **human** | **human** |

### Mode D — Supervised (default, shipped)

- **Audience:** Early adopters, high-stakes repos, anyone validating the swarm.
- **Auto-approved gates:** none. `human-spec-review` fires
  (`src/missions/cells/intake-phase.ts:107-111`); plan review fires
  (`src/missions/cells/plan-review.ts:40-110`).
- **Clarifier behavior:** all clarifier output is visible. The
  product-clarifier asks the analyst (`clarifier_question` →
  `clarifier_answer`, `src/mail/types.ts:37-38`) and surfaces unresolved
  questions to the operator via the spec.
- **PR review:** human, always (Stage E — the `approvedHeadSha` gate at
  `src/missions/types.ts:272-273`).
- **CLI:** `ha mission start "<intent>"` (no flag → `supervised`,
  `src/commands/mission.ts:142`).
- **Default config:** built-in fallback; nothing to set.

### Mode C — Spec-driven (`auto-spec`)

- **Audience:** Teams that trust the clarifier's spec but want eyes on the
  *plan* (architecture, workstream split) before builders run.
- **Auto-approved gates:** spec only. `evaluateHumanSpecReview` returns
  `approved` immediately (`src/watchdog/gate-evaluators.ts:1004-1006`). Plan
  review still fires.
- **Clarifier behavior:** questions surfaced; the auto-approved spec still
  embeds open questions for the operator to read at the *plan* gate.
- **PR review:** human.
- **CLI:** `ha mission start "<intent>" --autonomy auto-spec`.
- **Default config:** opt-in.

### Mode B — Dev factory (`auto-all`)

- **Audience:** Mature repos where the operator only wants to review the final
  PR — the swarm self-drives spec and plan.
- **Auto-approved gates:** spec **and** plan. (Spec via
  `src/watchdog/gate-evaluators.ts:1004`; plan-skip is the implementation gap
  called out in §10 — the `auto-all` *intent* is documented at
  `src/missions/types.ts:386` but plan-review does not yet read
  `mission.autonomy`.)
- **Clarifier behavior:** questions surfaced **only when blocking** — i.e. the
  clarifier cannot produce a spec without an answer. Non-blocking ambiguities
  are resolved with kura/analyst defaults.
- **PR review:** human.
- **CLI:** `ha mission start "<intent>" --autonomy auto-all` or the ergonomic
  alias `--mode dev-factory` (§9).
- **Default config:** opt-in per project once mature.

### Mode A — Dark factory (`auto-all` + clarifier suppression)

- **Audience:** Highest-throughput, lowest-stakes work (chore sweeps, doc
  refreshes, mechanical refactors) where the operator wants *zero* interaction
  until the PR — or, post-Stage-E, not even then.
- **Auto-approved gates:** spec and plan (same as B).
- **Clarifier behavior:** **user-facing questions suppressed.** Only
  *technical* questions reach the analyst; *business/product* questions are
  resolved by analyst + kura defaults and recorded, never surfaced. This is the
  one behavior that distinguishes A from B and motivates §3.
- **PR review:** human for now (Stage E). Auto-merge is a *future* extension
  gated on Stage E maturity (§5, §8) — not in scope for the first cut.
- **CLI:** `ha mission start "<intent>" --mode dark-factory`.
- **Default config:** opt-in; the riskiest default, reserved for repos with
  proven debug-loop reliability.

## 3. Mode A clarifier filter design

Mode A's defining behavior is suppressing **user-facing** questions while still
letting the clarifier resolve **technical** ones with the analyst. We need to
deterministically separate the two. Today `ClarifierQuestionPayload`
(`src/mail/types.ts:431-436`) carries no audience signal:

```ts
export interface ClarifierQuestionPayload {
	missionId: string;
	question: string;
	context?: string;
}
```

### Option 1 — Tag every question with an `audience` field (recommended)

Add one optional field to `ClarifierQuestionPayload`:

```ts
/** Who must answer: 'tech' → analyst can resolve from code; 'user' → needs human product judgement. */
audience?: "tech" | "user";   // default "tech"
```

- **Routing:** in `auto-all`/dark-factory, the intake flow drops or
  defaults-resolves any `audience: "user"` question and only forwards
  `audience: "tech"` to the analyst. In supervised/auto-spec, both flow through.
- **Impact:** one optional field at `src/mail/types.ts:431`. Backward
  compatible — legacy mail without the field defaults to `"tech"` (analyst
  answerable), which preserves today's behavior. No new mail type, no migration.
- **Cost:** the clarifier prompt must *classify* each question. That judgement
  is the actual risk (a mis-tagged business question silently auto-resolved),
  not the schema.

### Option 2 — Two separate mail types

Split into `clarifier_question_user` and `clarifier_question_analyst`, both
added to the `MailType` union (`src/mail/types.ts:37-38`, literal list at
`src/mail/types.ts:84-85`).

- **Pro:** type-level separation; routing is a `switch` on type, impossible to
  mis-route at the transport layer.
- **Con:** doubles the payload surface, the literal list, the payload map at
  `src/mail/types.ts:613-614`, and every handler that pattern-matches on
  clarifier mail. Two types that are 95% identical is a maintenance tax for a
  one-bit distinction.

### Option 3 — Heuristic at the clarifier prompt level (no schema change)

The product-clarifier (`agents/product-clarifier.md`) decides internally which
questions to ask the analyst vs which to defer to kura defaults, with no field
on the wire.

- **Pro:** zero schema change.
- **Con:** **non-deterministic and unobservable.** The mission record carries
  no trace of which questions were suppressed, so we can't audit Mode A
  decisions or surface "N business questions auto-resolved" in the PR. Fails the
  "operator's last line of defense" test.

### Decision: Option 1

The single `audience` field is the minimum change that is **deterministic**
(routing reads a field, not prose), **auditable** (the suppressed questions are
recorded with their tag), and **backward compatible** (default `"tech"`). The
real risk — the clarifier mis-classifying — is identical across options 1 and 3;
option 1 at least makes the classification visible and reviewable.

## 4. Mode C — does it exist, or fold into B?

### Argument for folding C into B

- The substrate is a *3-value* enum; if we expose A and B both as `auto-all`,
  one could argue C (`auto-spec`) is the awkward middle nobody picks — users
  either want plan review (D) or don't (B).
- Fewer modes = simpler mental model and CLI surface.

### Argument for keeping C distinct (recommended)

- **C maps cleanly to an existing, distinct enum value** (`auto-spec`,
  `src/missions/types.ts:388`). It is not a synthetic mode — the gate skip is
  already implemented and tested (`src/watchdog/gate-evaluators.ts:1004`).
  Folding it away would mean *removing* working behavior.
- **The spec gate and plan gate guard different failure classes.** The spec
  gate catches "we're building the wrong thing"; the plan gate catches "we're
  building the right thing the wrong way" (bad workstream split, missing
  interface). A team can reasonably trust the clarifier's *what* while still
  wanting eyes on the *how*. That is exactly Mode C.
- **Plan review when spec is auto-approved still works.** The plan-review
  subgraph (`src/missions/cells/plan-review.ts:40-110`) runs critics against
  `plan/architecture.md` regardless of how the spec was approved. Auto-spec
  feeds the plan reviewers an unreviewed-by-human spec, but the plan critics
  (architecture/security/performance/devil-advocate) provide an independent
  check, and the operator sees the plan with the auto-approved spec attached.

### Decision: Keep C

C is a real mode backed by a real enum value. Fold-in would delete tested
behavior to save one row in a table. Recommendation: keep `auto-spec` as Mode C,
documented as "trust the spec, review the plan."

## 5. Default mode evolution

Today the built-in default is `supervised` (`src/commands/mission.ts:95`,
`src/missions/lifecycle-start.ts:236`). The question is **when** the default
should advance to `auto-spec` (or further) for a project.

This is a trust decision, and trust should be **earned from signals, not a
calendar**. Proposed switching criterion — advance the project default one notch
(`supervised → auto-spec → auto-all`) only when *all three* signals clear a
threshold over a rolling window (e.g. last 20 missions):

| Signal | Source | Threshold to skip the spec gate | Threshold to skip the plan gate |
|--------|--------|--------------------------------|----------------------------------|
| Tier-classifier rule accuracy | classifier vs operator override rate | ≥ 90% un-overridden | ≥ 95% |
| Debug-loop reliability | Stage C holdout pass-after-fix rate (`src/missions/types.ts:219-227`) | ≥ 80% auto-resolved | ≥ 90% |
| MRP / acceptance coverage | acceptance signals met without human spec edits | ≥ 85% | ≥ 90% |

- **Skip the spec gate (→ auto-spec)** when the clarifier rarely produces specs
  the operator rewrites *and* the tier classifier rarely guesses wrong.
- **Skip the plan gate (→ auto-all)** only when the debug loop additionally
  proves it can recover from bad plans without human intervention — because with
  no plan gate, the debug loop *is* the safety net.

These thresholds are **operator-tunable starting points**, not hard-coded law.
The switching itself should stay **manual** (operator runs
`ha config set mission.defaultAutonomy auto-spec`) until we have the telemetry to
trust an automatic bump — auto-advancing the default is itself an autonomy
increase and deserves the same caution.

## 6. Per-project default

### Option 1 — `.overstory/config.yaml` key (recommended)

Add `mission.defaultAutonomy` to the config schema. Touch points:

- `src/config-types.ts:197` — add to the `mission?` block:
  ```ts
  /** Built-in fallback autonomy when --autonomy is omitted. Default "supervised". */
  defaultAutonomy?: MissionAutonomy;
  ```
- `src/config-schema.ts:106-114` — add `"defaultAutonomy"` to the `mission`
  allow-set so validation accepts it.

```yaml
# .overstory/config.yaml
mission:
  defaultAutonomy: auto-spec
```

### Option 2 — Per-mission only (no project default)

Operators always pass `--autonomy`/`--mode`; omission always means
`supervised`.

- **Pro:** zero config surface; explicit every time.
- **Con:** a mature team that wants `auto-spec` on *every* mission must remember
  the flag every time — exactly the friction modes are meant to remove.

### Decision: Option 1, with this resolution order

```
explicit --autonomy / --mode flag   (highest precedence)
  > mission.defaultAutonomy (project config.yaml)
    > built-in default "supervised"   (lowest)
```

This mirrors the existing flag-over-default pattern already in
`src/commands/mission.ts:142` (`opts.autonomy ?? "supervised"`); the project
default slots in as the middle term:
`opts.autonomy ?? config.mission?.defaultAutonomy ?? "supervised"`.

## 7. Notification UX in autonomous modes

In Modes A/B the operator is not watching gates — so we need a deliberate
"something needs you" signal. Candidates:

### Option 1 — Watchdog "needs operator attention" event hook

The watchdog already escalates stuck human gates (the gate-timeout path noted at
`src/watchdog/gate-evaluators.ts:1018-1020`). Extend it to emit a structured
attention event.

- **Pro:** centralizes attention logic where stuck-detection already lives.
- **Con:** an event with no delivery channel is just a log line; needs one of
  the below to actually reach a human.

### Option 2 — Mail to the operator inbox (recommended MVP)

Send to the `operator` address — already in use: intake-phase mails the operator
on spec-rejection exhaustion (`src/missions/cells/intake-phase.ts:464-469`).

- **Pro:** zero new infrastructure; the mail store + `ha mail` surface already
  exist; the operator sees it on next `ha mail check`. The PR-ready signal and
  any blocking-question escalation both land in one inbox.
- **Con:** pull-based — the operator must check mail. Fine for an MVP where the
  operator is still nearby; insufficient for true unattended Mode A.

### Option 3 — External webhook (Slack/email)

A `mission.notify.webhook` config that POSTs on attention events.

- **Pro:** true push; works when the operator is away from the terminal — the
  only option that makes Mode A genuinely unattended.
- **Con:** new config surface, secret handling (webhook URL is a secret →
  env-var, never committed), retry/failure semantics, and an external
  dependency. Premature before the in-repo signal is solid.

### Decision: Option 2 now, Option 3 later

Ship **mail to the operator inbox** as the MVP attention channel — it reuses the
existing operator address and mail store, and covers both PR-ready and
blocking-question escalations. Layer the **webhook** on later (behind
`mission.notify.webhook`) once Mode A is used enough that pull-based mail is the
bottleneck. The watchdog event (Option 1) is the *producer*; mail then webhook
are successive *delivery channels* — they compose rather than compete.

## 8. Dependencies & phasing

Issue #234 gives a 4-phase rollout. Current state of each prereq:

| Phase | Mode | Gate to ship | Prereq | Current state |
|-------|------|--------------|--------|---------------|
| 1 | D Supervised | Stage A `mission.autonomy` field | Stage A | **DONE** — enum at `src/missions/types.ts:388`, gate skip at `src/watchdog/gate-evaluators.ts:1004`, CLI at `src/commands/mission.ts:93` |
| 2 | C Spec-driven | Stage A stable | spec auto-approve path | **DONE at substrate** — `auto-spec` already skips spec gate; needs only mode docs + CLI alias |
| 3 | B Dev factory | Stage C + D | plan-gate skip reads `autonomy`; debug loop reliable | **PARTIAL** — `auto-all` intent documented (`src/missions/types.ts:386`) but plan-review does not yet read `autonomy` (§10 gap); Stage C debug loop landed (`src/missions/types.ts:219-227`) |
| 4 | A Dark factory | Stage E (PR lifecycle) | clarifier `audience` filter + notification + (future) auto-merge | **BLOCKED** — needs §3 field, §7 notification, and Stage E PR lifecycle (`MissionPrStateRow`, `src/missions/types.ts:264-275`) before auto-merge |

**Critical-path reading:** D and C are effectively shippable today (substrate +
docs). B needs the plan-gate `autonomy` wiring (a small, well-scoped change). A
needs the most net-new work — the clarifier audience tag, the notification
channel, and (for full unattended operation) Stage E auto-merge.

## 9. CLI surface

`--autonomy <supervised|auto-spec|auto-all>` already exists
(`src/commands/mission.ts:93-96`) and stays the **canonical, low-level flag**.

We add an ergonomic **`--mode`** alias that maps product names → autonomy +
mode-specific behavior (the only thing `--mode` adds over `--autonomy` is the
dark-factory clarifier suppression, which `auto-all` alone does not imply):

| `--mode` value | maps to `autonomy` | extra |
|----------------|--------------------|-------|
| `supervised`   | `supervised`       | — |
| `spec-driven`  | `auto-spec`        | — |
| `dev-factory`  | `auto-all`         | clarifier surfaces blocking questions |
| `dark-factory` | `auto-all`         | clarifier suppresses user-facing questions (§3) |

Concrete invocations:

```bash
ha mission start "fix the flaky retry test"                            # D (default)
ha mission start "add a --json flag to ha costs" --mode spec-driven    # C
ha mission start "sweep all deprecated imports" --mode dev-factory     # B
ha mission start "refresh the architecture doc anchors" --mode dark-factory  # A
ha mission start "..." --autonomy auto-spec                            # C, low-level form
```

### Conflict cases

`--mode` and `--autonomy` can disagree (e.g.
`--mode dark-factory --autonomy supervised`). Two resolutions:

- **Option 1 — Error on conflict (recommended).** If both are passed and they
  imply different autonomy levels, exit non-zero with a clear message. Rationale:
  the two flags are redundant; passing contradictory values is almost always a
  mistake, and silently picking one hides the operator's error. This matches the
  existing fail-fast validation at `src/commands/mission.ts:142-150`.
- **Option 2 — `--autonomy` overrides `--mode`.** Treat `--mode` as a preset and
  `--autonomy` as a fine-tune. Rejected: it lets `dark-factory` silently run with
  `supervised` gates, which contradicts the operator's stated intent and is a
  footgun.

`--mode <m>` *without* `--autonomy` is always unambiguous (the table above
resolves it). Only the both-passed-and-disagree case errors.

## 10. Implementation sketch (high-level, no code)

Code areas this proposal would touch, when implemented (NO diffs here):

- **`src/mail/types.ts:431`** — add optional `audience?: "tech" | "user"` to
  `ClarifierQuestionPayload` (§3). Default `"tech"`. No migration (mail payloads
  are JSON, not columns).
- **`src/missions/cells/intake-phase.ts:92-104`** (dispatch-clarifier /
  await-spec region) — in `auto-all`/dark-factory, route `audience: "user"`
  questions to default-resolution instead of surfacing.
- **`src/missions/cells/plan-review.ts:40-110`** — read `mission.autonomy` and
  auto-approve the plan gate when `auto-all`, mirroring the spec-gate skip at
  `src/watchdog/gate-evaluators.ts:1004`. **This is the §8 Phase-3 gap** — the
  `auto-all` intent at `src/missions/types.ts:386` is not yet honored by plan
  review.
- **`src/commands/mission.ts:84-150`** — add the `--mode` option, the mode→
  autonomy mapping table, and the conflict check (§9).
- **`src/config-types.ts:197` + `src/config-schema.ts:106`** — add
  `mission.defaultAutonomy` and the resolution order (§6).
- **`agents/product-clarifier.md`** — instruct the clarifier to tag each
  question's `audience` (prompt work, out of scope for code review but on the
  critical path for Mode A correctness).
- **Notification** — extend the watchdog attention path
  (`src/watchdog/gate-evaluators.ts:1018`) to mail the `operator` address on
  PR-ready / blocking-question events (§7).

**The `mission.autonomy` schema field itself is NOT touched** — it already has
the three values these modes need.

## 11. Open questions (deferred to operator)

1. **A vs B as separate user-facing modes?** Both are `auto-all`; the only
   difference is clarifier suppression + future auto-merge. Is "dark factory"
   worth a distinct mode name now, or do we ship B and add A's suppression as a
   `--suppress-questions` flag on B?
2. **Auto-merge in Mode A:** does "dark factory" *eventually* mean auto-merge
   after Stage E, or is human PR review permanent? This ADR assumes human PR
   review stays for the first cut (§2, §8).
3. **Switching-criterion thresholds (§5):** the 80/90/95% numbers are starting
   points. What window size and exact thresholds does the operator want before
   auto-advancing a project default?
4. **Per-mission audit of suppressed questions:** in Mode A, should the count of
   auto-resolved `audience: "user"` questions be surfaced in the PR description
   as a reviewer aid?
5. **Webhook secret handling (§7):** if/when webhooks land, env-var only, or a
   dedicated secrets mechanism?

## 12. Acceptance signals

Observable end-to-end behaviors per mode (no test code — behaviors a smoke test
would assert):

- **Mode D (`supervised`):** mission halts at `human-spec-review`; `ha mission
  status` shows a pending spec gate; mission does not advance until
  `ha mission spec approve`. Plan gate likewise halts.
- **Mode C (`auto-spec`):** mission advances past the spec gate with **no**
  operator action (gate evaluator returns `approved`,
  `src/watchdog/gate-evaluators.ts:1004-1006`); it then **halts at the plan
  gate**.
- **Mode B (`auto-all`):** mission advances past **both** spec and plan gates
  unattended; it halts only at the PR review gate; blocking clarifier questions
  still surface to the operator inbox when the clarifier cannot proceed.
- **Mode A (`dark-factory`):** same gate flow as B, **plus** no `audience:
  "user"` question ever reaches the operator during intake; the spec records
  that N user-facing questions were auto-resolved; the operator's first
  interaction is the PR review.
- **Default resolution:** with `mission.defaultAutonomy: auto-spec` set and no
  flag, a new mission runs as Mode C; passing `--mode supervised` overrides it
  back to D.
- **Conflict:** `--mode dark-factory --autonomy supervised` exits non-zero with
  a contradiction message; no mission is created.

---

**Safety summary — where is the operator's last line of defense?**

| Mode | Last defense before merge |
|------|---------------------------|
| D | Spec gate, plan gate, **and** PR review — three independent stops |
| C | Plan gate **and** PR review |
| B | **PR review only** — the plan critics (`src/missions/cells/plan-review.ts:40-110`) are the only pre-PR check, and they are agents, not humans |
| A | **PR review only**, and the operator never saw the questions that shaped the spec — the PR diff is the *entire* human checkpoint |

The progression A→D is a progression in trust. In Mode A the PR review is not
one safety net among several — it is the *only* human checkpoint, which is
exactly why this ADR keeps PR review human until Stage E maturity is proven
(§5, §8) and why the clarifier filter must be auditable (§3) rather than a
black box.
