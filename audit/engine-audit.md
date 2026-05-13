# Engine Audit — Findings

**Mission:** engine-audit (mission-1778654620847-engine-audit)
**Scope:** `src/missions/`, `src/watchdog/`, `src/missions/cells/`, `src/merge/`
**Date:** 2026-05-13

## Summary

Six bugs (four high-priority, two medium) and one low-priority improvement filed against `liker0704/haru`. The dominant theme is **silent failure in the lifecycle engine**: the gate evaluator, dispatch cells, and the engine-tick advance path all swallow signals (mail, spawn failures, partial writes) without operator-visible escalation. Two production missions have already stalled because of the gate-timing race (#267); the zombie-recovery gap (#268) silently broke the advertised "auto-resume on mail" contract; the dispatch handlers (#269) and the 50ms spawn probe (#272) hide infrastructure failures from the engine. Crash-window race conditions in #270 (transactionless advance writes) and #271 (handler side-effects before checkpoint) are latent today but likely to surface as the system's load increases. Operator should triage the high-priority cluster first — they share enough overlapping fix surface that a unified refactor of `mission-tick.ts` and `engine.ts performAdvance` could close several at once.

## Filed issues

### Bugs

- [ ] [#267](https://github.com/liker0704/haru/issues/267) — Gate-evaluators drop pre-gate mail (15+ call sites stall on `createdAt >= gateEnteredAt` filter) — `priority:high` — area:graph
- [ ] [#268](https://github.com/liker0704/haru/issues/268) — Watchdog: dead-tmux waiting agents never auto-resume on mail (zombie recovery gap) — `priority:high` — area:agents
- [ ] [#269](https://github.com/liker0704/haru/issues/269) — Cells: dispatch handlers swallow `Bun.spawn` failures and emit `*_dispatched` triggers anyway — `priority:high` — area:graph
- [ ] [#270](https://github.com/liker0704/haru/issues/270) — Engine: `mission.current_node` and `mission_gate_state` writes are not transactional (current_node staleness on crash) — `priority:high` — area:graph
- [ ] [#271](https://github.com/liker0704/haru/issues/271) — Engine: handler side-effects fire BEFORE checkpoint write — replay duplicates spawns/mail on crash — `priority:medium` — area:graph
- [ ] [#272](https://github.com/liker0704/haru/issues/272) — `spawnEphemeralAgent`: 50ms exit-code probe is wrong for both fast and slow spawns — `priority:medium` — area:graph

### Improvements

- [ ] [#273](https://github.com/liker0704/haru/issues/273) — Long-running watchdog daemon caches old workstreamId logic — restart needed after PR #256 — `priority:low` — area:observability

## Themes / cross-cutting observations

- **No shared mail-since-event helper.** Every gate evaluator inlines the same `m.createdAt >= gateEnteredAt` filter; the two intentional debug-loop exceptions (`evaluateAwaitDebugBriefReady`, `evaluateAwaitDebugFix`) already model the better `dispatchedAt` pattern. A unified helper would close #267 in one place rather than at 15+ call sites.
- **Transactionality gaps between `missions` and `mission_gate_state` writes.** `MissionStore.transaction(fn)` exists at `src/missions/store.ts:1366-1368` but is never used by any of the three advance paths in `mission-tick.ts` or by `engine.ts performAdvance`. Each advance is 3-4 separate `UPDATE`/`INSERT` statements across two tables. #270 closes the SQL side; #271 closes the handler-side replay risk. They share one fix surface.
- **Side effects precede commit.** Every dispatch handler in `cells/` produces external side effects (`Bun.spawn`, mail send) before the engine writes the transition checkpoint. Combined with non-transactional advance writes, this means a process kill in mid-tick produces *both* duplicate side effects on replay and inconsistent on-disk state — a worst-of-both outcome. #271 + #270 should be reasoned about together.
- **Silent failure pattern.** Three classes of silent failure landed in this audit: pre-gate mail dropping (#267), `Bun.spawn` swallowing (#269 + #272), and dead-tmux waiting agents (#268). All three share a structural problem: the engine has no concept of "expected signal didn't arrive within a meaningful window" → "escalate to operator". The grace-period nudge ceiling at `mission-tick.ts:653-712` is the closest existing primitive but only fires on the 1-hour timeout, well past the point of operator confusion.
- **Daemon module-cache lifecycle.** `ha watch` is a long-lived process that imports gate evaluators once at startup. Source-tree changes don't take effect until restart. #273 is the operator-cited symptom, but the structural problem (no daemon-vs-source-tree freshness signal) applies to every code change, not just PR #256.
