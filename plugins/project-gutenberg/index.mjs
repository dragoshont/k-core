import { XMLParser } from "fast-xml-parser";
import { downloadFile, fetchText, isPluginMain, runPlugin } from "../lib/runtime.mjs";

export const descriptor = { capabilities: ["search", "detail", "acquire"], pluginId: "project-gutenberg", protocolVersion: 1, version: "1.0.0" };
const policy = { allowedHosts: ["www.gutenberg.org"], maxBytes: 1024 * 1024, maxRedirects: 0 };
const parser = new XMLParser({ attributeNamePrefix: "@", ignoreAttributes: false, processEntities: false, removeNSPrefix: true, trimValues: true });
const array = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = (value) => typeof value === "string" ? value : value && typeof value === "object" && typeof value["#text"] === "string" ? value["#text"] : "";

function parseXml(source) {
	if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error("OPDS document types and entities are not allowed");
	return parser.parse(source);
}

export function parseSearch(source, query) {
	const feed = parseXml(source).feed;
	const checkedAt = new Date().toISOString();
	const items = array(feed?.entry).slice(0, 24).flatMap((entry) => {
		const subsection = array(entry.link).find((link) => link?.["@rel"] === "subsection");
		const match = String(subsection?.["@href"] ?? entry.id ?? "").match(/\/ebooks\/(\d+)\.opds/);
		if (!match) return [];
		return [{ acquisitionOptions: [], authors: text(entry.content) ? [text(entry.content)] : [], capability: "candidate", capabilityReason: "Project Gutenberg reports public-domain EPUB editions; preflight rechecks the item.", checkedAt, itemId: match[1], language: null, pluginId: descriptor.pluginId, publishedYear: null, source: "Project Gutenberg", title: text(entry.title) || "Untitled" }];
	});
	return { items, query, searchedAt: checkedAt };
}

function optionId(title) {
	const normalized = title.toLowerCase();
	if (normalized.includes("epub3")) return "epub3-images";
	if (normalized.includes("no images")) return "epub-noimages";
	return "epub-images";
}

export function parseDetail(source, itemId) {
	const feed = parseXml(source).feed;
	const entries = array(feed?.entry);
	const checkedAt = new Date().toISOString();
	const options = entries.flatMap((entry) => array(entry.link))
		.filter((link) => link?.["@rel"] === "http://opds-spec.org/acquisition" && /epub/i.test(String(link?.["@title"] ?? "")))
		.map((link) => ({ estimatedBytes: Number.isFinite(Number(link["@length"])) ? Number(link["@length"]) : null, format: "epub", optionId: optionId(String(link["@title"] ?? "epub")), rightsBasis: "public-domain", sourceHref: String(link["@href"] ?? "") }))
		.filter((option, index, all) => option.sourceHref && all.findIndex((candidate) => candidate.optionId === option.optionId) === index);
	const first = entries[0] ?? {};
	return { acquisitionOptions: options.map(({ sourceHref: _sourceHref, ...option }) => option), authors: text(first.content) ? [text(first.content)] : [], capability: "candidate", capabilityReason: "Public-domain status and EPUB bytes will be rechecked during preflight and acquisition.", checkedAt, itemId, language: null, pluginId: descriptor.pluginId, publishedYear: null, source: "Project Gutenberg", title: text(feed?.title).replace(/^All formats of /, "") || text(first.title) || `Project Gutenberg ${itemId}`, _options: options };
}

async function detail(input) {
	if (!/^\d{1,8}$/.test(input.itemId)) throw new Error("invalid Gutenberg item ID");
	return parseDetail(await fetchText(`https://www.gutenberg.org/ebooks/${input.itemId}.opds`, policy), input.itemId);
}

if (isPluginMain(import.meta.url)) {
	await runPlugin(descriptor, {
		search: async ({ query }) => parseSearch(await fetchText(`https://www.gutenberg.org/ebooks/search.opds/?query=${encodeURIComponent(query)}`, policy), query),
		detail: async ({ itemId }) => {
			const { _options, ...item } = await detail({ itemId });
			return item;
		},
		acquire: async ({ destinationPath, itemId, optionId: selectedOption }) => {
			const item = await detail({ itemId });
			const option = item._options.find((candidate) => candidate.optionId === selectedOption);
			if (!option) throw new Error("unknown Gutenberg option");
			return downloadFile(option.sourceHref, destinationPath, { ...policy, maxBytes: 25 * 1024 * 1024 });
		},
	});
}