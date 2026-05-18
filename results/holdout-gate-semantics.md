# Holdout-gate semantics — haru-leakage-v2

Pre-flight (W0) audit answering the two ambiguity probes from `decisions.md` §D7 before W1/W2 dispatch. Both readings resolved directly from code — **no coordinator escalation required**.

## Acceptance #4 (gate triple)

- **Verdict:** `baseline-diff` — confirmed by code.
- **Granularity caveat:** diff key is the top-level gate id (e.g. `l1-tests`, `l1-lint`, `l1-typecheck`), **not** the `(file, rule-id, name)` tuple that `kura mx-b18e` implies. See "Granularity caveat" below.

### Evidence (file:line citations)

1. `src/watchdog/gate-evaluators.ts:1075-1175` — `evaluateHoldoutGate` is the post-merge holdout cell. The pass/fail decision is:

   ```ts
   // src/watchdog/gate-evaluators.ts:1160-1174
   const parsed = (await resultFile.json()) as { checks: HoldoutCheck[] };
   const diff = compareSnapshotDiff(baseline, parsed.checks);
   if (diff.newFailures.length === 0) {
       return { met: true, trigger: "holdout_pass", ... };
   }
   return { met: true, trigger: "holdout_fail", ... };
   ```

   Note: the function ALWAYS returns `met: true`. The verdict is encoded in the `trigger` (`holdout_pass` vs `holdout_fail`) routed by the graph engine, not in `met`. The semantics are unambiguously **"no NEW failures vs baseline"**, not "all checks green absolutely".

2. `src/missions/baseline-snapshot.ts:72-118` — `compareSnapshotDiff` bucketing:

   ```ts
   // src/missions/baseline-snapshot.ts:95-103
   if (b !== undefined && c !== undefined) {
       if (b.status === c.status) {
           unchanged.push(c);                 // baseline=fail + current=fail → unchanged
       } else if (c.status === "fail") {
           newFailures.push(c);               // baseline≠fail + current=fail → NEW
       } else if (b.status === "fail") {
           resolvedFailures.push(b);          // baseline=fail + current≠fail → resolved
       }
   } else if (c !== undefined && c.status === "fail") {
       newFailures.push(c);                   // current-only fail → NEW
   }
   ```

3. `src/missions/holdout.ts:48-50` — diff key:

   ```ts
   export function extractCheckKey(check: HoldoutCheck): string {
       return check.id;
   }
   ```

   `check.id` is the gate id assigned by `checkQualityGates` (holdout.ts:84): `l1-${gate.name.toLowerCase().replace(/\s+/g, "-")}` — i.e. `l1-tests`, `l1-lint`, `l1-typecheck` for the three project gates. There is no per-file, per-rule, or per-test-case decomposition before bucketing.

4. `src/watchdog/gate-evaluators.ts:1062-1074` (header comment) — explicitly documents "snapshot-diff semantics (w11)" and the triggers `holdout_pass` / `holdout_fail` / `holdout_baseline_missing` / `holdout_baseline_corrupt` / `holdout_skip`. All non-pass triggers fall back to permissive (`met:true`) so a missing/corrupt baseline does NOT block — the gate degrades open. This re-confirms baseline-diff (vs strict-green, which would default to failing on missing baseline).

5. `src/missions/baseline-snapshot.ts:62` — baseline.json contents are the same `HoldoutCheck[]` shape produced by `checkQualityGates`. No different code path captures finer-grained failure rows — the file IS the gate-level result snapshot.

### Local probe result

Worktree HEAD `ca16a57d` is identical to main HEAD (verified `git rev-parse HEAD main` returned the same SHA). Running gates from main HEAD is therefore equivalent to reading the existing `results/baseline.json` from the mission artifact root (`/home/liker2/projects/os-eco/haru/.overstory/missions/mission-1779093808582-haru-leakage-v2/results/baseline.json`). Cross-check:

