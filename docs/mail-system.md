# Mail System

This document is the contributor guide for Overstory's inter-agent mail system.
It covers the SQLite store schema, message types, delivery semantics, the dead
letter queue, broadcast topology, the nudge system, mailbox identity, concurrency
model, and instructions for adding new message types.

---

## 1. What the Mail System Does

The mail system is the primary communication channel between agents in an
Overstory swarm. It replaces ad-hoc tmux key injection with a durable,
inspectable, crash-safe message queue backed by SQLite.

Key properties:
- **Durable**: messages survive process restarts
- **Inspectable**: `ha mail list`, `ha mail read`, `ha mail check` expose all messages
- **Crash-safe**: claim/ack semantics ensure messages are not lost on agent crash
- **Low latency**: ~1-5ms per query (synchronous `bun:sqlite`)
- **Concurrent**: WAL mode allows many agents to read/write simultaneously

---

## 2. Source Files

| File | Purpose |
|------|---------|
| `src/mail/types.ts` | All type definitions: `MailMessage`, `MailMessageType`, `MailPayloadMap`, etc. |
| `src/mail/store.ts` | Low-level SQLite CRUD: `createMailStore()` |
| `src/mail/client.ts` | High-level operations: `createMailClient()`, `parsePayload()` |
| `src/mail/broadcast.ts` | Group address resolution: `resolveGroupAddress()` |
| `src/mail/nudge.ts` | Pending nudge markers: `writePendingNudge()`, `readAndClearPendingNudge()` |
| `src/mail/identity.ts` | Mailbox alias resolution: `canonicalizeMailAgentName()` |

---

## 3. SQLite Store

**Source:** `src/mail/store.ts:155`

The mail store lives at `.overstory/mail.db`. It is opened with WAL mode and a
5-second busy timeout so multiple agent processes can write concurrently without
blocking:

```typescript
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA busy_timeout = 5000");
```
(`src/mail/store.ts:427`)

### Schema

```sql
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,            -- "msg-" + 12-char random alphanumeric
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'status'
    CHECK(type IN ('status','question','result','error',
                   'worker_done','merge_ready','merged',...)),
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK(priority IN ('low','normal','high','urgent')),
  thread_id TEXT,                 -- Conversation threading
  payload TEXT,                   -- JSON for protocol messages
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK(state IN ('queued','claimed','acked','failed','dead_letter')),
  claimed_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  fail_reason TEXT,
  mission_id TEXT                 -- Scope messages to a mission
)
```

Indexes for efficient polling:

```sql
CREATE INDEX idx_state ON messages(to_agent, state, next_retry_at);
CREATE INDEX idx_thread ON messages(thread_id);
CREATE INDEX idx_messages_mission ON messages(to_agent, mission_id, state);
```

A separate `mail_check_state` table (migration v4) tracks per-agent last-check
timestamps for debounce in `ha mail check --inject`.

### Migrations

The store runs through 4 versioned migrations at startup:

| Version | Change |
|---------|--------|
| 1 | Initial schema |
| 2 | Delivery state columns (`state`, `claimed_at`, `attempt`, etc.) + `payload` + `CHECK` constraints |
| 3 | `mission_id` column + composite index `(to_agent, mission_id, state)` |
| 4 | `mail_check_state` table for debounce tracking |

Migrations are idempotent — `detect()` checks whether the change is already
applied before running `up()`. This makes them safe to re-run after an incomplete
initialization (`src/mail/store.ts:177`).

---

## 4. Message Types

**Source:** `src/mail/types.ts:7`

All message types are validated by a SQL `CHECK` constraint built from the
runtime constant `MAIL_MESSAGE_TYPES` (`src/mail/types.ts:42`).

### Semantic Types (human-authored)

| Type | Use |
|------|-----|
| `status` | Progress update from an agent |
| `question` | Request for clarification (expects reply) |
| `result` | Task completion report |
| `error` | Failure notification (use `--priority urgent`) |

### Protocol Types (structured coordination)

