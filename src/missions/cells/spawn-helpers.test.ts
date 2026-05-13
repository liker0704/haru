import { describe, expect, test } from "bun:test";
import { spawnEphemeralAgent } from "./spawn-helpers.ts";

describe("spawnEphemeralAgent", () => {
	test("returns spawned:true within <50ms even if proc.exited never resolves", () => {
		const stub = (_cmd: unknown, _opts: unknown) => ({
			unref: () => {},
			exited: new Promise<number>(() => {}), // never resolves
		});
		const before = Date.now();
		const result = spawnEphemeralAgent(
			{ capability: "test-cap", agentName: "test-agent" },
			{ spawn: stub as unknown as typeof Bun.spawn },
		);
		const elapsed = Date.now() - before;
		expect(result.spawned).toBe(true);
		// bug_demo: under HEAD~1 (50ms setTimeout probe), elapsed ≥ 50ms.
		// Under HEAD, returns immediately — no await, no setTimeout.
		expect(elapsed).toBeLessThan(50);
	});

	test("synchronous spawn throw returns spawned:false with reason", () => {
		const stub = (_cmd: unknown, _opts: unknown): never => {
			throw new Error("ENOENT: ha not found");
		};
		const result = spawnEphemeralAgent(
			{ capability: "test-cap", agentName: "test-agent" },
			{ spawn: stub as unknown as typeof Bun.spawn },
		);
		expect(result.spawned).toBe(false);
		expect(result.reason).toContain("ENOENT");
	});

	test("calls proc.unref and passes detached:true", () => {
		let capturedOpts: Record<string, unknown> | undefined;
		let unrefCount = 0;
		const stub = (_cmd: unknown, opts: unknown) => {
			capturedOpts = opts as Record<string, unknown>;
			return {
				unref: () => {
					unrefCount++;
				},
				exited: Promise.resolve(0),
			};
		};
		spawnEphemeralAgent(
			{ capability: "test-cap", agentName: "test-agent" },
			{ spawn: stub as unknown as typeof Bun.spawn },
		);
		expect(unrefCount).toBe(1);
		expect(capturedOpts?.detached).toBe(true);
	});
});
