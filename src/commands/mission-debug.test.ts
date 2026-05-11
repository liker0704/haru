import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createMissionStore } from "../missions/store.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import { createMissionDebugCommand } from "./mission-debug.ts";

let tempDir: string;
let overstoryDir: string;
let originalCwd: string;
let originalExitCode: typeof process.exitCode;
let originalStdoutWrite: typeof process.stdout.write;

async function writeConfig(root: string): Promise<void> {
	await Bun.write(
		join(root, ".overstory", "config.yaml"),
		[
			"project:",
			"  name: mission-debug-test",
			`  root: ${root}`,
			"  canonicalBranch: main",
			"agents:",
			"  manifestPath: .overstory/agent-manifest.json",
			"  baseDir: .overstory/agent-defs",
			"",
		].join("\n"),
	);
}

function seedMission(
	overstoryDirPath: string,
	opts: {
		id: string;
		slug: string;
		state?: "active" | "frozen";
		pendingInputKind?: "debug-escalation" | "question" | null;
		debugAttempts?: number;
		currentNode?: string;
	},
): void {
	const dbPath = join(overstoryDirPath, "sessions.db");
	const store = createMissionStore(dbPath);
	try {
		const artifactRoot = join(overstoryDirPath, "artifacts", opts.slug);
		store.create({
			id: opts.id,
			slug: opts.slug,
			objective: `seed mission ${opts.slug}`,
			runId: null,
			artifactRoot,
			startedAt: null,
			tier: "planned",
			autonomy: "supervised",
			featureBranch: null,
		});
		if (opts.state === "frozen") {
			store.freeze(opts.id, opts.pendingInputKind ?? "debug-escalation", null);
			store.updatePauseReason(opts.id, "Stage C debug loop exhausted after 3 attempts");
		}
		if (opts.currentNode) {
			store.updateCurrentNode(opts.id, opts.currentNode);
		}
		if (opts.debugAttempts !== undefined) {
			store.checkpoints.saveCheckpoint(opts.id, "done-phase:dispatch-debugger", {
				debugAttempts: opts.debugAttempts,
			});
		}
	} finally {
		store.close();
	}
}

beforeEach(async () => {
	tempDir = await createTempGitRepo();
	overstoryDir = join(tempDir, ".overstory");
	await mkdir(overstoryDir, { recursive: true });
	await writeConfig(tempDir);

	originalCwd = process.cwd();
	process.chdir(tempDir);

	originalExitCode = process.exitCode;
	process.exitCode = 0;

	// Silence CLI output during tests
	originalStdoutWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = (() => true) as typeof process.stdout.write;
});

afterEach(async () => {
	process.stdout.write = originalStdoutWrite;
	process.chdir(originalCwd);
	process.exitCode = originalExitCode ?? 0;
	await cleanupTempDir(tempDir);
});

describe("createMissionDebugCommand structure", () => {
	test("registers status, retry, accept, abort subcommands", () => {
		const cmd = createMissionDebugCommand();
		const names = cmd.commands.map((c) => c.name());
		expect(names).toContain("status");
		expect(names).toContain("retry");
		expect(names).toContain("accept");
		expect(names).toContain("abort");
	});

	test("status subcommand exposes --json", () => {
		const cmd = createMissionDebugCommand();
		const status = cmd.commands.find((c) => c.name() === "status");
		const opts = status?.options ?? [];
		expect(opts.find((o) => o.long === "--json")).toBeDefined();
	});

	test("accept subcommand exposes --notes and --json", () => {
		const cmd = createMissionDebugCommand();
		const accept = cmd.commands.find((c) => c.name() === "accept");
		const opts = accept?.options ?? [];
		expect(opts.find((o) => o.long === "--notes")).toBeDefined();
		expect(opts.find((o) => o.long === "--json")).toBeDefined();
	});

	test("abort subcommand exposes --reason and --json", () => {
		const cmd = createMissionDebugCommand();
		const abort = cmd.commands.find((c) => c.name() === "abort");
		const opts = abort?.options ?? [];
		expect(opts.find((o) => o.long === "--reason")).toBeDefined();
		expect(opts.find((o) => o.long === "--json")).toBeDefined();
	});
});

