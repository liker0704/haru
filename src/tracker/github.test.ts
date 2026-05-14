/**
 * GitHub Issues tracker adapter tests.
 *
 * Uses Bun.spawn mocks — the `gh` CLI would hit live GitHub API and
 * mutate real issue state if invoked directly.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AgentError } from "../errors.ts";
import { createGitHubTracker } from "./github.ts";

function mockSpawnResult(
	stdout: string,
	stderr: string,
	exitCode: number,
): {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	pid: number;
} {
	return {
		stdout: new Response(stdout).body as ReadableStream<Uint8Array>,
		stderr: new Response(stderr).body as ReadableStream<Uint8Array>,
		exited: Promise.resolve(exitCode),
		pid: 12345,
	};
}

const TEST_CWD = "/test/repo";

describe("createGitHubTracker — comment()", () => {
	let spawnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		spawnSpy = spyOn(Bun, "spawn");
	});

	afterEach(() => {
		spawnSpy.mockRestore();
	});

	test("calls [gh, issue, comment, <id>, --body, <body>]", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		const tracker = createGitHubTracker(TEST_CWD);
		await tracker.comment("42", "Resolved by abc123");

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const cmd = callArgs[0] as string[];
		expect(cmd).toEqual(["gh", "issue", "comment", "42", "--body", "Resolved by abc123"]);
	});

	test("propagates cwd to Bun.spawn", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "", 0));

		const customCwd = "/my/project/root";
		const tracker = createGitHubTracker(customCwd);
		await tracker.comment("1", "note");

		const callArgs = spawnSpy.mock.calls[0] as unknown[];
		const opts = callArgs[1] as { cwd: string };
		expect(opts.cwd).toBe(customCwd);
	});

	test("throws AgentError on non-zero exit code", async () => {
		spawnSpy.mockImplementation(() => mockSpawnResult("", "could not find issue: 999", 1));

		const tracker = createGitHubTracker(TEST_CWD);
		await expect(tracker.comment("999", "hello")).rejects.toThrow(AgentError);
	});
});
