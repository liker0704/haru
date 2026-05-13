import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, createTempGitRepo, runGitInDir } from "../test-helpers.ts";
import type { Spawner } from "./init.ts";
import {
	buildAgentManifest,
	HARU_GITIGNORE,
	HARU_README,
	initCommand,
	resolveToolSet,
} from "./init.ts";

/**
 * Tests for `haru init` -- agent definition deployment.
 *
 * Uses real temp git repos. Suppresses stdout to keep test output clean.
 * process.cwd() is saved/restored because initCommand uses it to find the project root.
 *
 * Tests that don't exercise ecosystem bootstrap pass a no-op spawner via _spawner
 * so they don't require ml/sd/cn CLIs to be installed (they aren't available in CI).
 */

/** No-op spawner that treats all ecosystem tools as "not installed". */
const noopSpawner: Spawner = async () => ({ exitCode: 1, stdout: "", stderr: "not found" });

const AGENT_DEF_FILES = [
	"architect.md",
	"architecture-review-lead.md",
	"architecture-sync.md",
	"builder.md",
	"coordinator-mission-direct.md",
	"coordinator-mission-full.md",
	"coordinator-mission-planned.md",
	"coordinator-mission.md",
	"coordinator.md",
	"debugger.md",
	"execution-director.md",
	"lead-mission.md",
	"lead.md",
	"merger.md",
	"mission-analyst.md",
	"mission-analyst-intake.md",
	"mission-analyst-planned.md",
	"monitor.md",
	"orchestrator.md",
	"ov-co-creation.md",
	"plan-architecture-critic.md",
	"plan-devil-advocate.md",
	"plan-performance-critic.md",
	"plan-review-lead.md",
	"plan-second-opinion.md",
	"plan-security-critic.md",
	"plan-simulator.md",
	"product-clarifier.md",
	"pr-comment-triage.md",
	"research-lead.md",
	"tier-classifier.md",
	"researcher.md",
	"reviewer.md",
	"scout.md",
	"shared-mandate.md",
	"tester.md",
];

/** Resolve the source agents directory (same logic as init.ts). */
const SOURCE_AGENTS_DIR = join(import.meta.dir, "..", "..", "agents");

describe("initCommand: agent-defs deployment", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Suppress stdout noise from initCommand
		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("creates .overstory/agent-defs/ with all agent definition files (supervisor deprecated)", async () => {
		await initCommand({ _spawner: noopSpawner });

		const agentDefsDir = join(tempDir, ".haru", "agent-defs");
		const files = await readdir(agentDefsDir);
		const mdFiles = files.filter((f) => f.endsWith(".md")).sort();

		expect(mdFiles).toEqual(AGENT_DEF_FILES.slice().sort());
	});

	test("copied files match source content", async () => {
		await initCommand({ _spawner: noopSpawner });

		for (const fileName of AGENT_DEF_FILES) {
			const sourcePath = join(SOURCE_AGENTS_DIR, fileName);
			const targetPath = join(tempDir, ".haru", "agent-defs", fileName);

			const sourceContent = await Bun.file(sourcePath).text();
			const targetContent = await Bun.file(targetPath).text();

			expect(targetContent).toBe(sourceContent);
		}
	});

	test("starter manifest includes mission and multi-plan runtime agents", () => {
		const manifest = buildAgentManifest();
		for (const agentName of [
			"coordinator-mission",
			"mission-analyst",
			"execution-director",
			"lead-mission",
			"plan-review-lead",
			"plan-devil-advocate",
			"plan-security-critic",
			"plan-performance-critic",
			"plan-second-opinion",
			"plan-simulator",
		]) {
			expect(manifest.agents[agentName]).toBeDefined();
		}
	});

	test("--force reinit overwrites existing agent def files", async () => {
		// First init
		await initCommand({ _spawner: noopSpawner });

		// Tamper with one of the deployed files
		const tamperPath = join(tempDir, ".haru", "agent-defs", "scout.md");
		await Bun.write(tamperPath, "# tampered content\n");

		// Verify tamper worked
		const tampered = await Bun.file(tamperPath).text();
		expect(tampered).toBe("# tampered content\n");

		// Reinit with --force
		await initCommand({ force: true, _spawner: noopSpawner });

		// Verify the file was overwritten with the original source
		const sourceContent = await Bun.file(join(SOURCE_AGENTS_DIR, "scout.md")).text();
		const restored = await Bun.file(tamperPath).text();
		expect(restored).toBe(sourceContent);
	});

	test("Stop hook includes mulch learn command", async () => {
		await initCommand({ _spawner: noopSpawner });

		const hooksPath = join(tempDir, ".haru", "hooks.json");
		const content = await Bun.file(hooksPath).text();
		const parsed = JSON.parse(content);
		const stopHooks = parsed.hooks.Stop[0].hooks;

		expect(stopHooks.length).toBe(2);
		expect(stopHooks[0].command).toContain("ha log session-end");
		expect(stopHooks[1].command).toBe("mulch learn");
	});

	test("PostToolUse hooks include Bash-matched mulch diff hook", async () => {
		await initCommand({ _spawner: noopSpawner });

		const hooksPath = join(tempDir, ".haru", "hooks.json");
		const content = await Bun.file(hooksPath).text();
		const parsed = JSON.parse(content);
		const postToolUseHooks = parsed.hooks.PostToolUse;

		// Should have the generic tool-end logger plus the new Bash-specific hook
		expect(postToolUseHooks.length).toBe(2);

		const bashHookEntry = postToolUseHooks[1];
		expect(bashHookEntry.matcher).toBe("Bash");
		expect(bashHookEntry.hooks.length).toBe(1);

		const command = bashHookEntry.hooks[0].command;
		expect(command).toContain("git commit");
		expect(command).toContain("mulch diff HEAD~1");
	});
});

describe("initCommand: .overstory/.gitignore", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Suppress stdout noise from initCommand
		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("creates .overstory/.gitignore with wildcard+whitelist model", async () => {
		await initCommand({ _spawner: noopSpawner });

		const gitignorePath = join(tempDir, ".haru", ".gitignore");
		const content = await Bun.file(gitignorePath).text();

		// Verify wildcard+whitelist pattern
		expect(content).toContain("*\n");
		expect(content).toContain("!.gitignore\n");
		expect(content).toContain("!config.yaml\n");
		expect(content).toContain("!agent-manifest.json\n");
		expect(content).toContain("!hooks.json\n");
		expect(content).toContain("!groups.json\n");
		expect(content).toContain("!agent-defs/\n");
		expect(content).toContain("!agent-defs/**\n");

		// Verify it matches the exported constant
		expect(content).toBe(HARU_GITIGNORE);
	});

	test("gitignore is always written when init completes", async () => {
		// Init should write gitignore
		await initCommand({ _spawner: noopSpawner });

		const gitignorePath = join(tempDir, ".haru", ".gitignore");
		const content = await Bun.file(gitignorePath).text();

		// Verify gitignore was written with correct content
		expect(content).toBe(HARU_GITIGNORE);

		// Verify the file exists
		const exists = await Bun.file(gitignorePath).exists();
		expect(exists).toBe(true);
	});

	test("--force reinit overwrites stale .overstory/.gitignore", async () => {
		// First init
		await initCommand({ _spawner: noopSpawner });

		const gitignorePath = join(tempDir, ".haru", ".gitignore");

		// Tamper with the gitignore file (simulate old deny-list format)
		await Bun.write(gitignorePath, "# old format\nworktrees/\nlogs/\nmail.db\n");

		// Verify tamper worked
		const tampered = await Bun.file(gitignorePath).text();
		expect(tampered).not.toContain("*\n");
		expect(tampered).not.toContain("!.gitignore\n");

		// Reinit with --force
		await initCommand({ force: true, _spawner: noopSpawner });

		// Verify the file was overwritten with the new wildcard+whitelist format
		const restored = await Bun.file(gitignorePath).text();
		expect(restored).toBe(HARU_GITIGNORE);
		expect(restored).toContain("*\n");
		expect(restored).toContain("!.gitignore\n");
	});

	test("subsequent init without --force does not overwrite gitignore", async () => {
		// First init
		await initCommand({ _spawner: noopSpawner });

		const gitignorePath = join(tempDir, ".haru", ".gitignore");

		// Tamper with the gitignore file
		await Bun.write(gitignorePath, "# custom content\n");

		// Verify tamper worked
		const tampered = await Bun.file(gitignorePath).text();
		expect(tampered).toBe("# custom content\n");

		// Second init without --force should return early (not overwrite)
		await initCommand({ _spawner: noopSpawner });

		// Verify the file was NOT overwritten (early return prevented it)
		const afterSecondInit = await Bun.file(gitignorePath).text();
		expect(afterSecondInit).toBe("# custom content\n");
	});
});

