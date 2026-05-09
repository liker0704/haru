# Coverage Report — canopy → tane

**Script:** scripts/tane.sh (16 steps)  
**Baseline token counts:** see results/baseline-canopy.md

---

## Token-Site → Script-Step Mapping

### 1. `.name("cn")` at src/index.ts:31

**Brief note:** The brief refers to this as `program.name("cn")`, but the source has `program` on
line 30 and `.name("cn")` chained on line 31. `grep -F 'program.name("cn")'` returns 0 — the
conceptual call IS present; the literal pattern does not span one line.

| Site | Script Step |
|------|-------------|
| `.name("cn")` at `src/index.ts:31` | **Step 9** — explicit `sed -i 's/\.name("cn")/\.name("ta")/g' src/index.ts` |
| `cn` command in *.md documentation | **Step 13** — bulk `\bcn\b → ta` in *.md |

**Acceptance check #3 satisfied:** step 9 explicitly targets `src/index.ts` for the `.name("cn")`
→ `.name("ta")` transform. Step 13 handles the 188 documentation sites.

---

### 2. `palette.brand(chalk.bold("canopy"))` at src/index.ts:43

| Site | Script Step |
|------|-------------|
| `palette.brand(chalk.bold("canopy"))` at `src/index.ts:43` | **Step 9** — explicit `sed -i 's/palette\.brand(chalk\.bold("canopy"))/palette.brand(chalk.bold("tane"))/g' src/index.ts` |
| All other `canopy` occurrences in src/index.ts | **Step 11** — bulk `\bcanopy\b → tane` sweep |

---

### 3. `@os-eco/canopy-cli` — 11 sites (org-qualified pre-pass)

**Handled by Step 6 (pre-pass) — runs BEFORE the bulk word-boundary sweep to prevent corruption.**

If the bulk sweep ran first, `@os-eco/canopy-cli` would become `@os-eco/tane-cli` (corrupted org
name). The pre-pass rewrites `@os-eco/canopy-cli` → `@hana/tane-cli` first.

| File | Sites | Step |
|------|-------|------|
| README.md | 3 | Step 6 (pre-pass) |
| V1_DONE.md | 1 | Step 6 (pre-pass) |
| CHANGELOG.md | 1 | Step 6 (pre-pass) |
| package.json | 1 | Step 6 (pre-pass) |
| src/index.ts | 1 | Step 6 (pre-pass) |
| src/commands/upgrade.ts | 1 | Step 6 (pre-pass) |
| other files | 3 | Step 6 (pre-pass) |

**Acceptance (Step 7 — integrity checks):**
- Positive: `grep -rqF '@hana/tane-cli' --include="*.ts" --include="*.json" --include="*.md" .` must succeed
- Negative: `grep -rqF '@os-eco/tane-cli' --include="*.ts" --include="*.json" --include="*.md" .` must fail (absent)

---

### 4. `.canopy/` paths — 67 sites

`.canopy/` paths appear in: `.gitattributes`, `src/config.ts`, `src/store.ts`, tests.

| Location | Step | Mechanism |
|----------|------|-----------|
| `src/config.ts` lines 6, 89 (`join(dir, ".canopy", ...)`) | Step 10 (explicit) + Step 11 (bulk) | sed pattern `project: "canopy"` + `\bcanopy\b` |
| `.gitattributes` (`.canopy/prompts.jsonl`, `.canopy/schemas.jsonl`) | **Step 14** (explicit) | `.gitattributes` excluded from bulk sweep (no extension); `sed -i 's/\.canopy\//\.tane\//g'` |
| All other `.canopy/` path strings in *.ts, *.md, *.json | **Step 11** (bulk) | `\bcanopy\b` matches `canopy` in `.canopy/` (`.` and `/` are non-word chars → word boundary satisfied) |

---

### 5. `liker0704/canopy` GitHub URLs (explicit step)

`liker0704/canopy` URLs appear in documentation and were captured in the baseline. These are the
repository owner's URLs and should be rewritten to `liker0704/tane`.

