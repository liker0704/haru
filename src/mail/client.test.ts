import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailError } from "../errors.ts";
import { cleanupTempDir } from "../test-helpers.ts";
import type { WorkerDonePayload } from "../types.ts";
import { createMailClient, isConvergenceType, type MailClient, parsePayload } from "./client.ts";
import { createMailStore, type MailStore } from "./store.ts";

describe("createMailClient", () => {
	let tempDir: string;
	let store: MailStore;
	let client: MailClient;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "haru-mail-client-test-"));
		store = createMailStore(join(tempDir, "mail.db"));
		client = createMailClient(store);
	});

	afterEach(async () => {
		client.close();
		await cleanupTempDir(tempDir);
	});

	describe("send", () => {
		test("returns a message ID", () => {
			const id = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Status update",
				body: "All tests passing",
			});

			expect(id).toMatch(/^msg-[a-z0-9]{12}$/);
		});

		test("defaults type to 'status' when not provided", () => {
			const id = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Update",
				body: "Done",
			});

			const msg = store.getById(id);
			expect(msg).not.toBeNull();
			expect(msg?.type).toBe("status");
		});

		test("defaults priority to 'normal' when not provided", () => {
			const id = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Update",
				body: "Done",
			});

			const msg = store.getById(id);
			expect(msg).not.toBeNull();
			expect(msg?.priority).toBe("normal");
		});

		test("uses provided type and priority", () => {
			const id = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Help needed",
				body: "Blocked on dependency",
				type: "question",
				priority: "high",
			});

			const msg = store.getById(id);
			expect(msg).not.toBeNull();
			expect(msg?.type).toBe("question");
			expect(msg?.priority).toBe("high");
		});

		test("stores all message fields correctly", () => {
			const id = client.send({
				from: "builder-1",
				to: "lead-1",
				subject: "Task complete",
				body: "Implementation finished",
				type: "result",
				priority: "low",
				threadId: "thread-abc",
			});

			const msg = store.getById(id);
			expect(msg).not.toBeNull();
			expect(msg?.from).toBe("builder-1");
			expect(msg?.to).toBe("lead-1");
			expect(msg?.subject).toBe("Task complete");
			expect(msg?.body).toBe("Implementation finished");
			expect(msg?.threadId).toBe("thread-abc");
			expect(msg?.read).toBe(false);
		});

		test("canonicalizes coordinator mission mailbox names on send", () => {
			const id = client.send({
				from: "coordinator-mission",
				to: "coordinator-mission",
				subject: "Alias route",
				body: "Normalize this mailbox",
			});

			const msg = store.getById(id);
			expect(msg).not.toBeNull();
			expect(msg?.from).toBe("coordinator");
			expect(msg?.to).toBe("coordinator");
		});
	});

	describe("check", () => {
		test("returns unread messages for the agent", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
			});
			client.send({
				from: "agent-b",
				to: "orchestrator",
				subject: "msg2",
				body: "body2",
			});

			const messages = client.check("orchestrator");
			expect(messages).toHaveLength(2);
			const subjects = messages.map((m) => m.subject).sort();
			expect(subjects).toEqual(["msg1", "msg2"]);
		});

		test("marks returned messages as read", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
			});

			const firstCheck = client.check("orchestrator");
			expect(firstCheck).toHaveLength(1);

			// Second check should return empty since messages are now read
			const secondCheck = client.check("orchestrator");
			expect(secondCheck).toHaveLength(0);
		});

		test("returns empty array when no unread messages", () => {
			const messages = client.check("orchestrator");
			expect(messages).toHaveLength(0);
		});

		test("only returns messages addressed to the specified agent", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "for-orch",
				body: "body",
			});
			client.send({
				from: "agent-a",
				to: "agent-b",
				subject: "for-b",
				body: "body",
			});

			const messages = client.check("orchestrator");
			expect(messages).toHaveLength(1);
			expect(messages[0]?.subject).toBe("for-orch");
		});

		test("returns legacy alias-addressed messages for canonical coordinator inbox", () => {
			store.insert({
				id: "",
				from: "mission-analyst",
				to: "coordinator-mission",
				subject: "Legacy alias",
				body: "Queued under the old mailbox name",
				type: "status",
				priority: "normal",
				threadId: null,
			});

			const messages = client.check("coordinator");
			expect(messages).toHaveLength(1);
			expect(messages[0]?.to).toBe("coordinator-mission");
			expect(messages[0]?.subject).toBe("Legacy alias");
		});
	});

	describe("checkInject", () => {
		test("returns empty string when no unread messages", () => {
			const { output: result } = client.checkInject("orchestrator");
			expect(result).toBe("");
		});

		test("formats single message with count of 1", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Build complete",
				body: "All 42 tests pass",
			});

			const { output: result } = client.checkInject("orchestrator");
			expect(result).toContain("1 new message");
			expect(result).not.toContain("messages:");
		});

		test("includes sender name in formatted output", () => {
			client.send({
				from: "builder-1",
				to: "orchestrator",
				subject: "Done",
				body: "Finished implementation",
			});

			const { output: result } = client.checkInject("orchestrator");
			expect(result).toContain("From:      builder-1");
		});

		test("includes subject in formatted output", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Important Update",
				body: "Details here",
			});

			const { output: result } = client.checkInject("orchestrator");
			expect(result).toContain("Subject:   Important Update");
		});

		test("includes message body in formatted output", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Update",
				body: "The implementation is complete and all tests pass.",
			});

			const { output: result } = client.checkInject("orchestrator");
			expect(result).toContain("The implementation is complete and all tests pass.");
		});

		test("includes reply command with message id", () => {
			const id = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Question",
				body: "Need clarification",
			});

			const { output: result } = client.checkInject("orchestrator");
			expect(result).toContain(`ha mail reply ${id}`);
		});

		test("formats multiple messages with correct count", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
			});
			client.send({
				from: "agent-b",
				to: "orchestrator",
				subject: "msg2",
				body: "body2",
			});
			client.send({
				from: "agent-c",
				to: "orchestrator",
				subject: "msg3",
				body: "body3",
			});

			const { output: result } = client.checkInject("orchestrator");
			expect(result).toContain("3 new messages");
			expect(result).toContain("From:      agent-a");
			expect(result).toContain("From:      agent-b");
			expect(result).toContain("From:      agent-c");
		});

		test("shows priority tag for high priority", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Urgent matter",
				body: "Need help now",
				priority: "high",
			});

			const { output: result } = client.checkInject("orchestrator");
			expect(result).toContain("[HIGH]");
		});

		test("shows priority tag for urgent priority", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Critical failure",
				body: "Build broken",
				priority: "urgent",
			});

			const { output: result } = client.checkInject("orchestrator");
			expect(result).toContain("[URGENT]");
		});

		test("shows priority tag for low priority", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "FYI",
				body: "Minor note",
				priority: "low",
			});

			const { output: result } = client.checkInject("orchestrator");
			expect(result).toContain("[LOW]");
		});

		test("does not show priority tag for normal priority", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Update",
				body: "Regular update",
				priority: "normal",
			});

			const { output: result } = client.checkInject("orchestrator");
			expect(result).not.toContain("[NORMAL]");
		});

		test("marks messages as read after injection", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
			});

			const { output: first } = client.checkInject("orchestrator");
			expect(first).not.toBe("");

			// Second call should return empty since messages are claimed
			const { output: second } = client.checkInject("orchestrator");
			expect(second).toBe("");
		});
	});

	describe("list", () => {
		test("returns all messages without filters", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
			});
			client.send({
				from: "agent-b",
				to: "agent-c",
				subject: "msg2",
				body: "body2",
			});

			const messages = client.list();
			expect(messages).toHaveLength(2);
		});

		test("filters by from", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
			});
			client.send({
				from: "agent-b",
				to: "orchestrator",
				subject: "msg2",
				body: "body2",
			});

			const messages = client.list({ from: "agent-a" });
			expect(messages).toHaveLength(1);
			expect(messages[0]?.from).toBe("agent-a");
		});

		test("filters by to", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
			});
			client.send({
				from: "agent-a",
				to: "agent-b",
				subject: "msg2",
				body: "body2",
			});

			const messages = client.list({ to: "agent-b" });
			expect(messages).toHaveLength(1);
			expect(messages[0]?.to).toBe("agent-b");
		});

		test("filters by unread status", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "msg1",
				body: "body1",
			});
			const id2 = client.send({
				from: "agent-b",
				to: "orchestrator",
				subject: "msg2",
				body: "body2",
			});
			client.markRead(id2);

			const unread = client.list({ unread: true });
			expect(unread).toHaveLength(1);
			expect(unread[0]?.subject).toBe("msg1");
		});
	});

	describe("markRead", () => {
		test("marks a message as read", () => {
			const id = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
			});

			client.markRead(id);

			const msg = store.getById(id);
			expect(msg).not.toBeNull();
			expect(msg?.read).toBe(true);
		});

		test("throws MailError when message does not exist", () => {
			expect(() => client.markRead("nonexistent-id")).toThrow(MailError);
		});

		test("MailError includes the missing message ID", () => {
			try {
				client.markRead("bad-msg-id");
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeInstanceOf(MailError);
				expect((err as MailError).message).toContain("bad-msg-id");
			}
		});
	});

	describe("reply", () => {
		test("creates a reply addressed to original sender", () => {
			const originalId = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Question about API",
				body: "How do I use the merge endpoint?",
				type: "question",
				priority: "normal",
			});

			const replyMsg = client.reply(
				originalId,
				"Use POST /merge with branch param",
				"orchestrator",
			);
			expect(replyMsg).not.toBeNull();
			expect(replyMsg?.from).toBe("orchestrator");
			expect(replyMsg?.to).toBe("agent-a");
		});

		test("sets subject to 'Re: {original subject}'", () => {
			const originalId = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Build Status",
				body: "Tests failing",
			});

			const replyMsg = client.reply(originalId, "Looking into it", "orchestrator");
			expect(replyMsg).not.toBeNull();
			expect(replyMsg?.subject).toBe("Re: Build Status");
		});

		test("uses original message id as threadId when original has no threadId", () => {
			const originalId = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "New thread",
				body: "Starting conversation",
			});

			const replyMsg = client.reply(originalId, "Reply here", "orchestrator");
			expect(replyMsg).not.toBeNull();
			expect(replyMsg?.threadId).toBe(originalId);
		});

		test("preserves threadId from original message when present", () => {
			const originalId = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "In-thread message",
				body: "Part of existing thread",
				threadId: "thread-root-123",
			});

			const replyMsg = client.reply(originalId, "Continuing thread", "orchestrator");
			expect(replyMsg).not.toBeNull();
			expect(replyMsg?.threadId).toBe("thread-root-123");
		});

		test("preserves original message type in reply", () => {
			const originalId = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Error report",
				body: "Something broke",
				type: "error",
			});

			const replyMsg = client.reply(originalId, "Fixed", "orchestrator");
			expect(replyMsg).not.toBeNull();
			expect(replyMsg?.type).toBe("error");
		});

		test("preserves original priority in reply", () => {
			const originalId = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Urgent",
				body: "Need help",
				priority: "urgent",
			});

			const replyMsg = client.reply(originalId, "On it", "orchestrator");
			expect(replyMsg).not.toBeNull();
			expect(replyMsg?.priority).toBe("urgent");
		});

		test("returns the full reply message", () => {
			const originalId = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Test",
				body: "Test body",
			});

			const replyMsg = client.reply(originalId, "Reply body", "orchestrator");
			expect(replyMsg.id).toMatch(/^msg-[a-z0-9]{12}$/);
			expect(replyMsg.from).toBe("orchestrator");
			expect(replyMsg.to).toBe("agent-a");
		});

		test("throws MailError when original message not found", () => {
			expect(() => client.reply("nonexistent-id", "reply body", "orchestrator")).toThrow(MailError);
		});

		test("MailError includes the missing message ID", () => {
			try {
				client.reply("bad-msg-id", "reply body", "orchestrator");
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeInstanceOf(MailError);
				expect((err as MailError).message).toContain("bad-msg-id");
			}
		});

		test("reply to own sent message goes to original recipient, not back to sender", () => {
			// Scenario: orchestrator sends to status-builder, then replies to that same message
			const originalId = client.send({
				from: "orchestrator",
				to: "status-builder",
				subject: "Task assignment",
				body: "Please implement feature X",
			});

			// Orchestrator replies to their own sent message
			const replyMsg = client.reply(originalId, "Actually, also do Y", "orchestrator");
			expect(replyMsg).not.toBeNull();
			expect(replyMsg?.from).toBe("orchestrator");
			// Reply should go to status-builder (original.to), not orchestrator (original.from)
			expect(replyMsg?.to).toBe("status-builder");
		});

		test("reply from a third party goes to original sender", () => {
			// Scenario: agent-a sends to agent-b, but agent-c replies (edge case)
			const originalId = client.send({
				from: "agent-a",
				to: "agent-b",
				subject: "Question",
				body: "Need info",
			});

			// agent-c is neither sender nor recipient of original
			const replyMsg = client.reply(originalId, "I can help", "agent-c");
			expect(replyMsg).not.toBeNull();
			expect(replyMsg?.from).toBe("agent-c");
			// Third-party reply goes to original sender
			expect(replyMsg?.to).toBe("agent-a");
		});

		test("reply to a legacy coordinator alias thread routes back to canonical coordinator", () => {
			const original = store.insert({
				id: "",
				from: "coordinator-mission",
				to: "mission-analyst",
				subject: "Need findings",
				body: "Send your latest analysis",
				type: "question",
				priority: "normal",
				threadId: null,
			});

			const replyMsg = client.reply(original.id, "Here is the analysis", "mission-analyst");
			expect(replyMsg.from).toBe("mission-analyst");
			expect(replyMsg.to).toBe("coordinator");
		});
	});

	describe("sendProtocol", () => {
		test("sends a worker_done message with serialized payload", () => {
			const payload: WorkerDonePayload = {
				taskId: "beads-abc",
				branch: "agent/builder-1",
				exitCode: 0,
				filesModified: ["src/foo.ts", "src/bar.ts"],
			};
			const id = client.sendProtocol({
				from: "builder-1",
				to: "lead-1",
				subject: "Task complete",
				body: "Implementation finished, all tests pass",
				type: "worker_done",
				payload,
			});

			const msg = store.getById(id);
			expect(msg).not.toBeNull();
			expect(msg?.type).toBe("worker_done");
			expect(msg?.payload).toBe(JSON.stringify(payload));
		});

		test("defaults priority to normal", () => {
			const id = client.sendProtocol({
				from: "merger-1",
				to: "lead-1",
				subject: "Merged",
				body: "Branch merged",
				type: "merged",
				payload: { branch: "agent/b1", taskId: "beads-xyz", tier: "clean-merge" as const },
			});

			const msg = store.getById(id);
			expect(msg?.priority).toBe("normal");
		});

		test("respects provided priority", () => {
			const id = client.sendProtocol({
				from: "builder-1",
				to: "orchestrator",
				subject: "Escalation",
				body: "Build failing",
				type: "escalation",
				priority: "urgent",
				payload: { severity: "critical" as const, taskId: null, context: "OOM" },
			});

			const msg = store.getById(id);
			expect(msg?.priority).toBe("urgent");
		});

		test("preserves threadId", () => {
			const id = client.sendProtocol({
				from: "lead-1",
				to: "builder-1",
				subject: "Assign task",
				body: "Please implement feature X",
				type: "assign",
				threadId: "thread-dispatch-1",
				payload: {
					taskId: "beads-123",
					specPath: ".overstory/specs/beads-123.md",
					workerName: "builder-1",
					branch: "agent/builder-1",
				},
			});

			const msg = store.getById(id);
			expect(msg?.threadId).toBe("thread-dispatch-1");
		});
	});

	describe("parsePayload", () => {
		test("parses a valid JSON payload", () => {
			const payload: WorkerDonePayload = {
				taskId: "beads-abc",
				branch: "agent/builder-1",
				exitCode: 0,
				filesModified: ["src/foo.ts"],
			};
			const id = client.sendProtocol({
				from: "builder-1",
				to: "lead-1",
				subject: "Done",
				body: "Done",
				type: "worker_done",
				payload,
			});

			const msg = store.getById(id);
			if (msg === null) throw new Error("expected message");
			const parsed = parsePayload(msg, "worker_done");
			expect(parsed).toEqual(payload);
		});

		test("returns null for message with no payload", () => {
			const id = client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Status",
				body: "All good",
			});

			const msg = store.getById(id);
			if (msg === null) throw new Error("expected message");
			const parsed = parsePayload(msg, "worker_done");
			expect(parsed).toBeNull();
		});

		test("returns null for invalid JSON payload", () => {
			// Manually insert a message with malformed payload via store
			const msg = store.insert({
				id: "msg-bad-json",
				from: "agent-a",
				to: "orchestrator",
				subject: "Bad",
				body: "Bad payload",
				type: "worker_done",
				priority: "normal",
				threadId: null,
				payload: "not valid json{{{",
			});

			const parsed = parsePayload(msg, "worker_done");
			expect(parsed).toBeNull();
		});
	});

	describe("checkInject with protocol messages", () => {
		test("includes payload in injection output for protocol messages", () => {
			const payload: WorkerDonePayload = {
				taskId: "beads-abc",
				branch: "agent/builder-1",
				exitCode: 0,
				filesModified: ["src/foo.ts"],
			};
			client.sendProtocol({
				from: "builder-1",
				to: "orchestrator",
				subject: "Task complete",
				body: "Implementation done",
				type: "worker_done",
				payload,
			});

			const { output: result } = client.checkInject("orchestrator");
			expect(result).toContain("worker_done");
			expect(result).toContain("Payload:");
			expect(result).toContain("beads-abc");
		});

		test("does not include payload line for semantic messages", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Status",
				body: "All good",
			});

			const { output: result } = client.checkInject("orchestrator");
			expect(result).not.toContain("Payload:");
		});
	});

	describe("isConvergenceType (per #284)", () => {
		test("returns true for plan_critic_verdict", () => {
			expect(isConvergenceType("plan_critic_verdict")).toBe(true);
		});

		test("returns true for worker_done", () => {
			expect(isConvergenceType("worker_done")).toBe(true);
		});

		test("returns true for merge_ready", () => {
			expect(isConvergenceType("merge_ready")).toBe(true);
		});

		test("returns true for result", () => {
			expect(isConvergenceType("result")).toBe(true);
		});

		test("returns true for plan_review_consolidated (#314)", () => {
			expect(isConvergenceType("plan_review_consolidated")).toBe(true);
		});

		test("returns false for status", () => {
			expect(isConvergenceType("status")).toBe(false);
		});

		test("returns false for question", () => {
			expect(isConvergenceType("question")).toBe(false);
		});

		test("returns false for error", () => {
			expect(isConvergenceType("error")).toBe(false);
		});

		test("returns false for dispatch", () => {
			expect(isConvergenceType("dispatch")).toBe(false);
		});
	});

	describe("formatForInjection banner format (#315)", () => {
		test("N=1: renders Message 1 of 1 separator and END marker, no PROCESS ALL", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "Solo message",
				body: "Just one",
			});

			const { output: result } = client.checkInject("orchestrator");
			expect(result).toContain("═══ Message 1 of 1 ═══");
			expect(result).toContain("═══ END (1 message above) ═══");
			expect(result).not.toContain("PROCESS ALL OF THEM");
		});

		test("N=1: top line reads 'You have 1 new message.' without PROCESS ALL clause", () => {
			client.send({ from: "agent-a", to: "orchestrator", subject: "s", body: "b" });

			const { output: result } = client.checkInject("orchestrator");
			expect(result).toContain("You have 1 new message.");
			expect(result).not.toContain("PROCESS ALL");
		});

		test("N>1 mixed senders/types: numbered separators, PROCESS ALL line, no duplicate sub-hint", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "s1",
				body: "b1",
				type: "status",
			});
			client.send({
				from: "agent-b",
				to: "orchestrator",
				subject: "s2",
				body: "b2",
				type: "question",
			});

			const { output: result } = client.checkInject("orchestrator");
			expect(result).toContain("PROCESS ALL OF THEM");
			expect(result).toContain("═══ Message 1 of 2 ═══");
			expect(result).toContain("═══ Message 2 of 2 ═══");
			expect(result).toContain("═══ END (2 messages above) ═══");
			expect(result).not.toContain("NOTE:");
		});

		test("N>1 with at-least-one repeated (from, type): duplicate-detection sub-hint present", () => {
			client.send({
				from: "lead",
				to: "orchestrator",
				subject: "v1",
				body: "body1",
				type: "worker_done",
			});
			client.send({
				from: "lead",
				to: "orchestrator",
				subject: "v2",
				body: "body2",
				type: "worker_done",
			});

			const { output: result } = client.checkInject("orchestrator");
			expect(result).toContain("NOTE:");
			expect(result).toContain("lead");
			expect(result).toContain("worker_done");
		});

		test("N>1 with two different repeated pairs: both are mentioned in sub-hints", () => {
			client.send({ from: "a", to: "orchestrator", subject: "s", body: "b", type: "status" });
			client.send({ from: "a", to: "orchestrator", subject: "s2", body: "b2", type: "status" });
			client.send({ from: "b", to: "orchestrator", subject: "s3", body: "b3", type: "question" });
			client.send({ from: "b", to: "orchestrator", subject: "s4", body: "b4", type: "question" });

			const { output: result } = client.checkInject("orchestrator");
			// Both pairs should be mentioned (one NOTE line each)
			const noteLines = result.split("\n").filter((l) => l.startsWith("NOTE:"));
			expect(noteLines.length).toBe(2);
		});

		test("banner includes Type, Received, and Mail ID fields", () => {
			const id = client.send({ from: "agent-a", to: "orchestrator", subject: "s", body: "b" });

			const { output: result } = client.checkInject("orchestrator");
			expect(result).toContain("Type:      status");
			expect(result).toContain("Received:");
			expect(result).toContain(`Mail ID:   ${id}`);
		});

		test("banner includes Ack command with message id", () => {
			const id = client.send({ from: "agent-a", to: "orchestrator", subject: "s", body: "b" });

			const { output: result } = client.checkInject("orchestrator");
			expect(result).toContain(`ha mail ack ${id} --agent $HARU_AGENT_NAME`);
		});

		test("priority tag renders after type field, not in From line", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "s",
				body: "b",
				priority: "urgent",
			});

			const { output: result } = client.checkInject("orchestrator");
			expect(result).toContain("Type:      status [URGENT]");
			expect(result).toContain("From:      agent-a");
			// From line should not have priority tag
			const fromLine = result.split("\n").find((l) => l.startsWith("From:"));
			expect(fromLine).not.toContain("[URGENT]");
		});

		test("payload rendered inline for plan_review_consolidated (protocol type)", () => {
			client.send({
				from: "plan-review-lead",
				to: "orchestrator",
				subject: "Consolidated",
				body: "All verdicts in",
				type: "plan_review_consolidated",
				payload: JSON.stringify({ verdict: "APPROVE", rounds: 1 }),
			});

			const { output: result } = client.checkInject("orchestrator");
			expect(result).toContain("Payload:");
			expect(result).toContain("APPROVE");
		});
	});

	describe("checkInject convergence behavior (per #284)", () => {
		test("convergence-typed messages are excluded from returned messageIds", () => {
			// Mix convergence and non-convergence types
			const verdictId = client.sendProtocol({
				from: "critic-a",
				to: "plan-review-lead",
				subject: "Verdict",
				body: "APPROVE",
				type: "plan_critic_verdict",
				payload: {
					criticType: "devil-advocate",
					verdict: "APPROVE",
					concerns: [],
					notes: [],
					round: 1,
					confidence: 0.9,
				},
			});
			const statusId = client.send({
				from: "agent-a",
				to: "plan-review-lead",
				subject: "Progress",
				body: "Working",
				type: "status",
			});

			const { messageIds } = client.checkInject("plan-review-lead");
			// Only the non-convergence message should be in messageIds for ack
			expect(messageIds).toContain(statusId);
			expect(messageIds).not.toContain(verdictId);
		});

		test("convergence-typed messages remain claimed after checkInject + ackBatch", () => {
			const verdictId = client.sendProtocol({
				from: "critic-a",
				to: "plan-review-lead",
				subject: "Verdict",
				body: "APPROVE",
				type: "plan_critic_verdict",
				payload: {
					criticType: "security",
					verdict: "APPROVE",
					concerns: [],
					notes: [],
					round: 1,
					confidence: 0.85,
				},
			});

			const { messageIds, output } = client.checkInject("plan-review-lead");
			expect(output).toContain("plan_critic_verdict");
			// Caller would now ackBatch; verdict id is NOT in the list
			client.ackBatch(messageIds);

			const msg = store.getById(verdictId);
			expect(msg).not.toBeNull();
			expect(msg?.state).toBe("claimed");
		});

		test("non-convergence messages are acked after checkInject + ackBatch", () => {
			const statusId = client.send({
				from: "agent-a",
				to: "plan-review-lead",
				subject: "Progress",
				body: "Working",
				type: "status",
			});

			const { messageIds } = client.checkInject("plan-review-lead");
			client.ackBatch(messageIds);

			const msg = store.getById(statusId);
			expect(msg).not.toBeNull();
			expect(msg?.state).toBe("acked");
		});

		test("multiple rapid convergence verdicts all surface and remain claimed", () => {
			// Simulate 4 critics reporting in close succession (the #284 scenario)
			const ids: string[] = [];
			for (const critic of ["devil-advocate", "security", "performance", "second-opinion"]) {
				const id = client.sendProtocol({
					from: `critic-${critic}`,
					to: "plan-review-lead",
					subject: `Verdict from ${critic}`,
					body: `APPROVE from ${critic}`,
					type: "plan_critic_verdict",
					payload: {
						criticType: critic as "devil-advocate" | "security" | "performance" | "second-opinion",
						verdict: "APPROVE",
						concerns: [],
						notes: [],
						round: 1,
						confidence: 0.9,
					},
				});
				ids.push(id);
			}

			const { messageIds, output } = client.checkInject("plan-review-lead");
			// All 4 verdicts should appear in the banner
			expect(output).toContain("4 new messages");
			// None of them should be in the ack list
			for (const id of ids) {
				expect(messageIds).not.toContain(id);
			}
			// All 4 visible via list with state=claimed
			client.ackBatch(messageIds);
			const claimed = client.list({ to: "plan-review-lead", state: "claimed" });
			expect(claimed).toHaveLength(4);
			// And after explicit ack of all 4, zero claimed remain
			for (const id of ids) {
				client.ack(id);
			}
			const remaining = client.list({ to: "plan-review-lead", state: "claimed" });
			expect(remaining).toHaveLength(0);
		});

		test("lease expiry does NOT re-queue convergence-typed claims", async () => {
			// Insert a convergence message and claim it with a 1-second lease
			const verdictId = client.sendProtocol({
				from: "critic-a",
				to: "plan-review-lead",
				subject: "Verdict",
				body: "BLOCK",
				type: "plan_critic_verdict",
				payload: {
					criticType: "devil-advocate",
					verdict: "BLOCK",
					concerns: [],
					notes: [],
					round: 1,
					confidence: 0.9,
				},
			});
			client.claim("plan-review-lead", 1);

			// Sleep past the lease — SQLite datetime('now') is second-resolution
			// so we need >2s sleep to guarantee claimed_at < now-1s
			await Bun.sleep(2100);

			// Re-claim with lease=1; expiry would trigger for non-convergence types
			const reClaim = client.claim("plan-review-lead", 1);
			// The convergence message should NOT have been re-queued
			expect(reClaim.map((m) => m.id)).not.toContain(verdictId);

			// Verify state is still claimed (lease did not return it to queued)
			const msg = store.getById(verdictId);
			expect(msg?.state).toBe("claimed");
		});

		test("lease expiry DOES re-queue non-convergence claims", async () => {
			// Control test: status type should still expire normally
			const statusId = client.send({
				from: "agent-a",
				to: "plan-review-lead",
				subject: "Progress",
				body: "Working",
				type: "status",
			});
			client.claim("plan-review-lead", 1);

			// Sleep past the lease — SQLite datetime('now') is second-resolution
			await Bun.sleep(2100);

			// Re-claim with lease=1 — expiry should re-queue then claim again
			const reClaim = client.claim("plan-review-lead", 1);
			expect(reClaim.map((m) => m.id)).toContain(statusId);
		});

		test("idempotent ack of convergence types", () => {
			const verdictId = client.sendProtocol({
				from: "critic-a",
				to: "plan-review-lead",
				subject: "Verdict",
				body: "APPROVE",
				type: "plan_critic_verdict",
				payload: {
					criticType: "devil-advocate",
					verdict: "APPROVE",
					concerns: [],
					notes: [],
					round: 1,
					confidence: 0.95,
				},
			});

			client.claim("plan-review-lead");
			client.ack(verdictId);

			const msg = store.getById(verdictId);
			expect(msg?.state).toBe("acked");

			// Second ack of an already-acked convergence message — store.ack throws
			// MailError because state is no longer 'claimed'. The CLI handler is
			// responsible for translating that to an idempotent success; at the
			// client/store layer the strict state-guard semantics are preserved.
			expect(() => client.ack(verdictId)).toThrow(MailError);
		});
	});

	describe("close", () => {
		test("closes without error", () => {
			// Create a separate client/store to test close independently
			const tempStore = createMailStore(join(tempDir, "mail-close-test.db"));
			const tempClient = createMailClient(tempStore);

			// Should not throw
			tempClient.close();
		});
	});

	describe("claim + ack", () => {
		test("claim returns messages and ack marks them processed", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "task done",
				body: "finished",
				type: "worker_done",
			});

			const claimed = client.claim("orchestrator");
			expect(claimed).toHaveLength(1);
			expect(claimed[0]?.state).toBe("claimed");

			client.ack(claimed[0]?.id);

			// Should not appear in subsequent claims
			const secondClaim = client.claim("orchestrator");
			expect(secondClaim).toHaveLength(0);
		});

		test("check uses claim+ack internally and returns empty on re-check", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "test",
				body: "body",
			});

			const first = client.check("orchestrator");
			expect(first).toHaveLength(1);

			const second = client.check("orchestrator");
			expect(second).toHaveLength(0);
		});
	});

	describe("nack", () => {
		test("nack retries message", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "retry me",
				body: "body",
			});

			const claimed = client.claim("orchestrator");
			const result = client.nack(claimed[0]?.id, "transient error");
			expect(result.deadLettered).toBe(false);
		});
	});

	describe("sendBroadcast", () => {
		test("sends to all recipients atomically", () => {
			const ids = client.sendBroadcast({
				from: "coordinator",
				to: ["agent-a", "agent-b", "agent-c"],
				subject: "announcement",
				body: "new policy",
			});

			expect(ids).toHaveLength(3);

			// Each agent should have one unread message
			expect(client.check("agent-a")).toHaveLength(1);
			expect(client.check("agent-b")).toHaveLength(1);
			expect(client.check("agent-c")).toHaveLength(1);
		});
	});

	describe("getDlq + replayDlq", () => {
		test("dead-lettered messages appear in DLQ and can be replayed", () => {
			client.send({
				from: "agent-a",
				to: "orchestrator",
				subject: "will fail",
				body: "body",
			});

			// Claim and nack until dead-lettered (maxAttempts defaults to 3 in store)
			const claimed = client.claim("orchestrator");
			// Force dead-letter via store directly since client.nack uses default maxAttempts
			store.nack(claimed[0]?.id, { maxAttempts: 1, reason: "permanent failure" });

			const dlq = client.getDlq();
			expect(dlq).toHaveLength(1);
			expect(dlq[0]?.id).toBe(claimed[0]?.id);

			client.replayDlq(dlq[0]?.id);

			// Should now be claimable again
			const reClaimed = client.claim("orchestrator");
			expect(reClaimed).toHaveLength(1);
		});
	});
});