| Type | Payload interface | Use |
|------|------------------|----|
| `worker_done` | `WorkerDonePayload` | Worker signals task completion to supervisor |
| `merge_ready` | `MergeReadyPayload` | Supervisor signals branch is ready for merge |
| `merged` | `MergedPayload` | Merger confirms successful merge with tier used |
| `merge_failed` | `MergeFailedPayload` | Merger signals merge failure with conflict files |
| `escalation` | `EscalationPayload` | Any agent escalates an issue to a higher-level agent |
| `health_check` | `HealthCheckPayload` | Watchdog probes agent liveness |
| `dispatch` | `DispatchPayload` | Coordinator dispatches work to a supervisor |
| `assign` | `AssignPayload` | Supervisor assigns work to a specific worker |
| `rate_limited` | `RateLimitedPayload` | Agent signals it has hit a provider rate limit |
| `mission_finding` | `MissionFindingPayload` | Lead escalates cross-stream finding to analyst |
| `analyst_resolution` | `AnalystResolutionPayload` | Analyst resolves a finding |
| `execution_guidance` | `ExecutionGuidancePayload` | Execution director sends guidance to leads |
| `analyst_recommendation` | `AnalystRecommendationPayload` | Analyst recommends action to coordinator |
| `execution_handoff` | `ExecutionHandoffPayload` | Coordinator hands off execution to director |
| `mission_resolution` | `MissionResolutionPayload` | Coordinator resolves a mission decision |
| `plan_review_request` | `PlanReviewRequestPayload` | Analyst requests plan review |
| `plan_critic_verdict` | `PlanCriticVerdictPayload` | Individual critic sends verdict |
| `plan_review_consolidated` | `PlanReviewConsolidatedPayload` | Lead consolidates critic verdicts |
| `plan_revision_complete` | `PlanRevisionCompletePayload` | Analyst signals plan revision done |
| `decision_gate` | `DecisionGatePayload` | Agent pauses for human decision |
| `task_retried` | `TaskRetriedPayload` | Agent reports a task retry |
| `breaker_tripped` | `BreakerTrippedPayload` | Circuit breaker opened |
| `breaker_reset` | `BreakerResetPayload` | Circuit breaker closed |
| `task_rerouted` | `TaskReroutedPayload` | Task rerouted to different capability |
| `reroute_recommendation` | `RerouteRecommendationPayload` | Reroute engine recommendation |
| `health_policy_action` | `HealthPolicyActionPayload` | Health policy engine action |

The full `MailPayloadMap` interface maps each protocol type to its payload
(`src/mail/types.ts:401`). Use `parsePayload<T>()` from `src/mail/client.ts:123`
to decode protocol payloads safely:

```typescript
const payload = parsePayload(message, "worker_done");
if (payload !== null) {
    console.log(payload.branch); // typed as WorkerDonePayload
}
```

---

## 5. Delivery Semantics

**Source:** `src/mail/store.ts:67` (`claim` method)

The store implements claim/ack semantics for crash-safe delivery. The delivery
lifecycle is:

```
queued → claimed → acked          (normal path)
       → claimed → failed → queued (retry after backoff, up to maxAttempts)
       → claimed → dead_letter    (maxAttempts exceeded)
```

### `MailStore` interface

```typescript
export interface MailStore {
    insert(message): MailMessage;
    insertBatch(messages): MailMessage[];   // atomic fan-out for broadcast
    getUnread(agentName, missionId?): MailMessage[];
    getAll(filters?): MailMessage[];
    getById(id): MailMessage | null;
    getByThread(threadId): MailMessage[];
    markRead(id): void;
    claim(agentName, leaseTimeoutSec?, missionId?): MailMessage[];
    ack(id, agentName?): void;
    ackBatch(ids): void;
    nack(id, options?): { deadLettered: boolean };
    getDlq(filters?): MailMessage[];
    replayDlq(id): void;
    replayDlqBatch(ids): number;
    purgeDlq(options?): number;
    purge(options): number;
    recordMailCheck(agent): void;
    isMailCheckDebounced(agent, debounceMs): boolean;
    close(): void;
}
```

**Claim** atomically transitions `queued` messages to `claimed` in a single
transaction:
1. Expire stale claims older than `leaseTimeoutSec` (default 120s) back to `queued`
2. Promote retryable `failed` messages whose `next_retry_at` has passed to `queued`
3. Claim all available `queued` messages (up to 200, `MAX_POLL_BATCH`)
(`src/mail/store.ts:632`)

**Nack** with backoff: `backoffBaseSec * 2^attempt`, capped at `backoffMaxSec`
(default base=5s, max=60s). After `maxAttempts` (default 3), the message moves
to `dead_letter` (`src/mail/store.ts:924`).

---

## 6. Mail Client

**Source:** `src/mail/client.ts:17` (`MailClient` interface)

The `MailClient` wraps `MailStore` with higher-level operations. Agents interact
with the client, not the store directly.

