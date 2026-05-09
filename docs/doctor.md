# Doctor System

This document is the contributor guide for Overstory's `ha doctor` health check
system. It covers the 11 check categories, the `DoctorCheckFn` interface, how
`--fix` closures work, CLI usage, integration with the health scoring system, and
instructions for adding a new category.

---

## 1. What `ha doctor` Does

`ha doctor` runs a set of modular health checks across Overstory's subsystems and
reports any problems. Each check produces a `pass`, `warn`, or `fail` status with
a human-readable message and optional auto-fix.

Typical use cases:

```
ha doctor                         # Run all categories
ha doctor --category dependencies # Run one category
ha doctor --fix                   # Run checks and auto-fix fixable issues
ha doctor --json                  # JSON output for scripting
```

---

## 2. Source Files

| File | Category | Purpose |
|------|----------|---------|
| `src/doctor/types.ts` | — | `DoctorCheck`, `DoctorCheckFn`, `DoctorCategory` types |
| `src/doctor/dependencies.ts` | `dependencies` | External CLI tool availability |
| `src/doctor/config-check.ts` | `config` | `config.yaml` schema validation |
| `src/doctor/structure.ts` | `structure` | `.overstory/` directory layout |
| `src/doctor/databases.ts` | `databases` | SQLite database integrity |
| `src/doctor/consistency.ts` | `consistency` | Cross-subsystem state agreement |
| `src/doctor/agents.ts` | `agents` | Agent manifest and identity files |
| `src/doctor/merge-queue.ts` | `merge` | Merge queue database health |
| `src/doctor/logs.ts` | `logs` | Log file size and disk usage |
| `src/doctor/version.ts` | `version` | Package version and sync |
| `src/doctor/ecosystem.ts` | `ecosystem` | os-eco tool semver validity |
| `src/doctor/providers.ts` | `providers` | Provider reachability and auth |
| `src/commands/doctor.ts` | — | CLI wiring, category registry, fix execution |

---

## 3. The `DoctorCheck` Interface

**Source:** `src/doctor/types.ts:19`

```typescript
export interface DoctorCheck {
    name: string;
    category: DoctorCategory;
    status: "pass" | "warn" | "fail";
    message: string;
    details?: string[];
    fixable?: boolean;
    fix?: () => Promise<string[]> | string[];
}
```

- `name`: Short label for the check (e.g., `"Required files"`).
- `details`: Optional list of per-issue strings printed in verbose mode.
- `fixable`: True if this check issue can be corrected automatically.
- `fix`: Closure called when `--fix` is passed. Captures context at construction
  time (path, DB handle, etc.). Returns a list of human-readable actions taken.

The `DoctorCheckFn` signature every category module must export:

```typescript
export type DoctorCheckFn = (
    config: OverstoryConfig,
    overstoryDir: string,
) => DoctorCheck[] | Promise<DoctorCheck[]>;
```

**Source:** `src/doctor/types.ts:36`

---

## 4. Check Categories

Checks run in the fixed order declared in `src/commands/doctor.ts:28`:
`dependencies` → `config` → `structure` → `databases` → `consistency` →
`agents` → `merge` → `logs` → `version` → `ecosystem` → `providers`.

### 4.1 `dependencies`

**Source:** `src/doctor/dependencies.ts`

Detects whether required and optional CLI tools are available on `PATH`.

| Tool | Required | Alias checked |
|------|----------|--------------|
| `git` | Yes | — |
| `bun` | Yes | — |
| `tmux` | Yes | — |
| `sd` or `bd` (task tracker) | Yes | — |
| `mulch` | Yes | `ml` |
| `ov` | Yes | `haru` |
| `cn` | No | — |

Each tool is probed with its `--version` flag via `Bun.spawn`. A non-zero exit
code or spawn failure produces a `fail` (required tools) or `warn` (optional).

For `bd` specifically, a CGO support probe runs `bd status` in a temp directory
and checks stderr for `"without CGO support"` — a silent failure mode where the
binary exists but the Dolt backend is non-functional (`src/doctor/dependencies.ts:92`).

**`--fix` support:** None. Missing tools require manual installation.

### 4.2 `config`

**Source:** `src/doctor/config-check.ts`

Validates `config.yaml` in the project's `.overstory/` directory.

| Check | What it detects |
|-------|----------------|
| `config-parseable` | YAML parses without error |
| `config-valid` | Schema validation passes (`loadConfig` + `ValidationError`) |
| `config-version` | `version` field matches `CURRENT_CONFIG_VERSION` |
| `project-root-exists` | `project.root` path exists on disk |
| `canonical-branch-exists` | `project.canonicalBranch` exists in the git repo |

**`--fix` support:** None. Config errors require manual edits.

### 4.3 `structure`

**Source:** `src/doctor/structure.ts`

Validates the `.overstory/` directory layout.