describe("initCommand: .overstory/README.md", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Suppress stdout noise from initCommand
		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("creates .overstory/README.md with expected content", async () => {
		await initCommand({ _spawner: noopSpawner });

		const readmePath = join(tempDir, ".haru", "README.md");
		const exists = await Bun.file(readmePath).exists();
		expect(exists).toBe(true);

		const content = await Bun.file(readmePath).text();
		expect(content).toBe(HARU_README);
	});

	test("README.md is whitelisted in gitignore", () => {
		expect(HARU_GITIGNORE).toContain("!README.md\n");
	});

	test("--force reinit overwrites README.md", async () => {
		// First init
		await initCommand({ _spawner: noopSpawner });

		const readmePath = join(tempDir, ".haru", "README.md");

		// Tamper with the README
		await Bun.write(readmePath, "# tampered\n");
		const tampered = await Bun.file(readmePath).text();
		expect(tampered).toBe("# tampered\n");

		// Reinit with --force
		await initCommand({ force: true, _spawner: noopSpawner });

		// Verify restored to canonical content
		const restored = await Bun.file(readmePath).text();
		expect(restored).toBe(HARU_README);
	});

	test("subsequent init without --force does not overwrite README.md", async () => {
		// First init
		await initCommand({ _spawner: noopSpawner });

		const readmePath = join(tempDir, ".haru", "README.md");

		// Tamper with the README
		await Bun.write(readmePath, "# custom content\n");
		const tampered = await Bun.file(readmePath).text();
		expect(tampered).toBe("# custom content\n");

		// Second init without --force returns early
		await initCommand({ _spawner: noopSpawner });

		// Verify tampered content preserved (early return)
		const afterSecondInit = await Bun.file(readmePath).text();
		expect(afterSecondInit).toBe("# custom content\n");
	});
});

describe("initCommand: canonical branch detection", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		// Remove origin remote so detectCanonicalBranch falls through to
		// current-branch check (otherwise remote HEAD resolves to main regardless)
		await runGitInDir(tempDir, ["remote", "remove", "origin"]);
		process.chdir(tempDir);

		// Suppress stdout noise from initCommand
		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("non-standard branch names are accepted as canonicalBranch", async () => {
		// Switch to a non-standard branch name
		await runGitInDir(tempDir, ["switch", "-c", "trunk"]);

		await initCommand({ _spawner: noopSpawner });

		const configPath = join(tempDir, ".haru", "config.yaml");
		const content = await Bun.file(configPath).text();
		expect(content).toContain("canonicalBranch: trunk");
	});

	test("standard branch names (main) still work as canonicalBranch", async () => {
		// createTempGitRepo defaults to main branch
		await initCommand({ _spawner: noopSpawner });

		const configPath = join(tempDir, ".haru", "config.yaml");
		const content = await Bun.file(configPath).text();
		expect(content).toContain("canonicalBranch: main");
	});
});

describe("initCommand: --yes flag", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Suppress stdout noise from initCommand
		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("--yes reinitializes when .overstory/ already exists", async () => {
		// First init
		await initCommand({ _spawner: noopSpawner });

		// Tamper with config to verify reinit happens
		const configPath = join(tempDir, ".haru", "config.yaml");
		await Bun.write(configPath, "# tampered\n");

		// Second init with --yes should reinitialize (not return early)
		await initCommand({ yes: true, _spawner: noopSpawner });

		// Verify config was regenerated (not the tampered content)
		const content = await Bun.file(configPath).text();
		expect(content).not.toBe("# tampered\n");
		expect(content).toContain("# Overstory configuration");
	});

	test("--yes works on fresh project (no .overstory/ yet)", async () => {
		await initCommand({ yes: true, _spawner: noopSpawner });

		const configPath = join(tempDir, ".haru", "config.yaml");
		const exists = await Bun.file(configPath).exists();
		expect(exists).toBe(true);

		const content = await Bun.file(configPath).text();
		expect(content).toContain("# Overstory configuration");
	});

	test("--yes overwrites agent-defs on reinit", async () => {
		// First init
		await initCommand({ _spawner: noopSpawner });

		// Tamper with an agent def
		const scoutPath = join(tempDir, ".haru", "agent-defs", "scout.md");
		await Bun.write(scoutPath, "TAMPERED CONTENT");

		// Reinit with --yes should overwrite
		await initCommand({ yes: true, _spawner: noopSpawner });

		const restored = await Bun.file(scoutPath).text();
		expect(restored).not.toBe("TAMPERED CONTENT");
	});
});

