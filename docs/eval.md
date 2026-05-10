# Scenario-Based Eval Framework

This document is the contributor guide for Haru's eval framework. It covers
scenario definition, assertion kinds, the runner pipeline, artifact storage, and
a step-by-step walkthrough for writing custom scenarios.

---

## 1. What `ha eval` Does

The eval framework runs end-to-end orchestration tests against disposable
fixture repos. Each **scenario** defines a repo template, config overrides,
startup actions, and assertions. The runner:

1. Creates a temporary fixture repo from the scenario's template.
2. Initializes haru (`ha init`) in the fixture.
3. Applies config overrides and runs startup actions.
4. Starts a coordinator and polls for completion.
5. Collects metrics from the fixture's SQLite databases.
6. Evaluates assertions against the collected metrics.
7. Writes artifacts and cleans up the fixture.

This provides a deterministic, repeatable way to verify that the swarm system
handles dispatch, merging, watchdog behavior, and cost budgets correctly.

---

## 2. Scenario Directory Structure

Each scenario lives in its own directory under `evals/`:

```
evals/
  dispatch-smoke/
    scenario.yaml         # Required: scenario metadata
    assertions.yaml       # Required: assertions to evaluate
    repo-template/        # Optional: files copied into the fixture repo
      hello.txt
      goodbye.txt
      CLAUDE.md
```

---

## 3. `scenario.yaml` Format

**Source:** [`src/eval/scenario.ts`](../src/eval/scenario.ts)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `description` | `string` | Yes | -- | Human description of what this scenario tests |
| `timeout_ms` | `number` | No | `300000` (5 min) | Max time to wait for coordinator completion |
| `config_overrides` | `object` | No | `{}` | Deep-merged into `.overstory/config.yaml` |
| `startup_actions` | `list` | No | `[]` | Shell commands to run before coordinator start |

### `startup_actions` entries

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | `string` | Yes | Shell command to run in the fixture repo |
| `description` | `string` | No | Human description of the action |

### Example `scenario.yaml`

```yaml
description: "Smoke test: coordinator dispatches 2 tasks, workers spawn and complete"
timeout_ms: 600000

config_overrides:
  agents:
    maxConcurrent: 4

startup_actions:
  - command: su create --title "Write hello.txt" --type task --priority 2
    description: "Create first task for dispatch"
  - command: su create --title "Write goodbye.txt" --type task --priority 2
    description: "Create second task for dispatch"
```

---

## 4. `assertions.yaml` Format

**Source:** [`src/eval/assertions.ts`](../src/eval/assertions.ts)

The file must contain a top-level `assertions` key with a non-empty list.

Each assertion has:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | `AssertionKind` | Yes | One of the 8 supported kinds |
| `expected` | `number \| boolean \| string` | Yes | Threshold or expected value |
| `label` | `string` | No | Human label (auto-generated from kind if omitted) |

### Example `assertions.yaml`

```yaml
assertions:
  - kind: min_workers_spawned
    label: "At least 2 workers spawned"
    expected: 2
  - kind: tasks_completed
    label: "Both tasks completed"
    expected: 2
  - kind: no_zombies
    label: "No zombie agents"
    expected: true
  - kind: max_stall_rate
    label: "No stalled agents"
    expected: 0.0
```

---

## 5. Assertion Kinds

**Source:** [`src/eval/types.ts`](../src/eval/types.ts), [`src/eval/assertions.ts`](../src/eval/assertions.ts)

```typescript
export type AssertionKind =
	| "min_workers_spawned"
	| "no_zombies"
	| "merge_queue_empty"
	| "tasks_completed"
	| "max_stall_rate"
	| "max_cost"
	| "max_duration_ms"
	| "custom"
	| "before"
	| "after"
	| "within"
	| "event_count"
	| "success_ratio"
	| "percentile_bound"
	| "max_retry_frequency";
```

### Metric-based assertions

| Kind | Expected type | Metric compared | Pass condition |
|------|---------------|-----------------|----------------|
| `min_workers_spawned` | `number` | `metrics.totalAgents` | `actual >= expected` |
| `no_zombies` | `boolean` | `metrics.zombieCount` | `actual === 0` |
| `merge_queue_empty` | `boolean` | `metrics.mergeQueuePending` | `actual === 0` |
| `tasks_completed` | `number` | `metrics.tasksCompleted` | `actual >= expected` |
| `max_stall_rate` | `number` (0.0--1.0) | `metrics.stallRate` | `actual <= expected` |
| `max_cost` | `number` (USD) | `metrics.estimatedCostUsd` | `actual <= expected` |
| `max_duration_ms` | `number` (ms) | `metrics.durationMs` | `actual <= expected` |
| `custom` | `string` | -- | Always passes (LLM judge not yet implemented) |

