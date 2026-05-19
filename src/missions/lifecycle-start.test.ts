/**
 * Tests for missionStart() and missionResumeAll().
 *
 * Strategy:
 * - missionStart() has deep tmux/agent-spawn dependencies that cannot be
 *   exercised without a live tmux + Claude runtime. We test one observable
 *   side-effect that happens before any role is spawned: the artifact
 *   directory is created. We verify this by injecting stub deps that return
 *   immediately without spawning anything.
 * - missionResumeAll() is tested for its error path when no suspended mission
 *   exists — a pure DB + exitCode test with no tmux required.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartPersistentAgentResult } from "../agents/persistent-root.ts";
import { buildAgentManifest } from "../commands/init.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { missionResumeAll, missionStart } from "./lifecycle-start.ts";
import type { MissionCommandDeps } from "./lifecycle-types.ts";
import { createMissionStore } from "./store.ts";

let tempDir: string;
let overstoryDir: string;
let projectRoot: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "ov-lifecycle-start-test-"));
	overstoryDir = join(tempDir, ".overstory");
	projectRoot = tempDir;
	await Bun.write(join(overstoryDir, ".keep"), "");
	await Bun.write(
		join(overstoryDir, "agent-manifest.json"),
		JSON.stringify(buildAgentManifest(), null, "\t"),
	);

	// Minimal config.yaml so loadConfig() succeeds
	await Bun.write(
		join(projectRoot, ".overstory", "config.yaml"),
		["version: 1", "watchdog:", "  tier0Enabled: false", "mission:", "  maxConcurrent: 1"].join(
			"\n",
		),
	);
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

/** Minimal stub for startMissionCoordinator / startMissionAnalyst injected via deps. */
function makeRoleStub(sessionId: string) {
	return async (_opts: unknown) =>
		({
			session: {
				id: sessionId,
				agentName: "stub",
				tmuxSession: null,
				pid: null,
				worktreePath: null,
				state: "active" as const,
				depth: 0,
				runId: null,
				runtimeSessionId: null,
				capability: null,
				branchName: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
			runId: null,
			pid: 0,
		}) as unknown as StartPersistentAgentResult;
}

describe("missionStart", () => {
	test("scaffolds the artifact directory before any role is spawned", async () => {
		// Use injected stubs that resolve without touching tmux/Claude
		const deps = {
			startMissionCoordinator: makeRoleStub("coord-session-stub"),
			startMissionAnalyst: makeRoleStub("analyst-session-stub"),
			stopMissionRole: async () => ({}) as never,
		} as MissionCommandDeps;

		await missionStart(
			overstoryDir,
			projectRoot,
			{ slug: "test-scaffold", objective: "scaffold test", json: true },
			deps,
		);

		// Find the created mission to locate its artifactRoot
		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		let artifactRoot: string | null = null;
		try {
			const missions = store.list();
			const created = missions.find((m) => m.slug === "test-scaffold");
			artifactRoot = created?.artifactRoot ?? null;
		} finally {
			store.close();
		}

		expect(artifactRoot).not.toBeNull();
		// The directory must exist on disk — access() resolves without throwing on success
		let accessError: unknown;
		try {
			await access(artifactRoot!);
		} catch (err) {
			accessError = err;
		}
		expect(accessError).toBeUndefined();
	});
});

describe("missionStart feature branch (issue #321)", () => {
	test("defaults feature_branch to mission/<slug> and materializes branch in git", async () => {
		// Set up a real git repo at projectRoot so materializeFeatureBranch
		// can create a branch.
		const { createTempGitRepo, runGitInDir } = await import("../test-helpers.ts");
		const repoDir = await createTempGitRepo();
		const repoOverstoryDir = join(repoDir, ".overstory");
		await Bun.write(join(repoOverstoryDir, ".keep"), "");
		await Bun.write(
			join(repoOverstoryDir, "agent-manifest.json"),
			JSON.stringify(buildAgentManifest(), null, "\t"),
		);
		await Bun.write(
			join(repoDir, ".overstory", "config.yaml"),
			["version: 1", "watchdog:", "  tier0Enabled: false", "mission:", "  maxConcurrent: 1"].join(
				"\n",
			),
		);
		// Add an origin/main ref so `git branch mission/<slug> origin/main` resolves.
		await runGitInDir(repoDir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

		const deps = {
			startMissionCoordinator: makeRoleStub("c"),
			startMissionAnalyst: makeRoleStub("a"),
			stopMissionRole: async () => ({}) as never,
		} as MissionCommandDeps;

		await missionStart(
			repoOverstoryDir,
			repoDir,
			{ slug: "issue-321-default", objective: "test", json: true },
			deps,
		);

		const store = createMissionStore(join(repoOverstoryDir, "sessions.db"));
		let featureBranch: string | null | undefined;
		try {
			const m = store.list().find((mm) => mm.slug === "issue-321-default");
			featureBranch = m?.featureBranch;
		} finally {
			store.close();
		}
		expect(featureBranch).toBe("mission/issue-321-default");

		// Verify the branch actually exists in git
		const branches = await runGitInDir(repoDir, ["branch", "--list", "mission/issue-321-default"]);
		expect(branches.trim()).toContain("mission/issue-321-default");

		await rm(repoDir, { recursive: true, force: true });
	});

	test("--feature-branch <name> overrides the default mission/<slug> name", async () => {
		const deps = {
			startMissionCoordinator: makeRoleStub("c"),
			startMissionAnalyst: makeRoleStub("a"),
			stopMissionRole: async () => ({}) as never,
		} as MissionCommandDeps;

		await missionStart(
			overstoryDir,
			projectRoot,
			{
				slug: "issue-321-override",
				objective: "test override",
				featureBranch: "custom/integration",
				json: true,
			},
			deps,
		);

		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			const m = store.list().find((mm) => mm.slug === "issue-321-override");
			expect(m?.featureBranch).toBe("custom/integration");
		} finally {
			store.close();
		}
	});

	test("--branch (existingBranch / continue-from) takes priority over default mission/<slug>", async () => {
		const deps = {
			startMissionCoordinator: makeRoleStub("c"),
			startMissionAnalyst: makeRoleStub("a"),
			stopMissionRole: async () => ({}) as never,
		} as MissionCommandDeps;

		await missionStart(
			overstoryDir,
			projectRoot,
			{
				slug: "issue-321-continue",
				objective: "continue-from path",
				existingBranch: "mission/predecessor",
				json: true,
			},
			deps,
		);

		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			const m = store.list().find((mm) => mm.slug === "issue-321-continue");
			expect(m?.featureBranch).toBe("mission/predecessor");
		} finally {
			store.close();
		}
	});
});