describe("initCommand: --name flag", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Suppress stdout noise from initCommand
		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("--name overrides auto-detected project name", async () => {
		await initCommand({ name: "custom-project", _spawner: noopSpawner });

		const configPath = join(tempDir, ".haru", "config.yaml");
		const content = await Bun.file(configPath).text();
		expect(content).toContain("name: custom-project");
	});

	test("--name combined with --yes works for fully non-interactive init", async () => {
		await initCommand({ yes: true, name: "scripted-project", _spawner: noopSpawner });

		const configPath = join(tempDir, ".haru", "config.yaml");
		const content = await Bun.file(configPath).text();
		expect(content).toContain("name: scripted-project");
		expect(content).toContain("# Overstory configuration");
	});
});

// ---- Ecosystem Bootstrap Tests ----

/**
 * Build a Spawner that returns preset responses keyed by "arg0 arg1 ..." prefix.
 * Records all calls for assertion.
 */
function createMockSpawner(
	responses: Record<string, { exitCode: number; stdout: string; stderr: string }>,
): {
	spawner: Spawner;
	calls: string[][];
} {
	const calls: string[][] = [];
	const spawner: Spawner = async (args) => {
		calls.push(args);
		const key = args.join(" ");
		// Longest prefix match
		let bestMatch = "";
		let bestResponse = { exitCode: 1, stdout: "", stderr: "not found" };
		for (const [pattern, response] of Object.entries(responses)) {
			if (key.startsWith(pattern) && pattern.length > bestMatch.length) {
				bestMatch = pattern;
				bestResponse = response;
			}
		}
		return bestResponse;
	};
	return { spawner, calls };
}

describe("resolveToolSet", () => {
	test("default (no opts) returns all three tools in order", () => {
		const tools = resolveToolSet({});
		expect(tools.map((t) => t.name)).toEqual(["kura", "suji", "tane"]);
	});

	test("--skip-mulch removes mulch", () => {
		const tools = resolveToolSet({ skipMulch: true });
		expect(tools.map((t) => t.name)).toEqual(["suji", "tane"]);
	});

	test("--skip-seeds removes seeds", () => {
		const tools = resolveToolSet({ skipSeeds: true });
		expect(tools.map((t) => t.name)).toEqual(["kura", "tane"]);
	});

	test("--skip-canopy removes canopy", () => {
		const tools = resolveToolSet({ skipCanopy: true });
		expect(tools.map((t) => t.name)).toEqual(["kura", "suji"]);
	});

	test("multiple skip flags combine", () => {
		const tools = resolveToolSet({ skipMulch: true, skipSeeds: true });
		expect(tools.map((t) => t.name)).toEqual(["tane"]);
	});

	test("--tools overrides to specific tools", () => {
		const tools = resolveToolSet({ tools: "kura,suji" });
		expect(tools.map((t) => t.name)).toEqual(["kura", "suji"]);
	});

	test("--tools single tool", () => {
		const tools = resolveToolSet({ tools: "tane" });
		expect(tools.map((t) => t.name)).toEqual(["tane"]);
	});

	test("--tools with unknown name filters it out", () => {
		const tools = resolveToolSet({ tools: "kura,unknown" });
		expect(tools.map((t) => t.name)).toEqual(["kura"]);
	});

	test("--tools overrides skip flags", () => {
		// --tools takes precedence over --skip-* flags
		const tools = resolveToolSet({ tools: "kura", skipMulch: true });
		expect(tools.map((t) => t.name)).toEqual(["kura"]);
	});

	test("all skip flags returns empty array", () => {
		const tools = resolveToolSet({ skipMulch: true, skipSeeds: true, skipCanopy: true });
		expect(tools).toHaveLength(0);
	});
});

