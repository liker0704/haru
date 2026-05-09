# Baseline: mulch → kura Rebrand

**Captured:** 2026-05-09  
**Target repo:** /home/liker2/projects/os-eco/mulch  
**Task:** overstory-11c8

---

## 1. Git State

**HEAD commit:** b30f40c76e47b0723884583d5e775c8d43ddf516

**Working tree status (git status --short):**
```
 M .overstory/agent-defs/architecture-review-lead.md
 M .overstory/agent-defs/builder.md
 M .overstory/agent-defs/coordinator.md
 M .overstory/agent-defs/execution-director.md
 M .overstory/agent-defs/lead-mission.md
 M .overstory/agent-defs/lead.md
 M .overstory/agent-defs/merger.md
 M .overstory/agent-defs/mission-analyst.md
 M .overstory/agent-defs/plan-architecture-critic.md
 M .overstory/agent-defs/plan-devil-advocate.md
 M .overstory/agent-defs/plan-performance-critic.md
 M .overstory/agent-defs/plan-review-lead.md
 M .overstory/agent-defs/plan-second-opinion.md
 M .overstory/agent-defs/plan-security-critic.md
 M .overstory/agent-defs/plan-simulator.md
 M .overstory/agent-defs/research-lead.md
 M .overstory/agent-defs/reviewer.md
 M .overstory/agent-defs/scout.md
 M .overstory/agent-manifest.json
```
→ All mods are under `.overstory/agent-defs/` (D18 carve-out: script allows these).

**Git remote:**
```
origin  git@github.com:liker0704/mulch.git (fetch)
origin  git@github.com:liker0704/mulch.git (push)
```
→ No upstream remote. origin matches expected `liker0704/mulch.git`.

---

## 2. Token Counts (baseline)

| Token | Count |
|-------|-------|
| `\bmulch\b` (case-insensitive, all files) | 864 |
| `.mulch/` directory references | 127 |
| `\bml ` in `*.md` files | 55 |
| `@os-eco/mulch-cli` references | 16 |
| `\bMulchConfig\b` in `*.ts` files | 24 |

---

## 3. Quality Gate Baselines

| Gate | Exit Code | Result |
|------|-----------|--------|
| `bun test` | 0 | PASS |
| `bun run lint` | 0 | PASS |
| `tsc --noEmit` | 0 | PASS |

All baseline gates GREEN. Script may proceed.

---

## 4. File Scope

**Source files:**
- `src/cli.ts`, `src/index.ts`, `src/api.ts`
- 25 files in `src/commands/`
- 6 util files: `src/utils/{config,expertise,format,lock,markers,version}.ts`
- Schema: `src/schemas/config.ts`

**Tests:** 26 files across `test/commands/`, `test/utils/`, `test/`

**Config/docs:**
- `package.json`, `biome.json`, `.gitattributes`
- `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`
- `.github/workflows/publish.yml`, `.github/ISSUE_TEMPLATE/bug_report.yml`

**Critical constants (explicit rename required):**
- `MULCH_DIR` → `KURA_DIR` (src/utils/config.ts)
- `MULCH_README` → `KURA_README` (src/utils/config.ts)
- `MulchConfig` → `KuraConfig` (src/schemas/config.ts + imports)
- `getMulchDir` → `getKuraDir`, `initMulchDir` → `initKuraDir` (src/utils/config.ts)