describe("missionStart --spec power-user paths", () => {
	async function startWithSpec(opts: {
		specFile: string;
		tier?: import("../types.ts").MissionTier;
		slug: string;
	}) {
		const deps = {
			startMissionCoordinator: makeRoleStub("coord-stub"),
			startMissionAnalyst: makeRoleStub("analyst-stub"),
			stopMissionRole: async () => ({}) as never,
		} as MissionCommandDeps;

		await missionStart(
			overstoryDir,
			projectRoot,
			{
				slug: opts.slug,
				objective: "imported spec test",
				specFile: opts.specFile,
				tier: opts.tier,
				json: true,
			},
			deps,
		);

		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			return store.list().find((m) => m.slug === opts.slug) ?? null;
		} finally {
			store.close();
		}
	}

	test("--spec without --tier: jumps to dispatch-tier-classifier (skips clarifier+analyst)", async () => {
		const specPath = join(tempDir, "pre.md");
		await Bun.write(specPath, "# Test spec\n\nIntent: test\n");

		const m = await startWithSpec({ specFile: specPath, slug: "spec-no-tier" });
		expect(m).not.toBeNull();
		expect(m?.phase).toBe("intake");
		expect(m?.currentNode).toBe("intake-phase:dispatch-tier-classifier");
		expect(m?.tier).toBeNull();
	});

	test("--spec --tier=planned: skips intake-phase entirely, jumps to understand:active", async () => {
		const specPath = join(tempDir, "pre.md");
		await Bun.write(specPath, "# Test spec\n");

		const m = await startWithSpec({ specFile: specPath, tier: "planned", slug: "spec-planned" });
		expect(m).not.toBeNull();
		expect(m?.phase).toBe("understand");
		expect(m?.currentNode).toBe("understand:active");
		expect(m?.tier).toBe("planned");
	});

	test("--spec --tier=direct: jumps directly to execute:active", async () => {
		const specPath = join(tempDir, "pre.md");
		await Bun.write(specPath, "# Test spec\n");

		const m = await startWithSpec({ specFile: specPath, tier: "direct", slug: "spec-direct" });
		expect(m).not.toBeNull();
		expect(m?.phase).toBe("execute");
		expect(m?.currentNode).toBe("execute:active");
		expect(m?.tier).toBe("direct");
	});

	test("default (no --spec): starts at intake:active for full subgraph traversal", async () => {
		const deps = {
			startMissionCoordinator: makeRoleStub("c"),
			startMissionAnalyst: makeRoleStub("a"),
			stopMissionRole: async () => ({}) as never,
		} as MissionCommandDeps;
		await missionStart(
			overstoryDir,
			projectRoot,
			{ slug: "default-flow", objective: "regular flow", json: true },
			deps,
		);
		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			const m = store.list().find((mm) => mm.slug === "default-flow");
			expect(m?.phase).toBe("intake");
			expect(m?.currentNode).toBe("intake:active");
			expect(m?.tier).toBeNull();
		} finally {
			store.close();
		}
	});
});