describe("initCommand: ecosystem bootstrap", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);
		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("all tools installed and init succeeds → status initialized", async () => {
		const { spawner, calls } = createMockSpawner({
			"ku --version": { exitCode: 0, stdout: "0.6.3", stderr: "" },
			"ku init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"ku onboard": { exitCode: 0, stdout: "appended", stderr: "" },
			"su --version": { exitCode: 0, stdout: "0.2.4", stderr: "" },
			"su init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"su onboard": { exitCode: 0, stdout: "appended", stderr: "" },
			"ta --version": { exitCode: 0, stdout: "0.2.0", stderr: "" },
			"ta init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"ta onboard": { exitCode: 0, stdout: "appended", stderr: "" },
		});

		await initCommand({ _spawner: spawner });

		// All three init commands were called
		expect(calls).toContainEqual(["ku", "init"]);
		expect(calls).toContainEqual(["su", "init"]);
		expect(calls).toContainEqual(["ta", "init"]);

		// All three onboard commands were called
		expect(calls).toContainEqual(["ku", "onboard"]);
		expect(calls).toContainEqual(["su", "onboard"]);
		expect(calls).toContainEqual(["ta", "onboard"]);
	});

	test("tool not installed → init and onboard not called", async () => {
		const { spawner, calls } = createMockSpawner({
			"ku --version": { exitCode: 1, stdout: "", stderr: "command not found" },
			"su --version": { exitCode: 0, stdout: "0.2.4", stderr: "" },
			"su init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"su onboard": { exitCode: 0, stdout: "appended", stderr: "" },
			"ta --version": { exitCode: 0, stdout: "0.2.0", stderr: "" },
			"ta init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"ta onboard": { exitCode: 0, stdout: "appended", stderr: "" },
		});

		await initCommand({ _spawner: spawner });

		// mulch init should NOT have been called
		expect(calls).not.toContainEqual(["ku", "init"]);
		// seeds and canopy should still be called
		expect(calls).toContainEqual(["su", "init"]);
		expect(calls).toContainEqual(["ta", "init"]);
	});

	test("tool init non-zero + dir exists → already_initialized", async () => {
		// Create .mulch/ directory to simulate existing mulch init
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(tempDir, ".mulch"), { recursive: true });

		const { spawner } = createMockSpawner({
			"ku --version": { exitCode: 0, stdout: "0.6.3", stderr: "" },
			"ku init": { exitCode: 1, stdout: "", stderr: "already initialized" },
			"ku onboard": { exitCode: 0, stdout: "appended", stderr: "" },
			"su --version": { exitCode: 0, stdout: "0.2.4", stderr: "" },
			"su init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"su onboard": { exitCode: 0, stdout: "appended", stderr: "" },
			"ta --version": { exitCode: 0, stdout: "0.2.0", stderr: "" },
			"ta init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"ta onboard": { exitCode: 0, stdout: "appended", stderr: "" },
		});

		// Should not throw — already_initialized is not an error
		await initCommand({ _spawner: spawner });
	});

	test("--skip-onboard skips onboard calls", async () => {
		const { spawner, calls } = createMockSpawner({
			"ku --version": { exitCode: 0, stdout: "0.6.3", stderr: "" },
			"ku init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"su --version": { exitCode: 0, stdout: "0.2.4", stderr: "" },
			"su init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"ta --version": { exitCode: 0, stdout: "0.2.0", stderr: "" },
			"ta init": { exitCode: 0, stdout: "initialized", stderr: "" },
		});

		await initCommand({ skipOnboard: true, _spawner: spawner });

		expect(calls).not.toContainEqual(["ku", "onboard"]);
		expect(calls).not.toContainEqual(["su", "onboard"]);
		expect(calls).not.toContainEqual(["ta", "onboard"]);
	});

	test("--skip-mulch skips mulch entirely", async () => {
		const { spawner, calls } = createMockSpawner({
			"su --version": { exitCode: 0, stdout: "0.2.4", stderr: "" },
			"su init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"su onboard": { exitCode: 0, stdout: "appended", stderr: "" },
			"ta --version": { exitCode: 0, stdout: "0.2.0", stderr: "" },
			"ta init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"ta onboard": { exitCode: 0, stdout: "appended", stderr: "" },
		});

		await initCommand({ skipMulch: true, _spawner: spawner });

		expect(calls.filter((c) => c[0] === "ml")).toHaveLength(0);
	});

	test("--json outputs JSON envelope with tools and onboard status", async () => {
		const { spawner } = createMockSpawner({
			"ku --version": { exitCode: 0, stdout: "0.6.3", stderr: "" },
			"ku init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"ku onboard": { exitCode: 0, stdout: "appended", stderr: "" },
			"su --version": { exitCode: 0, stdout: "0.2.4", stderr: "" },
			"su init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"su onboard": { exitCode: 0, stdout: "appended", stderr: "" },
			"ta --version": { exitCode: 0, stdout: "0.2.0", stderr: "" },
			"ta init": { exitCode: 0, stdout: "initialized", stderr: "" },
			"ta onboard": { exitCode: 0, stdout: "appended", stderr: "" },
		});

		let capturedOutput = "";
		const restoreWrite = process.stdout.write;
		process.stdout.write = ((chunk: unknown) => {
			capturedOutput += String(chunk);
			return true;
		}) as typeof process.stdout.write;

		await initCommand({ json: true, _spawner: spawner });

		process.stdout.write = restoreWrite;

		// Find the JSON line (last line with JSON content)
		const jsonLine = capturedOutput.split("\n").find((line) => line.startsWith('{"success":'));

		expect(jsonLine).toBeDefined();
		const parsed = JSON.parse(jsonLine ?? "{}") as Record<string, unknown>;
		expect(parsed.success).toBe(true);
		expect(parsed.command).toBe("init");
		expect(parsed.tools).toBeDefined();
		expect(parsed.onboard).toBeDefined();
		expect(typeof parsed.gitattributes).toBe("boolean");

		const tools = parsed.tools as Record<string, { status: string }>;
		expect(tools.haru?.status).toBe("initialized");
		expect(tools.kura?.status).toBe("initialized");
		expect(tools.suji?.status).toBe("initialized");
		expect(tools.tane?.status).toBe("initialized");
	});
});

describe("initCommand: scaffold commit", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);
		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("git commit is called with scaffold message when git add succeeds and changes are staged", async () => {
		const calls: string[][] = [];
		const spawner: import("./init.ts").Spawner = async (args) => {
			calls.push(args);
			const key = args.join(" ");
			// Sibling tool calls: all "not installed"
			if (key.endsWith("--version")) return { exitCode: 1, stdout: "", stderr: "not found" };
			// git add: success
			if (key.startsWith("git add")) return { exitCode: 0, stdout: "", stderr: "" };
			// git diff --cached --quiet: exit 1 means changes are staged
			if (key.startsWith("git diff --cached --quiet"))
				return { exitCode: 1, stdout: "", stderr: "" };
			// git commit: success
			if (key.startsWith("git commit")) return { exitCode: 0, stdout: "", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "not found" };
		};

		await initCommand({ _spawner: spawner });

		expect(calls).toContainEqual([
			"git",
			"commit",
			"-m",
			"chore: initialize haru and ecosystem tools",
		]);
	});

	test("git commit is NOT called when git diff reports nothing staged (exit 0)", async () => {
		const calls: string[][] = [];
		const spawner: import("./init.ts").Spawner = async (args) => {
			calls.push(args);
			const key = args.join(" ");
			if (key.endsWith("--version")) return { exitCode: 1, stdout: "", stderr: "not found" };
			if (key.startsWith("git add")) return { exitCode: 0, stdout: "", stderr: "" };
			// exit 0 = nothing staged
			if (key.startsWith("git diff --cached --quiet"))
				return { exitCode: 0, stdout: "", stderr: "" };
			if (key.startsWith("git commit")) return { exitCode: 0, stdout: "", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "not found" };
		};

		await initCommand({ _spawner: spawner });

		const commitCalls = calls.filter((c) => c[0] === "git" && c[1] === "commit");
		expect(commitCalls).toHaveLength(0);
	});

	test("git commit failure does not throw — init still succeeds", async () => {
		const spawner: import("./init.ts").Spawner = async (args) => {
			const key = args.join(" ");
			if (key.endsWith("--version")) return { exitCode: 1, stdout: "", stderr: "not found" };
			if (key.startsWith("git add")) return { exitCode: 0, stdout: "", stderr: "" };
			if (key.startsWith("git diff --cached --quiet"))
				return { exitCode: 1, stdout: "", stderr: "" };
			// commit fails
			if (key.startsWith("git commit"))
				return { exitCode: 1, stdout: "", stderr: "nothing to commit" };
			return { exitCode: 1, stdout: "", stderr: "not found" };
		};

		// Should not throw
		await expect(initCommand({ _spawner: spawner })).resolves.toBeUndefined();

		// .overstory files should still be created
		const configPath = join(tempDir, ".haru", "config.yaml");
		const exists = await Bun.file(configPath).exists();
		expect(exists).toBe(true);
	});

	test("git add failure skips commit without throwing", async () => {
		const calls: string[][] = [];
		const spawner: import("./init.ts").Spawner = async (args) => {
			calls.push(args);
			const key = args.join(" ");
			if (key.endsWith("--version")) return { exitCode: 1, stdout: "", stderr: "not found" };
			// git add fails
			if (key.startsWith("git add")) return { exitCode: 1, stdout: "", stderr: "git add failed" };
			if (key.startsWith("git commit")) return { exitCode: 0, stdout: "", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "not found" };
		};

		await expect(initCommand({ _spawner: spawner })).resolves.toBeUndefined();

		// commit should NOT have been called since add failed
		const commitCalls = calls.filter((c) => c[0] === "git" && c[1] === "commit");
		expect(commitCalls).toHaveLength(0);
	});

	test("--json output includes scaffoldCommitted boolean", async () => {
		const spawner: import("./init.ts").Spawner = async (args) => {
			const key = args.join(" ");
			if (key.endsWith("--version")) return { exitCode: 1, stdout: "", stderr: "not found" };
			if (key.startsWith("git add")) return { exitCode: 0, stdout: "", stderr: "" };
			if (key.startsWith("git diff --cached --quiet"))
				return { exitCode: 1, stdout: "", stderr: "" };
			if (key.startsWith("git commit")) return { exitCode: 0, stdout: "", stderr: "" };
			return { exitCode: 1, stdout: "", stderr: "not found" };
		};

		let capturedOutput = "";
		const restoreWrite = process.stdout.write;
		process.stdout.write = ((chunk: unknown) => {
			capturedOutput += String(chunk);
			return true;
		}) as typeof process.stdout.write;

		await initCommand({ json: true, _spawner: spawner });

		process.stdout.write = restoreWrite;

		const jsonLine = capturedOutput.split("\n").find((line) => line.startsWith('{"success":'));
		expect(jsonLine).toBeDefined();
		const parsed = JSON.parse(jsonLine ?? "{}") as Record<string, unknown>;
		expect(typeof parsed.scaffoldCommitted).toBe("boolean");
		expect(parsed.scaffoldCommitted).toBe(true);
	});
});

