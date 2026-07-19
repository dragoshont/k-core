import { describe, expect, it } from "vitest";

describe("public-domain source plugin parsers", () => {
	it("normalizes Project Gutenberg OPDS search and acquisition options", async () => {
		const { parseDetail, parseSearch } = await import(path("project-gutenberg"));
		const search = parseSearch(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>https://www.gutenberg.org/ebooks/1342.opds</id><title>Pride and Prejudice</title><content>Jane Austen</content><link rel="subsection" href="/ebooks/1342.opds"/></entry></feed>`, "pride");
		expect(search.items[0]).toMatchObject({ itemId: "1342", pluginId: "project-gutenberg", title: "Pride and Prejudice" });
		const detail = parseDetail(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>All formats of Pride and Prejudice</title><entry><content>Jane Austen</content><link rel="http://opds-spec.org/acquisition" title="EPUB3 (E-readers incl. Send-to-Kindle)" length="1234" href="https://www.gutenberg.org/ebooks/1342.epub3.images"/></entry></feed>`, "1342");
		expect(detail.acquisitionOptions).toEqual([{ estimatedBytes: 1234, format: "epub", optionId: "epub3-images", rightsBasis: "public-domain" }]);
		expect(() => parseSearch("<!DOCTYPE feed><feed/>", "bad")).toThrow();
	});

	it("normalizes Standard Ebooks semantic catalog and fails on selector drift", async () => {
		const { parseDetail, parseSearch } = await import(path("standard-ebooks"));
		const search = parseSearch(`<ol class="ebooks-list"><li typeof="schema:Book" about="/ebooks/h-g-wells/the-time-machine"><p><a property="schema:url"><span property="schema:name">The Time Machine</span></a></p><p property="schema:author"><span property="schema:name">H. G. Wells</span></p></li></ol>`, "time");
		expect(search.items[0]).toMatchObject({ itemId: "h-g-wells~the-time-machine", title: "The Time Machine" });
		const detail = parseDetail(`<h1 property="schema:name">The Time Machine</h1><a property="schema:author"><span property="schema:name">H. G. Wells</span></a><meta property="schema:inLanguage" content="en-GB"/><a property="schema:contentUrl" class="epub" href="/ebooks/h-g-wells/the-time-machine/downloads/h-g-wells_the-time-machine.epub">EPUB</a>`, "h-g-wells~the-time-machine");
		expect(detail.acquisitionOptions[0]?.optionId).toBe("compatible");
		expect(() => parseDetail("<html><body>changed</body></html>", "item")).toThrow();
	});

	it("accepts only rights-filtered Internet Archive records and bounded EPUB files", async () => {
		const { parseDetail, parseSearch } = await import(path("internet-archive"));
		const search = parseSearch(JSON.stringify({ response: { docs: [
			{ creator: "H. G. Wells", identifier: "wellstimemachine", licenseurl: "https://creativecommons.org/publicdomain/mark/1.0/", title: "The Time Machine" },
			{ identifier: "not-public", licenseurl: "https://example.com/copyright", title: "Blocked" },
		] } }), "time");
		expect(search.items).toHaveLength(1);
		const detail = parseDetail(JSON.stringify({ metadata: { creator: "H. G. Wells", identifier: "wellstimemachine", licenseurl: "https://creativecommons.org/publicdomain/mark/1.0/", title: "The Time Machine" }, files: [{ format: "EPUB", name: "wellstimemachine.epub", size: "1000", source: "derivative" }] }), "wellstimemachine");
		expect(detail.acquisitionOptions[0]).toMatchObject({ estimatedBytes: 1000, optionId: "epub-0" });
		expect(() => parseDetail(JSON.stringify({ metadata: { identifier: "x", licenseurl: "https://example.com/copyright" }, files: [] }), "x")).toThrow();
	});
});

function path(pluginId: string) {
	return new URL(`../../plugins/${pluginId}/index.mjs`, import.meta.url).href;
}