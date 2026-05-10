import { describe, expect, test } from "bun:test";
import { generateSlugFromIntent } from "./slug.ts";

describe("generateSlugFromIntent", () => {
	test("produces kebab-case slug from significant words", () => {
		const slug = generateSlugFromIntent("Fix JWT expiry bug in auth middleware", new Set());
		expect(slug).toBe("fix-jwt-expiry-bug-auth-middleware");
	});

	test("strips stopwords", () => {
		const slug = generateSlugFromIntent("Add a new feature for users", new Set());
		// "a", "for" are stopwords
		expect(slug).toBe("add-new-feature-users");
	});

	test("strips punctuation and special chars", () => {
		const slug = generateSlugFromIntent("Fix: bug #123 in module/auth!", new Set());
		expect(slug).toContain("fix");
		expect(slug).toContain("bug");
		expect(slug).not.toContain("#");
		expect(slug).not.toContain(":");
		expect(slug).not.toContain("/");
		expect(slug).not.toContain("!");
	});

	test("limits to 6 words", () => {
		const slug = generateSlugFromIntent(
			"Implement comprehensive authentication system with OAuth2 SAML LDAP support",
			new Set(),
		);
		expect(slug.split("-").length).toBeLessThanOrEqual(6);
	});

	test("appends -2 on first collision", () => {
		const existing = new Set(["fix-typo"]);
		const slug = generateSlugFromIntent("Fix typo", existing);
		expect(slug).toBe("fix-typo-2");
	});

	test("appends -3 on second collision", () => {
		const existing = new Set(["fix-typo", "fix-typo-2"]);
		const slug = generateSlugFromIntent("Fix typo", existing);
		expect(slug).toBe("fix-typo-3");
	});

	test("falls back to hash on heavy collision", () => {
		const existing = new Set<string>(["fix-typo"]);
		for (let i = 2; i <= 99; i++) existing.add(`fix-typo-${i}`);
		const slug = generateSlugFromIntent("Fix typo", existing);
		expect(slug.startsWith("fix-typo-")).toBe(true);
		// hash suffix is alphanumeric; not a small integer
		expect(slug).not.toBe("fix-typo-100");
	});

	test("retains stopwords when remaining significant words too short", () => {
		const slug = generateSlugFromIntent("To be", new Set());
		// All stopwords; falls back to retaining them
		expect(slug.length).toBeGreaterThan(0);
	});

	test("handles empty intent gracefully", () => {
		const slug = generateSlugFromIntent("   !@#$  ", new Set());
		expect(slug).toMatch(/^mission-/);
	});
});
