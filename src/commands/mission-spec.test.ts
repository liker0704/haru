import { describe, expect, test } from "bun:test";
import { createMissionSpecCommand } from "./mission-spec.ts";

describe("createMissionSpecCommand", () => {
	test("registers approve and reject subcommands", () => {
		const cmd = createMissionSpecCommand();
		const names = cmd.commands.map((c) => c.name());
		expect(names).toContain("approve");
		expect(names).toContain("reject");
	});

	test("approve subcommand exposes --mission and --json", () => {
		const cmd = createMissionSpecCommand();
		const approve = cmd.commands.find((c) => c.name() === "approve");
		const opts = approve?.options ?? [];
		expect(opts.find((o) => o.long === "--mission")).toBeDefined();
		expect(opts.find((o) => o.long === "--json")).toBeDefined();
	});

	test("reject subcommand requires --reason", () => {
		const cmd = createMissionSpecCommand();
		const reject = cmd.commands.find((c) => c.name() === "reject");
		const opts = reject?.options ?? [];
		expect(opts.find((o) => o.long === "--reason")).toBeDefined();
		expect(opts.find((o) => o.long === "--mission")).toBeDefined();
		expect(opts.find((o) => o.long === "--json")).toBeDefined();
	});
});