describe("initCommand: spawner error resilience", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);
		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("spawner that throws ENOENT does not crash init — degrades gracefully", async () => {
		const throwingSpawner: Spawner = async (args) => {
			const key = args.join(" ");
			// Allow git operations through (git add, git diff, git commit)
			if (key.startsWith("git")) return { exitCode: 0, stdout: "", stderr: "" };
			// Simulate ecosystem tool binary not found (ENOENT)
			throw new Error(`spawn ENOENT: ${args[0]}: not found`);
		};

		// Should not throw — graceful degradation
		await expect(initCommand({ _spawner: throwingSpawner })).resolves.toBeUndefined();

		// Core .overstory files should still be created
		const configPath = join(tempDir, ".haru", "config.yaml");
		expect(await Bun.file(configPath).exists()).toBe(true);
	});

	test("throwing spawner causes all ecosystem tools to be skipped", async () => {
		const calls: string[][] = [];
		const throwingSpawner: Spawner = async (args) => {
			calls.push(args);
			const key = args.join(" ");
			if (key.startsWith("git")) return { exitCode: 0, stdout: "", stderr: "" };
			throw new Error("spawn ENOENT");
		};

		await initCommand({ _spawner: throwingSpawner });

		// init and onboard should NOT be called when --version throws
		expect(calls).not.toContainEqual(["ku", "init"]);
		expect(calls).not.toContainEqual(["su", "init"]);
		expect(calls).not.toContainEqual(["ta", "init"]);
		expect(calls).not.toContainEqual(["ku", "onboard"]);
		expect(calls).not.toContainEqual(["su", "onboard"]);
		expect(calls).not.toContainEqual(["ta", "onboard"]);
	});

	test("spawner that throws only on init (not --version) still skips gracefully", async () => {
		// --version succeeds (tool appears installed), but init itself throws
		const throwingInitSpawner: Spawner = async (args) => {
			const key = args.join(" ");
			if (key.startsWith("git")) return { exitCode: 0, stdout: "", stderr: "" };
			if (key.endsWith("--version")) return { exitCode: 0, stdout: "1.0.0", stderr: "" };
			if (key.endsWith("onboard")) return { exitCode: 0, stdout: "", stderr: "" };
			// init itself throws
			throw new Error("spawn ENOENT on init");
		};

		await expect(initCommand({ _spawner: throwingInitSpawner })).resolves.toBeUndefined();

		const configPath = join(tempDir, ".haru", "config.yaml");
		expect(await Bun.file(configPath).exists()).toBe(true);
	});
});

