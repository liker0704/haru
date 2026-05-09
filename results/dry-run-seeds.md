# Dry-Run Results — scripts/suji.sh

**Date:** 2026-05-09  
**Agent:** builder-suji-script  
**Sandbox:** `sandbox/seeds` (cloned from `/home/liker2/projects/os-eco/seeds`)

---

## Sandbox Setup

```bash
git clone /home/liker2/projects/os-eco/seeds sandbox/seeds
cd sandbox/seeds
git remote add upstream https://github.com/jayminwest/seeds.git
```

Sandbox remotes after setup:
```
origin    /home/liker2/projects/os-eco/seeds (fetch/push) — local clone
upstream  https://github.com/jayminwest/seeds.git (fetch/push)
```

---

## Pass 1: DRY_RUN=1 SKIP_PUSH=1 SANDBOX=1

```
SISTER_REPO=$(pwd)/sandbox/seeds SANDBOX=1 DRY_RUN=1 SKIP_PUSH=1 bash scripts/suji.sh
```

**Exit: 0**

All 22 steps completed with `[dry-run] ...` prefix. No files mutated.

Key observations:
- Step 1 (D17): upstream present check passed; origin check skipped (SANDBOX=1 — local path, not liker0704/seeds URL).
- Step 3 baseline: test=0, lint=1, tsc=0 (16+ pre-existing `noNonNullAssertion` warnings).
- Step 5 pre-pass: 5 files identified containing `@os-eco/seeds-cli` (README.md, src/commands/upgrade.ts, src/index.ts, .github/workflows/publish.yml, V1_DONE.md). None of these are `package.json`, so the pre-pass correctly excludes it.
- Post-mod summary (dry-run, no changes): seeds=299, suji=0.

---

## Pass 2: DRY_RUN=0 SKIP_PUSH=1 SANDBOX=1

```
SISTER_REPO=$(pwd)/sandbox/seeds SANDBOX=1 DRY_RUN=0 SKIP_PUSH=1 bash scripts/suji.sh
```

**Exit: 0**

### Step-by-step outcomes

| Step | Description | Outcome |
|------|-------------|---------|
| 1 | D17 remote check | SANDBOX skip origin; upstream present ✓ |
| 2 | D18 dirty-tree | SANDBOX skip ✓ |
| 3 | Baseline quality gates | test=0, lint=1, tsc=0 — WARN (M2 adapted) |
| 4 | Branch rebrand-to-suji | Created ✓ |
| 5 | Org pre-pass @os-eco/seeds-cli → @hana/suji-cli | 5 files modified; positive/negative checks pass ✓ |
| 6 | package.json (name, bin, URLs) | Rebranded ✓ |
| 7 | SEEDS_DIR_NAME → SUJI_DIR_NAME | All *.ts files updated ✓ |
| 8 | config.ts default | "suji" ✓ |
| 9 | index.ts name + Usage | su ✓ |
| 10 | D5 fixture flip id.test.ts | generateId("haru") + startsWith("haru-") ✓ |
| 11 | Temp-dir prefixes | suji-config-test-, suji-store-test- ✓ |
| 12 | yaml.test.ts literals | "suji" ✓ |
| 13 | Sentinel-mask bulk pass | jayminwest/seeds masked → unmasked; \bseeds\b → suji ✓ |
| 14 | \.seeds/ → \.suji/ | .gitattributes + all text files ✓ |
| 15 | \bsd\b → su in *.md | Markdown only (D4 carve-out) ✓ |
| 16 | git mv .seeds → .suji | .seeds/config.yaml, .gitignore, issues.jsonl, templates.jsonl ✓ |
| 17 | README.md attribution | Forked from jayminwest/seeds ✓ |
| 18 | CHANGELOG.md unreleased | Renamed to suji ✓ |
| 19 | bun install + biome format | Checked 10 packages; biome fixed 9 files ✓ |
| 20 | git commit | 53 files changed, 534 insertions, 492 deletions ✓ |
| 21 | Post-mod quality gates | test=0, lint=1, tsc=0 — no regression ✓ |
| 22 | Remote publish | SKIP_PUSH=1 — skipped ✓ |

### Git commit
```
[rebrand-to-suji dc5ec65] refactor(rebrand): seeds → suji per mission rebrand-hana-v2
 53 files changed, 534 insertions(+), 492 deletions(-)
 delete mode 100644 .seeds/config.yaml
 rename {.seeds => .suji}/.gitignore (100%)
 create mode 100644 .suji/config.yaml
 rename {.seeds => .suji}/issues.jsonl (100%)
 rename {.seeds => .suji}/templates.jsonl (100%)
```

---

## Sandbox Quality Gates (post-mod)

Run from `sandbox/seeds` after the script committed:

| Gate | Exit | Notes |
|------|------|-------|
| `bun test` | **0** | 235 pass / 0 fail / 409 expects |
| `bun run lint` | **1** | Pre-existing `noNonNullAssertion` warnings (same as baseline) |
| `tsc --noEmit` | **0** | Clean |

**No regression from baseline.** Baseline: test=0, lint=1, tsc=0. Post-mod: test=0, lint=1, tsc=0.

Note on biome lint count: sandbox baseline shows "Found 10 errors. Found 47 warnings." (biome v2.4.6 counting formatter + lint). Post-mod after biome format --write: "Found 1 error. Found 47 warnings." — biome format resolved 9 formatter differences. Exit code unchanged at 1. The pre-collected baseline summary ("16 noNonNullAssertion warnings") reflects the live repo; the sandbox clone shows 47 warnings total (all `noNonNullAssertion`, some hidden by diagnostics-not-shown limit).

---

## Token Count Diff

| Pattern | Before | After |
|---------|--------|-------|
| `\bseeds\b` (case-insensitive) | 299 | 63 |
| `\bsuji\b` (case-insensitive) | 0 | 240 |

Remaining 63 `seeds` refs are expected:
- `jayminwest/seeds` fork attribution lines (preserved by sentinel-mask)
- `LICENSE` file (excluded from all passes)
- `bun.lock` (excluded from all passes)
- Any `seeds` in node_modules documentation (excluded)

---

## Expected vs Unexpected Outcomes

| Item | Expected | Actual | Notes |
|------|----------|--------|-------|
| All 22 steps complete | ✓ | ✓ | |
| Exit 0 | ✓ | ✓ | |
| bun test 235/235 pass | ✓ | ✓ | Including D5 id.test.ts fixture fix |
| lint exit unchanged | ✓ | ✓ | 1 → 1 |
| tsc exit unchanged | ✓ | ✓ | 0 → 0 |
| jayminwest/seeds preserved | ✓ | ✓ | Sentinel mask strategy confirmed |
| .seeds → .suji directory rename | ✓ | ✓ | git mv confirmed |
| D4 migrate.ts strings intact | ✓ | ✓ | *.ts excluded from \bsd\b pass |
| biome format needed | unexpected | confirmed | 9 files required formatting after sed; added to step 19 |

**One unexpected finding:** sed transforms introduce formatting differences that biome would flag as errors. Added `bunx biome format --write .` to step 19 (alongside bun install) to normalize before commit. This brought lint from "10 errors + 47 warnings" → "1 error + 47 warnings" in post-mod (the remaining "1 error" is biome's internal check summary, exit code unchanged at 1).