| Check | What it detects | `--fix` |
|-------|----------------|---------|
| `.overstory/ directory` | Directory exists | No |
| `Required files` | `config.yaml`, `agent-manifest.json`, `hooks.json`, `.gitignore` | No |
| `Required subdirectories` | `agent-defs/`, `agents/`, `worktrees/`, `specs/`, `logs/` | Yes — `mkdir` |
| `.gitignore entries` | Wildcard+whitelist model entries present | Yes — appends missing entries |
| `Agent definition files` | `.md` files referenced by manifest exist in `agent-defs/` | No |
| `Leftover temp files` | `*.tmp`, `*.bak` files in `.overstory/` | Yes — `rm` |
| `Stale lock files` | `*.lock` files older than 5 minutes | Yes — `rm` |

The `.gitignore` model uses `*` to ignore everything by default and `!` whitelists
for specific tracked files (`config.yaml`, `hooks.json`, `agent-defs/**`, etc.)
(`src/doctor/structure.ts:106`).

### 4.4 `databases`

**Source:** `src/doctor/databases.ts`

Opens each known SQLite database and validates table presence and required column
existence. Checked databases: `mail.db`, `metrics.db`, `sessions.db`,
`merge-queue.db`.

For each database:
1. Checks file existence
2. Checks WAL mode (`PRAGMA journal_mode`)
3. Checks required tables exist
4. Checks required columns exist via `PRAGMA table_info`

**`--fix` support:** WAL mode can be enabled automatically via fix closure:
```typescript
fix: () => {
    const fixDb = new Database(dbPath);
    fixDb.exec("PRAGMA journal_mode=WAL");
    fixDb.close();
    return [`Enabled WAL mode on ${dbSpec.name}`];
}
```
(`src/doctor/databases.ts:191`)

### 4.5 `consistency`

**Source:** `src/doctor/consistency.ts`

Cross-subsystem sanity checks: SessionStore records vs. git worktrees vs. tmux
sessions.

Detects:
- Sessions in `sessions.db` with no corresponding git worktree
- Sessions in `sessions.db` with no corresponding tmux session
- Zombie sessions (state `working` but PID is gone)
- Orphaned worktrees (worktree path exists but no session record)

`checkConsistency` accepts injectable `deps` for testing without tmux:

```typescript
export interface ConsistencyCheckDeps {
    listSessions: () => Promise<Array<{ name: string; pid: number }>>;
    isProcessAlive: (pid: number) => boolean;
}
```

**`--fix` support:** None. Consistency issues require `ha clean` or manual
intervention.

### 4.6 `agents`

**Source:** `src/doctor/agents.ts`

Validates `agent-manifest.json` and per-agent identity files.

| Check | What it detects |
|-------|----------------|
| `Manifest parsing` | Valid JSON with required fields (`version`, `agents`, `capabilityIndex`) |
| `Agent definition files` | `.md` files referenced by `agents[n].file` exist in `agent-defs/` |
| `Capability index` | `capabilityIndex` bidirectionally consistent with `agents[n].capabilities` |
| `Identity validation` | Per-agent `identity.yaml` has valid `name`, `capability`, `created`, `sessionsCompleted` |
| `Stale identities` | Agents with identity files but removed from manifest |

Each agent definition requires: `file` (non-empty string), `model` (one of
`sonnet`/`opus`/`haiku`), `tools` (array), `capabilities` (non-empty array),
`canSpawn` (boolean), `constraints` (array) (`src/doctor/agents.ts:55`).

**`--fix` support:** Stale identity files can be removed; capability index
inconsistencies are flagged but require manual manifest edits.

### 4.7 `merge`

**Source:** `src/doctor/merge-queue.ts`

Validates `merge-queue.db` schema and detects stale in-progress entries.

Detects:
- Database not readable
- `merge_queue` table missing
- Required columns missing
- Entries stuck in `merging` status (in-progress but process may be dead)

If `merge-queue.db` does not exist, the check passes — this is normal for new
installations or projects with no merges yet.

**`--fix` support:** None. Stale entries require `ha clean --merge-queue`.

### 4.8 `logs`

**Source:** `src/doctor/logs.ts`

Checks disk usage in `.overstory/logs/` and detects oversized log files.

- Warns if total log directory size exceeds 500 MB (`DISK_USAGE_WARN_THRESHOLD`
  at `src/doctor/logs.ts:5`)
- Lists individual log files that are disproportionately large

**`--fix` support:** None. Log rotation requires manual `ha clean --logs` or
external log management.

### 4.9 `version`

**Source:** `src/doctor/version.ts`

| Check | What it detects |
|-------|----------------|
| `version-current` | `package.json` has a parseable `version` field |
| `package-json-sync` | Version in `package.json` matches version declared in `src/index.ts` |

**`--fix` support:** None.

### 4.10 `ecosystem`

**Source:** `src/doctor/ecosystem.ts`

