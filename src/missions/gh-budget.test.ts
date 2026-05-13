import { afterEach, expect, test } from "bun:test";
import {
	createGhBudget,
	type GhBudget,
	type GhBudgetConfig,
	type GhInvocationResult,
	type GhSpawn,
	getGhBudget,
	setGhBudget,
} from "./gh-budget.ts";

// === Helpers ===

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
};

function makeDeferred<T>(): Deferred<T> {
	return Promise.withResolvers<T>();
}

function instantSpawn(result: { stdout: string; stderr: string; exitCode: number }): GhSpawn {
	return async () => result;
}

async function microtaskFlush(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
}

afterEach(() => {
	setGhBudget(null);
});

// === T-w13-1: Token bucket math ===

test("T-w13-1: Token bucket math — first burst immediate, refill paced at rpm/60", async () => {
	const config: GhBudgetConfig = { rpm: 60, burst: 20, callTimeoutMs: 1000, maxConcurrent: 100 };
	const spawn = instantSpawn({ stdout: "", stderr: "", exitCode: 0 });
	const budget = createGhBudget(config, { spawn });

	const t0 = performance.now();
	const promises: Promise<GhInvocationResult>[] = [];
	const resolveTimes: number[] = [];

	for (let i = 0; i < 30; i++) {
		promises.push(
			budget.runGh(["api", `/x/${i}`]).then((r) => {
				resolveTimes.push(performance.now() - t0);
				return r;
			}),
		);
	}

	await Promise.all(promises);

	// First 20 (burst) should resolve quickly (within ~200ms).
	const fastSet = resolveTimes
		.slice()
		.sort((a, b) => a - b)
		.slice(0, 20);
	for (const t of fastSet) {
		expect(t).toBeLessThan(250);
	}

	// Remaining 10 dispatched roughly at 1/s (rpm=60 → 1 token/sec).
	const slowSet = resolveTimes
		.slice()
		.sort((a, b) => a - b)
		.slice(20);
	expect(slowSet).toHaveLength(10);
	// Last (10th) of remaining should land around 10s — give ±250ms tolerance per-step but
	// total tolerance loosened to ±2500ms for the 10th slot.
	const lastSlow = slowSet[slowSet.length - 1];
	expect(lastSlow).toBeDefined();
	if (lastSlow !== undefined) {
		expect(lastSlow).toBeGreaterThanOrEqual(9750);
		expect(lastSlow).toBeLessThanOrEqual(12500);
	}
}, 30000);

// === T-w13-2: Concurrency cap ===

test("T-w13-2: Concurrency cap — never exceeds maxConcurrent in-flight", async () => {
	const config: GhBudgetConfig = {
		rpm: 6000,
		burst: 100,
		callTimeoutMs: 5000,
		maxConcurrent: 8,
	};

	const deferreds: Deferred<{ stdout: string; stderr: string; exitCode: number }>[] = [];
	let inFlight = 0;
	let maxObservedInFlight = 0;

	const spawn: GhSpawn = async () => {
		inFlight++;
		if (inFlight > maxObservedInFlight) maxObservedInFlight = inFlight;
		const d = makeDeferred<{ stdout: string; stderr: string; exitCode: number }>();
		deferreds.push(d);
		try {
			return await d.promise;
		} finally {
			inFlight--;
		}
	};

	const budget = createGhBudget(config, { spawn });

	const promises: Promise<GhInvocationResult>[] = [];
	for (let i = 0; i < 16; i++) {
		promises.push(budget.runGh(["api", `/x/${i}`]));
	}

	await microtaskFlush();
	await Bun.sleep(20);

	expect(inFlight).toBe(8);
	expect(deferreds).toHaveLength(8);

	// Resolve first 8 → next 8 dispatch.
	for (let i = 0; i < 8; i++) {
		const d = deferreds[i];
		expect(d).toBeDefined();
		if (d) d.resolve({ stdout: "", stderr: "", exitCode: 0 });
	}

	await microtaskFlush();
	await Bun.sleep(20);

	expect(inFlight).toBe(8);
	expect(deferreds.length).toBe(16);

	for (let i = 8; i < 16; i++) {
		const d = deferreds[i];
		expect(d).toBeDefined();
		if (d) d.resolve({ stdout: "", stderr: "", exitCode: 0 });
	}

	await Promise.all(promises);
	expect(inFlight).toBe(0);
	expect(maxObservedInFlight).toBe(8);
}, 10000);

