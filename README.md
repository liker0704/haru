# Haru

> Forked from jayminwest/overstory under MIT License.

Multi-agent orchestration for AI coding agents.

[![npm](https://img.shields.io/npm/v/@hana/haru-cli)](https://www.npmjs.com/package/@hana/haru-cli)
[![CI](https://github.com/jayminwest/haru/actions/workflows/ci.yml/badge.svg)](https://github.com/jayminwest/haru/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Overstory turns a single coding session into a multi-agent team by spawning worker agents in git worktrees via tmux, coordinating them through a custom SQLite mail system, and merging their work back with tiered conflict resolution. A pluggable `AgentRuntime` interface lets you swap between runtimes — Claude Code, [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent), [Gemini CLI](https://github.com/google-gemini/gemini-cli), or your own adapter.

> **Warning: Agent swarms are not a universal solution.** Do not deploy Overstory without understanding the risks of multi-agent orchestration — compounding error rates, cost amplification, debugging complexity, and merge conflicts are the normal case, not edge cases. Read [STEELMAN.md](STEELMAN.md) for a full risk analysis and the [Agentic Engineering Book](https://github.com/jayminwest/agentic-engineering-book) ([web version](https://jayminwest.com/agentic-engineering-book)) before using this tool in production.

## Install

Requires [Bun](https://bun.sh) v1.0+, git, and tmux. At least one supported agent runtime must be installed:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude` CLI)
- [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) (`pi` CLI)
- [GitHub Copilot](https://github.com/features/copilot) (`copilot` CLI)
- [Codex](https://github.com/openai/codex) (`codex` CLI)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`gemini` CLI)
- [Cursor CLI](https://cursor.com/docs/cli/overview) (`agent` CLI)
- [Sapling](https://github.com/jayminwest/sapling) (`sp` CLI)
- [OpenCode](https://opencode.ai) (`opencode` CLI)

```bash
bun install -g @hana/haru-cli
```

Or try without installing:

```bash
npx @hana/haru-cli --help
```

### Development

```bash
git clone https://github.com/jayminwest/haru.git
cd haru
bun install
bun link              # Makes 'ov' available globally

bun test              # Run all tests
bun run lint          # Biome check
bun run typecheck     # tsc --noEmit
```

## Quick Start

```bash
# Initialize haru in your project
cd your-project
ha init

# Install hooks into .claude/settings.local.json
ha hooks install

# Start a coordinator (persistent orchestrator)
ha coordinator start

# Or spawn individual worker agents
ha sling <task-id> --capability builder --name my-builder

# Check agent status
ha status

# Live dashboard for monitoring the fleet
ha dashboard

# Nudge a stalled agent
ha nudge <agent-name>

# Check mail from agents
ha mail check --inject
```

## Commands

Every command supports `--json` where noted. Global flags: `-q`/`--quiet`, `--timing`, `--project <path>`. ANSI colors respect `NO_COLOR`.

### Core Workflow

| Command | Description |
|---------|-------------|
| `ha init` | Initialize `.overstory/` and bootstrap os-eco tools (`--yes`, `--name`, `--tools`, `--skip-mulch`, `--skip-seeds`, `--skip-canopy`, `--skip-onboard`, `--json`) |
| `ha sling <task-id>` | Spawn a worker agent (`--capability`, `--name`, `--spec`, `--files`, `--parent`, `--depth`, `--skip-scout`, `--skip-review`, `--max-agents`, `--dispatch-max-agents`, `--skip-task-check`, `--no-scout-check`, `--runtime`, `--base-branch`, `--profile`, `--json`) |
| `ha stop <agent-name>` | Terminate a running agent (`--clean-worktree`, `--json`) |
| `ha prime` | Load context for orchestrator/agent (`--agent`, `--compact`) |
| `ha spec write <task-id>` | Write a task specification (`--body`) |
| `ha discover` | Discover a brownfield codebase via coordinator-driven scout swarm (`--skip`, `--name`, `--attach`, `--watchdog`, `--json`) |
| `ha update` | Refresh `.overstory/` managed files from installed package (`--agents`, `--manifest`, `--hooks`, `--dry-run`, `--json`) |

### Coordination

| Command | Description |
|---------|-------------|
| `ha coordinator start` | Start persistent coordinator agent (`--attach`/`--no-attach`, `--watchdog`, `--monitor`, `--profile`) |
| `ha coordinator stop` | Stop coordinator |
| `ha coordinator status` | Show coordinator state |
| `ha coordinator send` | Fire-and-forget message to coordinator (`--subject`) |
| `ha coordinator ask` | Synchronous request/response to coordinator (`--subject`, `--timeout`) |
| `ha coordinator output` | Show recent coordinator output (`--lines`) |
| `ha coordinator check-complete` | Evaluate exit triggers, return completion status |
| `ha supervisor start` | **[DEPRECATED]** Start per-project supervisor agent |
| `ha supervisor stop` | **[DEPRECATED]** Stop supervisor |
| `ha supervisor status` | **[DEPRECATED]** Show supervisor state |

### Messaging

| Command | Description |
|---------|-------------|
| `ha mail send` | Send a message (`--to`, `--subject`, `--body`, `--type`, `--priority`) |
| `ha mail check` | Check inbox — unread messages (`--agent`, `--inject`, `--debounce`, `--json`) |
| `ha mail list` | List messages with filters (`--from`, `--to`, `--unread`) |
| `ha mail read <id>` | Mark message as read |
| `ha mail reply <id>` | Reply in same thread (`--body`) |
| `ha mail purge` | Purge old messages (`--older-than`, `--read-only`, `--dry-run`) |
| `ha mail dlq` | List or inspect dead-letter queue messages |
| `ha mail retry <id>` | Retry a dead-lettered message |
| `ha nudge <agent> [message]` | Send a text nudge to an agent (`--from`, `--force`, `--json`) |

### Task Groups

| Command | Description |
|---------|-------------|
| `ha group create <name>` | Create a task group for batch tracking |
| `ha group status <name>` | Show group progress |
| `ha group add <name> <issue-id>` | Add issue to group |
| `ha group remove <name> <issue-id>` | Remove issue from group |
| `ha group list` | List all groups |

### Merge

| Command | Description |
|---------|-------------|
| `ha merge` | Merge agent branches into canonical (`--branch`, `--all`, `--into`, `--dry-run`, `--json`) |

### Mission Orchestration

| Command | Description |
|---------|-------------|
| `ha mission start` | Start a mission with objective (`--slug`, `--objective`) |
| `ha mission status` | Show mission phase, agents, workstreams |
| `ha mission answer` | Answer a pending mission question (`--body`, `--file`) |
| `ha mission handoff` | Hand off from plan to execute phase |
| `ha mission pause <ws-id>` | Pause a workstream (`--reason`) |
| `ha mission resume <ws-id>` | Resume a paused workstream |
| `ha mission complete` | Complete the mission (runs holdout validation) |
| `ha mission stop` | Stop the mission (suspends all agents) |
| `ha mission list` | List all missions |
| `ha mission show` | Show mission details |
| `ha mission output` | Show mission coordinator output |
| `ha mission graph` | Show mission graph state |
| `ha mission workstream-complete <ws-id>` | Manually mark a workstream as completed |
| `ha mission refresh-briefs` | Refresh workstream briefs after scope change |
| `ha mission bundle` | Export mission result bundle |
| `ha mission update` | Update mission objective or metadata |
| `ha mission extract-learnings` | Extract reusable learnings from a completed mission |
| `ha mission artifacts` | List artifacts produced during a mission |
| `ha mission tier set` | Set the active tier for a mission |
| `ha mission tier show` | Show current tier for a mission |
| `ha mission holdout` | Run holdout validation against the mission |

### Configuration

| Command | Description |
|---------|-------------|
| `ha config list` | Show all current settings (merged config as YAML) |
| `ha config get <key>` | Get a specific value (e.g., `taskTracker.backend`) |
| `ha config set <key> <value>` | Set a config value (`--local` for machine-local overrides) |
| `ha config reset` | Reset config to defaults (preserves project name/root/branch) |

### Observability

| Command | Description |
|---------|-------------|
| `ha status` | Show all active agents, worktrees, tracker state (`--json`, `--verbose`, `--all`) |
| `ha dashboard` | Live TUI dashboard for agent monitoring (`--interval`, `--all`) |
| `ha inspect <agent>` | Deep per-agent inspection (`--follow`, `--interval`, `--no-tmux`, `--limit`, `--json`) |
| `ha trace` | View agent/task timeline (`--agent`, `--run`, `--since`, `--until`, `--limit`, `--json`) |
| `ha errors` | Aggregated error view across agents (`--agent`, `--run`, `--since`, `--until`, `--limit`, `--json`) |
| `ha replay` | Interleaved chronological replay (`--run`, `--agent`, `--since`, `--until`, `--limit`, `--json`) |
| `ha feed` | Unified real-time event stream (`--follow`, `--interval`, `--agent`, `--run`, `--json`) |
| `ha logs` | Query NDJSON logs across agents (`--agent`, `--level`, `--since`, `--until`, `--follow`, `--json`) |
| `ha costs` | Token/cost analysis and breakdown (`--live`, `--self`, `--agent`, `--run`, `--bead`, `--by-capability`, `--last`, `--json`) |
| `ha metrics` | Show session metrics (`--last`, `--json`) |
| `ha run list` | List orchestration runs (`--last`, `--json`) |
| `ha run show <id>` | Show run details |
| `ha run complete` | Mark current run as completed |

### Infrastructure

| Command | Description |
|---------|-------------|
| `ha hooks install` | Install orchestrator hooks to `.claude/settings.local.json` (`--force`) |
| `ha hooks uninstall` | Remove orchestrator hooks |
| `ha hooks status` | Check if hooks are installed |
| `ha worktree list` | List worktrees with status |
| `ha worktree clean` | Remove completed worktrees (`--completed`, `--all`, `--force`) |
| `ha watch` | Start watchdog daemon — Tier 0 (`--interval`, `--background`) |
| `ha monitor start` | Start Tier 2 monitor agent |
| `ha monitor stop` | Stop monitor agent |
| `ha monitor status` | Show monitor state |
| `ha log <event>` | Log a hook event (`--agent`) |
| `ha clean` | Clean up worktrees, sessions, artifacts (`--completed`, `--all`, `--run`) |
| `ha doctor` | Run health checks on haru setup — 11 categories (`--category`, `--fix`, `--json`) |
| `ha ecosystem` | Show os-eco tool versions and health (`--json`) |
| `ha upgrade` | Upgrade haru to latest npm version (`--check`, `--all`, `--json`) |
| `ha agents discover` | Discover agents by capability/state/parent (`--capability`, `--state`, `--parent`, `--json`) |
| `ha completions <shell>` | Generate shell completions (bash, zsh, fish) |

## Architecture

Overstory uses instruction overlays and tool-call guards to turn agent sessions into orchestrated workers. Each agent runs in an isolated git worktree via tmux. Inter-agent messaging is handled by a custom SQLite mail system (WAL mode, ~1-5ms per query) with typed protocol messages and broadcast support. A FIFO merge queue with 4-tier conflict resolution merges agent branches back to canonical. A tiered watchdog system (Tier 0 mechanical daemon, Tier 1 AI-assisted triage, Tier 2 monitor agent) ensures fleet health. See [CLAUDE.md](CLAUDE.md) for full technical details.

### Runtime Adapters

Overstory is runtime-agnostic. The `AgentRuntime` interface (`src/runtimes/types.ts`) defines the contract — each adapter handles spawning, config deployment, guard enforcement, readiness detection, and transcript parsing for its runtime. Set the default in `config.yaml` or override per-agent with `ha sling --runtime <name>`.

| Runtime | CLI | Guard Mechanism | Stability |
|---------|-----|-----------------|-----------|
| Claude Code | `claude` | `settings.local.json` hooks | Stable |
| Sapling | `sp` | `.sapling/guards.json` | Stable |
| Pi | `pi` | `.pi/extensions/` guard extension | Experimental |
| Copilot | `copilot` | (none — `--allow-all-tools`) | Experimental |
| Cursor | `agent` | (none — `--yolo`) | Experimental |
| Codex | `codex` | OS-level sandbox (Seatbelt/Landlock) | Experimental |
| Gemini | `gemini` | `--sandbox` flag | Experimental |
| OpenCode | `opencode` | (none) | Experimental |

## How It Works

Instruction overlays + tool-call guards + the `ov` CLI turn your coding session into a multi-agent orchestrator. A persistent coordinator agent manages task decomposition and dispatch, while a mechanical watchdog daemon monitors agent health in the background.

```
Orchestrator (multi-repo coordinator of coordinators)
  --> Coordinator (persistent orchestrator at project root)
        --> Supervisor / Lead (team lead, depth 1)
              --> Workers: Scout, Builder, Reviewer, Merger (depth 2)
```

### Agent Types

| Agent | Role | Access |
|-------|------|--------|
| **Orchestrator** | Multi-repo coordinator of coordinators — dispatches coordinators per sub-repo | Read-only |
| **Coordinator** | Persistent orchestrator — decomposes objectives, dispatches agents, tracks task groups | Read-only |
| **Supervisor** | Per-project team lead — manages worker lifecycle, handles nudge/escalation | Read-only |
| **Scout** | Read-only exploration and research | Read-only |
| **Builder** | Implementation and code changes | Read-write |
| **Reviewer** | Validation and code review | Read-only |
| **Lead** | Team coordination, can spawn sub-workers | Read-write |
| **Merger** | Branch merge specialist | Read-write |
| **Monitor** | Tier 2 continuous fleet patrol — ongoing health monitoring | Read-only |
| **Mission Analyst** | Research + planning for missions — spawns scouts, creates workstream plans | Read-only |
| **Execution Director** | Mission execution — dispatches leads per workstream, forwards merge signals | Read-only |
| **Architect** | Design authority (TDD mode) — writes architecture.md, test-plan.yaml, reviews merged code | Read-only |
| **Plan-Review-Lead** | Multi-critic review loop — spawns critics, runs convergence until approve/stuck | Read-only |
| **Tester** | RED-phase test writer (TDD full mode) — writes failing tests before builders | Read-write |

### Key Architecture

- **Agent Definitions**: Two-layer system — base `.md` files define the HOW (workflow), per-task overlays define the WHAT (task scope). Base definition content is injected into spawned agent overlays automatically.
- **Messaging**: Custom SQLite mail system with typed protocol — 8 message types (`worker_done`, `merge_ready`, `dispatch`, `escalation`, etc.) for structured agent coordination, plus broadcast messaging with group addresses (`@all`, `@builders`, etc.)
- **Worktrees**: Each agent gets an isolated git worktree — no file conflicts between agents
- **Merge**: FIFO merge queue (SQLite-backed) with 4-tier conflict resolution
- **Watchdog**: Tiered health monitoring — Tier 0 mechanical daemon (tmux/pid liveness), Tier 1 AI-assisted failure triage, Tier 2 monitor agent for continuous fleet patrol
- **Mission Lifecycle**: Graph execution engine monitors mission phases (understand → plan → execute → done), nudges stuck agents, auto-resumes waiting agents. See [ADR](docs/architecture/adr-graph-engine-lifecycle.md)
- **Waiting State**: Agents that dispatch sub-agents set `state=waiting` — system prevents premature completion, auto-resumes when results arrive
- **Tool Enforcement**: Runtime-specific guards (hooks for Claude Code, extensions for Pi) mechanically block file modifications for non-implementation agents and dangerous git operations for all agents
- **Task Groups**: Batch coordination with auto-close when all member issues complete
- **Session Lifecycle**: Checkpoint save/restore for compaction survivability, handoff orchestration for crash recovery
- **Token Instrumentation**: Session metrics extracted from runtime transcript files (JSONL)

## Project Structure

```
haru/
  src/
    index.ts                      CLI entry point (Commander.js program)
    types.ts                      Shared types and interfaces
    config.ts                     Config loader + validation
    errors.ts                     Custom error types
    json.ts                       Standardized JSON envelope helpers
    commands/                     One file per CLI subcommand (58 commands)
      agents.ts                   Agent discovery and querying
      coordinator.ts              Persistent orchestrator lifecycle
      supervisor.ts               Team lead management [DEPRECATED]
      dashboard.ts                Live TUI dashboard (ANSI via Chalk)
      hooks.ts                    Orchestrator hooks management
      sling.ts                    Agent spawning
      group.ts                    Task group batch tracking
      nudge.ts                    Agent nudging
      mail.ts                     Inter-agent messaging
      monitor.ts                  Tier 2 monitor management
      merge.ts                    Branch merging
      status.ts                   Fleet status overview
      prime.ts                    Context priming
      init.ts                     Project initialization
      worktree.ts                 Worktree management
      watch.ts                    Watchdog daemon
      log.ts                      Hook event logging
      logs.ts                     NDJSON log query
      feed.ts                     Unified real-time event stream
      run.ts                      Orchestration run lifecycle
      trace.ts                    Agent/task timeline viewing
      clean.ts                    Worktree/session cleanup
      doctor.ts                   Health check runner (11 check modules)
      inspect.ts                  Deep per-agent inspection
      spec.ts                     Task spec management
      errors.ts                   Aggregated error view
      replay.ts                   Interleaved event replay
      stop.ts                     Agent termination
      costs.ts                    Token/cost analysis
      metrics.ts                  Session metrics
      ecosystem.ts                os-eco tool dashboard
      update.ts                   Refresh managed files
      upgrade.ts                  npm version upgrades
      discover.ts                 Brownfield codebase discovery via coordinator-driven scout swarm
      completions.ts              Shell completion generation (bash/zsh/fish)
    canopy/
      client.ts                   Canopy client (prompt rendering, listing, emission)
    agents/                       Agent lifecycle management
      manifest.ts                 Agent registry (load + query)
      overlay.ts                  Dynamic CLAUDE.md overlay generator
      identity.ts                 Persistent agent identity (CVs)
      checkpoint.ts               Session checkpoint save/restore
      lifecycle.ts                Handoff orchestration
      hooks-deployer.ts           Deploy hooks + tool enforcement
      guard-rules.ts              Shared guard constants (tool lists, bash patterns)
    worktree/                     Git worktree + tmux management
    mail/                         SQLite mail system (typed protocol, broadcast)
    merge/                        FIFO queue + conflict resolution
    watchdog/                     Tiered health monitoring (daemon, triage, health)
    logging/                      Multi-format logger + sanitizer + reporter + color control + shared theme/format
    metrics/                      SQLite metrics + pricing + transcript parsing
    doctor/                       Health check modules (11 checks)
    insights/                     Session insight analyzer for auto-expertise
    runtimes/                     AgentRuntime abstraction (registry + adapters: Claude, Pi, Copilot, Codex, Gemini, Sapling, OpenCode, Cursor)
    tracker/                      Pluggable task tracker (beads + seeds backends)
    mulch/                        mulch client (programmatic API + CLI wrapper)
    e2e/                          End-to-end lifecycle tests
  agents/                         Base agent definitions (.md, 32 roles) + skill definitions
  templates/                      Templates for overlays and hooks
```

## Configuration

### Gateway Providers

Route agent API calls through custom gateway endpoints (z.ai, OpenRouter, self-hosted proxies). Configure providers in `.overstory/config.yaml`:

```yaml
providers:
  anthropic:
    type: native
  zai:
    type: gateway
    baseUrl: https://api.z.ai/v1
    authTokenEnv: ZAI_API_KEY
  openrouter:
    type: gateway
    baseUrl: https://openrouter.ai/api/v1
    authTokenEnv: OPENROUTER_API_KEY
models:
  builder: zai/claude-sonnet-4-6
  scout: openrouter/openai/gpt-4o
```

**How it works:** Model refs use `provider/model-id` format. Overstory sets `ANTHROPIC_BASE_URL` to the gateway `baseUrl`, `ANTHROPIC_AUTH_TOKEN` from the env var named in `authTokenEnv`, and `ANTHROPIC_API_KEY=""` to prevent direct Anthropic calls. The agent receives `"sonnet"` as a model alias and Claude Code routes via env vars.

**Environment variable notes:**
- `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` are mutually exclusive per-agent
- Gateway agents get `ANTHROPIC_API_KEY=""` and `ANTHROPIC_AUTH_TOKEN` from provider config
- Direct Anthropic API calls (merge resolver, watchdog triage) still need `ANTHROPIC_API_KEY` in the orchestrator env

**Validation:** `ha doctor --category providers` checks reachability, auth tokens, model-provider refs, and tool-use compatibility.

**`ProviderConfig` fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `native` or `gateway` | Yes | Provider type |
| `baseUrl` | string | Gateway only | API endpoint URL |
| `authTokenEnv` | string | Gateway only | Env var name holding auth token |

## Troubleshooting

### Coordinator died during startup

This error means the coordinator tmux session exited before the TUI became ready. The most common cause is slow shell initialization.

**Step 1: Measure shell startup time**

```bash
time zsh -i -c exit   # For zsh
time bash -i -c exit  # For bash
```

If startup takes more than 1 second, slow shell init is likely the cause.

**Step 2: Common slow-startup causes**

| Cause | Typical delay | Fix |
|-------|---------------|-----|
| oh-my-zsh with many plugins | 1-5s | Reduce plugins, switch to lighter framework (zinit with lazy loading) |
| nvm (Node Version Manager) | 1-3s | Use `--no-use` + lazy-load nvm, or switch to fnm/volta |
| pyenv init | 0.5-2s | Lazy-load pyenv |
| rbenv init | 0.5-1s | Lazy-load rbenv |
| starship prompt | 0.5-1s | Check starship timings |
| conda auto-activate | 1-3s | `auto_activate_base: false` in `.condarc` |
| Homebrew shellenv | 0.5-1s | Cache output instead of evaluating every shell start |

**Step 3: Configure `shellInitDelayMs`** in `.overstory/config.yaml`:

```yaml
runtime:
  shellInitDelayMs: 3000
```

- Default: `0` (no delay)
- Typical values: `1000`–`5000` depending on shell startup time
- Values above `30000` (30s) trigger a warning
- Inserts a delay between tmux session creation and TUI readiness polling

**Step 4: Optimization examples**

Lazy-load nvm (add to `~/.zshrc` or `~/.bashrc`):

```bash
# Lazy-load nvm — only activates when you first call nvm/node/npm
export NVM_DIR="$HOME/.nvm"
nvm() { unset -f nvm node npm npx; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; nvm "$@"; }
node() { unset -f nvm node npm npx; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; node "$@"; }
npm()  { unset -f nvm node npm npx; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; npm  "$@"; }
npx()  { unset -f nvm node npm npx; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; npx  "$@"; }
```

Reduce oh-my-zsh plugins (edit `~/.zshrc`):

```bash
# Before: plugins=(git zsh-autosuggestions zsh-syntax-highlighting node npm python ruby rbenv pyenv ...)
# After: keep only what you use regularly
plugins=(git)
```

## Part of os-eco

Overstory is part of the [os-eco](https://github.com/jayminwest/os-eco) AI agent tooling ecosystem.

<p align="center">
  <img src="https://raw.githubusercontent.com/jayminwest/os-eco/main/branding/logo.png" alt="os-eco" width="444" />
</p>

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT
