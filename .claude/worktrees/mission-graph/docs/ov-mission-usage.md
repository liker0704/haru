# `ha mission` Operator Guide

`ha mission v1` is implemented and no longer experimental.
Use this document for day-to-day operation.

Related references:

- [Design / RFC context](./ov-mission.md)
- [Implementation / acceptance contract](./ov-mission-implementation.md)

## When To Use `ha mission`

Use `ha mission` for larger tasks where you want the system to:

1. clarify the objective first
2. build mission artifacts and workstreams
3. dispatch execution only after handoff
4. keep mission state durable across runtime interruptions

Use the fast-path `ha coordinator` flow when the task is already clear and you
do not need mission-level freeze / handoff discipline.

## Core Lifecycle

### 1. Start a mission

```bash
ha mission start --slug auth-refresh --objective "Stabilize the auth mission"
```

What this does immediately:

- creates a mission-owned run
- writes `.overstory/current-mission.txt` and `.overstory/current-run.txt`
- creates `.overstory/missions/<mission-id>/...`
- starts the long-lived `mission-analyst`

Execution does **not** start yet.
`execution-director` starts only at `ha mission handoff`.

### 2. Answer pending mission questions

If the mission is waiting on clarification, answer through:

```bash
ha mission answer --body "Admin-only. Keep passwords. No external provider."
```

Or:

```bash
ha mission answer --file answers.md
```

Useful inspection commands while the mission is forming:

```bash
ha mission status
ha mission output
ha mission artifacts
```

## Mission Artifacts

The important paths are:

```text
.overstory/current-mission.txt
.overstory/current-run.txt
.overstory/missions/<mission-id>/
.overstory/missions/<mission-id>/plan/workstreams.json
.overstory/specs/<task-id>.md
.overstory/specs/<task-id>.meta.json
```

`current-mission.txt` is only a convenience pointer.
Mission-aware recovery now falls back to the durable `missions` table when that
pointer is stale or missing.

## Handoff And Execution

Once planning artifacts are ready, hand off execution:

```bash
ha mission handoff
```

Runtime requirements enforced by `v1`:

- every workstream in `plan/workstreams.json` must have a canonical `taskId`
- dispatch happens against the canonical task before runtime spawn
- `execution-director` can spawn only `lead`
- mission `builder` / `reviewer` dispatch requires `--spec`
- stale or missing mission spec metadata blocks spawn / resume

After handoff, monitor the mission with:

```bash
ha mission status
ha mission output
ha status
ha dashboard
```

Shared `ha status` and `ha dashboard` now show mission runtime presence for:

- coordinator
- mission analyst
- execution director

## Refresh Briefs And Resume Workstreams

When a brief changes, refresh the affected workstream:

```bash
ha mission refresh-briefs --workstream ws-auth
```

Effect:

- the workstream is paused at mission level
- the current spec metadata is marked stale
- missing metadata is treated as regeneration-required, not as a pass

To make the workstream resumable again, regenerate the current spec from the
current brief:

```bash
ha spec write task-auth --agent lead-auth --workstream-id ws-auth --brief-path .overstory/missions/<mission-id>/plan/ws-auth.md < auth-spec.md
```

Then resume:

```bash
ha mission resume ws-auth
```

`ha mission resume` will refuse to continue if the workstream has no current
spec metadata.

If you need a manual operator pause without changing runtime agent state:

```bash
ha mission pause ws-auth --reason "Waiting on product clarification"
```

## Finish Or Abort

Complete the mission:

```bash
ha mission complete
```

Or stop it intentionally:

```bash
ha mission stop
```

Both terminal paths export a mission result bundle.
You can also force bundle regeneration later:

```bash
ha mission bundle --mission-id <mission-id> --force
```

## Review Commands

Mission review now has command-level proof for both list and single-mission
paths:

```bash
ha review missions
ha review mission <mission-id-or-slug>
```

Add `--json` when you want machine-readable output.

## Recommended Operator Loop

For most real missions, the operator-facing loop is:

```bash
ha mission start --slug <slug> --objective "<objective>"
ha mission status
ha mission output
ha mission answer --body "..."
ha mission handoff
ha status
ha dashboard
ha mission refresh-briefs --workstream <id>
ha spec write <task-id> --agent <lead-name> --workstream-id <id> --brief-path <brief-path> < spec.md
ha mission resume <id>
ha mission complete
ha review mission <mission-id-or-slug>
```

## Troubleshooting

- `ha mission handoff` fails:
  check that `plan/workstreams.json` is valid, every workstream has a canonical
  `taskId`, and each dispatchable workstream has a real `briefPath`.
- `ha mission resume` fails:
  the workstream still has stale or missing `.overstory/specs/<task-id>.meta.json`;
  regenerate the spec with `ha spec write`.
- `builder` / `reviewer` spawn fails under mission mode:
  supply `--spec`, and make sure the spec metadata matches the task being
  dispatched.
