import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGoogleBooksRequest, enrichGoogleBooks, normalizeExactText, parseGoogleBooksResponse } from "../../plugins/google-books/index.mjs";
import { PluginHost } from "../../src/modules/plugins/host";
import { discoverPlugins } from "../../src/modules/plugins/manifests";

const checkedAt = "2026-07-18T16:00:00.000Z";
const isbnInput = {
	mediaKind: "book",
	item: { title: "A Book", creators: ["Ada Author"], identifiers: [{ scheme: "isbn-13", value: "978-1-4028-9462-6" }] },
};

function volume(id: string, patch: Record<string, unknown> = {}) {
	return {
		id,
		volumeInfo: {
			title: "A Book",
			authors: ["Ada Author"],
			industryIdentifiers: [{ type: "ISBN_13", identifier: "9781402894626" }],
			infoLink: `https://books.google.com/books?id=${id}`,
			...patch,
		},
	};
}

describe("Google Books metadata plugin", () => {
	it("matches an exact normalized ISBN and returns bounded ratings with the official link", () => {
		const result = parseGoogleBooksResponse({ items: [volume("record_1", { averageRating: 4.25, ratingsCount: 37 })] }, isbnInput, checkedAt);
		expect(result).toMatchObject({
			state: "matched",
			recordId: "record_1",
			matchedBy: "isbn-13",
			matchQuality: "exact-identifier",
			fields: { averageRating: 4.25, ratingsCount: 37 },
			informationLink: "https://books.google.com/books?id=record_1",
		});
		expect(JSON.stringify(result)).not.toMatch(/thumbnail|cover/i);
	});

	it("uses NFKC, lowercase, and collapsed whitespace for exact title and primary creator matching", () => {
		const input = { mediaKind: "book", item: { title: "The  MIXED\u00a0Case", creators: ["JANE   DOE"], identifiers: [] } };
		const result = parseGoogleBooksResponse({ items: [volume("record_2", {
			title: "Ｔｈｅ mixed case",
			authors: ["Jane\nDoe", "Other Author"],
			industryIdentifiers: [],
		})] }, input, checkedAt);
		expect(normalizeExactText(" ＴＥＳＴ\tValue ")).toBe("test value");
		expect(result).toMatchObject({ state: "matched", matchedBy: "title-creator", matchQuality: "exact-title-creator" });
		expect(parseGoogleBooksResponse({ items: [volume("not-primary", {
			title: "The  MIXED Case",
			authors: ["x".repeat(301), "JANE DOE"],
			industryIdentifiers: [],
		})] }, input, checkedAt)).toMatchObject({ state: "no-match", reasonCode: "NO_EXACT_MATCH" });
	});

	it("returns typed zero and ambiguous exact-match outcomes without fuzzy attachment", () => {
		expect(parseGoogleBooksResponse({ items: [volume("different", { industryIdentifiers: [{ type: "ISBN_13", identifier: "9780000000000" }] })] }, isbnInput, checkedAt)).toEqual({
			state: "no-match", providerId: "google-books", providerLabel: "Google Books", mediaKind: "book", reasonCode: "NO_EXACT_MATCH", checkedAt,
		});
		expect(parseGoogleBooksResponse({ items: [volume("one"), volume("two")] }, isbnInput, checkedAt)).toMatchObject({ state: "no-match", reasonCode: "AMBIGUOUS_MATCH" });
	});

	it("bounds provider fields and rejects malformed candidate sets, IDs, and information links", () => {
		const result = parseGoogleBooksResponse({ items: [volume("bounded", {
			description: "x".repeat(9000),
			authors: ["Ada Author", ...Array.from({ length: 24 }, (_, index) => `Author ${index}`)],
			categories: Array.from({ length: 25 }, (_, index) => `Category ${index}`),
			pageCount: 100001,
			averageRating: 6,
			ratingsCount: Number.MAX_SAFE_INTEGER,
		})] }, isbnInput, checkedAt);
		expect(result.state).toBe("matched");
		if (result.state !== "matched") throw new Error("expected a match");
		expect(result.fields.description).toHaveLength(8000);
		expect(result.fields.creators).toHaveLength(20);
		expect(result.fields.categories).toHaveLength(20);
		expect(result.fields).not.toHaveProperty("pageCount");
		expect(result.fields).not.toHaveProperty("averageRating");
		expect(result.fields).not.toHaveProperty("ratingsCount");
		expect(() => parseGoogleBooksResponse({ items: Array.from({ length: 11 }, (_, index) => volume(`record_${index}`)) }, isbnInput, checkedAt)).toThrow("invalid items");
		expect(() => parseGoogleBooksResponse({ items: [volume("bad id")] }, isbnInput, checkedAt)).toThrow("invalid record");
		expect(() => parseGoogleBooksResponse({ items: [volume("bad-link", { infoLink: "https://example.com/book" })] }, isbnInput, checkedAt)).toThrow("invalid information link");
	});

	it("uses one fixed endpoint and keeps the API key only in X-Goog-Api-Key", async () => {
		const apiKey = "test-google-books-api-key";
		let observedUrl = "";
		let observedPolicy: Record<string, unknown> = {};
		const result = await enrichGoogleBooks(isbnInput, { kind: "api-key", value: apiKey }, async (url: string, policy: Record<string, unknown>) => {
			observedUrl = url;
			observedPolicy = policy;
			return JSON.stringify({ items: [volume("header-test")] });
		}, () => new Date(checkedAt));
		const request = buildGoogleBooksRequest(isbnInput);
		expect(request?.url).toBe(observedUrl);
		expect(new URL(observedUrl).origin + new URL(observedUrl).pathname).toBe("https://www.googleapis.com/books/v1/volumes");
		expect(observedUrl).not.toContain(apiKey);
		expect(observedPolicy).toMatchObject({ headers: { "X-Goog-Api-Key": apiKey }, maxRedirects: 0 });
		expect(JSON.stringify(result)).not.toContain(apiKey);
		await expect(enrichGoogleBooks(isbnInput, { kind: "api-key", value: apiKey }, async () => {
			throw new Error(`upstream reflected ${apiKey}`);
		})).rejects.toThrow("Google Books request failed");
	});

	it("runs through the real protocol-v2 child process without a provider call or credential reflection", async () => {
		const plugin = discoverPlugins(resolve("plugins")).find((candidate) => candidate.manifest.pluginId === "google-books");
		expect(plugin).toBeDefined();
		const apiKey = "child-process-api-key";
		const result = await new PluginHost("k-test").invokeCapability(plugin!, {
			authorization: { kind: "api-key", value: apiKey },
			capabilityId: "google-books/metadata",
			command: "metadata.enrich",
			input: { mediaKind: "book", item: { title: "Creatorless Book", creators: [], identifiers: [] } },
		});
		expect(result).toMatchObject({ state: "no-match", reasonCode: "NO_EXACT_MATCH" });
		expect(JSON.stringify(result)).not.toContain(apiKey);
	});
});