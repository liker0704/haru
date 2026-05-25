/**
 * CLI command: ha log <event> --agent <name> [--stdin]
 *
 * Called by Pre/PostToolUse and Stop hooks.
 * Events: tool-start, tool-end, session-end.
 * Writes to .overstory/logs/{agent-name}/{session-timestamp}/.
 *
 * When --stdin is passed, reads one line of JSON from stdin containing the full
 * hook payload (tool_name, tool_input, transcript_path, session_id, etc.)
 * and writes structured events to the EventStore for observability.
 */

import { join } from "node:path";
import { Command } from "commander";
import { PERSISTENT_CAPABILITIES } from "../agents/capabilities.ts";
import { updateIdentity } from "../agents/identity.ts";
import { detectHaruDir, loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { filterToolArgs } from "../events/tool-filter.ts";
import { analyzeSessionInsights } from "../insights/analyzer.ts";
import { createLogger } from "../logging/logger.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { estimateCost } from "../metrics/pricing.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { parseTranscriptUsage } from "../metrics/transcript.ts";
import { createMulchClient, type MulchClient } from "../mulch/client.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession } from "../types.ts";

/**
 * Get or create a session timestamp directory for the agent.
 * Uses a file-based marker to track the current session directory.
 */
async function getSessionDir(logsBase: string, agentName: string): Promise<string> {
	const agentLogsDir = join(logsBase, agentName);
	const markerPath = join(agentLogsDir, ".current-session");

	const markerFile = Bun.file(markerPath);
	if (await markerFile.exists()) {
		const sessionDir = (await markerFile.text()).trim();
		if (sessionDir.length > 0) {
			return sessionDir;
		}
	}

	// Create a new session directory
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const sessionDir = join(agentLogsDir, timestamp);
	const { mkdir } = await import("node:fs/promises");
	await mkdir(sessionDir, { recursive: true });
	await Bun.write(markerPath, sessionDir);
	return sessionDir;
}

/**
 * Update the lastActivity timestamp for an agent in the SessionStore.
 * Non-fatal: silently ignores errors to avoid breaking hook execution.
 */
function updateLastActivity(projectRoot: string, agentName: string, _event?: string): void {
	try {
		const overstoryDir = join(projectRoot, detectHaruDir(projectRoot));
		const { store } = openSessionStore(overstoryDir);
		try {
			const session = store.getByName(agentName);
			if (session) {
				store.updateLastActivity(agentName);
				if (
					session.state === "booting" ||
					session.state === "zombie" ||
					session.state === "waiting"
				) {
					store.updateState(agentName, "working");
				}
			}
		} finally {
			store.close();
		}
	} catch {
		// Non-fatal: don't break logging if session update fails
	}
}

/**
 * Transition agent state to 'waiting' on session-end.
 *
 * The Stop hook fires on every turn boundary for ALL agents (interactive mode).
 * Instead of trying to determine if the agent is "really done" (which required
 * 5 escape hatches), we always set waiting. The watchdog daemon is the sole
 * authority on completion — it checks completion signals, run status, etc.
 *
 * Skip booting agents: Stop hook can fire on the first turn before any tool
 * calls. Leave in booting so tool-start → working transition works.
 *
 * Exception (#452): when a non-persistent agent has already sent a `result`
 * mail this session, the Stop hook transitions state directly to `completed`
 * (bypassing the watchdog's idleLoopThresholdMs path) to prevent the idle-loop
 * caused by checkInboxAndNudge re-waking the agent on stale claimed dispatch
 * mail. Persistent agents (coordinator, monitor, mission-analyst,
 * execution-director, plan-review-lead, architecture-review-lead, etc.) are
 * excluded — they also send `result` mail but must keep their normal lifecycle
 * (state stays `waiting`, watchdog decides termination).
 *
 * Non-fatal: silently ignores errors to avoid breaking hook execution.
 */
async function handleSessionEnd(projectRoot: string, agentName: string): Promise<void> {
	try {
		const overstoryDir = join(projectRoot, detectHaruDir(projectRoot));
		const { store } = openSessionStore(overstoryDir);
		try {
			const session = store.getByName(agentName);
			if (!session) return;

			// Skip booting — Stop hook can fire on first turn before any tool calls.
			// Leave in booting so the tool-start hook can transition to working.
			if (session.state === "booting") {
				store.updateLastActivity(agentName);
				return;
			}

			// Always transition to waiting. The watchdog decides completion.
			let didTransitionToWaiting = false;
			if (session.state !== "completed" && session.state !== "waiting") {
				store.updateState(agentName, "waiting");
				didTransitionToWaiting = true;
			}
			store.updateLastActivity(agentName);

			// #452: if the agent already sent a `result` mail this session, treat it
			// as terminal. Without this, leaf agents (scout/builder/reviewer) get
			// re-woken by checkInboxAndNudge because their dispatch mail is still in
			// `state=claimed` (read-only scouts never explicitly ack; convergence-type
			// claims are excluded from expire). The nudge → "Loop N — No change" Stop
			// hook → nudge cycle would otherwise run forever.
			//
			// Persistent agents (coordinator, mission-analyst, plan-review-lead, etc.)
			// also send `result` mail but must stay alive — they may keep working on
			// review loops, post-merge reconciliation, etc. Without this exclusion,
			// the next inbound mail would respawn them via the messaging layer
			// (`state=completed` → respawn) → context loss + respawn storm.
			if (
				!PERSISTENT_CAPABILITIES.has(session.capability) &&
				(await hasSentResultMailThisSession(overstoryDir, agentName, session.startedAt))
			) {
				if (session.state !== "completed") {
					store.updateState(agentName, "completed");
				}
				return;
			}

			// #324: auto-nudge if the inbox has unprocessed mail at the moment we go
			// to waiting. Sub-agent results that arrived during the working phase sit
			// in `claimed` state forever — no nudge fires for already-delivered mail.
			// Watchdog auto-resume covers this eventually, but only if it ticks before
			// maxTotalWaitMs. Firing the nudge inline closes the race at source.
			if (didTransitionToWaiting) {
				await checkInboxAndNudge(projectRoot, agentName);
			}
		} finally {
			store.close();
		}
	} catch {
		// Non-fatal: don't break logging if session update fails
	}
}

/**
 * Returns true if the agent has emitted a `mail_sent` event with `type=result`
 * since `sessionStartedAt`. Best-effort: any error is swallowed (returns false).
 *
 * Mirrors `timeSinceLastResultMail` in `src/watchdog/daemon.ts` — scans the
 * last 100 events newest-to-oldest, parses the JSON `data` payload, and stops
 * at the first `result` mail. ISO 8601 timestamps are lex-sortable so direct
 * string comparison against `sessionStartedAt` is correct.
 */
async function hasSentResultMailThisSession(
	overstoryDir: string,
	agentName: string,
	sessionStartedAt: string,
): Promise<boolean> {
	try {
		const eventsDbPath = join(overstoryDir, "events.db");
		// Skip when events.db is absent — opening would create an empty DB file
		// as a side effect, and there is nothing to find anyway.
		if (!(await Bun.file(eventsDbPath).exists())) {
			return false;
		}
		const eventStore = createEventStore(eventsDbPath);
		try {
			const events = eventStore.getByAgent(agentName);
			const scanLimit = Math.max(0, events.length - 100);
			for (let i = events.length - 1; i >= scanLimit; i--) {
				const event = events[i];
				if (!event || event.eventType !== "mail_sent" || !event.data) continue;
				if (event.createdAt < sessionStartedAt) continue;
				try {
					const data = JSON.parse(event.data) as { type?: string };
					if (data.type === "result") return true;
				} catch {
					// Ignore malformed payloads
				}
			}
		} finally {
			eventStore.close();
		}
	} catch {
		// Best-effort: Stop hook must remain unbreakable
	}
	return false;
}

/**
 * After an agent transitions to `waiting`, check its inbox for unprocessed mail
 * (queued or claimed-but-unacked) and fire an immediate tmux nudge if found.
 *
 * Why: sub-agent results that arrived during the parent's working phase sit in
 * `claimed` state with no nudge to wake the parent. Without this check, the
 * agent deadlocks until the watchdog ticks and notices via `getPendingForWaitingAgent`.
 *
 * Best-effort: catches all errors; the Stop hook must remain unbreakable.
 */
async function checkInboxAndNudge(projectRoot: string, agentName: string): Promise<void> {
	try {
		const mailDbPath = join(projectRoot, detectHaruDir(projectRoot), "mail.db");
		// Skip when no mail.db exists yet — nothing to check, and opening would
		// create an empty DB file as a side effect (breaks tests + wastes I/O).
		if (!(await Bun.file(mailDbPath).exists())) {
			return;
		}
		const mailStore = createMailStore(mailDbPath);
		let pendingCount = 0;
		try {
			// Use cutoff = now + 1s so any in-flight claim that races with this
			// transition is still counted as pre-waiting work.
			const cutoff = new Date(Date.now() + 1000).toISOString();
			pendingCount = mailStore.getPendingForWaitingAgent(agentName, cutoff).length;
		} finally {
			mailStore.close();
		}
		if (pendingCount > 0) {
			const { nudgeAgent } = await import("./nudge.ts");
			await nudgeAgent(
				projectRoot,
				agentName,
				`[MAIL] ${pendingCount} messages awaiting; resuming.`,
				true,
			);
		}
	} catch (err) {
		// Best-effort: Stop hook must remain unbreakable. Log warn and move on.
		console.warn(
			`[log] checkInboxAndNudge failed for "${agentName}": ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Look up an agent's session record.
 * Returns null if not found.
 */
function getAgentSession(projectRoot: string, agentName: string): AgentSession | null {
	try {
		const overstoryDir = join(projectRoot, detectHaruDir(projectRoot));
		const { store } = openSessionStore(overstoryDir);
		try {
			return store.getByName(agentName);
		} finally {
			store.close();
		}
	} catch {
		return null;
	}
}

/**
 * Read one line of JSON from stdin. Returns parsed object or null on failure.
 * Used when --stdin flag is present to receive hook payload from Claude Code.
 *
 * Reads ALL chunks from stdin to handle large payloads that exceed a single buffer.
 */
async function readStdinJson(): Promise<Record<string, unknown> | null> {
	try {
		const reader = Bun.stdin.stream().getReader();
		const chunks: Uint8Array[] = [];
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) chunks.push(value);
		}
		reader.releaseLock();
		if (chunks.length === 0) return null;
		// Concatenate all chunks
		const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
		const combined = new Uint8Array(totalLength);
		let offset = 0;
		for (const chunk of chunks) {
			combined.set(chunk, offset);
			offset += chunk.length;
		}
		const text = new TextDecoder().decode(combined).trim();
		if (text.length === 0) return null;
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Resolve the path to a Claude Code transcript JSONL file.
 * Tries direct construction first, then searches all project directories.
 * Caches the found path for faster subsequent lookups.
 */
async function resolveTranscriptPath(
	projectRoot: string,
	sessionId: string,
	logsBase: string,
	agentName: string,
): Promise<string | null> {
	// Check SessionStore for a runtime-provided transcript path
	try {
		const { store } = openSessionStore(join(projectRoot, detectHaruDir(projectRoot)));
		try {
			const session = store.getByName(agentName);
			if (session?.transcriptPath) {
				if (await Bun.file(session.transcriptPath).exists()) {
					return session.transcriptPath;
				}
			}
		} finally {
			store.close();
		}
	} catch {
		// Non-fatal: fall through to legacy resolution
	}

	// Check cached path first
	const cachePath = join(logsBase, agentName, ".transcript-path");
	const cacheFile = Bun.file(cachePath);
	if (await cacheFile.exists()) {
		const cached = (await cacheFile.text()).trim();
		if (cached.length > 0 && (await Bun.file(cached).exists())) {
			return cached;
		}
	}

	const homeDir = process.env.HOME ?? "";
	const claudeProjectsDir = join(homeDir, ".claude", "projects");

	// Try direct construction from project root
	const projectKey = projectRoot.replace(/\//g, "-");
	const directPath = join(claudeProjectsDir, projectKey, `${sessionId}.jsonl`);
	if (await Bun.file(directPath).exists()) {
		await Bun.write(cachePath, directPath);
		// Save discovered path to SessionStore for future lookups
		try {
			const { store: writeStore } = openSessionStore(join(projectRoot, detectHaruDir(projectRoot)));
			try {
				writeStore.updateTranscriptPath(agentName, directPath);
			} finally {
				writeStore.close();
			}
		} catch {
			// Non-fatal: cache write failure should not break transcript resolution
		}
		return directPath;
	}

	// Search all project directories for the session file
	const { readdir } = await import("node:fs/promises");
	try {
		const projects = await readdir(claudeProjectsDir);
		for (const project of projects) {
			const candidate = join(claudeProjectsDir, project, `${sessionId}.jsonl`);
			if (await Bun.file(candidate).exists()) {
				await Bun.write(cachePath, candidate);
				// Save discovered path to SessionStore for future lookups
				try {
					const { store: writeStore } = openSessionStore(
						join(projectRoot, detectHaruDir(projectRoot)),
					);
					try {
						writeStore.updateTranscriptPath(agentName, candidate);
					} finally {
						writeStore.close();
					}
				} catch {
					// Non-fatal: cache write failure should not break transcript resolution
				}
				return candidate;
			}
		}
	} catch {
		// Claude projects dir may not exist
	}

	return null;
}

/**
 * Auto-record expertise from mulch learn results.
 * Called during session-end for non-persistent agents.
 * Records a reference entry for each suggested domain at the canonical root,
 * then sends a slim notification mail to the parent agent.
 *
 * @returns List of successfully recorded domains
 */
export async function autoRecordExpertise(params: {
	mulchClient: MulchClient;
	agentName: string;
	capability: string;
	taskId: string | null;
	mailDbPath: string;
	parentAgent: string | null;
	projectRoot: string;
	sessionStartedAt: string;
}): Promise<string[]> {
	const learnResult = await params.mulchClient.learn({ since: "HEAD~1" });
	if (learnResult.suggestedDomains.length === 0) {
		return [];
	}

	const recordedDomains: string[] = [];
	const filesList = learnResult.changedFiles.join(", ");

	for (const domain of learnResult.suggestedDomains) {
		try {
			await params.mulchClient.record(domain, {
				type: "reference",
				description: `${params.capability} agent ${params.agentName} completed work in this domain. Files: ${filesList}`,
				tags: ["auto-session-end", params.capability],
				evidenceBead: params.taskId ?? undefined,
			});
			recordedDomains.push(domain);
		} catch {
			// Non-fatal per domain: skip failed records
		}
	}

	// Analyze session events for deeper insights (tool usage, file edits, errors)
	let insightSummary = "";
	try {
		const eventsDbPath = join(params.projectRoot, detectHaruDir(params.projectRoot), "events.db");
		const eventStore = createEventStore(eventsDbPath);

		const events = eventStore.getByAgent(params.agentName, {
			since: params.sessionStartedAt,
		});
		const toolStats = eventStore.getToolStats({
			agentName: params.agentName,
			since: params.sessionStartedAt,
		});

		eventStore.close();

		const analysis = analyzeSessionInsights({
			events,
			toolStats,
			agentName: params.agentName,
			capability: params.capability,
			domains: learnResult.suggestedDomains,
		});

		// Record each insight to mulch
		for (const insight of analysis.insights) {
			try {
				await params.mulchClient.record(insight.domain, {
					type: insight.type,
					description: insight.description,
					tags: insight.tags,
					evidenceBead: params.taskId ?? undefined,
				});
				if (!recordedDomains.includes(insight.domain)) {
					recordedDomains.push(insight.domain);
				}
			} catch {
				// Non-fatal per insight: skip failed records
			}
		}

		// Build insight summary for mail
		if (analysis.insights.length > 0) {
			const insightTypes = new Map<string, number>();
			for (const insight of analysis.insights) {
				const count = insightTypes.get(insight.type) ?? 0;
				insightTypes.set(insight.type, count + 1);
			}
			const typeCounts = Array.from(insightTypes.entries())
				.map(([type, count]) => `${count} ${type}`)
				.join(", ");
			insightSummary = `\n\nAuto-insights: ${typeCounts} (${analysis.toolProfile.totalToolCalls} tool calls, ${analysis.fileProfile.totalEdits} edits)`;
		}
	} catch {
		// Non-fatal: insight analysis should not break session-end handling
	}

	if (recordedDomains.length > 0) {
		const mailStore = createMailStore(params.mailDbPath);
		const mailClient = createMailClient(mailStore);
		const recipient = params.parentAgent ?? "orchestrator";
		const domainsList = recordedDomains.join(", ");
		mailClient.send({
			from: params.agentName,
			to: recipient,
			subject: `mulch: auto-recorded insights in ${domainsList}`,
			body: `Session completed. Auto-recorded expertise in: ${domainsList}.\n\nChanged files: ${filesList}${insightSummary}`,
			type: "status",
			priority: "low",
		});
		mailClient.close();
	}

	return recordedDomains;
}

interface AppliedRecordsData {
	taskId: string | null;
	agentName: string;
	capability: string;
	records: Array<{ id: string; domain: string }>;
}

/**
 * Append outcome entries to the mulch records that were applied when this agent was spawned.
 *
 * At spawn time, sling.ts writes .overstory/agents/{name}/applied-records.json listing
 * the mx-* IDs from the prime output. At session-end, this function reads that file,
 * appends a "success" outcome to each record, and deletes the file.
 *
 * @returns Number of records successfully updated.
 */
export async function appendOutcomeToAppliedRecords(params: {
	mulchClient: MulchClient;
	agentName: string;
	capability: string;
	taskId: string | null;
	projectRoot: string;
}): Promise<number> {
	const appliedRecordsPath = join(
		params.projectRoot,
		detectHaruDir(params.projectRoot),
		"agents",
		params.agentName,
		"applied-records.json",
	);
	const appliedFile = Bun.file(appliedRecordsPath);
	if (!(await appliedFile.exists())) return 0;

	let data: AppliedRecordsData;
	try {
		data = JSON.parse(await appliedFile.text()) as AppliedRecordsData;
	} catch {
		return 0;
	}

	const { records } = data;
	if (!records || records.length === 0) return 0;

	const taskSuffix = params.taskId ? ` for task ${params.taskId}` : "";
	const outcome = {
		status: "success" as const,
		agent: params.agentName,
		notes: `Applied by ${params.capability} agent ${params.agentName}${taskSuffix}. Session completed.`,
	};

	let appended = 0;
	for (const { id, domain } of records) {
		try {
			await params.mulchClient.appendOutcome(domain, id, outcome);
			appended++;
		} catch {
			// Non-fatal per record
		}
	}

	try {
		const { unlink } = await import("node:fs/promises");
		await unlink(appliedRecordsPath);
	} catch {
		// Non-fatal: file may already be gone
	}

	return appended;
}

/**
 * Core implementation for the log command.
 */
async function runLog(opts: {
	event: string;
	agent: string;
	toolName: string;
	transcript: string | undefined;
	stdin: boolean;
}): Promise<void> {
	const validEvents = ["tool-start", "tool-end", "session-end"];
	if (!validEvents.includes(opts.event)) {
		throw new ValidationError(`Invalid event "${opts.event}". Valid: ${validEvents.join(", ")}`, {
			field: "event",
			value: opts.event,
		});
	}

	// Read stdin payload if --stdin flag is set
	let stdinPayload: Record<string, unknown> | null = null;
	if (opts.stdin) {
		stdinPayload = await readStdinJson();
	}

	// Extract fields from stdin payload (preferred) or fall back to flags
	const toolName =
		typeof stdinPayload?.tool_name === "string" ? stdinPayload.tool_name : opts.toolName;
	const toolInput =
		stdinPayload?.tool_input !== undefined &&
		stdinPayload?.tool_input !== null &&
		typeof stdinPayload.tool_input === "object"
			? (stdinPayload.tool_input as Record<string, unknown>)
			: null;
	const sessionId = typeof stdinPayload?.session_id === "string" ? stdinPayload.session_id : null;
	const transcriptPath =
		typeof stdinPayload?.transcript_path === "string"
			? stdinPayload.transcript_path
			: opts.transcript;

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const logsBase = join(config.project.root, detectHaruDir(config.project.root), "logs");
	const sessionDir = await getSessionDir(logsBase, opts.agent);

	const logger = createLogger({
		logDir: sessionDir,
		agentName: opts.agent,
		verbose: config.logging.verbose,
		redactSecrets: config.logging.redactSecrets,
	});

	switch (opts.event) {
		case "tool-start": {
			// Backward compatibility: always write to per-agent log files
			logger.toolStart(toolName, toolInput ?? {});
			updateLastActivity(config.project.root, opts.agent, "tool-start");

			// Always write to EventStore for structured observability
			// (works for both Claude Code --stdin and Pi runtime --tool-name agents)
			try {
				const eventsDbPath = join(
					config.project.root,
					detectHaruDir(config.project.root),
					"events.db",
				);
				const eventStore = createEventStore(eventsDbPath);
				const filtered = toolInput
					? filterToolArgs(toolName, toolInput)
					: { args: {}, summary: toolName };
				eventStore.insert({
					runId: null,
					agentName: opts.agent,
					sessionId,
					eventType: "tool_start",
					toolName,
					toolArgs: JSON.stringify(filtered.args),
					toolDurationMs: null,
					level: "info",
					data: JSON.stringify({ summary: filtered.summary }),
				});
				eventStore.close();
			} catch {
				// Non-fatal: EventStore write should not break hook execution
			}

			// Track tool-in-flight for hang detection
			try {
				const overstoryDir = join(config.project.root, detectHaruDir(config.project.root));
				const { store } = openSessionStore(overstoryDir);
				try {
					store.setToolInFlight?.(opts.agent, toolName, new Date().toISOString());
				} finally {
					store.close();
				}
			} catch {
				// Non-fatal: tool-in-flight tracking should not break hook execution
			}
			break;
		}
		case "tool-end": {
			// Backward compatibility: always write to per-agent log files
			logger.toolEnd(toolName, 0);
			updateLastActivity(config.project.root, opts.agent, "tool-end");

			// Always write to EventStore for structured observability
			// (works for both Claude Code --stdin and Pi runtime --tool-name agents)
			try {
				const eventsDbPath = join(
					config.project.root,
					detectHaruDir(config.project.root),
					"events.db",
				);
				const eventStore = createEventStore(eventsDbPath);
				const filtered = toolInput
					? filterToolArgs(toolName, toolInput)
					: { args: {}, summary: toolName };
				eventStore.insert({
					runId: null,
					agentName: opts.agent,
					sessionId,
					eventType: "tool_end",
					toolName,
					toolArgs: JSON.stringify(filtered.args),
					toolDurationMs: null,
					level: "info",
					data: JSON.stringify({ summary: filtered.summary }),
				});
				const correlation = eventStore.correlateToolEnd(opts.agent, toolName);
				if (correlation) {
					logger.toolEnd(toolName, correlation.durationMs);
				}
				eventStore.close();
			} catch {
				// Non-fatal: EventStore write should not break hook execution
			}

			// Clear tool-in-flight tracking
			try {
				const overstoryDir = join(config.project.root, detectHaruDir(config.project.root));
				const { store } = openSessionStore(overstoryDir);
				try {
					store.clearToolInFlight?.(opts.agent);
				} finally {
					store.close();
				}
			} catch {
				// Non-fatal: tool-in-flight tracking should not break hook execution
			}

			// Throttled token snapshot recording (requires sessionId from --stdin; skipped for Pi agents)
			if (sessionId) {
				try {
					// Throttle check
					const snapshotMarkerPath = join(logsBase, opts.agent, ".last-snapshot");
					const SNAPSHOT_INTERVAL_MS = 30_000;
					const snapshotMarkerFile = Bun.file(snapshotMarkerPath);
					let shouldSnapshot = true;

					if (await snapshotMarkerFile.exists()) {
						const lastTs = Number.parseInt(await snapshotMarkerFile.text(), 10);
						if (!Number.isNaN(lastTs) && Date.now() - lastTs < SNAPSHOT_INTERVAL_MS) {
							shouldSnapshot = false;
						}
					}

					if (shouldSnapshot) {
						const resolvedTranscriptPath = await resolveTranscriptPath(
							config.project.root,
							sessionId,
							logsBase,
							opts.agent,
						);
						if (resolvedTranscriptPath) {
							const usage = await parseTranscriptUsage(resolvedTranscriptPath);
							const cost = estimateCost(usage);
							const metricsDbPath = join(
								config.project.root,
								detectHaruDir(config.project.root),
								"metrics.db",
							);
							const metricsStore = createMetricsStore(metricsDbPath);
							const agentSession = getAgentSession(config.project.root, opts.agent);
							metricsStore.recordSnapshot({
								agentName: opts.agent,
								inputTokens: usage.inputTokens,
								outputTokens: usage.outputTokens,
								cacheReadTokens: usage.cacheReadTokens,
								cacheCreationTokens: usage.cacheCreationTokens,
								estimatedCostUsd: cost,
								modelUsed: usage.modelUsed,
								runId: agentSession?.runId ?? null,
								createdAt: new Date().toISOString(),
							});
							metricsStore.close();
							await Bun.write(snapshotMarkerPath, String(Date.now()));
						}
					}
				} catch {
					// Non-fatal: snapshot recording should not break tool-end handling
				}
			}
			break;
		}
		case "session-end":
			logger.info("session.end", { agentName: opts.agent });
			// Transition agent state to waiting — watchdog decides completion
			await handleSessionEnd(config.project.root, opts.agent);
			// Look up agent session for identity update and metrics recording
			{
				const agentSession = getAgentSession(config.project.root, opts.agent);
				const taskId = agentSession?.taskId ?? null;

				// Update agent identity with completed session
				const identityBaseDir = join(
					config.project.root,
					detectHaruDir(config.project.root),
					"agents",
				);
				try {
					await updateIdentity(identityBaseDir, opts.agent, {
						sessionsCompleted: 1,
						completedTask: taskId ? { taskId, summary: `Completed task ${taskId}` } : undefined,
					});
				} catch {
					// Non-fatal: identity may not exist for this agent
				}

				// Auto-nudge coordinator when a lead completes so it wakes up
				// to process merge_ready / worker_done messages without waiting
				// for user input (see decision mx-728f8d).
				if (agentSession?.capability === "lead") {
					try {
						const nudgesDir = join(
							config.project.root,
							detectHaruDir(config.project.root),
							"pending-nudges",
						);
						const { mkdir } = await import("node:fs/promises");
						await mkdir(nudgesDir, { recursive: true });
						const markerPath = join(nudgesDir, "coordinator.json");
						const marker = {
							from: opts.agent,
							reason: "lead_completed",
							subject: `Lead ${opts.agent} completed — check mail for merge_ready/worker_done`,
							messageId: `auto-nudge-${opts.agent}-${Date.now()}`,
							createdAt: new Date().toISOString(),
						};
						await Bun.write(markerPath, `${JSON.stringify(marker, null, "\t")}\n`);
					} catch {
						// Non-fatal: nudge failure should not break session-end
					}
				}

				// Record session metrics (with optional token data from transcript)
				if (agentSession) {
					// NOTE: We intentionally do NOT auto-complete the run here for coordinator agents.
					// The coordinator's Stop hook fires on every turn boundary, not just at true session exit,
					// so auto-completing the run here would kill the session after the first turn.
					// Run completion is handled by: `ha coordinator stop`, `ha run complete` (self-exit),
					// or the watchdog daemon detecting a dead coordinator process.

					try {
						const metricsDbPath = join(
							config.project.root,
							detectHaruDir(config.project.root),
							"metrics.db",
						);
						const metricsStore = createMetricsStore(metricsDbPath);
						const now = new Date().toISOString();
						const durationMs = new Date(now).getTime() - new Date(agentSession.startedAt).getTime();

						// Parse token usage from transcript if path provided
						let inputTokens = 0;
						let outputTokens = 0;
						let cacheReadTokens = 0;
						let cacheCreationTokens = 0;
						let estimatedCostUsd: number | null = null;
						let modelUsed: string | null = null;

						if (transcriptPath) {
							try {
								const usage = await parseTranscriptUsage(transcriptPath);
								inputTokens = usage.inputTokens;
								outputTokens = usage.outputTokens;
								cacheReadTokens = usage.cacheReadTokens;
								cacheCreationTokens = usage.cacheCreationTokens;
								modelUsed = usage.modelUsed;
								estimatedCostUsd = estimateCost(usage);
							} catch {
								// Non-fatal: transcript parsing should not break metrics
							}
						}

						metricsStore.recordSession({
							agentName: opts.agent,
							taskId: agentSession.taskId,
							capability: agentSession.capability,
							startedAt: agentSession.startedAt,
							completedAt: now,
							durationMs,
							exitCode: null,
							mergeResult: null,
							parentAgent: agentSession.parentAgent,
							inputTokens,
							outputTokens,
							cacheReadTokens,
							cacheCreationTokens,
							estimatedCostUsd,
							modelUsed,
							runId: agentSession.runId,
						});
						metricsStore.close();
					} catch {
						// Non-fatal: metrics recording should not break session-end handling
					}

					// Auto-record expertise via mulch learn + record (post-session).
					// Skip persistent agents whose Stop hook fires every turn.
					if (!PERSISTENT_CAPABILITIES.has(agentSession.capability)) {
						try {
							const mulchClient = createMulchClient(config.project.root);
							const mailDbPath = join(
								config.project.root,
								detectHaruDir(config.project.root),
								"mail.db",
							);
							await autoRecordExpertise({
								mulchClient,
								agentName: opts.agent,
								capability: agentSession.capability,
								taskId,
								mailDbPath,
								parentAgent: agentSession.parentAgent,
								projectRoot: config.project.root,
								sessionStartedAt: agentSession.startedAt,
							});
						} catch {
							// Non-fatal: mulch learn/record should not break session-end handling
						}
					}

					// Append outcomes to applied mulch records (outcome feedback loop).
					// Reads applied-records.json written by sling.ts at spawn time.
					if (!PERSISTENT_CAPABILITIES.has(agentSession.capability)) {
						try {
							const mulchClient = createMulchClient(config.project.root);
							await appendOutcomeToAppliedRecords({
								mulchClient,
								agentName: opts.agent,
								capability: agentSession.capability,
								taskId,
								projectRoot: config.project.root,
							});
						} catch {
							// Non-fatal
						}
					}
				}

				// Always write session-end event to EventStore (not just when --stdin is used)
				try {
					const eventsDbPath = join(
						config.project.root,
						detectHaruDir(config.project.root),
						"events.db",
					);
					const eventStore = createEventStore(eventsDbPath);
					eventStore.insert({
						runId: null,
						agentName: opts.agent,
						sessionId,
						eventType: "session_end",
						toolName: null,
						toolArgs: null,
						toolDurationMs: null,
						level: "info",
						data: transcriptPath ? JSON.stringify({ transcriptPath }) : null,
					});
					eventStore.close();
				} catch {
					// Non-fatal: EventStore write should not break session-end
				}
			}
			// Clear the current session marker
			{
				const markerPath = join(logsBase, opts.agent, ".current-session");
				try {
					const { unlink } = await import("node:fs/promises");
					await unlink(markerPath);
				} catch {
					// Marker may not exist
				}
			}
			break;
	}

	logger.close();
}

export function createLogCommand(): Command {
	return new Command("log")
		.description("Log a hook event")
		.argument("<event>", "Event type: tool-start, tool-end, session-end")
		.option("--agent <name>", "Agent name (required)")
		.option("--tool-name <name>", "Tool name (for tool-start/tool-end events, legacy)")
		.option("--transcript <path>", "Path to Claude Code transcript JSONL (for session-end, legacy)")
		.option("--stdin", "Read hook payload JSON from stdin (preferred)")
		.option("--json", "Output as JSON")
		.action(
			async (
				event: string,
				opts: {
					agent?: string;
					toolName?: string;
					transcript?: string;
					stdin?: boolean;
					json?: boolean;
				},
			) => {
				if (!opts.agent) {
					throw new ValidationError("--agent is required for log command", { field: "agent" });
				}
				await runLog({
					event,
					agent: opts.agent,
					toolName: opts.toolName ?? "unknown",
					transcript: opts.transcript,
					stdin: opts.stdin ?? false,
				});
			},
		);
}

/**
 * Entry point for `ha log <event> --agent <name>`.
 */
export async function logCommand(args: string[]): Promise<void> {
	const cmd = createLogCommand();
	cmd.exitOverride();

	try {
		await cmd.parseAsync(args, { from: "user" });
	} catch (err: unknown) {
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: string }).code;
			if (code === "commander.helpDisplayed" || code === "commander.version") {
				return;
			}
		}
		throw err;
	}
}
