# Agent Lifecycle

This document is the contributor guide for the agent lifecycle subsystem in
Haru. It covers the spawn pipeline, overlay generation, hooks deployment,
identity and manifest management, state machine transitions, guard rules, the
checkpoint mechanism, and a walkthrough for adding a new agent type.

---

## 1. Architecture Overview

The agent lifecycle is implemented across six modules in `src/agents/`:

```
ha sling <task-id>
       |
       v
src/commands/sling.ts         # CLI parsing, validation, guard checks (steps 1-6)
       |
       v
src/agents/spawn.ts           # SpawnService factory — steps 7-14
  |
  +-- src/agents/overlay.ts       # Generate + write per-agent CLAUDE.md
  +-- src/agents/hooks-deployer.ts # Deploy per-agent hooks.json guard
  +-- src/agents/manifest.ts       # ManifestLoader — resolve AgentDefinition
  +-- src/agents/identity.ts       # Agent identity YAML (persistent state)
  +-- src/agents/checkpoint.ts     # Mid-session checkpoint (pause/resume)
  +-- src/agents/state-machine.ts  # Transition graph validation
  +-- src/agents/guard-rules.ts    # Shared constants for PreToolUse guards
```

Persistent root agents (coordinator, mission-analyst, execution-director) use
`src/agents/persistent-root.ts`, which provides the same tmux lifecycle without
a worktree. All other agents go through `SpawnService`.

---

## 2. Spawn Pipeline (Steps 7–14)

**Source:** [`src/agents/spawn.ts`](../src/agents/spawn.ts)

The CLI wiring in `sling.ts` performs steps 1–6 (validation, dedup, run setup).
`SpawnService.spawn()` owns steps 7–14 and wraps the entire post-worktree
section in a try/catch that calls `rollbackWorktree()` on failure.

### Dependency Injection

`createSpawnService(deps: SpawnDeps)` accepts all dependencies via interface, so
callers (commands, tests) provide their own implementations:

```typescript
export interface SpawnDeps {
  sessionStore: SessionStore;
  createRunStore: (dbPath: string) => RunStore;
  manifestLoader: ManifestLoader;
  manifest: AgentManifest;
  agentDef: AgentDefinition;
  config: OverstoryConfig;
  resolvedBackend: string;

  // Lazy factories — only constructed on the paths that need them
  tracker: () => TrackerClient;
  mailStore: () => MailStore;
  mailClient: (store: MailStore) => MailClient;
  tane: () => TaneClient;
  kura: () => KuraClient;
  runtime: () => AgentRuntime;
  missionStore?: () => MissionStore;

  tmux: TmuxOps; // mockable tmux interface
}
```

Lazy deps (`tracker`, `mailStore`, etc.) are factory functions so they are not
constructed on early-exit paths (validation failures, spawn-paused sentinel).

### Step-by-Step Summary

| Step | Code location | What happens |
|------|--------------|--------------|
| 7 | `createWorktree()` | Create git worktree + branch under `.overstory/worktrees/` |
| 8 | `writeOverlay()` | Generate + write `CLAUDE.md` (or runtime-specific instruction file) |
| 8a | `kura.prime()` | Pre-fetch file-scoped expertise if kura is enabled and files are scoped |
| 8b | `tane.render()` | Resolve tane profile overlay if configured |
| 8c | Project context | Load `.overstory/project-context.json` for overlay injection |
| 9 | `runtime.deployConfig()` | Deploy capability-specific hooks guard |
| 9b | `buildAutoDispatch()` | Queue the auto-dispatch mail before session start |
| 10 | `tracker().claim()` | Claim tracker issue |
| 11 | `createIdentity()` | Create identity YAML if new agent |
| 11b | `applied-records.json` | Save applied kura record IDs for outcome tracking |
| 12 | tmux or headless | Create tmux session or `Bun.spawn()` for headless runtimes |
| 13 | `store.upsert()` | Record session in SessionStore **before** sending beacon |
| 13b–d | Beacon + verification | Send initial prompt, adaptive follow-up Enters, verify receipt |
| 13e | `discoverSessionId()` | Discover runtime-native session ID post-spawn |
| 14 | `SpawnResult` | Return result to caller |

### Session-Before-Beacon Ordering

