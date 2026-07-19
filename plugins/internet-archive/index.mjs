import { downloadFile, fetchText, isPluginMain, runPlugin } from "../lib/runtime.mjs";

export const descriptor = { capabilities: ["search", "detail", "acquire"], pluginId: "internet-archive", protocolVersion: 1, version: "1.0.0" };
const policy = { allowedHosts: ["archive.org", "*.archive.org"], maxBytes: 1024 * 1024, maxRedirects: 3 };
const acceptedLicenses = new Set([
	"http://creativecommons.org/publicdomain/mark/1.0/",
	"https://creativecommons.org/publicdomain/mark/1.0/",
	"http://creativecommons.org/publicdomain/zero/1.0/",
	"https://creativecommons.org/publicdomain/zero/1.0/",
]);
const validItemId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(value);
const authors = (value) => (Array.isArray(value) ? value : value ? [value] : []).filter((item) => typeof item === "string").slice(0, 20);

export function parseSearch(source, query) {
	const payload = JSON.parse(source);
	const checkedAt = new Date().toISOString();
	const items = (payload.response?.docs ?? []).slice(0, 24).flatMap((doc) => {
		if (!validItemId(doc.identifier) || !acceptedLicenses.has(doc.licenseurl) || typeof doc.title !== "string") return [];
		return [{ acquisitionOptions: [], authors: authors(doc.creator), capability: "candidate", capabilityReason: "Internet Archive reports an EPUB with explicit public-domain rights evidence; preflight rechecks metadata.", checkedAt, itemId: doc.identifier, language: null, pluginId: descriptor.pluginId, publishedYear: null, source: "Internet Archive", title: doc.title }];
	});
	return { items, query, searchedAt: checkedAt };
}

export function parseDetail(source, itemId) {
	const payload = JSON.parse(source);
	if (payload.metadata?.identifier !== itemId || !acceptedLicenses.has(payload.metadata?.licenseurl)) throw new Error("Internet Archive item lacks accepted public-domain rights evidence");
	const files = (payload.files ?? []).filter((file) => file?.format === "EPUB" && file?.source === "derivative" && typeof file?.name === "string" && !file.name.includes("/") && Number(file.size) > 0 && Number(file.size) <= 25 * 1024 * 1024);
	const options = files.slice(0, 8).map((file, index) => ({ estimatedBytes: Number(file.size), fileName: file.name, format: "epub", optionId: `epub-${index}`, rightsBasis: "public-domain" }));
	if (options.length === 0) throw new Error("Internet Archive item has no bounded EPUB");
	return { acquisitionOptions: options.map(({ fileName: _fileName, ...option }) => option), authors: authors(payload.metadata.creator), capability: "candidate", capabilityReason: "This record has explicit Public Domain Mark or CC0 evidence; acquisition rechecks the listed EPUB.", checkedAt: new Date().toISOString(), itemId, language: typeof payload.metadata.language === "string" ? payload.metadata.language : null, pluginId: descriptor.pluginId, publishedYear: null, source: "Internet Archive", title: String(payload.metadata.title ?? itemId), _options: options };
}

async function detail(itemId) {
	if (!validItemId(itemId)) throw new Error("invalid Internet Archive item ID");
	return parseDetail(await fetchText(`https://archive.org/metadata/${encodeURIComponent(itemId)}`, policy), itemId);
}

if (isPluginMain(import.meta.url)) {
	await runPlugin(descriptor, {
		search: async ({ query }) => {
			const rights = '(licenseurl:"https://creativecommons.org/publicdomain/mark/1.0/" OR licenseurl:"http://creativecommons.org/publicdomain/mark/1.0/" OR licenseurl:"https://creativecommons.org/publicdomain/zero/1.0/" OR licenseurl:"http://creativecommons.org/publicdomain/zero/1.0/")';
			const escapedQuery = String(query).replace(/[\\(){}\[\]^~*?:!+\-"|&/]/g, " ").trim();
			if (escapedQuery.length < 2) throw new Error("search query has no usable terms");
			const q = `mediatype:texts AND format:"EPUB" AND ${rights} AND (${escapedQuery})`;
			const url = new URL("https://archive.org/advancedsearch.php");
			for (const [name, value] of [["q", q], ["fl[]", "identifier,title,creator,licenseurl"], ["rows", "24"], ["page", "1"], ["output", "json"]]) url.searchParams.append(name, value);
			return parseSearch(await fetchText(url, policy), query);
		},
		detail: async ({ itemId }) => {
			const { _options, ...item } = await detail(itemId);
			return item;
		},
		acquire: async ({ destinationPath, itemId, optionId }) => {
			const item = await detail(itemId);
			const option = item._options.find((candidate) => candidate.optionId === optionId);
			if (!option) throw new Error("unknown Internet Archive option");
			return downloadFile(`https://archive.org/download/${encodeURIComponent(itemId)}/${encodeURIComponent(option.fileName)}`, destinationPath, { ...policy, maxBytes: 25 * 1024 * 1024 });
		},
	});
}