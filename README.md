# Haru

> 春 — spring. Multi-agent orchestrator for AI coding agents.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Haru turns a single coding session into a multi-agent team. It spawns worker
agents in isolated git worktrees via tmux, coordinates them through a custom
SQLite mail system, and merges their work back with tiered conflict resolution.
A pluggable `AgentRuntime` interface lets you swap between Claude Code, Pi,
Gemini, and other runtimes, or add your own adapter.

> **Warning.** Multi-agent orchestration is not a free lunch — compounding error
> rates, cost amplification, debugging complexity, and merge conflicts are the
> normal case, not edge cases. Treat it as a power tool, not a default.

## Install

Requires [Bun](https://bun.sh) v1.0+, git, and tmux. At least one supported
agent runtime must be installed — see [docs/runtimes.md](docs/runtimes.md).

```bash
bun install -g @hana/haru-cli
```

### Development

```bash
git clone https://github.com/liker0704/haru.git
cd haru
bun install
bun link
bun test
```

## Quick start

```bash
# Initialize haru in your project
cd your-project
ha init

# Install hooks into .claude/settings.local.json
ha hooks install

# Start a coordinator (persistent orchestrator)
ha coordinator start

# Or spawn an individual worker
ha sling <task-id> --capability builder --name my-builder

# Check fleet status
ha status

# Live dashboard
ha dashboard
```

## Commands

The most common commands:

| Command | What it does |
|---------|-------------|
| `ha init` | Initialize `.overstory/` and bootstrap ecosystem tools |
| `ha sling <task-id>` | Spawn a worker agent |
| `ha coordinator start` | Start a persistent orchestrator |
| `ha mission start` | Start a mission with an objective |
| `ha status` | Show active agents and worktrees |
| `ha dashboard` | Live TUI fleet dashboard |
| `ha mail check` | Surface new messages from agents |
| `ha merge` | Merge agent branches into canonical |
| `ha doctor` | Run health checks on haru setup |
| `ha watch` | Start the watchdog daemon |

Full command reference: [docs/commands.md](docs/commands.md).

## Architecture

Each agent runs in an isolated git worktree via tmux. Inter-agent messaging is
handled by a custom SQLite mail system (WAL mode, ~1–5ms per query) with typed
protocol messages. A FIFO merge queue with tiered conflict resolution merges
branches back to canonical. A tiered watchdog (mechanical daemon, AI-assisted
triage, continuous monitor) keeps the fleet healthy.

For details, see:

- [docs/architecture/overview.md](docs/architecture/overview.md)
- [docs/architecture/adr-graph-engine-lifecycle.md](docs/architecture/adr-graph-engine-lifecycle.md)
- [docs/architecture/adr-ecosystem-decomposition.md](docs/architecture/adr-ecosystem-decomposition.md)
- [CLAUDE.md](CLAUDE.md) — full technical reference for Claude Code

## Configuration

Most settings live in `.overstory/config.yaml`. Common topics have dedicated
docs:

- [Gateway providers](docs/providers.md) — route agent calls through z.ai,
  OpenRouter, or self-hosted proxies
- [Runtimes](docs/runtimes.md) — supported agent runtimes and guard mechanisms
- [Troubleshooting](TROUBLESHOOTING.md) — common setup issues

## Part of Hana

Haru is part of the [Hana](https://github.com/liker0704/hana) ecosystem:

- [Haru](https://github.com/liker0704/haru) — orchestration
- [Kura](https://github.com/liker0704/kura) — structured expertise
- [Suji](https://github.com/liker0704/suji) — issue tracking
- [Tane](https://github.com/liker0704/tane) — prompt management

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT

---

Maintained by [Kyryl Zmiienko](https://www.linkedin.com/in/kyryl-zmiienko/).

Originally forked because of its mail system, but has since diverged
significantly in scope and direction and is no longer tracked against upstream.