The session record is written to `sessions.db` **before** the beacon is sent
(step 13 before 13b). This ensures the watchdog daemon can observe the agent in
`booting` state and never treats it as an orphan if a crash occurs between
session creation and beacon delivery (haru-036f).

### Spawn Guards

At the start of `spawn()`, two guards are checked before any work begins:

1. **spawn-paused sentinel** — if `.overstory/spawn-paused` exists, the spawn is
   rejected with a descriptive error referencing the health policy rule ID that
   placed the sentinel.
2. **Mission terminal state** — if a mission is associated with the run and is in
   `suspended`, `stopped`, `failed`, or `completed` state, the spawn is rejected
   to prevent agents from being created in the gap between a tick's suspend
   decision and its execution.

### Headless vs Interactive Paths

After step 11, the pipeline branches:

- **Headless** (`runtime.headless === true`): calls `spawnHeadlessAgent()` via
  `Bun.spawn()`, creates timestamped logs under `.overstory/logs/`, records
  session with `tmuxSession: ""`.
- **Interactive** (default): creates a tmux session, waits for TUI readiness via
  `waitForTuiReady()`, sends beacon + adaptive follow-up Enters, optionally runs
  beacon verification.

### Watchdog Auto-Spawn

**Source:** `maybeStartWatchdog()` in [`src/commands/sling.ts`](../src/commands/sling.ts),
mirrored by `src/missions/lifecycle-start.ts` for `ha mission start`.

**Trigger:** every `ha sling` or `ha mission start` call, including nested lead →
builder spawns. There is no depth guard — the function runs unconditionally on
each spawn.

