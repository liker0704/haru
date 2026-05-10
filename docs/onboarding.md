# Haru Onboarding Guide

Welcome to Haru — a project-agnostic swarm system for Claude Code agent orchestration. This guide covers everything you need to get started: CLI commands, agent types, and mission lifecycle.

---

## Table of Contents

1. [CLI Commands by Workflow](#cli-commands-by-workflow)
2. [Agent Capabilities and Hierarchy](#agent-capabilities-and-hierarchy)
3. [Agent Tool/Model Reference](#agent-toolmodel-reference)
4. [Mission Lifecycle](#mission-lifecycle)
5. [Quick Start Checklist](#quick-start-checklist)

---

## CLI Commands by Workflow

### Setup and Initialization

These commands bootstrap Haru in a new project. `ha init` creates the `.overstory/` directory containing `config.yaml`, SQLite databases (`sessions.db`, `mail.db`, `events.db`, etc.), and hooks configuration.

| Command | Purpose |
|---------|---------|
| `ha init` | Initialize `.overstory/` in the current project |
| `ha quickstart` | Guided first-run wizard for new users |
| `ha hooks install` | Install orchestrator hooks into Claude Code |
| `ha hooks uninstall` | Remove orchestrator hooks |
| `ha hooks status` | Check hook installation status |
| `ha config list` | Show all configuration values |
| `ha config get <key>` | Get a specific config value |
| `ha config set <key> <value>` | Set a config value |
| `ha update` | Refresh managed files from the installed package |
| `ha upgrade` | Upgrade Haru (use `--all` for all ecosystem tools) |

---

### Agent Lifecycle

These commands manage the agents that do the actual work. Agents run in isolated git worktrees via tmux, each on their own branch.

| Command | Purpose |
|---------|---------|
| `ha sling <task-id>` | Spawn a worker agent into a new worktree |
| `ha stop <agent>` | Terminate a running agent |
| `ha attach [agent]` | Attach to an agent's tmux session |
| `ha resume [agent]` | Resume an interrupted session |
| `ha nudge <agent>` | Send a text nudge to a stalled agent |
| `ha agents` | List available agent definitions |
| `ha worktree list` | List active worktrees |
| `ha worktree clean` | Remove stale worktrees |

**Key `ha sling` flags:**

```bash
ha sling <task-id> \
  --capability builder \      # agent type: scout, builder, reviewer, merger, tester
  --name my-builder \         # custom agent name
  --spec path/to/spec.md \    # task spec file
  --files src/foo.ts \        # files the agent owns (comma-separated)
  --parent coordinator \      # parent agent name
  --depth 2 \                 # hierarchy depth (default max: 2)
  --runtime claude \          # runtime adapter (claude, codex, gemini, etc.)
  --tdd-mode light \          # TDD mode: skip|light|full
  --profile ov-co-creation    # apply named profile (e.g., human-in-the-loop)
```

See `ha sling --help` for the full flag list.

---

### Messaging

Haru uses a custom SQLite mail system (`mail.db`) for inter-agent communication. All messages are typed and stored durably.

| Command | Purpose |
|---------|---------|
| `ha mail send` | Send a message to an agent |
| `ha mail check` | Check your inbox (injects new messages into the session) |
| `ha mail list` | List messages with optional filters |
| `ha mail read <id>` | Read a specific message |
| `ha mail reply <id>` | Reply to a message thread |
| `ha mail purge` | Purge old messages |
| `ha mail dlq` | View dead-letter queue |
| `ha mail retry` | Retry failed messages |

**Message types:** `status`, `result`, `question`, `error`, `dispatch`, `merge_ready`, `worker_done`

```bash
# Send a status update
ha mail send --to lead-agent --subject "Progress" \
  --body "Finished implementing X" --type status --agent my-agent

# Report completion
ha mail send --to lead-agent --subject "Worker done: task-id" \
  --body "Quality gates passed." --type worker_done --agent my-agent
```

**Waiting state and auto-resume:** Agents that dispatch sub-agents set `state=waiting` and stop. When mail arrives in their inbox, the watchdog automatically resumes them via tmux nudge — no polling required.

---

### Merge and Delivery

Each agent works on an isolated branch in its own git worktree. The coordinator or merger agent integrates branches back to main.

| Command | Purpose |
|---------|---------|
| `ha merge` | Merge an agent branch into main |
| `ha merge --branch <branch>` | Merge a specific branch |
| `ha merge --all` | Merge all merge-ready branches |
| `ha merge --dry-run` | Simulate merge without applying |
| `ha compat check <branch>` | Check branch compatibility against canonical |

Merges are handled sequentially by the coordinator to avoid conflicts. Agents never push — they commit to their worktree branch and signal `merge_ready`. The coordinator merges only after receiving a typed `merge_ready` mail from the owning lead.

---

### Status and Observability

| Command | Purpose |
|---------|---------|
| `ha status` | Show active agents, worktrees, and state |
| `ha dashboard` | Live TUI dashboard (use `--interval`, `--all`) |
| `ha inspect <agent>` | Deep agent inspection (use `--follow`) |
| `ha trace <target>` | Chronological event timeline for an agent |
| `ha feed` | Unified real-time event stream (use `--follow`) |
| `ha logs` | Query NDJSON logs (use `--agent`, `--level`, `--follow`) |
| `ha errors` | Aggregated error view across all agents |
| `ha costs` | Token and cost analysis (use `--live`, `--by-capability`) |
| `ha health` | Operational health score |
| `ha health-policy` | Health policy rules (use `--execute`) |
| `ha next-improvement` | Top recommendation from health scoring |
| `ha doctor` | Health checks with optional `--fix` |
| `ha rate-limits` | Rate-limit headroom (use `--live`, `--runtime`) |
| `ha metrics` | Session metrics |
| `ha adaptive` | Adaptive parallelism state and scaling |
| `ha replay` | Interleaved multi-agent replay |
| `ha export` | Observability export pipeline |
| `ha webserver` | HTTP webserver for remote access |

---

### Missions

`ha mission` is the structured orchestration mode for complex, multi-phase work. See [Mission Lifecycle](#mission-lifecycle) for the full flow.

| Command | Purpose |
|---------|---------|
| `ha mission start` | Start a new mission |
| `ha mission status` | Show current mission status |
| `ha mission output` | Show mission output and artifacts |
| `ha mission answer` | Answer a pending mission question |
| `ha mission handoff` | Trigger handoff from plan phase to execute |
| `ha mission pause` | Pause an active mission |
| `ha mission resume` | Resume a paused mission |
| `ha mission complete` | Mark a mission complete |
| `ha mission list` | List all missions |
| `ha mission graph` | Show the phase graph |
| `ha mission show` | Show details for a specific mission |
| `ha mission artifacts` | Show mission artifacts |
| `ha mission bundle` | Bundle mission data |
| `ha mission extract-learnings` | Extract learnings from mission |
| `ha mission holdout` | Trigger holdout validation manually |
| `ha mission refresh-briefs` | Refresh workstream briefs |
| `ha mission update` | Update mission parameters |
| `ha mission stop` | Stop a running mission |
| `ha mission tier set <tier>` | Set mission complexity tier (direct, planned, full) |
| `ha mission tier show` | Show the current mission tier |
| `ha mission workstream-complete <ws-id>` | Operator escape hatch for marking a workstream complete |

---

### Persistent Orchestration

| Command | Purpose |
|---------|---------|
| `ha coordinator start|stop|status|send|ask|output|check-complete` | Non-mission persistent orchestrator (direct tier fast path) |

---

## Agent Capabilities and Hierarchy

### Hierarchy

Haru uses a strict three-tier hierarchy with a default maximum depth of 2:

```
Orchestrator (your Claude Code session)
  └── Coordinator (depth 0)
        └── Lead (depth 1)
              └── Scout / Builder / Reviewer / Merger / Tester (depth 2)
```

Each level delegates to the level below. Coordinators only spawn leads; leads spawn workers. Agents at max depth cannot spawn further.

---

### Agent Types

#### Coordinator

The top-level agent that acts as your autonomous project manager. The coordinator communicates with you, owns the high-level plan, dispatches leads for each workstream, waits for `merge_ready` signals, and merges completed branches.

**When to use:** Any task too large for a single session. Spawn a coordinator and give it the objective — it handles decomposition, delegation, and integration.

---

#### Lead

A team lead that decomposes a task into specs, spawns 2–5 workers (scouts, builders, reviewers), assigns non-overlapping file scope to each, monitors progress, and verifies results before signaling `merge_ready` to the coordinator.

**When to use:** Automatically spawned by the coordinator. You can also spawn a lead directly for a focused workstream (e.g., `ha sling task-id --capability lead`).

---

#### Scout

A read-only exploration agent. The scout reads files, searches code, maps dependencies, and reports findings back to the lead via mail. It never modifies files.

**When to use:** Before writing specs for unfamiliar code. Scouts prevent "spec without context" errors by grounding specs in actual code analysis.

---

#### Builder

An implementation agent. The builder reads its spec, implements changes within its assigned file scope, runs quality gates (`bun test`, `bun run lint`, `bun run typecheck`), commits to its worktree branch, and reports `worker_done` to the lead.

**When to use:** Automatically spawned by the lead for each implementation task.

---

#### Reviewer

A verification agent that reads the builder's diff and checks it against the spec. Produces a PASS or FAIL verdict with actionable feedback. On FAIL, the lead sends revision requests back to the builder.

**When to use:** Spawned by the lead for complex or multi-file changes. For simple changes, the lead may self-verify.

---

#### Merger

A specialist for resolving complex merge conflicts. Handles cases where the coordinator's tiered conflict resolution cannot automatically integrate two branches.

**When to use:** Spawned by the coordinator or lead when `ha merge` encounters unresolvable conflicts.

---

#### Tester

Writes and runs tests, often in TDD workflows. In full TDD mode the tester writes tests first; builders then implement against them without modifying the test files.

**When to use:** Spawned by the lead when test coverage is a primary deliverable, or when TDD mode is active.

---

#### Plan Review Lead

Coordinates a panel of specialist critics to review a plan before execution. Spawns devil's advocate, security critic, performance critic, second-opinion, and simulator agents, then synthesizes their findings into a consolidated review report.

**When to use:** Spawn via `ha sling task-id --capability plan-review-lead` for any mission plan that warrants multi-angle scrutiny before committing to execution.

---

#### Plan Devils Advocate

Challenges plans by finding risks, gaps, and blind spots. Reviews the plan with a contrarian lens and reports issues without bias toward approval.

**When to use:** Spawned by the plan review lead.

---

#### Plan Security Critic

Reviews plans for security vulnerabilities, including auth gaps, secret exposure, injection surfaces, and trust boundary issues.

**When to use:** Spawned by the plan review lead when the plan touches auth, data handling, or external integrations.

---

#### Plan Performance Critic

Reviews plans for performance and scalability issues, including N+1 queries, missing indexes, unbounded memory growth, and hot-path concerns.

**When to use:** Spawned by the plan review lead when the plan involves database access, large data processing, or performance-sensitive paths.

---

#### Plan Second Opinion

Provides independent validation of a plan without access to prior context or the original reviewer's conclusions. Prevents confirmation bias in plan approval.

**When to use:** Spawned by the plan review lead for high-stakes or architecturally significant plans.

---

#### Plan Simulator

Tests a plan against multiple scenarios: happy path, edge cases, and failure paths. Identifies gaps before implementation begins.

**When to use:** Spawned by the plan review lead to stress-test execution assumptions.

---

#### Architecture Review Lead

Coordinates architecture-focused review of system designs and code changes. Can spawn architecture critics and synthesizes their findings.

**When to use:** Spawn for reviews that require deep architectural analysis across multiple subsystems.

---

#### Plan Architecture Critic

Reviews plans and designs for architectural integrity, scalability, maintainability, and alignment with existing system patterns.

**When to use:** Spawned by the architecture review lead.

---

#### Research Lead

Coordinates a team of researchers on deep research tasks. Owns the research plan, dispatches individual researchers, and synthesizes findings into a structured output.

**When to use:** Spawn via `ha sling task-id --capability research-lead` for broad research that benefits from parallel investigation.

---

#### Researcher

Performs deep research using web search, documentation fetching, and code analysis tools. Reports findings back to the research lead.

**When to use:** Spawned by the research lead. Runs without a worktree — purely a knowledge-gathering agent.

---

#### Architect

Designs system architecture, creates ADRs (Architecture Decision Records), produces diagrams and design documents, and records architectural decisions for future reference.

**When to use:** Spawn when a task requires upfront architecture design before builders can proceed. The architect produces artifacts that builders implement against.

---

#### Architecture Sync

Synchronizes architecture knowledge across the project. Reads current code state and updates architecture documentation to reflect reality.

**When to use:** Spawn after significant refactors to keep architecture docs current.

---

#### Coordinator Mission (Full)

A mission-aware coordinator that manages all mission phases from understand through done. Has full authority to spawn leads, analysts, and directors for any tier.

**When to use:** Automatically spawned by `ha mission start` for `full` tier missions.

---

#### Coordinator Mission Assess

Evaluates a new mission's complexity and selects the appropriate tier (`direct`, `planned`, or `full`). Runs once at mission start.

**When to use:** Automatically used during assess mode when a new mission is created.

---

#### Coordinator Mission Direct

Manages `direct` tier missions where the task is already fully decomposed. Skips understand/plan phases and goes straight to execution.

**When to use:** Used for `direct` tier missions.

---

#### Coordinator Mission Planned

Manages `planned` tier missions through understand → plan → execute → done phases.

**When to use:** Used for `planned` tier missions.

---

#### Mission Analyst Planned

Knowledge owner for `planned` tier missions. Explores the codebase, produces briefs and workstream decompositions, and provides context to the coordinator.

**When to use:** Automatically spawned by the coordinator for `planned` tier missions.

---

#### Lead Mission

A mission-aware team lead that understands mission context, workstream boundaries, and brief artifacts. Operates like a standard lead but with access to mission state.

**When to use:** Spawned by the execution director during mission execute phase.

---

#### Monitor

A read-only fleet patrol agent that checks agent health, detects stalls, and reports anomalies. Part of the Tier 2 monitoring system.

**When to use:** Started via `ha monitor start`. Runs continuously in the background alongside the watchdog.

---

#### Mission Analyst

The knowledge owner for a mission. The analyst synthesizes research across phases, produces mission artifacts (briefs, findings, decision summaries), triages incoming findings, and provides context to the coordinator and execution director.

**When to use:** Automatically spawned by `ha mission start` for `planned` and `full` tier missions.

---

#### Execution Director

Manages workstream dispatch during the `execute` phase of a `full` tier mission. Owns lead-level coordination so the mission coordinator can focus on mission-contract decisions rather than workstream details.

**When to use:** Automatically spawned at `ha mission handoff` for `full` tier missions.

---

### Profile: `ov-co-creation`

A human-in-the-loop workflow profile that pauses an agent at explicit decision gates rather than fully autonomous execution. Within an approved plan the agent acts immediately on routine choices (naming, file organization, test strategy); at architectural forks, design choices, or scope boundaries it stops and emits a `decision_gate` mail with options and a recommendation, then waits for the operator's reply.

Spawn via `ha sling <task-id> --profile ov-co-creation`. The base profile lives at `agents/ov-co-creation.md` — it overlays on top of the underlying agent capability (builder, lead, etc.) rather than replacing it.

---

## Agent Tool/Model Reference

All 28 agent specializations registered in `buildAgentManifest()` (`src/commands/init.ts`):

| Agent | Model | Tools | Can Spawn | Constraints |
|-------|-------|-------|-----------|-------------|
| scout | Haiku | Read, Glob, Grep, Bash | No | read-only |
| builder | Sonnet | Read, Write, Edit, Glob, Grep, Bash | No | — |
| reviewer | Sonnet | Read, Glob, Grep, Bash | No | read-only |
| lead | Opus | Read, Write, Edit, Glob, Grep, Bash, Task | Yes | — |
| merger | Sonnet | Read, Write, Edit, Glob, Grep, Bash | No | — |
| tester | Sonnet | Read, Write, Edit, Glob, Grep, Bash | No | — |
| coordinator | Opus | Read, Glob, Grep, Bash | Yes | read-only, no-worktree |
| coordinator-mission | Opus | Read, Glob, Grep, Bash | Yes | read-only, no-worktree |
| coordinator-mission-assess | Opus | Read, Glob, Grep, Bash | No | read-only, no-worktree |
| coordinator-mission-direct | Opus | Read, Glob, Grep, Bash | Yes | read-only, no-worktree |
| coordinator-mission-planned | Opus | Read, Glob, Grep, Bash | Yes | read-only, no-worktree |
| mission-analyst | Opus | Read, Glob, Grep, Bash | Yes | read-only, no-worktree |
| mission-analyst-planned | Opus | Read, Glob, Grep, Bash | Yes | read-only, no-worktree |
| execution-director | Opus | Read, Glob, Grep, Bash | Yes | read-only, no-worktree |
| lead-mission | Opus | Read, Write, Edit, Glob, Grep, Bash, Task | Yes | — |
| plan-review-lead | Opus | Read, Glob, Grep, Bash | Yes | read-only, no-worktree |
| plan-devil-advocate | Sonnet | Read, Glob, Grep, Bash | No | read-only, no-worktree |
| plan-security-critic | Sonnet | Read, Glob, Grep, Bash | No | read-only, no-worktree |
| plan-performance-critic | Sonnet | Read, Glob, Grep, Bash | No | read-only, no-worktree |
| plan-second-opinion | Sonnet | Read, Glob, Grep, Bash | No | read-only, no-worktree |
| plan-simulator | Sonnet | Read, Glob, Grep, Bash | No | read-only, no-worktree |
| monitor | Sonnet | Read, Glob, Grep, Bash | No | read-only, no-worktree |
| research-lead | Opus | Read, Write, Glob, Grep, Bash, Agent | Yes | no-worktree |
| researcher | Opus | Read, Glob, Grep, Bash, MCP | No | read-only |
| architect | Opus | Read, Write, Glob, Grep, Bash | Yes | no-worktree |
| architecture-review-lead | Opus | Read, Glob, Grep, Bash | Yes | read-only, no-worktree |
| plan-architecture-critic | Sonnet | Read, Glob, Grep, Bash | No | read-only, no-worktree |
| architecture-sync | Sonnet | Read, Glob, Grep, Bash | No | read-only, no-worktree |

---

## Mission Lifecycle

Use `ha mission` when you want the system to clarify the objective, build a plan, and only dispatch execution after a deliberate handoff. Use the fast-path `ha coordinator` flow for tasks that are already clear.

### Phases

| Phase | Description | Tiers |
|-------|-------------|-------|
| **understand** | Analyst explores the codebase and objective; produces a brief | planned, full |
| **align** | Coordinator and analyst align on constraints and acceptance criteria | full only |
| **decide** | Mission-level decisions are made and recorded | full only |
| **plan** | Analyst produces workstream decomposition and execution plan | planned, full |
| **execute** | Leads and builders implement per the plan | all |
| **done** | Mission marked complete, artifacts committed | all |

### Tiers

| Tier | Phases Active | When To Use |
|------|---------------|-------------|
| **direct** | execute → done | Task is already fully decomposed. Fastest path. |
| **planned** | understand → plan → execute → done | Needs exploration before coding. Standard flow. |
| **full** | understand → align → decide → plan → execute → done | Ambiguous, multi-subsystem, or architecturally significant. |

New missions start in **assess mode** (`tier=null`). The coordinator evaluates complexity and selects a tier with `ha mission tier set <tier>`. Tiers only escalate upward — you cannot downgrade a running mission.

### Flow Walkthrough

```
ha mission start --slug <slug> --objective "<objective>"
    │
    ▼
Assess mode — coordinator selects tier
    │
    ▼
understand phase — analyst explores, produces brief
    │  (full tier only)
    ├─▶ align phase — constraints and acceptance criteria locked
    │
    ├─▶ decide phase — mission decisions recorded
    │
    ▼
plan phase — workstreams decomposed, specs drafted
    │
    ▼ ha mission handoff
execute phase — leads and builders implement
    │
    ▼
done — ha mission complete
```

**Answering questions during a mission:**

```bash
ha mission answer --body "Admin-only. Keep passwords. No external provider."
```

**Monitoring:**

```bash
ha mission status          # current phase, active agents, gate state
ha mission graph           # visual phase graph
ha mission output          # artifacts produced so far
```

### Watchdog

`ha watch` starts the Tier 0 watchdog daemon. It drives missions forward automatically:

- Evaluates gate conditions each tick (mail received, artifacts present, agent done)
- Nudges agents when grace periods expire
- Recovers dead agents (restarts if tmux session is gone)
- Advances phase transitions without manual intervention

The watchdog runs the mission graph engine (`src/missions/engine.ts`) each tick, evaluating gate conditions tracked in the `mission_gate_state` table.

Run `ha watch` in a background terminal for any long-running mission. Without it, phases require manual nudging.

---

## More CLI Commands

Additional commands not covered above. Run `ha <command> --help` for full options.

| Command | Purpose |
|---------|---------|
| `ha supervisor start|stop|status` | [DEPRECATED] Per-project supervisor — use `ha sling --capability lead` instead |
| `ha discover` | Brownfield codebase discovery via scout swarm |
| `ha research start|stop|status|list|output` | Deep research sessions |
| `ha run list|show|complete` | Manage runs |
| `ha review sessions|session|handoffs|specs|stale` | Deterministic quality review |
| `ha eval run|show|list|compare` | Scenario-based orchestration evaluation |
| `ha snapshot` | Capture swarm state for recovery |
| `ha recover` | Restore from snapshot bundle |
| `ha workflow import|sync` | Import and sync workflows from task directory |
| `ha group create|status|add|remove|list` | Batch coordination |
| `ha compact [domain]` | Compact kura expertise records |
| `ha clean` | Wipe runtime state (`--all`, `--mail`, `--sessions`, etc.) |
| `ha spec write <task-id>` | Write task specification |
| `ha context generate|show|invalidate` | Manage project context cache |
| `ha completions` | Shell completions |
| `ha log <event>` | Log hook event (tool-start, tool-end, session-end) |
| `ha ecosystem` | Show os-eco tool versions and health |
| `ha prime` | Load orchestrator/agent context |

---

## Quick Start Checklist

```bash
# 1. Initialize Haru in your project
ha init

# 2. Run the guided setup wizard (first time only)
ha quickstart

# 3. Install hooks into your Claude Code session
ha hooks install

# 4. For simple, clear tasks — spawn a coordinator directly
ha sling task-id --capability coordinator

# 5. For complex or ambiguous tasks — use ha mission
ha mission start --slug my-task --objective "Describe the goal here"
ha watch   # run in a separate terminal to drive the mission forward

# 6. Monitor progress
ha status
ha dashboard

# 7. When leads signal merge_ready, merge their branches
ha merge --all

# 8. Check health and clean up
ha health
ha worktree clean
```
