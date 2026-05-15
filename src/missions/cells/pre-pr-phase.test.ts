import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MergeReadinessPack } from "../../merge/mrp-renderer.ts";
import type { Mission } from "../../types.ts";
import type { HandlerContext } from "../types.ts";
import { prePrPhaseCell } from "./pre-pr-phase.ts";
import type { PhaseCellDeps } from "./types.ts";

function makeDeps(overrides?: Partial<PhaseCellDeps>): PhaseCellDeps {
	return {
		mailSend: async () => {},
		checkpointStore: {} as unknown as PhaseCellDeps["checkpointStore"],
		missionStore: {} as unknown as PhaseCellDeps["missionStore"],
		...overrides,
	};
}

function makeMission(overrides: Partial<Mission> = {}): Mission {
	return {
		id: "mission-pre-pr-test",
		slug: "pre-pr-test",
		objective: "Test pre-pr phase",
		runId: null,
		state: "active",
		phase: "pre-pr",
		firstFreezeAt: null,
		pendingUserInput: false,
		pendingInputKind: null,
		pendingInputThreadId: null,
		reopenCount: 0,
		artifactRoot: null,
		pausedWorkstreamIds: [],
		analystSessionId: null,
		executionDirectorSessionId: null,
		coordinatorSessionId: null,
		architectSessionId: null,
		pausedLeadNames: [],
		pauseReason: null,
		currentNode: null,
		startedAt: null,
		completedAt: null,
		createdAt: "",
		updatedAt: "",
		learningsExtracted: false,
		hasEmittedWsProducerWrite: false,
		tier: null,
		autonomy: "supervised",
		parentMissionId: null,
		...overrides,
	};
}

function makeCtx(opts: {
	mission?: Mission | null;
	checkpoint?: unknown;
	nodeId?: string;
	onSaveCheckpoint?: (data: unknown) => void;
	sendMail?: (to: string, subject: string, body: string, type: string) => Promise<void>;
}): HandlerContext {
	return {
		nodeId: opts.nodeId ?? "pre-pr-phase:finalize",
		checkpoint: opts.checkpoint ?? null,
		getMission: () => opts.mission ?? null,
		saveCheckpoint: async (data: unknown) => {
			opts.onSaveCheckpoint?.(data);
		},
		sendMail: opts.sendMail ?? (async () => {}),
	} as HandlerContext;
}

/** Minimal valid MergeReadinessPack for stub testing. */
function makeMinimalMrp(): MergeReadinessPack {
	return {
		schema_version: 1,
		mission: {
			id: "mission-pre-pr-test",
			slug: "pre-pr-test",
			tier: "planned",
			autonomy: "supervised",
			intent_summary: "Test",
		},
		duration: { started_at: "", finished_at: "", wall_clock_seconds: 0 },
		diff: { files_changed: 0, additions: 0, deletions: 0, by_workstream: [] },
		tests: { total: 0, passed: 0, failed: 0, skipped: 0, new_tests: [] },
		quality_gates: { bun_test: "skip", biome: "skip", tsc: "skip" },
		compat: { breaking_changes: [], checked_branches: [] },
		risk_signals: {},
		workstreams: [],
		acceptance_criteria: [],
		linked_issues: [],
		debug_iterations: [],
		agent_trail: [],
		cost: { tokens_total: 0, usd_total: 0 },
	};
}

// === Subgraph shape ===

