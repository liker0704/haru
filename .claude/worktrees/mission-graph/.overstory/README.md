# .overstory/

This directory is managed by [haru](https://github.com/jayminwest/haru) — a multi-agent orchestration system for Claude Code.

Overstory turns a single Claude Code session into a multi-agent team by spawning worker agents in git worktrees via tmux, coordinating them through a custom SQLite mail system, and merging their work back with tiered conflict resolution.

## Key Commands

- `ha init`          — Initialize this directory
- `ha status`        — Show active agents and state
- `ha sling <id>`    — Spawn a worker agent
- `ha mail check`    — Check agent messages
- `ha merge`         — Merge agent work back
- `ha dashboard`     — Live TUI monitoring
- `ha doctor`        — Run health checks

## Structure

- `config.yaml`             — Project configuration
- `agent-manifest.json`     — Agent registry
- `hooks.json`              — Claude Code hooks config
- `agent-defs/`             — Agent definition files (.md)
- `specs/`                  — Task specifications
- `agents/`                 — Per-agent state and identity
- `worktrees/`              — Git worktrees (gitignored)
- `logs/`                   — Agent logs (gitignored)