Validates that `ml`, `sd`, and `cn` report parseable semver versions. Unlike the
`dependencies` category (which checks binary existence), `ecosystem` focuses on
version string quality and mutual compatibility.

Fix closures reinstall the relevant package via `bun install -g <pkg>` when a
binary reports a non-semver version string.

Tested tools:

| Name | Binary | Package |
|------|--------|---------|
| mulch | `ml` | `@os-eco/mulch-cli` |
| seeds | `sd` | `@os-eco/seeds-cli` |
| canopy | `cn` | `@os-eco/canopy-cli` |

**`--fix` support:** Yes — reinstalls the package for tools with invalid version
strings.

### 4.11 `providers`

**Source:** `src/doctor/providers.ts`

Validates the multi-runtime provider configuration.

| Check | What it detects |
|-------|----------------|
| `providers-configured` | At least one provider is configured |
| `provider-reachable-{name}` | Gateway provider `baseUrl` returns HTTP 200 |
| `provider-auth-token-{name}` | `authTokenEnv` environment variable is set |
| `tool-use-compat` | Tool-heavy roles (`builder`, `scout`, `merger`) are not assigned to providers without tool-use support |

**`--fix` support:** None. Provider configuration issues require config edits or
environment variable changes.

---

## 5. CLI Usage

```bash
# Run all checks (human-readable)
ha doctor

# Run checks with verbose detail output
ha doctor --verbose

# Run a single category
ha doctor --category dependencies
ha doctor --category config
ha doctor --category structure
ha doctor --category databases
ha doctor --category consistency
ha doctor --category agents
ha doctor --category merge
ha doctor --category logs
ha doctor --category version
ha doctor --category ecosystem
ha doctor --category providers

# Auto-fix fixable issues, then show results
ha doctor --fix

# JSON output
ha doctor --json
```

The `--fix` flag calls each check's `fix()` closure sequentially after all checks
have been collected (`src/commands/doctor.ts:46`). Fixed items are printed in a
separate section below the check results.

---

## 6. Integration with Health Scoring

**Source:** `src/health/signals.ts:34`

Doctor check results feed directly into the `ha health` scoring system. The
`collectSignals()` function accepts a `doctorChecks` parameter:

```typescript
const doctorFailCount = doctorChecks.filter((c) => c.status === "fail").length;
const doctorWarnCount = doctorChecks.filter((c) => c.status === "warn").length;
```

These counts become the `doctor_failures` scoring factor in `ha health`, which
carries a weight of 0.18 and reduces the overall health score by 15 points per
failure and 5 points per warning. A `doctor_failures` score below 55 triggers a
`critical` recommendation from `ha next-improvement`.

To run doctor checks as part of health signal collection, pass the results:

```typescript
const checks = await runDoctorChecks(config, overstoryDir);
const signals = collectSignals({ overstoryDir, doctorChecks: checks });
```

---

## 7. Adding a New Category (Contributor Guide)

### Step 1: Add the category name

In `src/doctor/types.ts:6`, add your category to `DoctorCategory`:

```typescript
export type DoctorCategory =
    | "dependencies"
    // ...existing categories...
    | "my-category";
```

### Step 2: Create the check module

Create `src/doctor/my-category.ts`:

```typescript
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

export const checkMyCategory: DoctorCheckFn = async (
    config,
    overstoryDir,
): Promise<DoctorCheck[]> => {
    const checks: DoctorCheck[] = [];

    // Check 1: example check
    const someCondition = true; // Replace with real check
    checks.push({
        name: "My check name",
        category: "my-category",
        status: someCondition ? "pass" : "fail",
        message: someCondition ? "All good" : "Something is wrong",
        details: someCondition ? undefined : ["Details about what failed"],
        fixable: !someCondition,
        fix: !someCondition
            ? async () => {
                // Perform fix
                return ["Fixed: description of what was changed"];
            }
            : undefined,
    });

    return checks;
};
```

Key rules:
- Return `pass` if the condition is healthy; `warn` for degraded but non-blocking;
  `fail` for blocking issues.
- Attach a `fix` closure only when the issue can be corrected deterministically
  without user input.
- Always set `fixable: true` when a `fix` is provided.

### Step 3: Register the category

In `src/commands/doctor.ts:28`, add an entry to `ALL_CHECKS`:

```typescript
const ALL_CHECKS: Array<{ category: DoctorCategory; fn: DoctorCheckFn }> = [
    // ...existing entries...
    { category: "my-category", fn: checkMyCategory },
];
```

Import your check function at the top of the file.

### Step 4: Write tests

Create `src/doctor/my-category.test.ts` with test cases covering:
- All pass conditions return `status: "pass"`
- Failure conditions return correct `status` and `details`
- Fix closures return a non-empty action list and make the appropriate changes
- The function handles missing files and permission errors gracefully (no throws)