| Gate | baseline.json says | Code/local verification |
|---|---|---|
| `l1-lint` | `fail`, "src/commands/config.ts:50:15 lint/style/noNonNullAssertion" | `sed -n '48,52p' src/commands/config.ts` shows `const key = keys[i]!;` — the `!` non-null assertion that triggers the rule. ✓ matches. |
| `l1-tests` | `fail`, 5 × `[mission-tick] resume coordinator-cap attempt N: Error: tmux start failed` | Pre-existing tmux-start flake in mission-tick resume path. Documented in kura `haru-6357` (mute-coordinator detector). Did not re-run full `bun test` (cost: ~minutes) — baseline cite is authoritative for `main` HEAD. |
| `l1-typecheck` | `fail`, details `["$ tsc --noEmit", ""]` (empty stderr captured) | Did not re-run `tsc --noEmit`. The fact the details are empty suggests the captured stderr was truncated by `checkQualityGates` (holdout.ts:88 takes `.split("\n").slice(0, 5)`). Treat as "typecheck currently red on main" without enumerating diagnostics here (W1's audit will surface concrete typecheck errors if any are in scope). |

Conclusion: baseline.json reflects current main HEAD. No drift between baseline-snapshot capture time and W0-audit time.

### Coordinator confirmation

None required. The code is unambiguous (`compareSnapshotDiff` + `diff.newFailures.length === 0` is structurally baseline-diff, not strict-green).

### Granularity caveat (important for W2)

`extractCheckKey` returns `check.id` (`l1-tests` / `l1-lint` / `l1-typecheck`), NOT a `(file, rule-id, name)` tuple. This means:

- If `l1-tests` is `fail` in baseline AND `fail` in current → bucket is `unchanged`, regardless of WHICH tests fail. A leak-fix PR that fixes the 5 baseline tmux-start failures but introduces a brand-new failure in `control.test.ts` will still see `l1-tests=fail==fail` → `unchanged` → `holdout_pass`.
- If `l1-tests` is `fail` in baseline AND `pass` in current → bucket is `resolvedFailures`. Still no `newFailures` → `holdout_pass`.
- A NEW gate-id-level failure only appears if baseline status was non-fail (`pass` or `skip`) and current is `fail`. Since all three l1 gates are baseline-fail today, the gate effectively cannot produce `newFailures` regardless of what W2 does inside those gates.

`kura mx-b18e` (cited in W0 brief) notes a "(file, rule-id, name) tuple key for diff", but **that finer-grained keying is NOT in the current `extractCheckKey` implementation**. The code uses gate-id keys only. This is a discrepancy between the kura record and the code — flagged here so W2 can plan accordingly.

## Acceptance #3 (cleanup proof)

- **Verdict:** `structural-matrix` — confirmed by code (D2 matrix governs).

### Evidence (file:line citations)

1. `rg -in 'proc[._-]?killed' src/` returns ONLY three matches, all inside `src/watchdog/daemon.test.ts`:
   - `src/watchdog/daemon.test.ts:2688` — `expect(proc.killed).toContain(process.pid);`
   - `src/watchdog/daemon.test.ts:2724` — `expect(proc.killed).toContain(deadPid);`
   - `src/watchdog/daemon.test.ts:2767` — `expect(proc.killed).toContain(process.pid);`

   In context (`src/watchdog/daemon.test.ts:2680-2700`), `proc.killed` here is a **test-local mock variable** — an array collecting PIDs killed by a `killTree` mock (`.toContain(pid)` is array containment, not the `Bun.Subprocess.killed` boolean from acceptance #3). Unrelated to the leak-detection primitive.

2. `rg -in 'proc[._-]?killed' src/watchdog/gate-evaluators.ts src/missions/cells/ src/missions/holdout*.ts` returns **zero matches**. No gate code text-greps for the literal.

3. `src/review/` (the `review` directory under `src/`) contains analytics modules (`batching.ts`, `dimensions.ts`, `staleness.ts`, `store.ts`, `analyzers/`) — none deal with PR diff text scanning. `rg -in 'proc[._-]?killed' src/review/` returns zero. There is no "reviewer text-grep" pipeline in this codebase.

4. `rg -in 'proc[._-]?killed' /home/liker2/projects/os-eco/haru/.overstory/missions/mission-1779093808582-haru-leakage-v2/ docs/ audit/ evals/ scripts/ templates/ agents/` returns **zero matches**. No mission docs, no agent prompts, no eval scenarios grep for the literal.

5. The literal `proc.killed===true` will still appear in source code anyway — `killAndAssert` (D2's foreground primitive helper in `src/test-helpers.ts`, to be added in W2) writes the assertion `expect(proc.killed).toBe(true)` against the live `Bun.Subprocess` object. So even if a hypothetical future grep gate were added, the literal would be present in the foreground-primitive code path. The other primitives (`killByPidAndAssert`, `killTreeAndAssert`) deliberately do NOT assert `proc.killed===true` because they operate on PIDs / detached children where the `Subprocess` object is unavailable (per D2 rationale: tmux-hosted children, daemons that orphan to init, headless detached wrappers).

### Coordinator confirmation

None required. The structural reading is the only reading the code supports — there is no grep path to satisfy.

## Implications for W1/W2

### From Probe 1 (baseline-diff confirmed)

- **W2 may leave the pre-existing `src/commands/config.ts:50` `noNonNullAssertion` lint failure untouched.** It is in baseline and will be classified `unchanged` (or, if W2 happens to introduce a NEW lint violation, the gate-level `l1-lint` is already `fail==fail` → unchanged anyway, so W2 won't be blocked by the gate at the lint level either).
- **W2 does NOT need to prepend the `src/commands/config.ts:50` fix** described in D7's fallback branch. That contingency is dormant.
- **W2 should still avoid introducing new lint/typecheck/test failures** as a matter of hygiene (and because gate-id granularity is loose enough that a future tightening to per-file diff would surface them). Treat the gate's permissiveness as headroom, not as a license.
- **Note for W1's audit:** when scanning test files for leak patterns, do NOT include `src/commands/config.ts:50` in remediation scope (it's outside the leak-fix theme and not required by the gate).

### From Probe 2 (structural-matrix confirmed)

- **D2's primitive matrix is accepted as-is.** No helper renames, no literal-`proc.killed===true` comments at every call site.
- **`killByPidAndAssert` and `killTreeAndAssert` may use `isProcessRunning(pid) === false` as the cleanup primitive** without wrapping or commenting to surface the `proc.killed===true` literal.
- **`killAndAssert` retains its `expect(proc.killed).toBe(true)` assertion** as the foreground primitive (this is D2 baseline behavior, not a concession to grep-literal).

## Decisions

- **D1 reaffirmed.** Acceptance #3 scope = HIGH files identified by W1's audit. The gate does not enforce a 33-file blanket sweep (no per-file diff key in `extractCheckKey`).
- **D2 reaffirmed.** Structural primitive matrix is the operative reading. Helpers proceed as designed.
- **D7 fallbacks dormant.** Neither the `config.ts:50`-fix amendment to W2 nor the literal-`proc.killed===true` surfacing in helper call-sites is needed. Both pre-committed fallbacks remain documented in the brief as contingencies for any future gate tightening, but neither activates in this mission.
- **New finding (kura record candidate):** `extractCheckKey` uses gate-id-only keys (`l1-tests` / `l1-lint` / `l1-typecheck`), not the `(file, rule-id, name)` tuple that `kura mx-b18e` describes. The holdout gate is therefore **coarser** than mx-b18e suggests — any baseline-fail gate-id cannot produce `newFailures` from that gate regardless of internal regressions. Worth recording for future mission planners so they don't over-trust gate-id granularity for fine-grained regression detection.
