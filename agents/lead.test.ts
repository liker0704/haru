import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const AGENTS_DIR = import.meta.dir;
const LEAD_PATH = join(AGENTS_DIR, "lead.md");
const COORDINATOR_PATH = join(AGENTS_DIR, "coordinator-mission-planned.md");

const REQUIRED_SUBSTRINGS = [
	"CONVERGENCE_MAIL_DROP",
	"--state claimed --type worker_done",
	"ha mail ack",
] as const;

function windowAround(content: string, anchor: string, lines: number): string {
	const allLines = content.split("\n");
	const idx = allLines.findIndex((l) => l.toLowerCase().includes(anchor.toLowerCase()));
	if (idx < 0) return "";
	const start = Math.max(0, idx - lines);
	const end = Math.min(allLines.length, idx + lines + 1);
	return allLines.slice(start, end).join("\n");
}

describe("convergence-mail discipline (cross-file equivalence)", () => {
	for (const [label, path] of [
		["lead.md", LEAD_PATH],
		["coordinator-mission-planned.md", COORDINATOR_PATH],
	] as const) {
		describe(label, () => {
			for (const substr of REQUIRED_SUBSTRINGS) {
				test(`contains "${substr}"`, async () => {
					const content = await readFile(path, "utf8");
					expect(content).toContain(substr);
				});
			}

			test('contains "--type result" within 20 lines of verify-then-ack block', async () => {
				const content = await readFile(path, "utf8");
				const ctx = windowAround(content, "verify-then-ack", 20);
				expect(ctx).toContain("--type result");
			});
		});
	}
});
