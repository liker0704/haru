import { describe, expect, test } from "bun:test";
import type { TrackerClient } from "../../tracker/types.ts";
import type { HandlerContext } from "../types.ts";
import { executeDirectPhaseCell } from "./execute-direct-phase.ts";
import type { PhaseCellDeps } from "./types.ts";

/** No-op TrackerClient stub — REQUIRED on PhaseCellDeps after ws-store-types lands. */
function makeStubTracker(): TrackerClient {
	return {
		ready: async () => [],
		show: async () => ({ id: "", title: "", status: "", priority: 0, type: "" }),
		create: async () => "",
		claim: async () => {},
		close: async () => {},
		comment: async () => {},
		list: async () => [],
		sync: async () => {},
	};
}

function makeDeps(): PhaseCellDeps {
	return {
		mailSend: async () => {},
		checkpointStore: {} as unknown as PhaseCellDeps["checkpointStore"],
		missionStore: {} as unknown as PhaseCellDeps["missionStore"],
		tracker: makeStubTracker(),
	};
}

function makeCtx(checkpoint: unknown = null): HandlerContext {
	return {
		nodeId: "execute-phase:merge-all",
		checkpoint,
		getMission: () => null,
	} as HandlerContext;
}

describe("execute-direct-phase merge-all handler", () => {
	const handlers = executeDirectPhaseCell.buildHandlers(makeDeps());

	test("allDone=true → trigger=all_merged", async () => {
		// biome-ignore lint/style/noNonNullAssertion: registry known to contain merge-all
		const result = await handlers["merge-all"]!(makeCtx({ allDone: true }));
		expect(result.trigger).toBe("all_merged");
	});

	test("morePending=true → trigger=more_leads", async () => {
		// biome-ignore lint/style/noNonNullAssertion: registry known to contain merge-all
		const result = await handlers["merge-all"]!(makeCtx({ morePending: true }));
		expect(result.trigger).toBe("more_leads");
	});

	test("no checkpoint signal → defaults to all_merged (prevents BUG-E loop)", async () => {
		// biome-ignore lint/style/noNonNullAssertion: registry known to contain merge-all
		const result = await handlers["merge-all"]!(makeCtx(null));
		expect(result.trigger).toBe("all_merged");
	});

	test("empty checkpoint object → defaults to all_merged", async () => {
		// biome-ignore lint/style/noNonNullAssertion: registry known to contain merge-all
		const result = await handlers["merge-all"]!(makeCtx({}));
		expect(result.trigger).toBe("all_merged");
	});
});
