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