describe("pre-pr-phase subgraph", () => {
	test("buildSubgraph emits all 6 expected node ids", () => {
		const graph = prePrPhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const nodeIds = graph.nodes.map((n) => n.id);
		expect(nodeIds).toContain("pre-pr-phase:finalize");
		expect(nodeIds).toContain("pre-pr-phase:check-gates");
		expect(nodeIds).toContain("pre-pr-phase:write-mrp");
		expect(nodeIds).toContain("pre-pr-phase:complete");
		expect(nodeIds).toContain("pre-pr-phase:escalate");
		expect(nodeIds).toContain("pre-pr-phase:paused");
		expect(nodeIds).toHaveLength(6);
	});

	test("complete and paused nodes have terminal: true", () => {
		const graph = prePrPhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const completeNode = graph.nodes.find((n) => n.id === "pre-pr-phase:complete");
		const pausedNode = graph.nodes.find((n) => n.id === "pre-pr-phase:paused");
		expect(completeNode?.terminal).toBe(true);
		expect(pausedNode?.terminal).toBe(true);
	});

	test("all 8 trigger edges present", () => {
		const graph = prePrPhaseCell.buildSubgraph({
			missionId: "m1",
			artifactRoot: "/tmp/m1",
			projectRoot: "/tmp",
		});
		const triggers = graph.edges.map((e) => e.trigger);
		expect(triggers).toContain("finalize_done");
		expect(triggers).toContain("finalize_failed");
		expect(triggers).toContain("gates_pass");
		expect(triggers).toContain("gates_skip");
		expect(triggers).toContain("gates_fail");
		expect(triggers).toContain("mrp_written");
		expect(triggers).toContain("mrp_write_failed");
		expect(triggers).toContain("escalated");
		expect(triggers).toHaveLength(8);
	});
});

// === finalize handler ===

describe("finalize handler", () => {
	test("returns finalize_done (no-op path)", async () => {
		const handlers = prePrPhaseCell.buildHandlers(makeDeps());
		const result = await handlers["finalize"]!(makeCtx({ mission: makeMission() }));
		expect(result.trigger).toBe("finalize_done");
	});
});

// === check-gates handler ===