describe("missionResumeAll", () => {
	test("sets exitCode=1 and returns when no suspended mission exists", async () => {
		process.exitCode = 0;

		await missionResumeAll(overstoryDir, projectRoot, true /* json */);

		expect(process.exitCode).toBe(1);

		// Reset so subsequent tests are unaffected
		process.exitCode = 0;
	});

	test("resets mission_gate_state for current_node so watchdog ceiling restarts (haru-a3e9)", async () => {
		// Seed a suspended mission whose gate state holds a stale entered_at —
		// this is the post-auto-suspend shape produced by max_total_wait_exceeded.
		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			store.create({
				id: "mission-gate-reset-test",
				slug: "gate-reset-test",
				objective: "verify resume clears stale gate row",
				runId: "run-test",
				artifactRoot: join(overstoryDir, "missions", "mission-gate-reset-test"),
				autonomy: "auto-all",
			} as never);
			// Mutate post-create into the post-auto-suspend shape
			store.updateState("mission-gate-reset-test", "suspended");
			store.updatePhase("mission-gate-reset-test", "understand");
			store.updateCurrentNode("mission-gate-reset-test", "understand-phase:evaluate");
		} finally {
			store.close();
		}

		// Insert stale gate row via raw SQL (store has no setter)
		const { Database } = await import("bun:sqlite");
		const rawDb = new Database(join(overstoryDir, "sessions.db"));
		try {
			const stale = new Date(Date.now() - 3900_000).toISOString();
			rawDb.run(
				"INSERT INTO mission_gate_state (mission_id, node_id, entered_at, nudge_count, last_nudge_at, respawn_count, last_respawn_at, grace_ms, nudge_interval_ms, max_nudges, max_total_wait_ms, resolved_at, resolved_trigger, ceiling_emitted_at) VALUES (?, ?, ?, 0, NULL, 0, NULL, 120000, 60000, 3, 3600000, NULL, NULL, ?)",
				["mission-gate-reset-test", "understand-phase:evaluate", stale, stale],
			);
		} finally {
			rawDb.close();
		}

		// Call resume — should set state=active AND delete the stale gate row.
		// The subsequent restart-roles step needs tmux/spawn and may throw in
		// this test env; the gate reset is what we're asserting and it happens
		// before that step. Swallow the late-stage error.
		await missionResumeAll(
			overstoryDir,
			projectRoot,
			true /* json */,
			"mission-gate-reset-test",
		).catch(() => {});

		// Verify the gate row was reset (deleted; watchdog will re-insert fresh)
		const verifyDb = new Database(join(overstoryDir, "sessions.db"), { readonly: true });
		try {
			const row = verifyDb
				.query<{ count: number }, [string, string]>(
					"SELECT COUNT(*) as count FROM mission_gate_state WHERE mission_id=? AND node_id=?",
				)
				.get("mission-gate-reset-test", "understand-phase:evaluate");
			expect(row?.count).toBe(0);
		} finally {
			verifyDb.close();
		}

		// Verify mission state flipped to active
		const verifyStore = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			const m = verifyStore.getById("mission-gate-reset-test");
			expect(m?.state).toBe("active");
		} finally {
			verifyStore.close();
		}
	});

	test("OOM recovery — all sessions completed → resume restarts all 3 roles and warns OOM", async () => {
		const missionId = "mission-oom-test";
		const runId = "run-oom-test";
		const now = new Date().toISOString();

		// Seed a suspended full-tier execute-phase mission
		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			store.create({
				id: missionId,
				slug: "oom-test",
				objective: "verify OOM recovery",
				runId,
				artifactRoot: join(overstoryDir, "missions", missionId),
				tier: "full",
			});
			store.updateState(missionId, "suspended");
			store.updatePhase(missionId, "execute");
		} finally {
			store.close();
		}

		// Insert 3 completed sessions (simulates post-OOM state)
		const { store: sessionStore } = openSessionStore(overstoryDir);
		try {
			const base = {
				capability: "test",
				runtime: "claude",
				worktreePath: "/tmp",
				branchName: "main",
				taskId: "",
				tmuxSession: "ha-oom",
				pid: null,
				parentAgent: null,
				depth: 0,
				runId,
				startedAt: now,
				lastActivity: now,
				escalationLevel: 0,
				stalledSince: null,
				rateLimitedSince: null,
				runtimeSessionId: null,
				transcriptPath: null,
				originalRuntime: null,
				statusLine: null,
			};
			sessionStore.upsert({
				...base,
				id: "sess-coord-oom",
				agentName: "coordinator-oom-test",
				state: "completed",
				tmuxSession: "ha-coord-oom",
			});
			sessionStore.upsert({
				...base,
				id: "sess-analyst-oom",
				agentName: "mission-analyst-oom-test",
				state: "completed",
				tmuxSession: "ha-analyst-oom",
			});
			sessionStore.upsert({
				...base,
				id: "sess-ed-oom",
				agentName: "execution-director-oom-test",
				state: "completed",
				tmuxSession: "ha-ed-oom",
			});
		} finally {
			sessionStore.close();
		}

		let coordCalled = 0;
		let analystCalled = 0;
		let edCalled = 0;
		const deps = {
			startMissionCoordinator: async (_opts: unknown) => {
				coordCalled++;
				return makeRoleStub("coord-new")(_opts);
			},
			startMissionAnalyst: async (_opts: unknown) => {
				analystCalled++;
				return makeRoleStub("analyst-new")(_opts);
			},
			startExecutionDirector: async (_opts: unknown) => {
				edCalled++;
				return makeRoleStub("ed-new")(_opts);
			},
		} as unknown as MissionCommandDeps;

		let captured = "";
		const origWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		}) as typeof process.stdout.write;

		process.exitCode = 0;
		try {
			await missionResumeAll(overstoryDir, projectRoot, false, missionId, deps);
		} finally {
			process.stdout.write = origWrite;
		}

		expect(process.exitCode).toBe(0);
		expect(captured).toMatch(/OOM|all.*completed|completed.*OOM/i);
		expect(coordCalled).toBe(1);
		expect(analystCalled).toBe(1);
		expect(edCalled).toBe(1);

		// Verify ED session was bound on the mission
		const verify = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			const m = verify.getById(missionId);
			expect(m?.executionDirectorSessionId).toBe("ed-new");
		} finally {
			verify.close();
		}

		process.exitCode = 0;
	});

	test("ED restart for execute phase — full tier + execute phase → startExecutionDirector invoked", async () => {
		const missionId = "mission-ed-execute";
		const runId = "run-ed-execute";

		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			store.create({
				id: missionId,
				slug: "ed-execute",
				objective: "verify ED restart for execute",
				runId,
				artifactRoot: join(overstoryDir, "missions", missionId),
				tier: "full",
			});
			store.updateState(missionId, "suspended");
			store.updatePhase(missionId, "execute");
		} finally {
			store.close();
		}

		let edCalled = 0;
		const deps = {
			startMissionCoordinator: makeRoleStub(
				"coord-ed",
			) as unknown as MissionCommandDeps["startMissionCoordinator"],
			startMissionAnalyst: makeRoleStub(
				"analyst-ed",
			) as unknown as MissionCommandDeps["startMissionAnalyst"],
			startExecutionDirector: async (_opts: unknown) => {
				edCalled++;
				return makeRoleStub("ed-exec")(_opts);
			},
		} as unknown as MissionCommandDeps;

		process.exitCode = 0;
		await missionResumeAll(overstoryDir, projectRoot, true, missionId, deps);

		expect(process.exitCode).toBe(0);
		expect(edCalled).toBe(1);

		// Verify ED session was bound
		const verify = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			const m = verify.getById(missionId);
			expect(m?.executionDirectorSessionId).toBe("ed-exec");
		} finally {
			verify.close();
		}

		process.exitCode = 0;
	});

	test("No ED restart for non-execute phases — full tier + understand phase → startExecutionDirector NOT invoked", async () => {
		const missionId = "mission-no-ed-understand";
		const runId = "run-no-ed-understand";

		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			store.create({
				id: missionId,
				slug: "no-ed-understand",
				objective: "verify no ED for understand phase",
				runId,
				artifactRoot: join(overstoryDir, "missions", missionId),
				tier: "full",
			});
			store.updateState(missionId, "suspended");
			store.updatePhase(missionId, "understand");
		} finally {
			store.close();
		}

		let edCalled = 0;
		const deps = {
			startMissionCoordinator: makeRoleStub(
				"coord-no-ed",
			) as unknown as MissionCommandDeps["startMissionCoordinator"],
			startMissionAnalyst: makeRoleStub(
				"analyst-no-ed",
			) as unknown as MissionCommandDeps["startMissionAnalyst"],
			startExecutionDirector: async (_opts: unknown) => {
				edCalled++;
				return makeRoleStub("ed-no-exec")(_opts);
			},
		} as unknown as MissionCommandDeps;

		process.exitCode = 0;
		await missionResumeAll(overstoryDir, projectRoot, true, missionId, deps);

		expect(process.exitCode).toBe(0);
		expect(edCalled).toBe(0);

		process.exitCode = 0;
	});

	test("Direct tier — only coordinator restarted, analyst and ED skipped, message omits mission-analyst", async () => {
		const missionId = "mission-direct-tier";
		const runId = "run-direct-tier";

		const store = createMissionStore(join(overstoryDir, "sessions.db"));
		try {
			store.create({
				id: missionId,
				slug: "direct-tier",
				objective: "verify direct tier restart",
				runId,
				artifactRoot: join(overstoryDir, "missions", missionId),
				tier: "direct",
			});
			store.updateState(missionId, "suspended");
			store.updatePhase(missionId, "execute");
		} finally {
			store.close();
		}

		let coordCalled = 0;
		let analystCalled = 0;
		let edCalled = 0;
		const deps = {
			startMissionCoordinator: async (_opts: unknown) => {
				coordCalled++;
				return makeRoleStub("coord-direct")(_opts);
			},
			startMissionAnalyst: async (_opts: unknown) => {
				analystCalled++;
				return makeRoleStub("analyst-direct")(_opts);
			},
			startExecutionDirector: async (_opts: unknown) => {
				edCalled++;
				return makeRoleStub("ed-direct")(_opts);
			},
		} as unknown as MissionCommandDeps;

		let captured = "";
		const origWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		}) as typeof process.stdout.write;

		process.exitCode = 0;
		try {
			await missionResumeAll(overstoryDir, projectRoot, false, missionId, deps);
		} finally {
			process.stdout.write = origWrite;
		}

		expect(process.exitCode).toBe(0);
		expect(coordCalled).toBe(1);
		expect(analystCalled).toBe(0);
		expect(edCalled).toBe(0);
		expect(captured).not.toMatch(/mission-analyst/i);

		process.exitCode = 0;
	});
});

