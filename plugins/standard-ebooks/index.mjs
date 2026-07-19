import { load } from "cheerio";
import { downloadFile, fetchText, isPluginMain, runPlugin } from "../lib/runtime.mjs";

export const descriptor = { capabilities: ["search", "detail", "acquire"], pluginId: "standard-ebooks", protocolVersion: 1, version: "1.0.0" };
const policy = { allowedHosts: ["standardebooks.org"], maxBytes: 1024 * 1024, maxRedirects: 0 };
const encodeItemId = (path) => path.replace(/^\/ebooks\//, "").replaceAll("/", "~");
const decodeItemId = (itemId) => {
	if (!/^[a-z0-9-]+~[a-z0-9~-]+$/.test(itemId)) throw new Error("invalid Standard Ebooks item ID");
	return itemId.replaceAll("~", "/");
};

export function parseSearch(source, query) {
	const $ = load(source, { xmlMode: true });
	const checkedAt = new Date().toISOString();
	const items = $("ol.ebooks-list > li[typeof='schema:Book']").slice(0, 24).map((_index, element) => {
		const path = $(element).attr("about") ?? "";
		const title = $(element).find("[property='schema:name']").first().text().trim();
		const author = $(element).find("[property='schema:author'] [property='schema:name']").first().text().trim();
		if (!/^\/ebooks\/[a-z0-9-]+\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(path) || !title) return null;
		return { acquisitionOptions: [], authors: author ? [author] : [], capability: "candidate", capabilityReason: "Standard Ebooks reports a CC0-compatible EPUB; preflight rechecks the edition.", checkedAt, itemId: encodeItemId(path), language: null, pluginId: descriptor.pluginId, publishedYear: null, source: "Standard Ebooks", title };
	}).get().filter(Boolean);
	return { items, query, searchedAt: checkedAt };
}

export function parseDetail(source, itemId) {
	const $ = load(source, { xmlMode: true });
	const title = $("h1[property='schema:name']").first().text().trim();
	if (!title) throw new Error("Standard Ebooks detail selectors changed");
	const authors = $("[property='schema:author'] [property='schema:name']").map((_index, element) => $(element).text().trim()).get().filter(Boolean).slice(0, 20);
	const language = $("meta[property='schema:inLanguage']").attr("content") ?? null;
	const compatible = $("a[property='schema:contentUrl'].epub").first().attr("href") ?? "";
	if (!/^\/ebooks\/[a-z0-9-]+\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\/downloads\/[A-Za-z0-9._-]+\.epub$/.test(compatible)) throw new Error("Standard Ebooks compatible EPUB link is missing");
	return { acquisitionOptions: [{ estimatedBytes: null, format: "epub", optionId: "compatible", rightsBasis: "public-domain" }], authors, capability: "candidate", capabilityReason: "Standard Ebooks content is dedicated through CC0; acquisition rechecks the same-origin EPUB.", checkedAt: new Date().toISOString(), itemId, language, pluginId: descriptor.pluginId, publishedYear: null, source: "Standard Ebooks", title, _downloadPath: compatible };
}

async function detail(itemId) {
	const slug = decodeItemId(itemId);
	return parseDetail(await fetchText(`https://standardebooks.org/ebooks/${slug}`, policy), itemId);
}

if (isPluginMain(import.meta.url)) {
	await runPlugin(descriptor, {
		search: async ({ query }) => parseSearch(await fetchText(`https://standardebooks.org/ebooks?query=${encodeURIComponent(query)}`, policy), query),
		detail: async ({ itemId }) => {
			const { _downloadPath, ...item } = await detail(itemId);
			return item;
		},
		acquire: async ({ destinationPath, itemId, optionId }) => {
			if (optionId !== "compatible") throw new Error("unknown Standard Ebooks option");
			const item = await detail(itemId);
			return downloadFile(`https://standardebooks.org${item._downloadPath}?source=download`, destinationPath, { ...policy, maxBytes: 25 * 1024 * 1024 });
		},
	});
}