```typescript
export interface MailClient {
    send(msg): string;                         // returns message ID
    sendProtocol<T>(msg): string;              // typed protocol message
    sendBroadcast(msg): string[];              // atomic fan-out
    check(agentName, missionId?): MailMessage[];  // claim+ack (at-most-once)
    checkInject(agentName, missionId?): { output: string; messageIds: string[] };
    checkClaimed(agentName, missionId?): MailMessage[];  // claim only, no ack
    claim(agentName, leaseTimeoutSec?, missionId?): MailMessage[];
    ack(id): void;
    ackBatch(ids): void;
    nack(id, reason?, options?): { deadLettered: boolean };
    getDlq(filters?): MailMessage[];
    replayDlq(id): void;
    replayDlqBatch(ids): number;
    list(filters?): MailMessage[];
    markRead(id): { alreadyRead: boolean };
    reply(messageId, body, from): MailMessage;
    recordMailCheck(agent): void;
    isMailCheckDebounced(agent, debounceMs): boolean;
    close(): void;
}
```

### Delivery guarantees

| Method | Semantics |
|--------|-----------|
| `check()` | At-most-once: claims then immediately acks. Loss on crash between claim and processing. |
| `checkClaimed()` | Claim-only. Caller must `ack()` per message after successful processing. |
| `checkInject()` | Claim-only. Caller must `ackBatch(messageIds)` after writing output to stdout. |
| `claim()` | Same as `checkClaimed()` with configurable lease timeout. |

The `checkInject()` method is used exclusively by the `UserPromptSubmit` hook
(`ha mail check --inject`). It claims messages and returns a formatted string for
injection into the agent's context, plus the message IDs so the hook can ack
them after successful stdout output (`src/mail/client.ts:357`).

### `reply()`

Reply routing: if the replier is the original sender, the reply goes to the
original recipient. Otherwise it goes to the original sender. Thread ID is
preserved (`src/mail/client.ts:415`).

---

## 7. Dead Letter Queue

**Source:** `src/mail/store.ts:93` (`getDlq`, `replayDlq`, `purgeDlq`)

Messages that exhaust all retry attempts transition to `dead_letter` state. The
DLQ is a view over the same `messages` table filtered by `state = 'dead_letter'`.

CLI commands:

```bash
ha mail dlq                           # List dead-lettered messages
ha mail dlq --agent my-agent          # Filter by recipient agent
ha mail retry <msg-id>                # Replay single message back to queued
ha mail purge --dlq                   # Delete all dead-letter messages
ha mail purge --dlq --older-than 24h  # Delete DLQ messages older than 24h
```

`replayDlqBatch()` resets messages atomically: clears `state` to `queued`,
resets `attempt` to 0, clears `fail_reason`, `next_retry_at`, and `claimed_at`.

---

## 8. Broadcast Topology

**Source:** `src/mail/broadcast.ts:52` (`resolveGroupAddress`)

Group addresses (starting with `@`) are resolved to lists of individual agents
based on the current active sessions. Group addresses are not stored in the
database — they are expanded at send time by the CLI.

| Address | Resolves to |
|---------|------------|
| `@all` | All active agents except sender |
| `@builders` / `@builder` | Agents with capability `builder` |
| `@scouts` / `@scout` | Agents with capability `scout` |
| `@reviewers` / `@reviewer` | Agents with capability `reviewer` |
| `@leads` / `@lead` | Agents with capability `lead` |
| `@mergers` / `@merger` | Agents with capability `merger` |
| `@coordinators` / `@coordinator` | Agents with capability `coordinator` |
| `@critics` / `@plan-critics` | Active plan critic agents (all 5 critic capabilities) |

`sendBroadcast()` uses `insertBatch()` to insert all copies atomically so no
partial fan-out occurs on crash (`src/mail/client.ts:329`).

---

## 9. Nudge System

**Source:** `src/mail/nudge.ts`

The nudge system avoids injecting raw tmux keystrokes (which corrupt tool I/O)
by writing a JSON marker file per agent instead. On the next `mail check --inject`
call, the marker is consumed and a priority banner is prepended to the injected
output.

### Auto-nudge triggers

Messages with the following types or priorities trigger a pending nudge:

- **Priority**: `urgent` or `high`
- **Types**: `worker_done`, `merge_ready`, `error`, `escalation`, `merge_failed`,
  `question`, `result`, `analyst_recommendation`, `mission_finding`