describe("initCommand: .gitattributes setup", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);
		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("creates .gitattributes with merge=union entries", async () => {
		// Use a spawner that skips all ecosystem tools so only gitattributes step runs
		const { spawner } = createMockSpawner({});
		await initCommand({ skipMulch: true, skipSeeds: true, skipCanopy: true, _spawner: spawner });

		const gitattrsPath = join(tempDir, ".gitattributes");
		const exists = await Bun.file(gitattrsPath).exists();
		expect(exists).toBe(true);

		const content = await Bun.file(gitattrsPath).text();
		expect(content).toContain(".mulch/expertise/*.jsonl merge=union");
		expect(content).toContain(".seeds/issues.jsonl merge=union");
	});

	test("does not duplicate entries on reinit with --force", async () => {
		const { spawner } = createMockSpawner({});

		// First init
		await initCommand({ skipMulch: true, skipSeeds: true, skipCanopy: true, _spawner: spawner });

		// Second init with --force
		await initCommand({
			force: true,
			skipMulch: true,
			skipSeeds: true,
			skipCanopy: true,
			_spawner: spawner,
		});

		const gitattrsPath = join(tempDir, ".gitattributes");
		const content = await Bun.file(gitattrsPath).text();

		// Count occurrences — should be exactly one each
		const mulchCount = (content.match(/\.mulch\/expertise\/\*\.jsonl merge=union/g) ?? []).length;
		const seedsCount = (content.match(/\.seeds\/issues\.jsonl merge=union/g) ?? []).length;
		expect(mulchCount).toBe(1);
		expect(seedsCount).toBe(1);
	});

	test("preserves existing .gitattributes content", async () => {
		// Pre-create .gitattributes with existing content
		const existingContent = "*.lock binary\n*.png binary\n";
		await Bun.write(join(tempDir, ".gitattributes"), existingContent);

		const { spawner } = createMockSpawner({});
		await initCommand({ skipMulch: true, skipSeeds: true, skipCanopy: true, _spawner: spawner });

		const content = await Bun.file(join(tempDir, ".gitattributes")).text();
		expect(content).toContain("*.lock binary");
		expect(content).toContain("*.png binary");
		expect(content).toContain(".mulch/expertise/*.jsonl merge=union");
		expect(content).toContain(".seeds/issues.jsonl merge=union");
	});

	test("no-op when entries already present", async () => {
		// Pre-create .gitattributes with the entries already
		const existingContent =
			".mulch/expertise/*.jsonl merge=union\n.seeds/issues.jsonl merge=union\n";
		await Bun.write(join(tempDir, ".gitattributes"), existingContent);

		const { spawner } = createMockSpawner({});
		await initCommand({ skipMulch: true, skipSeeds: true, skipCanopy: true, _spawner: spawner });

		const content = await Bun.file(join(tempDir, ".gitattributes")).text();
		// Content should be unchanged
		expect(content).toBe(existingContent);
	});
});

describe("initCommand: pr-comment-triage manifest entry", () => {
	test("manifest includes pr-comment-triage", () => {
		const manifest = buildAgentManifest();
		expect(manifest.agents["pr-comment-triage"]).toBeDefined();
	});

	test("tools is exactly ['Read'] (tool-surface regression guard)", () => {
		const manifest = buildAgentManifest();
		expect(manifest.agents["pr-comment-triage"]?.tools).toEqual(["Read"]);
	});

	test("canSpawn is false", () => {
		const manifest = buildAgentManifest();
		expect(manifest.agents["pr-comment-triage"]?.canSpawn).toBe(false);
	});

	test("constraints include no-write and no-bash", () => {
		const manifest = buildAgentManifest();
		const constraints = manifest.agents["pr-comment-triage"]?.constraints ?? [];
		expect(constraints).toContain("no-write");
		expect(constraints).toContain("no-bash");
	});
});