### Temporal and event-based assertions

These assertion kinds operate on the full event timeline (collected from
`events.db` after the run) using `EventSelector` fields (`eventA`, `eventB`,
`selector`, `windowMs`).

| Kind | Description |
|------|-------------|
| `before` | Asserts that an event matching `eventA` occurs strictly before any event matching `eventB`. |
| `after` | Asserts that an event matching `eventA` occurs strictly after any event matching `eventB`. |
| `within` | Asserts that the gap between matching `eventA` and `eventB` is at most `windowMs` milliseconds. |
| `event_count` | Counts events matching `selector` and compares the count against `expected`. |
| `success_ratio` | Pass-ratio assertion (used primarily by probabilistic runs); compares observed ratio against `expected`. |
| `percentile_bound` | For a numeric `metric` and a `percentile`, asserts that the percentile value is within `expected`. |
| `max_retry_frequency` | Caps how often retry-flavored events appear within the timeline; fails when retries exceed the threshold. |

`EventSelector` matches events by `eventType`, optional `agentName`, and an
optional `dataMatch` substring on the event payload.

---

## 5b. Probabilistic Eval Runs

**Source:** [`src/eval/probabilistic.ts`](../src/eval/probabilistic.ts),
[`src/eval/stochastic.ts`](../src/eval/stochastic.ts)

A probabilistic run executes the same scenario multiple times and aggregates
results. This is useful for flaky-by-design behavior (rate-limit swaps,
non-deterministic dispatch ordering) where a single trial is not a meaningful
signal.

A scenario opts into probabilistic mode by adding a `trials` block to its
`scenario.yaml`:

```yaml
trials:
  count: 20
  maxConcurrent: 4
```

### Types

```typescript
export interface ProbabilisticConfig {
	count: number;            // Number of trials to run
	maxConcurrent?: number;   // Max concurrent trials (default: 1, sequential)
}

export interface TrialResult {
	trialIndex: number;       // 0-based trial index
	evalResult: EvalResult;   // Full single-run result
}

export interface AggregateStats {
	trialCount: number;
	passCount: number;
	failCount: number;
	successRatio: number;
	timeoutCount: number;
	// Per-metric: mean, median, min, max, p5, p95, stddev
	metrics: Record<string, MetricAggregate>;
}

export interface StochasticAssertionResult {
	kind: string;
	label: string;
	passed: boolean;
	actual: number;
	expected: number;
	message: string;
}

export interface ProbabilisticEvalResult {
	runId: string;
	scenarioName: string;
	scenarioPath: string;
	startedAt: string;
	completedAt: string;
	totalDurationMs: number;
	config: ProbabilisticConfig;
	trials: TrialResult[];
	aggregateStats: AggregateStats;
	stochasticAssertions: StochasticAssertionResult[];
	passed: boolean;          // True iff all stochastic assertions passed
}
```

`src/eval/probabilistic.ts` orchestrates the trial loop (with bounded
concurrency) and aggregates per-trial `EvalResult`s into `AggregateStats`.
`src/eval/stochastic.ts` evaluates threshold assertions (`success_ratio`,
`percentile_bound`, `max_retry_frequency`, etc.) against the aggregate
statistics.

---

## 6. Collected Metrics

**Source:** [`src/eval/types.ts`](../src/eval/types.ts) (`EvalMetrics`)

The runner reads metrics from the fixture's SQLite databases after the
coordinator finishes (or times out). These metrics feed assertion evaluation.

```typescript
export interface EvalMetrics {
	totalAgents: number;
	completedAgents: number;
	zombieCount: number;
	stallCount: number;
	stallRate: number;
	mergeSuccessCount: number;
	mergeConflictCount: number;
	mergeQueuePending: number;
	tasksCompleted: number;
	durationMs: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	estimatedCostUsd: number;
	nudgesSent: number;
	runtimeSwaps: number;
	medianSessionDurationMs: number;
}
```

Data sources:

| Database | Metrics extracted |
|----------|-------------------|
| `sessions.db` | `totalAgents`, `completedAgents`, `zombieCount`, `stallCount`, `runtimeSwaps` |
| `metrics.db` | `totalInputTokens`, `totalOutputTokens`, `estimatedCostUsd`, `medianSessionDurationMs` |
| `merge-queue.db` | `mergeSuccessCount`, `mergeConflictCount`, `mergeQueuePending` |
| `events.db` | `nudgesSent` |

---

## 7. CLI Usage

### `ha eval run <scenario>`

Run a scenario against a temporary fixture repo.

```bash
ha eval run evals/dispatch-smoke
ha eval run evals/dispatch-smoke --json
ha eval run evals/dispatch-smoke --timeout 120000
```

Exits with code 1 if any assertion fails.

### `ha eval show <run-id>`

Display results of a previous eval run.

```bash
ha eval show a1b2c3d4-...
ha eval show a1b2c3d4-... --json
```

### `ha eval list`

List all past eval runs, sorted by start time (newest first).

```bash
ha eval list
ha eval list --json
```

### `ha eval compare <run-a> <run-b>`

Compare two eval runs side-by-side. Shows metric deltas (B - A) and assertion
regressions/improvements.

```bash
ha eval compare a1b2c3d4-... e5f6g7h8-...
ha eval compare a1b2c3d4-... e5f6g7h8-... --json
```

---

## 8. Artifact Storage

**Source:** [`src/eval/store.ts`](../src/eval/store.ts)

After each run, artifacts are written to:

```
.overstory/eval-runs/<run-id>/
  manifest.json       # Run ID, scenario name, pass/fail, timestamps
  summary.json        # Full EvalResult (metrics + assertions + metadata)
  assertions.json     # Per-assertion results
  metrics.json        # Collected EvalMetrics
  sessions.json       # Raw sessions from the fixture's sessions.db
  events.jsonl        # Raw events from the fixture's events.db (NDJSON)
```

The `summary.json` file is the canonical artifact -- `ha eval show` and
`ha eval compare` both read from it.

Human-readable rendering of these artifacts (tables, deltas, summaries
printed by `ha eval show`, `ha eval list`, and `ha eval compare`) is handled
by [`src/eval/report.ts`](../src/eval/report.ts). The store
([`src/eval/store.ts`](../src/eval/store.ts)) is responsible for writing the
artifact files; `report.ts` formats them for the terminal.

---

## 9. Runner Pipeline

**Source:** [`src/eval/runner.ts`](../src/eval/runner.ts)

```
loadScenario(scenarioPath)
        |
        v
runEval(config)
        |
        +-- 1. Copy repo-template (if exists) or init empty git repo
        +-- 2. ha init --yes --skip-kura --skip-suji --skip-tane
        +-- 3. Apply config_overrides to .overstory/config.yaml
        +-- 4. Run startup_actions (sequentially)
        +-- 5. ha coordinator start --no-attach
        +-- 6. Poll ha coordinator check-complete (every 5s, up to timeout)
        +-- 7. collectMetrics() from fixture SQLite databases
        +-- 8. evaluateAssertions(scenario.assertions, metrics)
        +-- 9. Build EvalResult { passed, timedOut, metrics, assertions }
        +-- 10. Cleanup: ha coordinator stop, rm fixture dir
```

The runner always cleans up -- even on timeout or error, the coordinator is
stopped and the fixture directory is removed.

---

## 10. Writing a Custom Scenario

### Step 1: Create the scenario directory

```bash
mkdir -p evals/my-scenario
```

### Step 2: Write `scenario.yaml`

```yaml
description: "Verify that rate-limited agents swap runtimes gracefully"
timeout_ms: 900000

config_overrides:
  rateLimit:
    enabled: true
    behavior: swap
    swapRuntime: codex
  agents:
    maxConcurrent: 2

startup_actions:
  - command: su create --title "Implement feature A" --type task --priority 1
```

### Step 3: Write `assertions.yaml`

```yaml
assertions:
  - kind: min_workers_spawned
    expected: 1
  - kind: tasks_completed
    expected: 1
  - kind: no_zombies
    expected: true
  - kind: max_cost
    label: "Under $5 budget"
    expected: 5.0
  - kind: max_duration_ms
    label: "Completes within 15 minutes"
    expected: 900000
```

### Step 4: Add a repo template (optional)

Create `evals/my-scenario/repo-template/` with files that should exist in the
fixture repo before `ha init` runs. This directory is copied verbatim into the
fixture. If omitted, an empty git repo with a single `README.md` commit is
created.

### Step 5: Run it

```bash
ha eval run evals/my-scenario
```