describe("validateRequiredCapabilities", () => {
	let capDir: string;
	let capOverstoryDir: string;
	let capProjectRoot: string;
	let originalStdout: typeof process.stdout.write;
	let originalStderr: typeof process.stderr.write;

	beforeEach(async () => {
		capDir = await mkdtemp(join(tmpdir(), "ov-validate-caps-test-"));
		capOverstoryDir = join(capDir, ".overstory");
		capProjectRoot = capDir;
		await Bun.write(join(capOverstoryDir, ".keep"), "");
		await Bun.write(
			join(capProjectRoot, ".overstory", "config.yaml"),
			["version: 1", "watchdog:", "  tier0Enabled: false", "mission:", "  maxConcurrent: 1"].join(
				"\n",
			),
		);
		process.exitCode = 0;
		originalStdout = process.stdout.write;
		originalStderr = process.stderr.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
		process.stderr.write = (() => true) as typeof process.stderr.write;
	});

	afterEach(async () => {
		process.exitCode = 0;
		process.stdout.write = originalStdout;
		process.stderr.write = originalStderr;
		await rm(capDir, { recursive: true, force: true });
	});

	test("all-required-present: proceeds when full manifest is seeded", async () => {
		await Bun.write(
			join(capOverstoryDir, "agent-manifest.json"),
			JSON.stringify(buildAgentManifest(), null, "\t"),
		);

		await missionStart(capOverstoryDir, capProjectRoot, {
			slug: "all-present",
			objective: "test",
			json: true,
		});

		expect(process.exitCode).not.toBe(1);
		const store = createMissionStore(join(capOverstoryDir, "sessions.db"));
		try {
			expect(store.list({ limit: 100 }).length).toBe(1);
		} finally {
			store.close();
		}
	});

	test("single-missing: fails fast when tier-classifier is missing", async () => {
		const fullManifest = buildAgentManifest();
		// Strip tier-classifier from the manifest
		const agents = { ...fullManifest.agents };
		delete agents["tier-classifier"];
		await Bun.write(
			join(capOverstoryDir, "agent-manifest.json"),
			JSON.stringify({ ...fullManifest, agents }, null, "\t"),
		);

		await missionStart(capOverstoryDir, capProjectRoot, {
			slug: "single-miss",
			objective: "test",
			json: true,
		});

		expect(process.exitCode).toBe(1);
		const store = createMissionStore(join(capOverstoryDir, "sessions.db"));
		try {
			expect(store.list({ limit: 100 }).length).toBe(0);
		} finally {
			store.close();
		}
	});

	test("all-missing: fails fast when no Stage A agents exist", async () => {
		await Bun.write(
			join(capOverstoryDir, "agent-manifest.json"),
			JSON.stringify({ version: "1.0", agents: {}, capabilityIndex: {} }, null, "\t"),
		);

		let captured = "";
		const origWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			await missionStart(capOverstoryDir, capProjectRoot, {
				slug: "all-miss",
				objective: "test",
				json: true,
			});
		} finally {
			process.stdout.write = origWrite;
		}

		expect(process.exitCode).toBe(1);
		const parsed = JSON.parse(captured);
		expect(parsed.command).toBe("mission start");
		expect(parsed.error).toContain("mission-analyst-intake");
		expect(parsed.error).toContain("product-clarifier");
		expect(parsed.error).toContain("tier-classifier");
		expect(parsed.error).toContain("debugger");
	});

	test("unreadable-manifest: fails fast with parse-error detail when manifest is malformed", async () => {
		await Bun.write(join(capOverstoryDir, "agent-manifest.json"), "not json");

		let captured = "";
		const origWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			await missionStart(capOverstoryDir, capProjectRoot, {
				slug: "unreadable",
				objective: "test",
				json: true,
			});
		} finally {
			process.stdout.write = origWrite;
		}

		expect(process.exitCode).toBe(1);
		const parsed = JSON.parse(captured);
		expect(parsed.command).toBe("mission start");
		expect(parsed.error).toContain("Cannot read");
	});
});