describe("mission debug retry — atomic state reset", () => {
	test("resets debugAttempts, moves node back to holdout, unfreezes, clears pauseReason", async () => {
		const missionId = "m-retry-1";
		seedMission(overstoryDir, {
			id: missionId,
			slug: "retry-mission",
			state: "frozen",
			pendingInputKind: "debug-escalation",
			debugAttempts: 3,
			currentNode: "done-phase:debug-paused",
		});

		const cmd = createMissionDebugCommand();
		const retry = cmd.commands.find((c) => c.name() === "retry");
		if (!retry) throw new Error("retry subcommand not registered");
		await retry.parseAsync([missionId, "--json"], { from: "user" });

		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			const mission = store.getById(missionId);
			expect(mission).not.toBeNull();
			if (!mission) throw new Error("mission not found");
			expect(mission.state).toBe("active");
			expect(mission.pendingInputKind).toBeNull();
			expect(mission.pauseReason).toBeNull();
			expect(mission.currentNode).toBe("done-phase:holdout");

			const cp = store.checkpoints.getCheckpoint(missionId, "done-phase:dispatch-debugger");
			expect(cp).not.toBeNull();
			const data = cp?.data as { debugAttempts?: number; resetByOperator?: boolean };
			expect(data.debugAttempts).toBe(0);
			expect(data.resetByOperator).toBe(true);
		} finally {
			store.close();
		}
	});

	test("resolves mission by slug as well as id", async () => {
		const missionId = "m-retry-2";
		seedMission(overstoryDir, {
			id: missionId,
			slug: "retry-by-slug",
			state: "frozen",
			pendingInputKind: "debug-escalation",
			debugAttempts: 2,
			currentNode: "done-phase:debug-paused",
		});

		const cmd = createMissionDebugCommand();
		const retry = cmd.commands.find((c) => c.name() === "retry");
		if (!retry) throw new Error("retry subcommand not registered");
		await retry.parseAsync(["retry-by-slug", "--json"], { from: "user" });

		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			const mission = store.getById(missionId);
			expect(mission?.state).toBe("active");
			expect(mission?.currentNode).toBe("done-phase:holdout");
		} finally {
			store.close();
		}
	});

	test("falls back to active mission when no arg given", async () => {
		const missionId = "m-retry-3";
		seedMission(overstoryDir, {
			id: missionId,
			slug: "retry-active",
			state: "frozen",
			pendingInputKind: "debug-escalation",
			debugAttempts: 1,
			currentNode: "done-phase:debug-paused",
		});

		const cmd = createMissionDebugCommand();
		const retry = cmd.commands.find((c) => c.name() === "retry");
		if (!retry) throw new Error("retry subcommand not registered");
		await retry.parseAsync(["--json"], { from: "user" });

		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			const mission = store.getById(missionId);
			expect(mission?.state).toBe("active");
		} finally {
			store.close();
		}
	});

	test("exits with code 1 when mission not found", async () => {
		const cmd = createMissionDebugCommand();
		const retry = cmd.commands.find((c) => c.name() === "retry");
		if (!retry) throw new Error("retry subcommand not registered");
		await retry.parseAsync(["does-not-exist", "--json"], { from: "user" });

		expect(process.exitCode).toBe(1);
	});
});

describe("mission debug accept", () => {
	test("unfreezes, sets pauseReason with notes, marks completed", async () => {
		const missionId = "m-accept-1";
		seedMission(overstoryDir, {
			id: missionId,
			slug: "accept-mission",
			state: "frozen",
			pendingInputKind: "debug-escalation",
			debugAttempts: 3,
		});

		const cmd = createMissionDebugCommand();
		const accept = cmd.commands.find((c) => c.name() === "accept");
		if (!accept) throw new Error("accept subcommand not registered");
		await accept.parseAsync([missionId, "--notes", "fixed in editor", "--json"], { from: "user" });

		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			const mission = store.getById(missionId);
			expect(mission?.state).toBe("completed");
			expect(mission?.pauseReason).toBe("accepted: fixed in editor");
		} finally {
			store.close();
		}
	});

	test("uses default note when --notes not provided", async () => {
		const missionId = "m-accept-2";
		seedMission(overstoryDir, {
			id: missionId,
			slug: "accept-default",
			state: "frozen",
			pendingInputKind: "debug-escalation",
		});

		const cmd = createMissionDebugCommand();
		const accept = cmd.commands.find((c) => c.name() === "accept");
		if (!accept) throw new Error("accept subcommand not registered");
		await accept.parseAsync([missionId, "--json"], { from: "user" });

		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			const mission = store.getById(missionId);
			expect(mission?.state).toBe("completed");
			expect(mission?.pauseReason).toContain("accepted:");
		} finally {
			store.close();
		}
	});
});