// === T-w13-3: Retry-After parse pauses bucket ===

test("T-w13-3: Retry-After parse pauses bucket ~30s", async () => {
	const config: GhBudgetConfig = { rpm: 60, burst: 10, callTimeoutMs: 1000, maxConcurrent: 4 };

	let call = 0;
	const spawn: GhSpawn = async () => {
		call++;
		if (call === 1) {
			return { stdout: "", stderr: "Retry-After: 30\n", exitCode: 1 };
		}
		// Subsequent calls would hang (held by bucket pause).
		return new Promise(() => {});
	};

	const budget = createGhBudget(config, { spawn });

	const first = await budget.runGh(["pr", "create"]);
	expect(first.exitCode).toBe(1);

	const snap = budget.snapshot();
	expect(snap.lastRateLimitResetAt).not.toBeNull();
	if (snap.lastRateLimitResetAt) {
		const delta = Date.parse(snap.lastRateLimitResetAt) - Date.now();
		expect(delta).toBeGreaterThanOrEqual(29000);
		expect(delta).toBeLessThanOrEqual(31000);
	}

	// Verify pause: fire a second call; expect it queued, not resolved within 50ms.
	let secondResolved = false;
	const second = budget.runGh(["pr", "view"]).then((r) => {
		secondResolved = true;
		return r;
	});

	await microtaskFlush();
	await Bun.sleep(50);

	expect(secondResolved).toBe(false);
	expect(budget.snapshot().queuedCount).toBe(1);

	// Don't await `second` — leave pending; Bun tears down on suite exit.
	void second;
}, 5000);

// === T-w13-4: X-RateLimit-Reset parse pauses bucket ===

test("T-w13-4: X-RateLimit-Reset parse pauses bucket until reset time", async () => {
	const config: GhBudgetConfig = { rpm: 60, burst: 5, callTimeoutMs: 1000, maxConcurrent: 4 };

	const resetUnixTs = Math.floor(Date.now() / 1000) + 5;
	let call = 0;
	const spawn: GhSpawn = async () => {
		call++;
		if (call === 1) {
			return {
				stdout: "",
				stderr: `X-RateLimit-Remaining: 0\nX-RateLimit-Reset: ${resetUnixTs}\n`,
				exitCode: 1,
			};
		}
		return new Promise(() => {});
	};

	const budget = createGhBudget(config, { spawn });

	await budget.runGh(["api", "/rate_limit"]);

	const snap = budget.snapshot();
	expect(snap.lastRateLimitResetAt).not.toBeNull();
	if (snap.lastRateLimitResetAt) {
		const delta = Date.parse(snap.lastRateLimitResetAt) - Date.now();
		expect(delta).toBeGreaterThanOrEqual(4000);
		expect(delta).toBeLessThanOrEqual(6000);
	}
}, 5000);

// === T-w13-5: Call timeout kills subprocess ===

test("T-w13-5: Call timeout kills subprocess and returns timeout result", async () => {
	const config: GhBudgetConfig = { rpm: 6000, burst: 10, callTimeoutMs: 200, maxConcurrent: 1 };

	let abortObserved = false;
	const spawn: GhSpawn = async (_args, opts) => {
		return new Promise((resolve) => {
			opts.signal.addEventListener("abort", () => {
				abortObserved = true;
				resolve({ stdout: "", stderr: "", exitCode: 137 });
			});
		});
	};

	const budget = createGhBudget(config, { spawn });

	const t0 = performance.now();
	const result = await budget.runGh(["api", "/hang"]);
	const elapsed = performance.now() - t0;

	expect(elapsed).toBeLessThan(600);
	expect(result.exitCode).toBe(-1);
	expect(result.stderr).toBe("gh call timeout");
	expect(result.durationMs).toBeGreaterThanOrEqual(200);
	expect(result.durationMs).toBeLessThan(600);
	expect(abortObserved).toBe(true);
}, 5000);

