# Coverage Report: mulch → kura Rebrand

**Prepared:** 2026-05-09  
**Script:** scripts/kura.sh  
**Task:** overstory-11c8

---

## 1. Token Sites from Research → Script Step Mapping

| Token / Site | Location | Script Step | Coverage |
|---|---|---|---|
| `@os-eco/mulch-cli` (name) | package.json | Step 9: package.json explicit | ✅ COVERED |
| `@os-eco/mulch-cli` (other files) | cli.ts, upgrade.ts, version.ts, README.md, CHANGELOG.md, CLAUDE.md, publish.yml | Step 7: org-qualified pre-pass | ✅ COVERED |
| `bin: {mulch, ml}` | package.json | Step 9: explicit bin rename | ✅ COVERED |
| `repository.url` (jayminwest/mulch.git) | package.json | Step 13: bulk word-boundary pass | ✅ COVERED |
| `homepage` (jayminwest/mulch#readme) | package.json | Step 13: bulk word-boundary pass | ✅ COVERED |
| `MULCH_DIR = ".mulch"` | src/utils/config.ts | Step 10: explicit identifier rename | ✅ COVERED |
| `MULCH_README` constant name | src/utils/config.ts | Step 10: explicit identifier rename | ✅ COVERED |
| `getMulchDir()` function name | src/utils/config.ts | Step 10: explicit identifier rename | ✅ COVERED |
| `initMulchDir()` function name | src/utils/config.ts | Step 10: explicit identifier rename | ✅ COVERED |
| `mulchDir` variable name | src/utils/config.ts | Step 10: explicit identifier rename | ✅ COVERED |
| `CONFIG_FILE = "mulch.config.yaml"` | src/utils/config.ts | Step 13: bulk word-boundary pass | ✅ COVERED |
| `GITATTRIBUTES_LINE = ".mulch/..."` | src/utils/config.ts | Step 13: bulk word-boundary pass | ✅ COVERED |
| `MULCH_README` content string | src/utils/config.ts | Step 13: bulk word-boundary pass | ✅ COVERED |
| `interface MulchConfig` | src/schemas/config.ts | Step 11: explicit MulchConfig→KuraConfig | ✅ COVERED |
| `MulchConfig` imports (6+ files) | src/utils/config.ts, src/commands/*.ts | Step 11: propagated find+sed | ✅ COVERED |
| `.mulch/` dir refs in strings | All *.ts, *.md, *.yaml | Step 13: bulk word-boundary pass | ✅ COVERED |
| `mulch init/add/record/...` in help/strings | All *.ts, *.md | Step 13: bulk word-boundary pass | ✅ COVERED |
| `mulch` CLI name in examples | README.md, CHANGELOG.md, CLAUDE.md | Step 13+14 bulk passes | ✅ COVERED |
| `biome.json` `.mulch/` ignore | biome.json | Step 12: explicit biome.json | ✅ COVERED |
| `.gitattributes` merge line | .gitattributes | Step 12b: explicit gitattributes | ✅ COVERED |
| `.github/workflows/publish.yml` refs | publish.yml | Steps 7+13: pre-pass + bulk pass | ✅ COVERED |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | bug_report.yml | Step 13: bulk word-boundary pass | ✅ COVERED |
| `README.md` fork attribution | README.md | Step 14: explicit sed insert | ✅ COVERED |
| `CHANGELOG.md` Unreleased entry | CHANGELOG.md | Step 15: explicit sed insert | ✅ COVERED |
| `CLAUDE.md` cross-tool refs (seeds/canopy/overstory) | CLAUDE.md | Step 16: cross-tool refs pass | ✅ COVERED |
| `CONTRIBUTING.md` cross-tool refs | CONTRIBUTING.md | Step 16: cross-tool refs pass | ✅ COVERED |
| `SECURITY.md` cross-tool refs | SECURITY.md | Step 16: cross-tool refs pass | ✅ COVERED |
| `.mulch/` dir rename | repo .mulch/ directory | Step 17: git mv | ✅ COVERED |
| `mulch.config.yaml` rename | .kura/ dir | Step 17: git mv | ✅ COVERED |
| `bun.lock` regeneration | bun.lock | Step 18: bun install | ✅ COVERED |
| `LICENSE` | LICENSE | Explicitly excluded from all passes | ✅ PRESERVED |

---

## 2. Sed Pass Summary

| Pass | Pattern | Files | Notes |
|---|---|---|---|
| 1 (pre-pass) | `@os-eco/mulch-cli` → `@hana/kura-cli` | All *.ts *.json *.md *.yaml *.yml except package.json | Must precede word-boundary pass |
| 2 (package.json) | name, bin, repository.url, homepage | package.json only | Targeted field-by-field |
| 3 (explicit TS) | MULCH_DIR, MULCH_README, getMulchDir, initMulchDir, mulchDir | src/utils/config.ts | Identifier names missed by \b pass |
| 4 (explicit TS) | MulchConfig → KuraConfig | src/schemas/config.ts, src/**/*.ts, test/**/*.ts | Interface + import propagation |
| 5 (biome) | .mulch/ → .kura/ | biome.json | Ignore list entry |
| 6 (gitattributes) | .mulch/expertise → .kura/expertise | .gitattributes | Merge strategy line |
| 7 (bulk lowercase) | `\bmulch\b` → kura | All text files (excl LICENSE, bun.lock) | Core bulk substitution |
| 8 (bulk PascalCase) | `\bMulch\b` → Kura | *.ts *.md *.yaml *.yml | Doc-level PascalCase |
| 9 (bulk UPPER) | `\bMULCH\b` → KURA | *.ts *.md *.yaml *.yml | UPPER_CASE residuals |
| 10 (README insert) | Line 2 insert | README.md | Fork attribution |
| 11 (CHANGELOG insert) | Line 1 prepend | CHANGELOG.md | Unreleased heading |
| 12 (cross-tool) | overstory→haru, seeds→suji, canopy→tane | CLAUDE.md CONTRIBUTING.md SECURITY.md | Ecosystem rename |

---

## 3. Expected Replacement Counts (approx.)

| Pass | Approx. count |
|---|---|
| Org-qualified pre-pass | 16 (`@os-eco/mulch-cli` occurrences) |
| package.json targeted | 5 (name × 1, bin × 2, url × 1, homepage × 1) |
| Explicit identifiers | ~10 (MULCH_DIR, MULCH_README, 3 function names, getMulchDir call sites) |
| MulchConfig propagation | 24 + imports in 6+ files |
| biome + .gitattributes | 2 |
| Bulk word-boundary `\bmulch\b` | ~800+ (per baseline: 864 total, subset caught by boundary) |
| Bulk PascalCase + UPPER | ~80 remaining |
| README + CHANGELOG inserts | 2 (1 line each) |
| Cross-tool refs | ~30 (seeds/canopy/overstory refs across 3 files) |

**Total:** ~950+ replacements across all passes.

---

## 4. Uncovered Sites

None. All token sites from the scout research (`overstory-0e18.md`) are covered by at least one script step.

---

## 5. Carve-outs (preserved as-is)

| Item | Reason |
|---|---|
| `LICENSE` | Explicitly excluded per spec — MIT license text unmodified |
| `bun.lock` | Excluded from sed passes; regenerated by `bun install` |
| `node_modules/` | Excluded from all find passes |
| `.git/` | Excluded from all find passes |

---

## 6. Escalation Items

None. All token sites are amenable to sed substitution without structural code changes. The `MulchConfig` → `KuraConfig` rename touches a TypeScript interface exported publicly, but since this is the mulch repo's own package (not an external consumer), the renaming is fully contained within the repository.

**Cross-repo note:** Any downstream project consuming `@os-eco/mulch-cli` and importing `MulchConfig` will need to update to `@hana/kura-cli` and `KuraConfig`. This is expected operator action post-publish and is outside this script's scope.