// === w8: --continue-from + captureBaseline integration ===

/**
 * Tests for the lifecycle-start hooks added by w8:
 *   1. captureBaseline (from w11) MUST be called after ensureMissionArtifacts.
 *   2. applyContinueFrom (from w8) MUST be called exactly once when
 *      LifecycleStartOpts.continueFromMissionId is set.
 *   3. captureBaseline failure MUST be swallowed (warning only) and not
 *      abort mission start.
 *
 * Both hooks must be injectable via deps for testability — the builder will
 * widen MissionCommandDeps with `captureBaseline?` and `applyContinueFrom?`
 * fields. The casts below use `as unknown as MissionCommandDeps` so the file
 * compiles against the un-widened deps interface during RED phase.
 */
describe("missionStart w8 hooks (continue-from + captureBaseline)", () => {
	let w8Dir: string;
	let w8OverstoryDir: string;
	let w8ProjectRoot: string;

	beforeEach(async () => {
		w8Dir = await mkdtemp(join(tmpdir(), "ov-lifecycle-start-w8-test-"));
		w8OverstoryDir = join(w8Dir, ".overstory");
		w8ProjectRoot = w8Dir;
		await Bun.write(join(w8OverstoryDir, ".keep"), "");
		await Bun.write(
			join(w8OverstoryDir, "agent-manifest.json"),
			JSON.stringify(buildAgentManifest(), null, "\t"),
		);
		await Bun.write(
			join(w8ProjectRoot, ".overstory", "config.yaml"),
			["version: 1", "watchdog:", "  tier0Enabled: false", "mission:", "  maxConcurrent: 1"].join(
				"\n",
			),
		);
	});

	afterEach(async () => {
		await rm(w8Dir, { recursive: true, force: true });
	});

	test("T-w8-13: lifecycle-start calls captureBaseline(missionId, artifactRoot, projectRoot) after ensureMissionArtifacts", async () => {
		const captureCalls: Array<[string, string, string]> = [];
		const captureBaseline = async (
			missionId: string,
			artifactRoot: string,
			projectRoot: string,
		): Promise<void> => {
			captureCalls.push([missionId, artifactRoot, projectRoot]);
		};

		const deps = {
			startMissionCoordinator: makeRoleStub("c"),
			startMissionAnalyst: makeRoleStub("a"),
			stopMissionRole: async () => ({}) as never,
			captureBaseline,
		} as unknown as MissionCommandDeps;

		await missionStart(
			w8OverstoryDir,
			w8ProjectRoot,
			{ slug: "captures-baseline", objective: "test", json: true },
			deps,
		);

		expect(captureCalls).toHaveLength(1);
		const firstCall = captureCalls[0];
		expect(firstCall).toBeDefined();
		const [missionId, artifactRoot, projectRoot] = firstCall as [string, string, string];
		expect(missionId).toMatch(/^mission-/);
		expect(artifactRoot).toContain("missions");
		expect(artifactRoot).toContain(missionId);
		expect(projectRoot).toBe(w8ProjectRoot);
	});

	test("T-w8-14: captureBaseline throwing → start completes successfully (warning only, no abort)", async () => {
		let captureCalled = false;
		const captureBaseline = async (
			_missionId: string,
			_artifactRoot: string,
			_projectRoot: string,
		): Promise<void> => {
			captureCalled = true;
			throw new Error("simulated baseline capture failure");
		};

		const deps = {
			startMissionCoordinator: makeRoleStub("c"),
			startMissionAnalyst: makeRoleStub("a"),
			stopMissionRole: async () => ({}) as never,
			captureBaseline,
		} as unknown as MissionCommandDeps;

		process.exitCode = 0;
		await missionStart(
			w8OverstoryDir,
			w8ProjectRoot,
			{ slug: "baseline-fails", objective: "test", json: true },
			deps,
		);

		// Both invariants must hold:
		//   1. captureBaseline was actually invoked (proving the hook is wired) —
		//      without this, the rest of the assertions could pass for the wrong reason.
		//   2. Mission start completed successfully despite the throw.
		expect(captureCalled).toBe(true);
		expect(process.exitCode).not.toBe(1);
		const store = createMissionStore(join(w8OverstoryDir, "sessions.db"));
		try {
			const m = store.list().find((mm) => mm.slug === "baseline-fails");
			expect(m).toBeDefined();
		} finally {
			store.close();
		}
	});

	test("T-w8-12: lifecycle-start with continueFromMissionId set → calls applyContinueFrom exactly once", async () => {
		// Seed an old mission to point continue-from at.
		const store = createMissionStore(join(w8OverstoryDir, "sessions.db"));
		try {
			store.create({
				id: "mission-old-x",
				slug: "old-x",
				objective: "old objective",
			});
			store.start("mission-old-x");
			// Coerce into pr-phase via raw current-node update.
			store.updateCurrentNode("mission-old-x", "pr-phase:done");
			store.updateState("mission-old-x", "pr-phase" as never);
		} finally {
			store.close();
		}

		const applyCalls: Array<{
			oldMissionId: string;
			newMissionId: string;
			newArtifactRoot: string;
		}> = [];
		const applyContinueFromStub = async (
			oldMissionId: string,
			newMissionId: string,
			newArtifactRoot: string,
		): Promise<void> => {
			applyCalls.push({ oldMissionId, newMissionId, newArtifactRoot });
		};

		const deps = {
			startMissionCoordinator: makeRoleStub("c"),
			startMissionAnalyst: makeRoleStub("a"),
			stopMissionRole: async () => ({}) as never,
			applyContinueFrom: applyContinueFromStub,
			// captureBaseline must also be injectable; provide a no-op so
			// it doesn't shell out to anything real.
			captureBaseline: async () => {},
		} as unknown as MissionCommandDeps;

		await missionStart(
			w8OverstoryDir,
			w8ProjectRoot,
			{
				slug: "continue-from-test",
				objective: "test continue-from",
				json: true,
				// `continueFromMissionId` is the new field on StartOpts added by w8.
				continueFromMissionId: "mission-old-x",
			} as unknown as Parameters<typeof missionStart>[2],
			deps,
		);

		expect(applyCalls).toHaveLength(1);
		expect(applyCalls[0]?.oldMissionId).toBe("mission-old-x");
		expect(applyCalls[0]?.newMissionId).toMatch(/^mission-/);
		expect(applyCalls[0]?.newMissionId).not.toBe("mission-old-x");
		expect(applyCalls[0]?.newArtifactRoot).toContain("missions");
	});
});
