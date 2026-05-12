import { describe, expect, it } from "bun:test";
import { analyzeCompatibility } from "./analyzer.ts";
import { formatCompatReport } from "./report.ts";
import type { ExportedSymbol, TypeSurface } from "./types.ts";

function makeSurface(ref: string, symbols: ExportedSymbol[]): TypeSurface {
	return { ref, symbols, extractedAt: new Date().toISOString() };
}

function makeSym(overrides: Partial<ExportedSymbol> & { name: string }): ExportedSymbol {
	return { kind: "interface", signature: "Foo", filePath: "src/foo.ts", line: 1, ...overrides };
}

describe("analyzeCompatibility", () => {
	it("1. identical surfaces → compatible, no changes", async () => {
		const sym = makeSym({ name: "Foo", signature: "{ a: string }" });
		const a = makeSurface("main", [sym]);
		const b = makeSurface("feature", [sym]);
		const result = await analyzeCompatibility(a, b);
		expect(result.compatible).toBe(true);
		expect(result.changes).toHaveLength(0);
		expect(result.staticOnly).toBe(true);
	});

	it("2. surface B removes an exported interface → incompatible, breaking", async () => {
		const sym = makeSym({ name: "Foo", kind: "interface" });
		const a = makeSurface("main", [sym]);
		const b = makeSurface("feature", []);
		const result = await analyzeCompatibility(a, b);
		expect(result.compatible).toBe(false);
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0]?.severity).toBe("breaking");
		expect(result.changes[0]?.kind).toBe("removed");
	});

	it("3. surface B adds a new export → compatible, info change", async () => {
		const sym = makeSym({ name: "Foo" });
		const newSym = makeSym({ name: "Bar", filePath: "src/bar.ts" });
		const a = makeSurface("main", [sym]);
		const b = makeSurface("feature", [sym, newSym]);
		const result = await analyzeCompatibility(a, b);
		expect(result.compatible).toBe(true);
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0]?.severity).toBe("info");
		expect(result.changes[0]?.kind).toBe("added");
	});

	it("4. surface B modifies interface (adds optional prop) → compatible, warning", async () => {
		const symA = makeSym({
			name: "Foo",
			kind: "interface",
			signature: "{ a: string }",
		});
		const symB = makeSym({
			name: "Foo",
			kind: "interface",
			signature: "{ a: string; b?: number }",
		});
		const a = makeSurface("main", [symA]);
		const b = makeSurface("feature", [symB]);
		const result = await analyzeCompatibility(a, b);
		expect(result.compatible).toBe(true);
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0]?.severity).toBe("warning");
	});

	it("5. surface B modifies interface (removes prop) → incompatible, breaking", async () => {
		const symA = makeSym({
			name: "Foo",
			kind: "interface",
			signature: "{ a: string; b: number }",
		});
		const symB = makeSym({
			name: "Foo",
			kind: "interface",
			signature: "{ a: string }",
		});
		const a = makeSurface("main", [symA]);
		const b = makeSurface("feature", [symB]);
		const result = await analyzeCompatibility(a, b);
		expect(result.compatible).toBe(false);
		expect(result.changes[0]?.severity).toBe("breaking");
	});

	it("6. both surfaces have same const with different values → warning", async () => {
		const symA = makeSym({
			name: "VERSION",
			kind: "const",
			signature: '"1.0.0"',
			filePath: "src/version.ts",
		});
		const symB = makeSym({
			name: "VERSION",
			kind: "const",
			signature: '"2.0.0"',
			filePath: "src/version.ts",
		});
		const a = makeSurface("main", [symA]);
		const b = makeSurface("feature", [symB]);
		const result = await analyzeCompatibility(a, b);
		expect(result.changes[0]?.severity).toBe("warning");
	});

	it("7. schema conflict: both modify same const in types.ts → breaking", async () => {
		const symA = makeSym({
			name: "RUN_STATES",
			kind: "const",
			signature: '["active", "stopped"]',
			filePath: "src/runs/types.ts",
		});
		const symB = makeSym({
			name: "RUN_STATES",
			kind: "const",
			signature: '["active", "stopped", "paused"]',
			filePath: "src/runs/types.ts",
		});
		const a = makeSurface("main", [symA]);
		const b = makeSurface("feature", [symB]);
		const result = await analyzeCompatibility(a, b);
		expect(result.changes[0]?.severity).toBe("breaking");
		expect(result.compatible).toBe(false);
	});

	it("8. AI fallback triggers when warnings exceed threshold", async () => {
		// Create 6 warning-level changes (aiThreshold default is 5)
		const symbols: ExportedSymbol[] = Array.from({ length: 6 }, (_, i) =>
			makeSym({ name: `Sym${i}`, kind: "const", signature: `"v${i}"`, filePath: "src/foo.ts" }),
		);
		const symbolsB: ExportedSymbol[] = Array.from({ length: 6 }, (_, i) =>
			makeSym({ name: `Sym${i}`, kind: "const", signature: `"v${i}_new"`, filePath: "src/foo.ts" }),
		);
		const a = makeSurface("main", symbols);
		const b = makeSurface("feature", symbolsB);

		let aiCalled = false;
		const result = await analyzeCompatibility(a, b, undefined, {
			invoke: async () => {
				aiCalled = true;
				return "AI enriched summary.";
			},
		});
		expect(aiCalled).toBe(true);
		expect(result.staticOnly).toBe(false);
		expect(result.summary).toBe("AI enriched summary.");
	});

	it("9. AI failure is non-blocking", async () => {
		const symbols: ExportedSymbol[] = Array.from({ length: 6 }, (_, i) =>
			makeSym({ name: `X${i}`, kind: "const", signature: `"a${i}"`, filePath: "src/foo.ts" }),
		);
		const symbolsB: ExportedSymbol[] = Array.from({ length: 6 }, (_, i) =>
			makeSym({ name: `X${i}`, kind: "const", signature: `"b${i}"`, filePath: "src/foo.ts" }),
		);
		const a = makeSurface("main", symbols);
		const b = makeSurface("feature", symbolsB);

		const result = await analyzeCompatibility(a, b, undefined, {
			invoke: async () => {
				throw new Error("AI error");
			},
		});
		expect(result.staticOnly).toBe(true);
		expect(result.summary).toBeTruthy();
	});

	it("R1. cross-file move with identical signature → compatible, single modified/info entry", async () => {
		const symA = makeSym({
			name: "Foo",
			kind: "interface",
			signature: "{ x: number }",
			filePath: "src/a.ts",
		});
		const symB = makeSym({
			name: "Foo",
			kind: "interface",
			signature: "{ x: number }",
			filePath: "src/b.ts",
		});
		const a = makeSurface("main", [symA]);
		const b = makeSurface("feature", [symB]);
		const result = await analyzeCompatibility(a, b);
		expect(result.compatible).toBe(true);
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0]?.kind).toBe("modified");
		expect(result.changes[0]?.severity).toBe("info");
		expect(result.changes[0]?.previousFilePath).toBe("src/a.ts");
		expect(result.changes[0]?.symbol.filePath).toBe("src/b.ts");
		expect(result.changes[0]?.previousSignature).toBeUndefined();
	});

	it("R2. cross-file move with different signature → no fold, incompatible", async () => {
		const symA = makeSym({
			name: "Foo",
			kind: "interface",
			signature: "{ x: number }",
			filePath: "src/a.ts",
		});
		const symB = makeSym({
			name: "Foo",
			kind: "interface",
			signature: "{ x: string }",
			filePath: "src/b.ts",
		});
		const a = makeSurface("main", [symA]);
		const b = makeSurface("feature", [symB]);
		const result = await analyzeCompatibility(a, b);
		expect(result.compatible).toBe(false);
		const removedEntry = result.changes.find((c) => c.kind === "removed");
		const addedEntry = result.changes.find((c) => c.kind === "added");
		expect(removedEntry).toBeDefined();
		expect(addedEntry).toBeDefined();
		expect(removedEntry?.symbol.filePath).toBe("src/a.ts");
		expect(addedEntry?.symbol.filePath).toBe("src/b.ts");
	});

	it("R3. same name, different kind → no fold", async () => {
		const symA = makeSym({
			name: "Foo",
			kind: "interface",
			signature: "{ x: number }",
			filePath: "src/a.ts",
		});
		const symB = makeSym({
			name: "Foo",
			kind: "const",
			signature: "{ x: number }",
			filePath: "src/b.ts",
		});
		const a = makeSurface("main", [symA]);
		const b = makeSurface("feature", [symB]);
		const result = await analyzeCompatibility(a, b);
		const removedEntry = result.changes.find((c) => c.kind === "removed");
		const addedEntry = result.changes.find((c) => c.kind === "added");
		expect(removedEntry).toBeDefined();
		expect(addedEntry).toBeDefined();
		expect(result.changes.find((c) => c.kind === "modified")).toBeUndefined();
	});

	it("R4. same name multiple removed — fold only signature-matching pair, remainder stays breaking", async () => {
		const symAa = makeSym({
			name: "Foo",
			kind: "interface",
			signature: "{ x: number }",
			filePath: "src/a.ts",
		});
		const symAc = makeSym({
			name: "Foo",
			kind: "interface",
			signature: "{ y: string }",
			filePath: "src/c.ts",
		});
		const symBb = makeSym({
			name: "Foo",
			kind: "interface",
			signature: "{ x: number }",
			filePath: "src/b.ts",
		});
		const a = makeSurface("main", [symAa, symAc]);
		const b = makeSurface("feature", [symBb]);
		const result = await analyzeCompatibility(a, b);
		const modified = result.changes.find((c) => c.kind === "modified");
		expect(modified).toBeDefined();
		expect(modified?.severity).toBe("info");
		expect(modified?.previousFilePath).toBe("src/a.ts");
		const remaining = result.changes.find((c) => c.kind === "removed");
		expect(remaining).toBeDefined();
		expect(remaining?.symbol.filePath).toBe("src/c.ts");
		expect(remaining?.severity).toBe("breaking");
		expect(result.compatible).toBe(false);
	});

	it("R5. cross-file move of const in types.ts with identical signature → fold produces info, not breaking", async () => {
		const symA = makeSym({
			name: "FooConfig",
			kind: "const",
			signature: "{ enabled: boolean }",
			filePath: "src/a/types.ts",
		});
		const symB = makeSym({
			name: "FooConfig",
			kind: "const",
			signature: "{ enabled: boolean }",
			filePath: "src/b/types.ts",
		});
		const a = makeSurface("main", [symA]);
		const b = makeSurface("feature", [symB]);
		const result = await analyzeCompatibility(a, b);
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0]?.kind).toBe("modified");
		expect(result.changes[0]?.severity).toBe("info");
		expect(result.changes[0]?.previousFilePath).toBe("src/a/types.ts");
		expect(result.compatible).toBe(true);
	});

	it("R6 (ordering-proof). fold runs after schema-conflict elevation — folded move not re-escalated", async () => {
		// Both surfaces have the same const in their respective types.ts files (different paths, identical signature).
		// Schema-conflict elevation only fires on kind==="modified" entries from same-file detection — not on
		// fold-produced entries — so the result must be info, not breaking.
		const symA = makeSym({
			name: "FooConfig",
			kind: "const",
			signature: '["a","b"]',
			filePath: "src/a/types.ts",
		});
		const symB = makeSym({
			name: "FooConfig",
			kind: "const",
			signature: '["a","b"]',
			filePath: "src/b/types.ts",
		});
		const a = makeSurface("main", [symA]);
		const b = makeSurface("feature", [symB]);
		const result = await analyzeCompatibility(a, b);
		expect(result.changes).toHaveLength(1);
		const entry = result.changes[0];
		expect(entry?.kind).toBe("modified");
		expect(entry?.severity).toBe("info");
		expect(result.compatible).toBe(true);
	});
});

describe("formatCompatReport", () => {
	it("10. report formatting produces valid markdown", async () => {
		const symA = makeSym({ name: "Foo", kind: "interface", signature: "{ a: string }" });
		const symB = makeSym({
			name: "Foo",
			kind: "interface",
			signature: "{ a: string; b?: number }",
		});
		const symNew = makeSym({ name: "Bar", filePath: "src/bar.ts" });
		const a = makeSurface("main", [symA]);
		const b = makeSurface("feature", [symB, symNew]);
		const result = await analyzeCompatibility(a, b);
		const report = formatCompatReport(result);

		expect(report).toContain("# Compatibility Report");
		expect(report).toContain("**Branch A:** main");
		expect(report).toContain("**Branch B:** feature");
		expect(report).toContain("Compatible");
		expect(report).toContain("## Summary");
		// Table headers
		expect(report).toContain("| Symbol |");
		expect(report).toContain("| Severity |");
		// Change rows
		expect(report).toContain("Foo");
		expect(report).toContain("Bar");
	});
});
