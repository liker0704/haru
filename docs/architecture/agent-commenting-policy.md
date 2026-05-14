# Agent Commenting Policy

**Status**: Active
**Resolves**: liker0704/haru#118 — design: agent commenting policy
**Related**: liker0704/haru#105 — feat: add comment support to TrackerClient

This document defines which agents may post comments on tracker issues, when
those comments are emitted, and the canonical format. It is referenced from
`agents/lead.md`, `agents/reviewer.md`, and `agents/debugger.md`.

The mechanism is `TrackerClient.comment(id, body)` — wired into the three
adapters (seeds, beads, GitHub) and exposed via `ha tracker comment <id> <body>`.
See `src/tracker/types.ts` for the interface.

---

## WHO comments

Comments add running narrative to a tracker issue without closing it. Only
agents with a coordination viewpoint — those that aggregate work across multiple
sub-agents — are allowed to comment. Leaf workers (builders, scouts, testers)
do not comment, because their parent lead already has the full picture and
would either duplicate or contradict the leaf's note.

| Agent | Comments? | What it posts |
|---|---|---|
| **Lead** | YES | Workstream merge events — one comment per successful merge with the SHA. |
| **Reviewer** | YES | One comment per verdict (PASS / FAIL) with a one-line summary. |
| **Debugger** | YES | One comment per `debug_fix_committed` with failure summary and the surgical fix description. |
| **Coordinator** | YES | Phase transitions on mission-level issues (understand → plan → execute → done). |
| **Architect** | OPTIONAL | Design-decision notes when an architecture call changes the spec. |
| **Mission-analyst** | NO | Writes briefs to artifact files, not tracker comments. |
| **Builder** | NO | The lead posts on the builder's behalf at merge time. Builders communicate via mail (`worker_done`). |
| **Scout / Tester / Researcher** | NO | Findings land in spec / artifact files. |
| **Merger** | NO | The lead owns the merge narrative. |
| **Plan-critics** | NO | Plan-review feedback lives in mission artifacts. |

**Rule of thumb**: if you spawned the agent whose work is being narrated, you
comment. If you are the work, you don't.

---

## WHEN to comment

Comments are emitted at well-defined transition points, **never** as ad-hoc
progress chatter (that's what `ha status set` and mail are for).

1. **Lead at workstream merge** — on the `worker_done` → builder→lead path,
   immediately after the coordinator confirms merge and BEFORE `tracker.close()`.
   This means a closed issue's last comment always points at the merge commit.
2. **Reviewer at PASS verdict** — once, when the reviewer's final `result` mail
   is sent to the lead. FAIL verdicts also produce a comment so the audit trail
   shows revision cycles.
3. **Debugger at fix-committed** — once per `debug_fix_committed`, paired with
   `attempts/<N>/test-report.json`. Failed attempts do NOT comment (the engine's
   escalation log captures those).
4. **Coordinator at phase transition** — on `understand → plan`, `plan →
   execute`, `execute → done`. One comment per transition.

---

## WHAT format

Comments are short structured one-liners — humans skim issue timelines, so
brevity matters. The canonical templates:

### Lead (merge)

```
Resolved by <commit-sha> (<short subject>). Tests: <N> pass / <M> fail. Reviewer verdict: <PASS|FAIL|self-verified>.
```

Example:

```
Resolved by 1a2b3c4 (feat(tracker): add comment() method). Tests: 412 pass / 0 fail. Reviewer verdict: PASS.
```

### Reviewer (verdict)

```
Review verdict: <PASS|FAIL>. <one-line summary>. Branch: <branch>.
```

Example:

```
Review verdict: PASS. Diff matches spec; quality gates green. Branch: haru/ws-auth/builder-core.
```

### Debugger (fix-committed)

```
Debug attempt <N>/3: <hypothesis summary>. Fixed: <failure summary>. Commit: <sha>.
```

Example:

```
Debug attempt 2/3: missing null-check on session.user. Fixed: 3 holdout tests for /auth/me. Commit: 9f8e7d6.
```

### Coordinator (phase transition)

```
Phase: <from> → <to>. <one-line context>.
```

---

## WHERE the rules live

This policy file is the source of truth. The three primary agent prompts carry
a small inline pointer (under the completion-protocol section) so the prompt
itself does not drift from policy:

- `agents/lead.md` — points here, includes the merge-comment template.
- `agents/reviewer.md` — points here, includes the verdict template.
- `agents/debugger.md` — points here, includes the fix-committed template.

The other agents (builder, scout, tester, etc.) carry no commenting language —
their prompts state explicitly that comments are not their responsibility.

---

## Known backend gaps

The `TrackerClient.comment()` contract is uniform across adapters, but the
underlying CLIs differ:

- **seeds (`su comment`)** — first-class support since suji v0.2.5. Stored as a
  comments array on the issue, surfaced by `su show`.
- **github (`gh issue comment`)** — first-class support. Renders inline in the
  GitHub web UI.
- **beads (`bd comment`)** — at time of writing, the `bd` CLI does **not**
  ship a `comment` subcommand. The adapter invokes `bd comment` optimistically
  and throws `AgentError` on failure; callers should treat the comment as
  best-effort and fall back to including the same content in the `close`
  reason (a one-shot string the bd backend already supports).

When the beads CLI gains a comment subcommand, no adapter change should be
required — the wrapper already matches the expected invocation shape.

---

## Why a separate command?

`ha tracker comment` (rather than `su comment` or `gh issue comment` directly)
gives agent prompts a single command they can rely on regardless of backend.
The same prompt template ships to seeds projects, beads projects, and GitHub
projects without `{{TRACKER_CLI}}` substitution surprises around argument
ordering.
