# Baseline — Seeds Repo (pre-rebrand)

**Recorded by:** lead-seeds-to-suji-v2 (pre-collected) + builder-suji-script (confirmed)
**Date:** 2026-05-09

---

## Git State

| Field | Value |
|---|---|
| HEAD | `a084963942a6ef607d161006784bafea95c566e5` |
| Branch | `main` |
| Working tree | 10 modified + 23 untracked — ALL under `.overstory/` |

### Modified files
```
 M .overstory/README.md
 M .overstory/agent-defs/builder.md
 M .overstory/agent-defs/coordinator.md
 M .overstory/agent-defs/lead.md
 M .overstory/agent-defs/merger.md
 M .overstory/agent-defs/monitor.md
 M .overstory/agent-defs/reviewer.md
 M .overstory/agent-defs/scout.md
 M .overstory/agent-manifest.json
 M .overstory/hooks.json
```

### Untracked files (23 .overstory/agent-defs/ additions)
```
?? .overstory/agent-defs/architect.md
?? .overstory/agent-defs/architecture-review-lead.md
?? .overstory/agent-defs/architecture-sync.md
?? .overstory/agent-defs/coordinator-mission-assess.md
?? .overstory/agent-defs/coordinator-mission-direct.md
?? .overstory/agent-defs/coordinator-mission-full.md
?? .overstory/agent-defs/coordinator-mission-planned.md
?? .overstory/agent-defs/execution-director.md
?? .overstory/agent-defs/lead-mission.md
?? .overstory/agent-defs/mission-analyst-planned.md
?? .overstory/agent-defs/mission-analyst.md
?? .overstory/agent-defs/orchestrator.md
?? .overstory/agent-defs/ov-co-creation.md
?? .overstory/agent-defs/plan-architecture-critic.md
?? .overstory/agent-defs/plan-devil-advocate.md
?? .overstory/agent-defs/plan-performance-critic.md
?? .overstory/agent-defs/plan-review-lead.md
?? .overstory/agent-defs/plan-second-opinion.md
?? .overstory/agent-defs/plan-security-critic.md
?? .overstory/agent-defs/plan-simulator.md
?? .overstory/agent-defs/research-lead.md
?? .overstory/agent-defs/researcher.md
?? .overstory/agent-defs/tester.md
```

---

## Remotes (D17 critical context)

```
origin    git@github.com:liker0704/seeds.git (fetch/push)
upstream  https://github.com/jayminwest/seeds.git (fetch/push)
```

**Risk:** BOTH remotes configured. Script MUST guard against accidental push to upstream (jayminwest/seeds). D17 rail is non-negotiable.

---

## Token Counts

| Pattern | Count | Notes |
|---|---|---|
| `\bseeds\b` (case-insensitive, all files) | 299 | Excludes .git/node_modules |
| `\bseeds\b` (TS only) | 118 | src/ *.ts files |
| `\.seeds/` | 59 | Path references |
| `\bsd ` (markdown) | 187 | CLI command examples in *.md |
| `@os-eco/seeds-cli` | 9 | Org-qualified package name |
| `\bSEEDS_DIR_NAME\b` | 11 | Constant definition + refs |

---

## Quality-Gate Baseline

| Gate | Exit Code | Notes |
|---|---|---|
| `bun test` | 0 | 235 tests / 18 files / 409 expects — all pass |
| `bun run lint` | 1 | PRE-EXISTING — 16 `noNonNullAssertion` warnings in `src/commands/{block,close,...}.ts` — NOT rebrand-induced |
| `tsc --noEmit` | 0 | Clean |

**M2 Adaptation:** Seeds baseline lint exit is 1 (pre-existing). The script uses WARN-on-baseline-RED and only aborts if POST exit code exceeds BASELINE (regression check). Strict-zero semantics do not apply here.

---

## Key Source Locations

| File | What to Change | Script Step |
|---|---|---|
| `src/types.ts` | `SEEDS_DIR_NAME → SUJI_DIR_NAME` constant | Step 7 |
| `src/config.ts` | `data.project ?? "seeds"` → `"suji"` | Step 8 |
| `src/index.ts` | `program.name("sd")`, `Usage: sd <command>` | Step 9 |
| `src/id.test.ts` | `generateId("overstory")` → `generateId("haru")` | Step 10 (D5) |
| `src/config.test.ts` | `seeds-config-test-` prefix | Step 11 |
| `src/store.test.ts` | `seeds-store-test-` prefix, `.seeds` path | Steps 11, 14 |
| `src/yaml.test.ts` | `"seeds"` project literals | Step 12 |
| `package.json` | name, bin, URLs | Steps 5, 6 |
| `.gitattributes` | `.seeds/issues.jsonl`, `.seeds/templates.jsonl` | Steps 13, 14 |
| `*.md` | `\bsd\b` CLI examples | Step 15 |
