/**
 * Tests for the `ha tracker` CLI command.
 *
 * Verifies Commander wiring (subcommand registration, required arguments).
 * Adapter-level behavior is covered by src/tracker/{seeds,beads,github}.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { createTrackerCommand } from "./tracker.ts";

describe("createTrackerCommand", () => {
	test("registers the `tracker` command with description", () => {
		const cmd = createTrackerCommand();
		expect(cmd.name()).toBe("tracker");
		expect(cmd.description()).toMatch(/tracker/i);
	});

	test("registers the `comment` subcommand", () => {
		const cmd = createTrackerCommand();
		const sub = cmd.commands.find((c) => c.name() === "comment");
		expect(sub).toBeDefined();
		expect(sub?.description()).toMatch(/comment/i);
	});

	test("`comment` subcommand requires <task-id> and <body...>", () => {
		const cmd = createTrackerCommand();
		const sub = cmd.commands.find((c) => c.name() === "comment");
		expect(sub).toBeDefined();
		// Commander stores registered arguments on the command instance.
		// Argument names are exposed as `_args` (typed loosely).
		const args = (sub as unknown as { _args: Array<{ _name: string; required: boolean }> })._args;
		expect(args).toHaveLength(2);
		expect(args[0]?._name).toBe("task-id");
		expect(args[0]?.required).toBe(true);
		expect(args[1]?._name).toBe("body");
		expect(args[1]?.required).toBe(true);
	});

	test("`comment` subcommand supports --json", () => {
		const cmd = createTrackerCommand();
		const sub = cmd.commands.find((c) => c.name() === "comment");
		const opts = (sub as unknown as { options: Array<{ long?: string }> }).options;
		const flags = opts.map((o) => o.long);
		expect(flags).toContain("--json");
	});
});
