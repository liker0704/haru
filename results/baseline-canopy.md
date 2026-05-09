# Baseline — canopy repo (pre-rebrand)

**Captured:** 2026-05-09 by lead-canopy-to-tane-v2  
**Purpose:** Pre-rebrand snapshot used for the COMPARE block in scripts/tane.sh (MED M2)

---

## Git State

| Field | Value |
|-------|-------|
| HEAD | `a4775cc45299df483ab31c0d476c13e782ffffc8` |
| Origin remote | ends in `liker0704/canopy.git` |
| Upstream remote | NOT present (D17-equivalent satisfied) |
| Working tree dirty | D18 carve-out satisfied: modified/untracked paths all under `.overstory/agent-defs/` |

---

## Token Counts

Counted via `grep -rE --exclude-dir=.git --exclude-dir=node_modules` from repo root:

| Token pattern | Scope | Count |
|---------------|-------|-------|
| `\bcanopy\b` (case-insensitive) | all files | **325** |
| `\.canopy/` | all files | **67** |
| `\bcn` | `*.md` only | **188** |
| `@os-eco/canopy-cli` (literal) | all files | **11** |
| `.name("cn")` (literal) | `src/index.ts:31` | **0 (grep)** — see note |

> **Note on `.name("cn")`:** A literal `grep` for `program.name("cn")` returns 0 because the source
> has `program` on one line and `.name("cn")` chained on the next (src/index.ts lines 30–31). The
> conceptual site IS present; scripts/tane.sh step 9 explicitly targets the `.name("cn")` pattern.
> See coverage report acceptance item #3.

### @os-eco/canopy-cli sites (11 total)

| File | Count |
|------|-------|
| README.md | 3 |
| V1_DONE.md | 1 |
| CHANGELOG.md | 1 |
| package.json | 1 |
| src/index.ts | 1 |
| src/commands/upgrade.ts | 1 |
| _(other)_ | 3 |

### Fork-attribution URLs (jayminwest/canopy — preserved, NOT rewritten)

Present in: CLAUDE.md, CONTRIBUTING.md, README.md, package.json (`repository.url`), SECURITY.md, src/commands/onboard.ts

---

## biome.json

Does **NOT** exclude `.canopy/` — no biome.json transform required.

---

## .gitattributes entries (require rewrite → .tane/)

```
.canopy/prompts.jsonl merge=union
.canopy/schemas.jsonl merge=union
```

---

## Quality-Gate Baseline

Recorded by lead prior to branching. Script captures these live via:
```bash
set +e
bun test     > /tmp/tane-baseline-test.log 2>&1; BASELINE_TEST_EXIT=$?
bun run lint > /tmp/tane-baseline-lint.log 2>&1; BASELINE_LINT_EXIT=$?
tsc --noEmit > /tmp/tane-baseline-tsc.log  2>&1; BASELINE_TSC_EXIT=$?
set -e
```

Expected: `test=0 lint=0 tsc=0` (all green before rebrand).

Script aborts with `[ABORT] baseline gates RED` if any baseline exit is non-zero.

---

## COMPARE Block

After all transforms, script step 16 captures post-mod exits and compares:

```
if [ "$POST_TEST_EXIT" -gt "$BASELINE_TEST_EXIT" ] || ...
```

Failure condition: any post-mod exit code GREATER than the corresponding baseline exit code.
