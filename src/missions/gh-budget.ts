export interface GhBudgetConfig {
	rpm: number;
	burst: number;
	callTimeoutMs: number;
	maxConcurrent: number;
}

export interface GhInvocationResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	durationMs: number;
}

export interface GhBudget {
	runGh(
		args: readonly string[],
		opts?: { cwd?: string; env?: Record<string, string> },
	): Promise<GhInvocationResult>;
	snapshot(): { tokensAvailable: number; queuedCount: number; lastRateLimitResetAt: string | null };
}

export type GhSpawn = (
	args: readonly string[],
	opts: { cwd?: string; env?: Record<string, string>; signal: AbortSignal },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export const DEFAULT_GH_BUDGET_CONFIG: GhBudgetConfig = {
	rpm: 60,
	burst: 20,
	callTimeoutMs: 10_000,
	maxConcurrent: 8,
};

const realGhSpawn: GhSpawn = async (args, opts) => {
	const proc = Bun.spawn(["gh", ...args], {
		cwd: opts.cwd,
		env: opts.env ?? Bun.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	opts.signal.addEventListener("abort", () => {
		try {
			proc.kill();
		} catch {}
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
};

type Waiter = { resolve: () => void };

export function createGhBudget(
	config: GhBudgetConfig,
	deps?: { spawn?: GhSpawn; now?: () => number },
): GhBudget {
	const spawn = deps?.spawn ?? realGhSpawn;
	const now = deps?.now ?? (() => Date.now());

	let lastTokens = config.burst;
	let lastRefillAt = now();
	let pauseUntilMs: number | null = null;

	// Token-bucket waiters (FIFO)
	const waiters: Waiter[] = [];

	// Concurrency tracking
	let inFlight = 0;
	const concWaiters: Waiter[] = [];

	function computeTokens(): number {
		const t = now();
		const elapsed = t - lastRefillAt;
		return Math.min(config.burst, lastTokens + (elapsed * config.rpm) / 60_000);
	}

	function tryDispatchWaiters(): void {
		// Wake waiters that can now proceed (not paused, token available)
		while (waiters.length > 0) {
			if (pauseUntilMs !== null && now() < pauseUntilMs) break;
			const tokens = computeTokens();
			if (tokens < 1) break;
			// consume one token
			lastTokens = tokens - 1;
			lastRefillAt = now();
			const waiter = waiters.shift();
			if (waiter) waiter.resolve();
		}
	}

	function scheduleRefill(): void {
		if (waiters.length === 0) return;

		// If paused, schedule wake after pause ends
		if (pauseUntilMs !== null) {
			const delay = pauseUntilMs - now();
			if (delay > 0) {
				setTimeout(() => {
					pauseUntilMs = null;
					tryDispatchWaiters();
					scheduleRefill();
				}, delay);
				return;
			}
			pauseUntilMs = null;
		}

		// Schedule next token arrival
		const tokens = computeTokens();
		if (tokens >= 1) {
			tryDispatchWaiters();
			scheduleRefill();
		} else {
			// Time until next token: need (1 - tokens) * 60_000 / rpm ms
			const delay = ((1 - tokens) * 60_000) / config.rpm;
			setTimeout(() => {
				tryDispatchWaiters();
				scheduleRefill();
			}, delay);
		}
	}

	function acquireToken(): Promise<void> {
		// Check pause
		if (pauseUntilMs !== null && now() < pauseUntilMs) {
			return new Promise<void>((resolve) => {
				waiters.push({ resolve });
				if (waiters.length === 1) scheduleRefill();
			});
		}

		const tokens = computeTokens();
		if (tokens >= 1) {
			lastTokens = tokens - 1;
			lastRefillAt = now();
			return Promise.resolve();
		}

		// Enqueue waiter
		return new Promise<void>((resolve) => {
			const waiter = { resolve };
			waiters.push(waiter);
			if (waiters.length === 1) scheduleRefill();
		});
	}

	function acquireConcurrency(): Promise<void> {
		if (inFlight < config.maxConcurrent) {
			inFlight++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			concWaiters.push({ resolve });
		});
	}

	function releaseConcurrency(): void {
		const waiter = concWaiters.shift();
		if (waiter) {
			waiter.resolve();
		} else {
			inFlight--;
		}
	}

	function parseRateLimitHeaders(stderr: string): number | null {
		const lines = stderr.split("\n");
		let retryAfterMs: number | null = null;
		let remaining: string | null = null;
		let resetTs: string | null = null;

		for (const line of lines) {
			const retryMatch = /^Retry-After:\s*(\d+)/.exec(line);
			if (retryMatch?.[1]) {
				const secs = parseInt(retryMatch[1], 10);
				const candidate = now() + secs * 1000;
				if (retryAfterMs === null || candidate > retryAfterMs) retryAfterMs = candidate;
			}
			if (/^X-RateLimit-Remaining:\s*0/.test(line)) remaining = "0";
			const resetMatch = /^X-RateLimit-Reset:\s*(\d+)/.exec(line);
			if (resetMatch?.[1]) resetTs = resetMatch[1];
		}

		let result = retryAfterMs;
		if (remaining === "0" && resetTs !== null) {
			const candidate = parseInt(resetTs, 10) * 1000;
			if (result === null || candidate > result) result = candidate;
		}
		return result;
	}

	async function runGh(
		args: readonly string[],
		opts?: { cwd?: string; env?: Record<string, string> },
	): Promise<GhInvocationResult> {
		await acquireToken();
		await acquireConcurrency();

		const controller = new AbortController();
		const startMs = now();

		let timedOut = false;
		const timeoutHandle = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, config.callTimeoutMs);

		let spawnResult: { stdout: string; stderr: string; exitCode: number };
		try {
			spawnResult = await Promise.race([
				spawn(args, { cwd: opts?.cwd, env: opts?.env, signal: controller.signal }),
				new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
					setTimeout(() => {
						resolve({ stdout: "", stderr: "gh call timeout", exitCode: -1 });
					}, config.callTimeoutMs);
				}),
			]);
		} finally {
			clearTimeout(timeoutHandle);
			releaseConcurrency();
		}

		const durationMs = now() - startMs;

		if (timedOut) {
			// Refund the token so repeated timeouts don't drain burst capacity
			lastTokens = Math.min(config.burst, computeTokens() + 1);
			lastRefillAt = now();
			return {
				stdout: "",
				stderr: "gh call timeout",
				exitCode: -1,
				durationMs: config.callTimeoutMs,
			};
		}

		// Parse rate-limit headers AFTER spawn resolves
		const pauseCandidate = parseRateLimitHeaders(spawnResult.stderr);
		if (pauseCandidate !== null) {
			if (pauseUntilMs === null || pauseCandidate > pauseUntilMs) {
				pauseUntilMs = pauseCandidate;
			}
		}

		return {
			stdout: spawnResult.stdout,
			stderr: spawnResult.stderr,
			exitCode: spawnResult.exitCode,
			durationMs,
		};
	}

	function snapshot(): {
		tokensAvailable: number;
		queuedCount: number;
		lastRateLimitResetAt: string | null;
	} {
		return {
			tokensAvailable: Math.floor(computeTokens()),
			queuedCount: waiters.length,
			lastRateLimitResetAt: pauseUntilMs !== null ? new Date(pauseUntilMs).toISOString() : null,
		};
	}

	return { runGh, snapshot };
}

let sharedBudget: GhBudget | null = null;

export function getGhBudget(): GhBudget {
	if (sharedBudget === null) {
		sharedBudget = createGhBudget(DEFAULT_GH_BUDGET_CONFIG);
	}
	return sharedBudget;
}

export function setGhBudget(b: GhBudget | null): void {
	sharedBudget = b;
}