(`src/mail/nudge.ts:19`, `shouldAutoNudge()`)

### Marker files

Written to `.overstory/pending-nudges/{agentName}.json`:

```typescript
export interface PendingNudge {
    from: string;
    reason: string;
    subject: string;
    messageId: string;
    createdAt: string;
}
```

`writePendingNudge()` overwrites any existing marker — only the latest nudge
matters. `readAndClearPendingNudge()` reads the marker and deletes it atomically
(`src/mail/nudge.ts:67`, `90`).

**Dispatch nudges** (`type === "dispatch"`) trigger an immediate tmux key
injection rather than a marker file, because they target newly spawned agents at
the welcome screen (`src/mail/nudge.ts:43`).

---

## 10. Identity and Addressing

**Source:** `src/mail/identity.ts`

Agents are addressed by name (e.g., `my-builder`, `upstream-merger`,
`orchestrator`). A small alias map handles capability variants:

```typescript
const MAILBOX_ALIASES = new Map<string, string>([
    ["coordinator-mission", "coordinator"],
]);
```

`canonicalizeMailAgentName()` resolves an alias to its canonical name.
`expandMailAgentNames()` returns all names (canonical first, then aliases) for
use in inbox polling — ensuring an agent receives messages sent to either name
(`src/mail/identity.ts:14`, `23`).

All addresses are canonicalized at insert time by `createMailClient` so the
database always stores canonical names.

---

## 11. Concurrency Model

The store uses `bun:sqlite`'s synchronous API throughout. WAL mode allows
multiple readers concurrent with one writer. The 5-second `busy_timeout` causes
any blocked writer to retry automatically rather than failing immediately.

Prepared statements are cached per store instance (`stmtCache` for dynamic filter
queries, explicit named statements for all hot paths). Transactions wrap all
multi-step operations: `claim` (expire + promote + claim), `ackBatch`, `nack`
(read + write), `insertBatch` (`src/mail/store.ts:614-688`).

The `MAX_POLL_BATCH = 200` cap on claim/poll queries prevents unbounded memory
use when an agent has a large backlog (`src/mail/store.ts:479`).

---

## 12. Adding a New Message Type (Contributor Guide)

### Step 1: Define the payload interface

In `src/mail/types.ts`, add your payload interface:

```typescript
export interface MyEventPayload {
    taskId: string;
    outcome: "success" | "failure";
    details: string;
}
```

### Step 2: Add the type string

Add the type name to `MailProtocolType` (`src/mail/types.ts:11`):

```typescript
export type MailProtocolType =
    | "worker_done"
    // ...existing types...
    | "my_event";
```

Add it to the `MAIL_MESSAGE_TYPES` runtime array (`src/mail/types.ts:42`):

```typescript
export const MAIL_MESSAGE_TYPES: readonly MailMessageType[] = [
    // ...existing entries...
    "my_event",
] as const;
```

The `CHECK` constraint in `CREATE_TABLE` is generated from this array at module
load time, so the SQL schema stays in sync automatically.

### Step 3: Register in the payload map

Add the mapping to `MailPayloadMap` (`src/mail/types.ts:401`):

```typescript
export interface MailPayloadMap {
    // ...existing entries...
    my_event: MyEventPayload;
}
```

### Step 4: Send and receive

Senders use `sendProtocol()`:

```typescript
client.sendProtocol({
    from: "my-agent",
    to: "coordinator",
    subject: "Event occurred",
    body: "Brief description",
    type: "my_event",
    payload: { taskId: "task-123", outcome: "success", details: "..." },
});
```

Receivers use `parsePayload()`:

```typescript
const payload = parsePayload(message, "my_event");
if (payload !== null) {
    console.log(payload.outcome); // typed as MyEventPayload
}
```

### Step 5: Consider nudge behavior

If the new type requires immediate attention, add it to `AUTO_NUDGE_TYPES` in
`src/mail/nudge.ts:19`:

```typescript
export const AUTO_NUDGE_TYPES: ReadonlySet<MailMessageType> = new Set([
    // ...existing types...
    "my_event",
]);
```

### Step 6: Run migrations (if adding to existing installations)

The `CHECK` constraint is rebuilt by migration v2 when new types are added.
Because migration v2 detects whether the current `CREATE TABLE` SQL matches, it
will auto-migrate on next store open. No manual migration version is needed for
type additions — but verify this by running `bun test src/mail/store.test.ts`
with a pre-existing database.
