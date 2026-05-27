# Command reference

Every command supports `--json` where noted. Global flags: `-q`/`--quiet`,
`--timing`, `--project <path>`. ANSI colors respect `NO_COLOR`.

## Core workflow

| Command | Description |
|---------|-------------|
| `ha init` | Initialize `.overstory/` and bootstrap ecosystem tools (`--yes`, `--name`, `--tools`, `--skip-mulch`, `--skip-seeds`, `--skip-canopy`, `--skip-onboard`, `--json`) |
| `ha sling <task-id>` | Spawn a worker agent (`--capability`, `--name`, `--spec`, `--files`, `--parent`, `--depth`, `--skip-scout`, `--skip-review`, `--max-agents`, `--dispatch-max-agents`, `--skip-task-check`, `--no-scout-check`, `--runtime`, `--base-branch`, `--profile`, `--json`) |
| `ha stop <agent-name>` | Terminate a running agent (`--clean-worktree`, `--json`) |
| `ha prime` | Load context for orchestrator/agent (`--agent`, `--compact`) |
| `ha spec write <task-id>` | Write a task specification (`--body`) |
| `ha discover` | Discover a brownfield codebase via coordinator-driven scout swarm (`--skip`, `--name`, `--attach`, `--watchdog`, `--json`) |
| `ha update` | Refresh `.overstory/` managed files from installed package (`--agents`, `--manifest`, `--hooks`, `--dry-run`, `--json`) |

## Coordination

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

## Messaging

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

## Task groups

| Command | Description |
|---------|-------------|
| `ha group create <name>` | Create a task group for batch tracking |
| `ha group status <name>` | Show group progress |
| `ha group add <name> <issue-id>` | Add issue to group |
| `ha group remove <name> <issue-id>` | Remove issue from group |
| `ha group list` | List all groups |

## Merge

| Command | Description |
|---------|-------------|
| `ha merge` | Merge agent branches into canonical (`--branch`, `--all`, `--into`, `--dry-run`, `--json`) |

## Mission orchestration

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

## Configuration

| Command | Description |
|---------|-------------|
| `ha config list` | Show all current settings (merged config as YAML) |
| `ha config get <key>` | Get a specific value (e.g., `taskTracker.backend`) |
| `ha config set <key> <value>` | Set a config value (`--local` for machine-local overrides) |
| `ha config reset` | Reset config to defaults (preserves project name/root/branch) |

## Observability

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

## Infrastructure

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
| `ha ecosystem` | Show ecosystem tool versions and health (`--json`) |
| `ha upgrade` | Upgrade haru to latest npm version (`--check`, `--all`, `--json`) |
| `ha agents discover` | Discover agents by capability/state/parent (`--capability`, `--state`, `--parent`, `--json`) |
| `ha completions <shell>` | Generate shell completions (bash, zsh, fish) |