describe("check-gates handler", () => {
	test("returns gates_skip for direct tier regardless of file state", async () => {
		const handlers = prePrPhaseCell.buildHandlers(makeDeps());
		const result = await handlers["check-gates"]!(
			makeCtx({ mission: makeMission({ tier: "direct" }) }),
		);
		expect(result.trigger).toBe("gates_skip");
	});

	test("returns gates_skip for planned tier when quality-gates.json is missing", async () => {
		const handlers = prePrPhaseCell.buildHandlers(makeDeps());
		const result = await handlers["check-gates"]!(
			makeCtx({
				mission: makeMission({ tier: "planned", artifactRoot: "/nonexistent/path" }),
			}),
		);
		expect(result.trigger).toBe("gates_skip");
	});

	test("returns gates_pass for planned tier when all gates are pass", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pre-pr-gates-"));
		try {
			await mkdir(join(dir, "results"), { recursive: true });
			await writeFile(
				join(dir, "results", "quality-gates.json"),
				JSON.stringify({ bun_test: "pass", biome: "pass", tsc: "pass" }),
			);
			const handlers = prePrPhaseCell.buildHandlers(makeDeps());
			const result = await handlers["check-gates"]!(
				makeCtx({ mission: makeMission({ tier: "planned", artifactRoot: dir }) }),
			);
			expect(result.trigger).toBe("gates_pass");
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	test("returns gates_fail for planned tier when any gate is fail", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pre-pr-gates-"));
		try {
			await mkdir(join(dir, "results"), { recursive: true });
			await writeFile(
				join(dir, "results", "quality-gates.json"),
				JSON.stringify({ bun_test: "fail", biome: "pass", tsc: "pass" }),
			);
			const handlers = prePrPhaseCell.buildHandlers(makeDeps());
			const result = await handlers["check-gates"]!(
				makeCtx({ mission: makeMission({ tier: "planned", artifactRoot: dir }) }),
			);
			expect(result.trigger).toBe("gates_fail");
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	test("returns gates_skip for planned tier when any gate is skip", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pre-pr-gates-"));
		try {
			await mkdir(join(dir, "results"), { recursive: true });
			await writeFile(
				join(dir, "results", "quality-gates.json"),
				JSON.stringify({ bun_test: "pass", biome: "skip", tsc: "pass" }),
			);
			const handlers = prePrPhaseCell.buildHandlers(makeDeps());
			const result = await handlers["check-gates"]!(
				makeCtx({ mission: makeMission({ tier: "planned", artifactRoot: dir }) }),
			);
			expect(result.trigger).toBe("gates_skip");
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	test("fail takes priority over skip for planned tier", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pre-pr-gates-"));
		try {
			await mkdir(join(dir, "results"), { recursive: true });
			await writeFile(
				join(dir, "results", "quality-gates.json"),
				JSON.stringify({ bun_test: "fail", biome: "skip", tsc: "pass" }),
			);
			const handlers = prePrPhaseCell.buildHandlers(makeDeps());
			const result = await handlers["check-gates"]!(
				makeCtx({ mission: makeMission({ tier: "planned", artifactRoot: dir }) }),
			);
			expect(result.trigger).toBe("gates_fail");
		} finally {
			await rm(dir, { recursive: true });
		}
	});
});

// === write-mrp handler ===

describe("write-mrp handler", () => {
	test("returns mrp_written for direct tier with no featureBranch", async () => {
		const handlers = prePrPhaseCell.buildHandlers(makeDeps());
		const result = await handlers["write-mrp"]!(
			makeCtx({ mission: makeMission({ tier: "direct", featureBranch: null }) }),
		);
		expect(result.trigger).toBe("mrp_written");
	});

	test("returns mrp_write_failed for planned tier with no featureBranch", async () => {
		let savedCheckpoint: unknown;
		const handlers = prePrPhaseCell.buildHandlers(makeDeps());
		const result = await handlers["write-mrp"]!(
			makeCtx({
				mission: makeMission({ tier: "planned", featureBranch: null }),
				onSaveCheckpoint: (data) => {
					savedCheckpoint = data;
				},
			}),
		);
		expect(result.trigger).toBe("mrp_write_failed");
		expect((savedCheckpoint as { mrpFailureReason?: string }).mrpFailureReason).toContain(
			"featureBranch",
		);
	});

	test("returns mrp_written when deps.assembleMrp is undefined (direct tier stub-deps path)", async () => {
		const handlers = prePrPhaseCell.buildHandlers(makeDeps({ assembleMrp: undefined }));
		const result = await handlers["write-mrp"]!(
			makeCtx({
				mission: makeMission({ tier: "direct", featureBranch: "feature/test" }),
			}),
		);
		expect(result.trigger).toBe("mrp_written");
	});

	test("returns mrp_write_failed when deps.assembleMrp is undefined for planned tier", async () => {
		const handlers = prePrPhaseCell.buildHandlers(makeDeps({ assembleMrp: undefined }));
		const result = await handlers["write-mrp"]!(
			makeCtx({
				mission: makeMission({ tier: "planned", featureBranch: "feature/test" }),
			}),
		);
		expect(result.trigger).toBe("mrp_write_failed");
	});

	test("returns mrp_written on success and writes merge-readiness-pack.json", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pre-pr-mrp-"));
		try {
			const mrp = makeMinimalMrp();
			const handlers = prePrPhaseCell.buildHandlers(
				makeDeps({
					assembleMrp: async () => mrp,
				}),
			);
			const result = await handlers["write-mrp"]!(
				makeCtx({
					mission: makeMission({
						tier: "planned",
						featureBranch: "feature/test",
						artifactRoot: dir,
					}),
				}),
			);
			expect(result.trigger).toBe("mrp_written");

			// Verify file was written
			const file = Bun.file(join(dir, "merge-readiness-pack.json"));
			const content = await file.text();
			const parsed = JSON.parse(content) as MergeReadinessPack;
			expect(parsed.schema_version).toBe(1);
			expect(parsed.mission.id).toBe("mission-pre-pr-test");
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	test("returns mrp_write_failed when assembleMrp factory throws", async () => {
		let savedCheckpoint: unknown;
		const handlers = prePrPhaseCell.buildHandlers(
			makeDeps({
				assembleMrp: async () => {
					throw new Error("metrics.db not found");
				},
			}),
		);
		const result = await handlers["write-mrp"]!(
			makeCtx({
				mission: makeMission({
					tier: "planned",
					featureBranch: "feature/test",
					artifactRoot: "/tmp/test",
				}),
				onSaveCheckpoint: (data) => {
					savedCheckpoint = data;
				},
			}),
		);
		expect(result.trigger).toBe("mrp_write_failed");
		expect((savedCheckpoint as { mrpFailureReason?: string }).mrpFailureReason).toContain(
			"metrics.db not found",
		);
	});
});