describe("mission debug abort", () => {
	test("unfreezes, sets pauseReason with reason, marks failed", async () => {
		const missionId = "m-abort-1";
		seedMission(overstoryDir, {
			id: missionId,
			slug: "abort-mission",
			state: "frozen",
			pendingInputKind: "debug-escalation",
			debugAttempts: 3,
		});

		const cmd = createMissionDebugCommand();
		const abort = cmd.commands.find((c) => c.name() === "abort");
		if (!abort) throw new Error("abort subcommand not registered");
		await abort.parseAsync([missionId, "--reason", "unfixable infra issue", "--json"], {
			from: "user",
		});

		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			const mission = store.getById(missionId);
			expect(mission?.state).toBe("failed");
			expect(mission?.pauseReason).toBe("aborted: unfixable infra issue");
		} finally {
			store.close();
		}
	});

	test("uses default reason when --reason not provided", async () => {
		const missionId = "m-abort-2";
		seedMission(overstoryDir, {
			id: missionId,
			slug: "abort-default",
			state: "frozen",
			pendingInputKind: "debug-escalation",
		});

		const cmd = createMissionDebugCommand();
		const abort = cmd.commands.find((c) => c.name() === "abort");
		if (!abort) throw new Error("abort subcommand not registered");
		await abort.parseAsync([missionId, "--json"], { from: "user" });

		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			const mission = store.getById(missionId);
			expect(mission?.state).toBe("failed");
			expect(mission?.pauseReason).toContain("aborted:");
		} finally {
			store.close();
		}
	});
});

describe("mission debug status", () => {
	test("returns JSON with mission metadata and empty attempts array when no debug dir", async () => {
		const missionId = "m-status-1";
		seedMission(overstoryDir, {
			id: missionId,
			slug: "status-mission",
			state: "frozen",
			pendingInputKind: "debug-escalation",
		});

		// Capture stdout to validate JSON shape
		let captured = "";
		process.stdout.write = ((chunk: unknown) => {
			captured += typeof chunk === "string" ? chunk : String(chunk);
			return true;
		}) as typeof process.stdout.write;

		const cmd = createMissionDebugCommand();
		const status = cmd.commands.find((c) => c.name() === "status");
		if (!status) throw new Error("status subcommand not registered");
		await status.parseAsync([missionId, "--json"], { from: "user" });

		expect(captured.length).toBeGreaterThan(0);
		const parsed = JSON.parse(captured);
		expect(parsed.missionId).toBe(missionId);
		expect(parsed.slug).toBe("status-mission");
		expect(parsed.state).toBe("frozen");
		expect(parsed.pendingInputKind).toBe("debug-escalation");
		expect(parsed.attempts).toEqual([]);
		expect(parsed.consultationPackPath).toBeNull();
	});

	test("reads attempts from artifact debug/attempts dir", async () => {
		const missionId = "m-status-2";
		const slug = "status-with-attempts";
		seedMission(overstoryDir, {
			id: missionId,
			slug,
			state: "frozen",
			pendingInputKind: "debug-escalation",
		});

		// Pre-populate attempts/<N>/hypothesis.md fixtures
		const artifactRoot = join(overstoryDir, "artifacts", slug);
		const attemptsDir = join(artifactRoot, "debug", "attempts");
		await Bun.write(join(attemptsDir, "0", "hypothesis.md"), "first hypothesis");
		await Bun.write(join(attemptsDir, "1", "hypothesis.md"), "second hypothesis");
		await Bun.write(
			join(artifactRoot, "debug", "consultation-request-pack.md"),
			"consultation pack",
		);

		let captured = "";
		process.stdout.write = ((chunk: unknown) => {
			captured += typeof chunk === "string" ? chunk : String(chunk);
			return true;
		}) as typeof process.stdout.write;

		const cmd = createMissionDebugCommand();
		const status = cmd.commands.find((c) => c.name() === "status");
		if (!status) throw new Error("status subcommand not registered");
		await status.parseAsync([missionId, "--json"], { from: "user" });

		const parsed = JSON.parse(captured);
		expect(parsed.attempts.length).toBe(2);
		expect(parsed.attempts[0].n).toBe(0);
		expect(parsed.attempts[0].hypothesis).toBe("first hypothesis");
		expect(parsed.attempts[1].n).toBe(1);
		expect(parsed.consultationPackPath).toContain("consultation-request-pack.md");
	});
});
