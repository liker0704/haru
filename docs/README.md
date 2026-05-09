# Overstory Documentation

## Getting Started
- [Onboarding](onboarding.md) — operator setup, first mission, agent overview
- [Mission Usage](ov-mission-usage.md) — operator guide for missions
- [CLI Reference (CLAUDE.md)](../CLAUDE.md#cli-quick-reference) — all 55 commands

## Architecture
- [Architecture Overview](architecture/overview.md) — system map, metrics, hotspots
- [Architecture README](architecture/README.md) — entry point for arch docs
- [ADR: Graph Engine Lifecycle](architecture/adr-graph-engine-lifecycle.md)
- [Workflows](architecture/workflows.md)
- [Code Review (snapshot 2026-04-05)](architecture/review.md)

## Subsystem Guides
- [Mission System (RFC)](ov-mission.md) — design rationale
- [Mission Implementation Plan (historical)](ov-mission-implementation.md)
- [Runtime Adapters](runtime-adapters.md) — adding a new runtime
- [Runtime Abstraction (design)](runtime-abstraction.md)
- [Canopy Prompt Architecture](canopy-prompt-architecture.md)
- [Config Versioning](config-versioning.md)
- [Health Scoring](health-scoring.md)
- [Eval Framework](eval.md)
- [Review Contour](review-contour.md)
- [Merge System](merge-system.md) — 4-tier conflict resolution
- [Doctor Checks](doctor.md) — 11 health-check categories
- [Mail System](mail-system.md) — inter-agent messaging
- [Recovery](recovery.md) — snapshot/restore
- [Agent Lifecycle](agent-lifecycle.md) — spawn/overlay/state machine
- [Dashboard TUI](dashboard.md)
- [Tracker Adapters](tracker-adapters.md) — seeds/beads/github
- [DB Migrations](db-migrations.md)

## Audits & Analysis
- [Agent Lifecycle Audit](analysis/agent-lifecycle-audit.md) — snapshot, see banner
- [Watchdog Mission-Tick Audit](analysis/watchdog-mission-tick-audit.md) — snapshot, see banner

## Research
- [Autonomous Software Systems 2025](research/autonomous-software-systems-2025.md)

## Archive
- [Historical Documents](archive/) — superseded fix plans, completed-epic docs
