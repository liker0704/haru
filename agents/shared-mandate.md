## mandatory-waiting-protocol

If you dispatch work to another agent (via `ha sling`, `ha mail send --type dispatch`, or any other mechanism) and need to wait for their response:

1. **Stop processing.** Do not continue, do not poll mail, do not call any more tools.
2. **You will be woken automatically** via tmux nudge when mail arrives in your inbox.
3. State transitions are fully automatic: session-end sets `waiting`, tool-start sets `working`.

**This is MANDATORY.** If you poll mail in a loop instead of stopping, you waste tokens. Stop and let the system wake you.

### failure-modes

- **MAIL_POLLING** -- Calling `ha mail check` in a loop while waiting for sub-agent results. This wastes tokens. Stop instead. You will be woken by tmux nudge.

## Filing follow-up issues

When filing a follow-up issue for work spawned by this mission, link it to
the parent mission's tracker issue with `--blockedBy "${HARU_MISSION_TASK_ID}"`.

Always quote `"${HARU_MISSION_TASK_ID}"` in shell commands — leave shell
expansion to the runtime, do not hard-code or substitute literal IDs.

If `HARU_MISSION_TASK_ID` is unset (mission has no auto-linked tracker
issue, OR you are an intake-phase agent spawned BEFORE the issue is
created, OR the mission is running standalone), OMIT the flag — do NOT
fabricate or guess an id.

Example using the safe shell pattern (emits the flag only when set):

```bash
{{TRACKER_CLI}} create --title "Follow-up: ..." --type task \
  ${HARU_MISSION_TASK_ID:+--blockedBy "$HARU_MISSION_TASK_ID"}
```

**Temporal availability:** agents spawned during the intake phase (analyst,
clarifier, tier-classifier) typically see `HARU_MISSION_TASK_ID` UNSET
because the parent issue is created later in the phase. Agents spawned for
execute/PR/done phases see it set. The `${VAR:+...}` defensive pattern
above covers both cases.

## debug-brief-protocol

Applies when you receive mail with `--type debug_brief_request` (Stage C/E debug-loop). The request payload (`DebugBriefRequestPayload`) is a **discriminated union on `failureSource`** — either `'holdout'` (post-merge integration gate failure) or `'ci'` (PR CI check failure). Your job is to package a `debug-brief.md` for the debugger so it can apply a surgical fix without re-deriving the whole mission context.

**Recipient:** mission-analyst variants ONLY (intake / planned / full). Builders, scouts, leads, and other agents inherit this protocol via shared-mandate injection but **must not act on `debug_brief_request` mail** — if you receive one and your role is not `mission-analyst-*`, reply to the sender with `--type error` and the body "Routing error: debug_brief_request should target mission-analyst, not <your-role>". Do not write a brief.

### workflow

1. **Read the payload — discriminate on `failureSource`:**
   - For `failureSource === 'holdout'`: read `failedGates: HoldoutCheck[]` (id/level/name/status/message), `integrationBranch`, `integrationSha`, `attemptN`, `debuggerName`.
   - For `failureSource === 'ci'`: read `failedChecks: GhCheck[]` (name/status/conclusion/durationMs), `prNumber`, `prHeadSha`, `attemptN`, `debuggerName`.

2. **Read mission artifacts** that you already authored:
   - `product-spec.md` (Intent / Goal / Non-goals / Acceptance criteria)
   - `plan/architecture.md`, `plan/workstreams.json` (what was supposed to be built)
   - `research/_summary.md` (domain context)

3. **Inspect recent diffs:**
   - For `holdout`: `git log <integrationSha>~5..<integrationSha>` and `git diff` for files referenced in failed gate output.
   - For `ci`: `git log <prHeadSha>~5..<prHeadSha>` and `gh pr view <prNumber> --json commits` for recent context.
   - Identify which workstream most likely introduced the regression (map commit authors / branch names → workstream ids).

4. **Hypothesize 2–4 root causes**, ranked by confidence. Cite specific spec sections or diff lines as evidence. Honest "unknown / needs investigation" is better than guesses.

5. **Write `debug/debug-brief.md`** (path from `MissionArtifactPaths.debugBriefMd`). Template:

   For `failureSource === 'holdout'`:
   ```markdown
   # Debug Brief — attempt N
   ## Failed gates
   <quote failedGates output, scoped excerpts>
   ## Scope
   integrationBranch: <name>
   integrationSha: <sha>
   ## Recent changes
   <scoped diff: file ranges that match failed test paths>
   ## Suspected workstream(s)
   <id + rationale>
   ## Hypotheses
   1. <hypothesis> — confidence: high|med|low — evidence: <cite>
   2. ...
   ## Spec context
   <excerpt from product-spec.md acceptance criteria touching the failing area>
   ```

   For `failureSource === 'ci'`:
   ```markdown
   # Debug Brief — attempt N (CI failure)
   ## Failed CI checks
   <quote failedChecks names, conclusions, durationMs>
   ## Scope
   prNumber: <N>
   prHeadSha: <sha>
   ## Recent changes
   <scoped diff from git log <prHeadSha>~5..<prHeadSha>>
   ## Suspected workstream(s)
   <id + rationale>
   ## Hypotheses
   1. <hypothesis> — confidence: high|med|low — evidence: <cite>
   2. ...
   ## Spec context
   <excerpt from product-spec.md acceptance criteria touching the failing area>
   ```

6. **Send `debug_brief_ready` mail** to the debugger. The payload includes `debuggerName` — use that exact address:
   ```bash
   ha mail send --to <payload.debuggerName> --subject "Debug brief ready (attempt N)" \
     --type debug_brief_ready --payload '{"briefPath":"...","suggestedRootCauses":[...],"attemptN":N}'
   ```

7. Stay alive — you may receive another `debug_brief_request` if a subsequent attempt fails with different gates or checks.

### constraints

- Do **not** propose code changes in the brief. That's the debugger's job. Your output is diagnosis only.
- Do **not** spawn scouts for this work. You already have the mission's knowledge from intake/plan phases.
- If you genuinely lack context (e.g., gates fail on code outside your mission's scope — like a flaky integration test), say so explicitly in Hypotheses with confidence "low" and recommend escalation.
- Brief should be tight: aim for under 300 lines. The debugger will read it in full each iteration.

### failure-modes

- **STALE_BRIEF** — Writing a brief based on outdated mission knowledge (e.g., not re-reading recent merges). Always `git log` to see what landed since you last touched the mission.
- **OVER_HYPOTHESIZING** — Listing 10 hypotheses dilutes signal. Cap at 4. Rank by confidence.
- **CODE_PROPOSAL** — Including patch snippets or "do this:" instructions. Not your role.
- **NO_BRIEF_MAIL** — Writing the file but forgetting to send `debug_brief_ready`. The debugger won't poll the filesystem — mail is the wake signal.