| Step | Mechanism |
|------|-----------|
| **Step 11** (bulk) | `\bcanopy\b → tane` sweep on *.md, *.json files transforms `liker0704/canopy` → `liker0704/tane` |

No explicit step needed: the bulk sweep handles these since "canopy" appears as a whole word in
`liker0704/canopy` (surrounded by `/` and end-of-string/whitespace, both non-word chars).

---

### 6. `jayminwest/canopy` URLs (fork-attribution — preserved, restore step)

Fork-attribution sites are in: CLAUDE.md, CONTRIBUTING.md, README.md, package.json
(`repository.url`), SECURITY.md, src/commands/onboard.ts.

| Step | Mechanism |
|------|-----------|
| Step 11 | Bulk sweep inadvertently transforms `jayminwest/canopy` → `jayminwest/tane` |
| **Step 12** (restore) | `sed -i 's|jayminwest/tane|jayminwest/canopy|g'` in each preservation file |
| Step 12 | Adds `Forked from jayminwest/canopy under MIT License.` to README.md top (new line, after bulk sweep — never transformed) |

---

### 7. `cn` shorthand — 188 *.md sites

| Step | Mechanism |
|------|-----------|
| **Step 13** (bulk *.md) | `find . -name '*.md' ... | xargs -0 sed -i -e 's/\bcn\b/ta/g' -e 's/\bCN\b/TA/g'` |

Note: `\bcn\b` → `ta` is applied only to *.md files to avoid unintended substitution in TypeScript
code. Explicit steps 8 and 9 handle the *.ts occurrences of `cn` (`bin` key in package.json,
`.name("cn")` in src/index.ts).

---

## Full Step Coverage Summary

| Step | Description | Token Sites Covered |
|------|-------------|---------------------|
| 1 | Non-agent guard + repo verify | — |
| 2 | Verify remotes | — |
| 3 | D18 pre-flight (awk porcelain-extraction) | — |
| 4 | Baseline COMPARE capture | — |
| 5 | Branch: rebrand-to-tane | — |
| **6** | **Org-qualified pre-pass** `@os-eco/canopy-cli` → `@hana/tane-cli` | All 11 @os-eco/canopy-cli sites |
| **7** | **Pre-pass integrity checks** (positive + negative grep) | Verification |
| **8** | **package.json** bin key `"cn"` → `"ta"` | package.json bin |
| **9** | **src/index.ts** `.name("cn")` → `.name("ta")`, `palette.brand`, usage banner | src/index.ts:31 (program.name), src/index.ts:43 (palette.brand) |
| **10** | **src/config.ts** `project: "canopy"` → `"tane"` | src/config.ts lines 12, 82 |
| **11** | **Bulk** `\bcanopy\b → tane` across *.ts *.json *.md *.yaml *.yml *.sh CODEOWNERS | 325 canopy + 67 .canopy/ + liker0704/canopy URLs |
| **12** | **Restore** `jayminwest/tane` → `jayminwest/canopy` + README attribution | 6 preservation files |
| **13** | **Bulk** `\bcn\b → ta` in *.md | 188 cn command examples |
| **14** | **git mv** `.canopy` → `.tane` + `.gitattributes` rewrite | 67 .canopy/ paths (gitattributes) |
| **15** | **CHANGELOG.md** Unreleased entry | docs |
| **16** | **Finalize** bun install + commit + push + post-mod COMPARE | — |

---

## Uncovered Sites

**None.** All token sites have a designated script step. No escalations required.

---

## Acceptance Checklist

- [x] **#1** `scripts/tane.sh` syntax-clean (`bash -n` exit 0)
- [x] **#2** `results/baseline-canopy.md` exists with full content
- [x] **#3** Coverage explicitly verifies `.name("cn")` → `.name("ta")` at src/index.ts:31 (step 9)
- [x] **#4** `results/dry-run-canopy.md` exists (see that file)
- [x] **#5** Org-qualified pre-pass in step 6 with positive AND negative grep checks in step 7
- [x] **#6** D18 pre-flight uses `awk` porcelain-extraction (step 3)
- [x] **#7** Baseline COMPARE block present with exit-code capture (step 4 + step 16)