**Mechanism:** `createWatchdogControl(projectRoot).start()` in
[`src/watchdog/control.ts`](../src/watchdog/control.ts). When a healthy daemon
already holds `.overstory/watchdog.pid`, the call short-circuits immediately
(haru-#325, commit `bc1b3f03`), so repeated invocations are cheap.

**Gate:** `config.watchdog.tier0Enabled`. When `false`, `maybeStartWatchdog()` is
a no-op.

**Failure mode:** errors are swallowed and surfaced as `printWarning("Watchdog
failed to start: …")`. A wedged daemon never blocks a successful sling.

**Guarantee:** every spawned agent is supervised by a running watchdog for the
duration of its session.

For manual recovery when the daemon is wedged, see
[`docs/runbooks/watchdog-recovery.md`](./runbooks/watchdog-recovery.md).

---

## 3. Overlay Generation

**Source:** [`src/agents/overlay.ts`](../src/agents/overlay.ts)

Every agent gets a per-task instruction file generated from a template. The
template is `templates/overlay.md.tmpl` in the repo root.

### Template Slots

`generateOverlay(config: OverlayConfig)` reads the template and replaces all
`{{VARIABLE}}` placeholders:

| Placeholder | Value |
|------------|-------|
| `{{BASE_DEFINITION}}` | Full text of the agent's `agents/<name>.md` base definition |
| `{{SHARED_MANDATE}}` | Contents of `.overstory/agent-defs/shared-mandate.md` (if present) |
| `{{PROFILE_INSTRUCTIONS}}` | Tane profile content rendered at spawn time |
| `{{AGENT_NAME}}` | Unique agent name (e.g. `builder-abc123`) |
| `{{TASK_ID}}` | Tracker issue ID |
| `{{SPEC_PATH}}` | Absolute path to the task spec file |
| `{{BRANCH_NAME}}` | Git branch in the worktree |
| `{{WORKTREE_PATH}}` | Absolute path to the worktree root |
| `{{PARENT_AGENT}}` | Name of the spawning agent |
| `{{DEPTH}}` | Delegation depth (0 = coordinator, 1 = lead, 2 = builder) |
| `{{FILE_SCOPE}}` | Markdown bullet list of owned files |
| `{{MULCH_DOMAINS}}` | `ku prime` command for relevant expertise domains |
| `{{MULCH_EXPERTISE}}` | Pre-fetched expertise blocks (omitted if empty) |
| `{{PROJECT_CONTEXT}}` | Compact project context (omitted if empty) |
| `{{CAN_SPAWN}}` | Spawn permission block with example `ha sling` command |
| `{{QUALITY_GATES}}` | Full quality gates section with gate commands |
| `{{CONSTRAINTS}}` | Worktree isolation and write-scope constraints |
| `{{TRACKER_CLI}}` | `su`, `bd`, or `gh` depending on resolved backend |
| `{{TRACKER_NAME}}` | Human-readable tracker name |
| `{{INSTRUCTION_PATH}}` | Runtime-specific instruction file path |

### Read-Only vs Writable Capability Handling

The `{{QUALITY_GATES}}` and `{{CONSTRAINTS}}` sections differ based on
capability. `READ_ONLY_CAPABILITIES = new Set(["scout", "reviewer", "researcher"])`
receive lightweight sections that omit commit/push gates and replace worktree
constraints with a read-only notice. Writable capabilities (builder, merger, lead)
receive the full gate list and strict path boundary constraints.

### Guard Against Canonical Root Writes

`writeOverlay()` calls `isCanonicalRoot(worktreePath, canonicalRoot)` before
writing. This prevents agent overlays from overwriting the user's
`.claude/CLAUDE.md` at the repo root — a bug that would break the orchestrator's
own Claude Code session. Path comparison is used (not file-existence heuristics)
to handle dogfooding scenarios where `.overstory/config.yaml` exists in every
worktree checkout (haru-p4st, haru-uwg4).

---

## 4. Hooks Deployment

**Source:** [`src/agents/hooks-deployer.ts`](../src/agents/hooks-deployer.ts)

`runtime.deployConfig()` delegates to `deployHooks()` for Claude Code runtimes.
Hooks are written to `{worktreePath}/.claude/settings.local.json` as `PreToolUse`
hook entries.

### Hook Categories

Three tiers of guards are merged per agent:

1. **Universal guards** (all agents): block `NATIVE_TEAM_TOOLS` (Task, TeamCreate,
   etc.) and `INTERACTIVE_TOOLS` (AskUserQuestion, EnterPlanMode).
2. **Path boundary guards** (all agents): Write, Edit, NotebookEdit tool calls
   check `HARU_WORKTREE_PATH` against the target path.
3. **Capability-specific guards**:
   - Non-implementation capabilities (scout, reviewer, lead, monitor, etc.) — block
     Write/Edit/NotebookEdit tools entirely and add dangerous Bash pattern guards.
   - Implementation capabilities (builder, merger) — add Bash path boundary
     validation for file-modifying shell commands.
   - Coordination capabilities (coordinator, supervisor, etc.) — allow
     `git add`/`git commit` via `COORDINATION_SAFE_PREFIXES` for task sync, but
     still block `git push`.

All hooks include an `ENV_GUARD` prefix:
```bash
[ -z "$HARU_AGENT_NAME" ] && exit 0
```
This makes every guard a no-op for the user's own Claude Code sessions at the
project root.

### Pi Runtime Guards

Pi agents get a TypeScript extension at `.pi/extensions/haru-guard.ts`
instead of Claude Code hooks. The extension uses `pi.on("tool_call", ...)` and
returns `{ block: true, reason }` to mirror PreToolUse behavior. It also handles
activity tracking via `pi.exec("ha log ...")` so the watchdog daemon does not
misclassify Pi agents as zombies.

---

## 5. Agent Manifest

**Source:** [`src/agents/manifest.ts`](../src/agents/manifest.ts)

The manifest is `.overstory/agent-manifest.json` and is loaded at startup by
`createManifestLoader(manifestPath, agentBaseDir)`.

### `AgentDefinition` Shape

```typescript
interface AgentDefinition {
  file: string;         // Relative path to agents/<name>.md
  model: string;        // Default model alias (e.g. "sonnet", "haiku")
  tools: string[];      // Allowed tool names
  capabilities: string[]; // Capability strings this agent declares
  canSpawn: boolean;    // Whether this agent may use ha sling
  constraints: string[]; // Human-readable constraint descriptions
}
```

### Capability Index

`createManifestLoader` builds a `capabilityIndex: Record<string, string[]>` that
maps each capability string to the list of agent names declaring it. `ha sling
--capability builder` calls `findByCapability("builder")` to resolve which agent
definition to use.

### Model Resolution

`resolveModel(config, manifest, role, fallback)` applies a three-tier resolution:

1. `config.models[role]` — explicit per-role override in `.overstory/config.yaml`
2. `manifest.agents[role]?.model` — manifest default
3. `fallback` (the agent definition's declared model)

Aliases (`sonnet`, `haiku`, `opus`) are expanded via
`ANTHROPIC_DEFAULT_{ALIAS}_MODEL` environment variables. Provider-prefixed models
(e.g. `openrouter/gpt-5`) are expanded into gateway env vars via
`resolveProviderEnv()`.

---

## 6. Agent Identity

**Source:** [`src/agents/identity.ts`](../src/agents/identity.ts)

Each agent has a persistent `identity.yaml` file at
`.overstory/agents/{name}/identity.yaml`. Identity tracks cross-session state
that survives agent restarts.

```yaml
name: builder-abc123
capability: builder
created: "2026-01-15T10:00:00.000Z"
sessionsCompleted: 3
expertiseDomains:
  - sessions
  - mail
recentTasks:
  - taskId: haru-1234
    summary: "Add WAL mode to mail store"
    completedAt: "2026-01-15T11:30:00.000Z"
```

`updateIdentity()` supports three additive operations:
- `sessionsCompleted` — incremented (not replaced)
- `expertiseDomains` — merged (deduplicated)
- `completedTask` — appended to `recentTasks` (capped at 20 entries, oldest
  dropped)

---

## 7. State Machine

**Source:** [`src/agents/state-machine.ts`](../src/agents/state-machine.ts)

The agent state graph is a DAG, not a linear chain. All transitions go through
`validateTransition()` for correctness and audit.

### Valid Transitions

```
booting  --> working, zombie, completed
working  --> waiting, stalled, completed, zombie
waiting  --> working, booting, zombie, completed
stalled  --> working, zombie, completed
zombie   --> booting, completed
completed --> (terminal — no outgoing edges)
```

**`waiting`** is the state agents set before stopping when they have dispatched
sub-agents. The watchdog does not auto-complete or escalate `waiting` agents.
Mail arrival resumes them via `resumeAgent()`. The `tool-start` hook
auto-clears `waiting → working` when the agent begins processing.

**`zombie`** is set by the watchdog when a tmux session dies or an agent has
been inactive past the zombie threshold. A zombie may be respawned (`zombie →
booting`) via `ha resume`.

### ZFC Override

`validateTransition(from, to, ctx, { force: true })` bypasses the graph when
observable state (tmux/pid) contradicts recorded state. The result records
`forced: true` for audit. Used by the dashboard health reconciliation loop and
the spawn pipeline when the TUI fails to become ready.

---

## 8. Autonomy Mode Gate-Skip Semantics (Trust Boundary)

The `auto-spec` and `auto-all` autonomy modes both bypass two gates that are
mandatory in supervised operation:

1. **Human spec-approval gate.** `evaluateHumanSpecReview` at
   [`src/watchdog/gate-evaluators.ts:959`](../src/watchdog/gate-evaluators.ts)
   auto-returns `{ met: true, trigger: "approved" }` when
   `mission.autonomy === "auto-spec"` or `"auto-all"`.

2. **Handoff-freeze ceremony.** The check at
   [`src/missions/workstream-control.ts:528`](../src/missions/workstream-control.ts)
   skips the freeze requirement and records a `freeze_skipped` event for both
   `auto-spec` and `auto-all`. The commit `6120844a` title understates this —
   "fix(mission): skip handoff freeze ceremony on auto-all autonomy" — but the
   code at HEAD applies to **both** `auto-spec` and `auto-all`. Trust the code,
   not the commit title.

Selecting either non-supervised mode is a **trust-boundary decision**: operators
consent to skipping the human spec-review checkpoint, not merely a UX ceremony.
This removes the human review step from the critical path; the system proceeds
on the assumption that the spec is correct and unambiguous.

---

## 9. Checkpoint Mechanism

**Source:** [`src/agents/checkpoint.ts`](../src/agents/checkpoint.ts)

Checkpoints persist session state for pause/resume workflows. A checkpoint is
written to `.overstory/agents/{name}/checkpoint.json`.

```typescript
interface SessionCheckpoint {
  agentName: string;
  sessionId: string;
  worktreePath: string;
  branchName: string;
  taskId: string;
  savedAt: string;
  // Additional runtime-specific fields
}
```

The three public functions:
- `saveCheckpoint(agentsDir, checkpoint)` — write checkpoint atomically
- `loadCheckpoint(agentsDir, agentName)` — read checkpoint, return null if absent
- `clearCheckpoint(agentsDir, agentName)` — delete checkpoint (ENOENT is ignored)

`ha resume` loads the checkpoint to restore session context before re-spawning
the agent in its original worktree.

---

## 10. Guard Rules Reference

**Source:** [`src/agents/guard-rules.ts`](../src/agents/guard-rules.ts)

Pure data constants shared between `hooks-deployer.ts` (Claude Code PreToolUse
hooks) and `pi-guards.ts` (Pi TypeScript extension). Modifying these constants
affects both runtimes.

| Export | Type | Purpose |
|--------|------|---------|
| `NATIVE_TEAM_TOOLS` | `string[]` | Claude Code team tools that bypass haru orchestration |
| `INTERACTIVE_TOOLS` | `string[]` | Tools that block indefinitely in non-interactive sessions |
| `WRITE_TOOLS` | `string[]` | File-writing tools blocked for non-implementation capabilities |
| `ARTIFACT_WRITE_CAPABILITIES` | `Set<string>` | Capabilities allowed to write `.overstory/` paths |
| `DANGEROUS_BASH_PATTERNS` | `string[]` | Regex fragments matched against Bash commands |
| `SAFE_BASH_PREFIXES` | `string[]` | Bash prefixes exempt from blocklist checks |

The safe prefix check runs before the blocklist. `ha `, `sd `, `git status`,
`git log`, `git diff`, `kura `, and similar read-only commands always pass.

---

## 11. Adding a New Agent Type

### Step 1: Write the base definition

Create `agents/<name>.md`. This is the static HOW — the reusable role description
that applies to every task assigned to this agent type. Include:
- Role summary
- Capabilities (what the agent can do)
- Workflow steps
- Communication protocol
- Completion protocol

See `agents/builder.md` for the canonical example.

### Step 2: Register in the manifest

Add an entry to `.overstory/agent-manifest.json`:

```json
{
  "agents": {
    "my-new-agent": {
      "file": "my-new-agent.md",
      "model": "sonnet",
      "tools": ["Read", "Glob", "Grep", "Bash"],
      "capabilities": ["my-capability"],
      "canSpawn": false,
      "constraints": [
        "Read-only access — may not modify project files",
        "Must report results via ha mail"
      ]
    }
  }
}
```

The `capabilities` array is indexed at load time. Use `ha sling --capability
my-capability` to spawn agents of this type.

### Step 3: Map to an overlay capability

If your agent has distinct read-only or writable behavior, add it to the
appropriate set in `hooks-deployer.ts`:

- **Read-only**: add to `NON_IMPLEMENTATION_CAPABILITIES`
- **Coordination** (needs `git add`/`git commit` but not `git push`): add to
  `COORDINATION_CAPABILITIES`
- **Implementation** (full file write access within worktree): no set needed —
  this is the default

Update `READ_ONLY_CAPABILITIES` in `overlay.ts` if the agent is read-only:

```typescript
const READ_ONLY_CAPABILITIES = new Set([
  "scout", "reviewer", "researcher",
  "my-capability",  // add here
]);
```

### Step 4: Add capability routing in overlay.ts (if needed)

If the agent can spawn sub-workers, add it to `EXAMPLE_CHILD_CAPABILITY` so the
overlay shows a realistic `ha sling` example:

```typescript
const EXAMPLE_CHILD_CAPABILITY: Record<string, string> = {
  // ...existing entries...
  "my-capability": "builder",
};
```

### Step 5: Write tests

Tests for spawn and overlay generation live in `src/agents/`. Use real temporary
directories (via `mkdtemp`) rather than mocks. Verify:
- The agent definition loads without manifest validation errors
- `generateOverlay()` renders correctly for the new capability
- `NON_IMPLEMENTATION_CAPABILITIES` membership produces read-only quality gates

---

## See also

- [`docs/haru-mission-usage.md`](./haru-mission-usage.md) — operator-facing
  coverage of intake-phase, pr-phase, autonomy modes, and per-mission
  `feature_branch`. This document deliberately does NOT duplicate that
  content; consult haru-mission-usage.md for operator workflow.
- [`docs/runbooks/watchdog-recovery.md`](./runbooks/watchdog-recovery.md) —
  manual recovery procedures for a wedged watchdog daemon.
