import { describe, expect, test } from "bun:test";
import { extractSpecTitle } from "./spec-title.ts";

describe("extractSpecTitle", () => {
	test("S-1: canonical template → first non-empty body line under ## Intent", () => {
		const body =
			"# canonical-slug\n\n## Intent\n\nThe user wants a thing\n\n## Goal\n\nGoal text\n";
		expect(extractSpecTitle(body)).toBe("The user wants a thing");
	});

	test("S-2: only `# <slug>` heading, no ## Intent → returns the slug", () => {
		const body = "# my-slug\n\nSome body without an Intent heading\n";
		expect(extractSpecTitle(body)).toBe("my-slug");
	});

	test("S-3: ## Intent immediately followed by another ## heading falls through to slug; if no slug → undefined", () => {
		const withSlug = "# real-slug\n\n## Intent\n## Goal\n\nbody\n";
		expect(extractSpecTitle(withSlug)).toBe("real-slug");

		const noSlug = "## Intent\n## Goal\n\nbody\n";
		expect(extractSpecTitle(noSlug)).toBeUndefined();
	});

	test("S-4: empty line after ## Intent then content line → returns content line", () => {
		const body = "## Intent\n\n\nactual content line\n";
		expect(extractSpecTitle(body)).toBe("actual content line");
	});

	test("S-5: multi-line Intent body → returns ONLY the first non-empty line (no concatenation)", () => {
		const body = "## Intent\n\nfirst line of intent\nsecond line of intent\nthird line of intent\n";
		expect(extractSpecTitle(body)).toBe("first line of intent");
	});

	test("S-6: leading/trailing whitespace on captured line is trimmed", () => {
		const body = "## Intent\n\n   spaced title with trailing space   \n\n## Goal\n";
		expect(extractSpecTitle(body)).toBe("spaced title with trailing space");
	});

	test("S-7: title >120 chars sliced to 119 + ellipsis (single Unicode char)", () => {
		const longLine = "a".repeat(200);
		const body = `## Intent\n\n${longLine}\n`;
		const result = extractSpecTitle(body);
		expect(result).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: checked above
		expect(result!.length).toBe(120);
		expect(result).toBe(`${"a".repeat(119)}…`);
	});

	test("S-8: neither ## Intent nor # heading → undefined", () => {
		const body = "just a body\nwith no heading at all\n\nand a blank line\n";
		expect(extractSpecTitle(body)).toBeUndefined();
	});

	test("S-9: fenced code block containing ## Intent — accept either per-line or false-positive behavior", () => {
		const realSlug = "real-slug";
		const fakeTitle = "fake-title";
		const body = [
			`# ${realSlug}`,
			"",
			"## Goal",
			"",
			"Some goal text",
			"",
			"```markdown",
			"## Intent",
			fakeTitle,
			"```",
			"",
		].join("\n");
		// Builder may pick either behavior per brief §7:
		//   (a) per-line state machine ignores fences → no real ## Intent, falls
		//       through to slug heading => "real-slug"
		//   (b) documented false positive: naive line scan matches the fenced
		//       "## Intent" and returns fakeTitle.
		//   (c) defensive null when ambiguity — also acceptable.
		expect([fakeTitle, realSlug, undefined]).toContain(extractSpecTitle(body));
	});
});