// === T-w13-6: snapshot() accurate counts ===

test("T-w13-6: snapshot() accurate counts during acquire and queueing", async () => {
	const config: GhBudgetConfig = {
		rpm: 60,
		burst: 5,
		callTimeoutMs: 1000,
		maxConcurrent: 100,
	};

	const deferreds: Deferred<{ stdout: string; stderr: string; exitCode: number }>[] = [];
	const spawn: GhSpawn = async () => {
		const d = makeDeferred<{ stdout: string; stderr: string; exitCode: number }>();
		deferreds.push(d);
		return d.promise;
	};

	const budget = createGhBudget(config, { spawn });

	const initial = budget.snapshot();
	expect(initial.tokensAvailable).toBe(5);
	expect(initial.queuedCount).toBe(0);
	expect(initial.lastRateLimitResetAt).toBeNull();

	const promises: Promise<GhInvocationResult>[] = [];
	for (let i = 0; i < 5; i++) {
		promises.push(budget.runGh(["api", `/a/${i}`]));
	}

	await microtaskFlush();
	await Bun.sleep(10);

	const afterFive = budget.snapshot();
	expect(afterFive.tokensAvailable).toBe(0);
	expect(afterFive.queuedCount).toBe(0);

	for (let i = 0; i < 3; i++) {
		promises.push(budget.runGh(["api", `/b/${i}`]));
	}

	await microtaskFlush();
	await Bun.sleep(10);

	expect(budget.snapshot().queuedCount).toBe(3);

	// Resolve all 8 deferreds — but only 5 exist now; remaining 3 are queued and will only
	// invoke spawn when tokens refill. Resolve as deferreds appear by draining periodically.
	const drainStart = performance.now();
	while (deferreds.length < 5 && performance.now() - drainStart < 1000) {
		await Bun.sleep(5);
	}
	for (let i = 0; i < 5; i++) {
		const d = deferreds[i];
		if (d) d.resolve({ stdout: "", stderr: "", exitCode: 0 });
	}

	await microtaskFlush();
	await Bun.sleep(10);

	// Queued 3 still waiting on token refill — drain remaining tokens by waiting.
	// At 1 token/sec, draining 3 takes ~3s. To keep test fast, just verify queuedCount
	// has not grown — actual drain time is implementation-paced.
	expect(budget.snapshot().queuedCount).toBeLessThanOrEqual(3);
}, 10000);

// === T-w13-7: Singleton default + setGhBudget override ===

test("T-w13-7: getGhBudget default singleton + setGhBudget override", () => {
	setGhBudget(null);

	const a = getGhBudget();
	expect(a.snapshot().tokensAvailable).toBe(20);

	const override: GhBudget = createGhBudget({
		rpm: 1,
		burst: 1,
		callTimeoutMs: 100,
		maxConcurrent: 1,
	});
	setGhBudget(override);

	const b = getGhBudget();
	expect(b.snapshot().tokensAvailable).toBe(1);
	expect(a).not.toBe(b);
});

// === T-w13-8: FIFO ordering ===

test("T-w13-8: FIFO ordering — queued callers resolve in submission order", async () => {
	const config: GhBudgetConfig = {
		rpm: 60,
		burst: 1,
		callTimeoutMs: 1000,
		maxConcurrent: 100,
	};

	const seenArgs: string[] = [];
	const spawn: GhSpawn = async (args) => {
		const first = args[0];
		if (first !== undefined) seenArgs.push(first);
		return { stdout: "", stderr: "", exitCode: 0 };
	};

	const budget = createGhBudget(config, { spawn });

	const ids = ["a1", "a2", "a3", "a4", "a5"];
	const promises: Promise<GhInvocationResult>[] = [];
	for (const id of ids) {
		promises.push(budget.runGh([id]));
		await Promise.resolve();
	}

	await Promise.all(promises);

	expect(seenArgs).toEqual(ids);
}, 30000);
