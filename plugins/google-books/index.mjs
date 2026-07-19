import { readFile } from "node:fs/promises";
import { fetchText, isPluginMain, runCapabilityPlugin } from "../lib/runtime.mjs";

export const manifest = JSON.parse(await readFile(new URL("./plugin.json", import.meta.url), "utf8"));

const API_ENDPOINT = "https://www.googleapis.com/books/v1/volumes";
const CAPABILITY_ID = "google-books/metadata";
const MAX_CANDIDATES = 10;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const IDENTIFIER_SCHEMES = new Set(["isbn-10", "isbn-13", "oclc", "lccn", "imdb", "tmdb"]);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value, maximum, minimum = 1) {
	if (typeof value !== "string") return undefined;
	const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").trim();
	if (Array.from(clean).length < minimum) return undefined;
	return Array.from(clean).slice(0, maximum).join("");
}

function exactText(value, maximum) {
	if (typeof value !== "string") return undefined;
	const clean = value.trim();
	if (!clean || Array.from(clean).length > maximum) return undefined;
	return clean;
}

export function normalizeExactText(value) {
	return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function normalizeIsbn(value, scheme) {
	if (typeof value !== "string") return null;
	const compact = value.normalize("NFKC").replace(/[\s-]+/gu, "").toUpperCase();
	if (scheme === "isbn-10" && /^\d{9}[\dX]$/.test(compact)) return compact;
	if (scheme === "isbn-13" && /^\d{13}$/.test(compact)) return compact;
	return null;
}

function validateInput(input) {
	if (!isRecord(input) || input.mediaKind !== "book" || !isRecord(input.item)) throw new Error("invalid metadata input");
	const title = exactText(input.item.title, 500);
	if (!title) throw new Error("invalid metadata title");
	if (!Array.isArray(input.item.creators) || input.item.creators.length > 20) throw new Error("invalid metadata creators");
	const creators = input.item.creators.map((creator) => {
		const value = exactText(creator, 300);
		if (!value) throw new Error("invalid metadata creator");
		return value;
	});
	if (!Array.isArray(input.item.identifiers) || input.item.identifiers.length > 20) throw new Error("invalid metadata identifiers");
	const identifiers = input.item.identifiers.map((identifier) => {
		if (!isRecord(identifier) || !IDENTIFIER_SCHEMES.has(identifier.scheme)) throw new Error("invalid metadata identifier");
		const value = exactText(identifier.value, 128);
		if (!value) throw new Error("invalid metadata identifier");
		return { scheme: identifier.scheme, value };
	});
	return { creators, identifiers, title };
}

function requestedIsbn(item) {
	for (const scheme of ["isbn-13", "isbn-10"]) {
		for (const identifier of item.identifiers) {
			if (identifier.scheme !== scheme) continue;
			const value = normalizeIsbn(identifier.value, scheme);
			if (value) return { scheme, value };
		}
	}
	return null;
}

function quotedQueryTerm(value) {
	return `"${value.replace(/["\\]/gu, " ").replace(/\s+/gu, " ").trim()}"`;
}

export function buildGoogleBooksRequest(input) {
	const item = validateInput(input);
	const isbn = requestedIsbn(item);
	if (!isbn && item.creators.length === 0) return null;
	const url = new URL(API_ENDPOINT);
	url.searchParams.set("q", isbn
		? `isbn:${isbn.value}`
		: `intitle:${quotedQueryTerm(item.title)}+inauthor:${quotedQueryTerm(item.creators[0])}`);
	url.searchParams.set("maxResults", String(MAX_CANDIDATES));
	url.searchParams.set("printType", "books");
	url.searchParams.set("projection", "full");
	return { item, matchedBy: isbn?.scheme ?? "title-creator", requestedIsbn: isbn?.value ?? null, url: url.toString() };
}

function boundedTextArray(value, maximumItems, maximumText) {
	if (!Array.isArray(value)) return [];
	return value.slice(0, maximumItems).map((entry) => boundedText(entry, maximumText)).filter((entry) => entry !== undefined);
}

function boundedInteger(value, minimum, maximum) {
	return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}

function boundedNumber(value, minimum, maximum) {
	return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum ? value : undefined;
}

function candidateIdentifiers(value) {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 20).flatMap((identifier) => {
		if (!isRecord(identifier) || (identifier.type !== "ISBN_10" && identifier.type !== "ISBN_13")) return [];
		const scheme = identifier.type === "ISBN_10" ? "isbn-10" : "isbn-13";
		const normalized = normalizeIsbn(identifier.identifier, scheme);
		return normalized ? [{ scheme, value: normalized }] : [];
	});
}

function parseCandidate(value) {
	if (!isRecord(value) || typeof value.id !== "string" || !OPAQUE_ID.test(value.id)) throw new Error("Google Books returned an invalid record");
	if (!isRecord(value.volumeInfo)) return { fields: {}, identifiers: [], informationLink: undefined, primaryAuthor: undefined, recordId: value.id, title: undefined };
	const volume = value.volumeInfo;
	const fields = {};
	const title = exactText(volume.title, 500);
	const primaryAuthor = Array.isArray(volume.authors) ? exactText(volume.authors[0], 300) : undefined;
	const assignText = (key, source, maximum, minimum = 1) => {
		const bounded = boundedText(source, maximum, minimum);
		if (bounded !== undefined) fields[key] = bounded;
	};
	assignText("title", volume.title, 500);
	assignText("subtitle", volume.subtitle, 500);
	const creators = boundedTextArray(volume.authors, 20, 300);
	if (creators.length > 0) fields.creators = creators;
	assignText("publisher", volume.publisher, 300);
	assignText("publishedDate", volume.publishedDate, 32, 4);
	assignText("description", volume.description, 8000);
	const pageCount = boundedInteger(volume.pageCount, 1, 100000);
	if (pageCount !== undefined) fields.pageCount = pageCount;
	const categories = boundedTextArray(volume.categories, 20, 200);
	if (categories.length > 0) fields.categories = categories;
	const averageRating = boundedNumber(volume.averageRating, 1, 5);
	if (averageRating !== undefined) fields.averageRating = averageRating;
	const ratingsCount = boundedInteger(volume.ratingsCount, 0, 2147483647);
	if (ratingsCount !== undefined) fields.ratingsCount = ratingsCount;
	return {
		fields,
		identifiers: candidateIdentifiers(volume.industryIdentifiers),
		informationLink: boundedText(volume.infoLink, 2048),
		primaryAuthor,
		recordId: value.id,
		title,
	};
}

function officialInformationLink(value) {
	if (!value || CONTROL_CHARACTER.test(value)) throw new Error("Google Books returned an invalid information link");
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Google Books returned an invalid information link");
	}
	if (url.protocol !== "https:" || url.hostname !== "books.google.com" || url.port || url.username || url.password) throw new Error("Google Books returned an invalid information link");
	return value;
}

function noMatch(reasonCode, checkedAt) {
	return { state: "no-match", providerId: "google-books", providerLabel: "Google Books", mediaKind: "book", reasonCode, checkedAt };
}

export function parseGoogleBooksResponse(payload, input, checkedAt = new Date().toISOString()) {
	const item = validateInput(input);
	if (!isRecord(payload)) throw new Error("Google Books returned invalid JSON");
	const values = payload.items === undefined ? [] : payload.items;
	if (!Array.isArray(values) || values.length > MAX_CANDIDATES) throw new Error("Google Books returned invalid items");
	const candidates = values.map(parseCandidate);
	const isbn = requestedIsbn(item);
	const exact = isbn
		? candidates.filter((candidate) => candidate.identifiers.some((identifier) => identifier.value === isbn.value))
		: item.creators.length === 0 ? [] : candidates.filter((candidate) => candidate.title !== undefined
			&& candidate.primaryAuthor !== undefined
			&& normalizeExactText(candidate.title) === normalizeExactText(item.title)
			&& normalizeExactText(candidate.primaryAuthor) === normalizeExactText(item.creators[0]));
	if (exact.length === 0) return noMatch("NO_EXACT_MATCH", checkedAt);
	if (exact.length > 1) return noMatch("AMBIGUOUS_MATCH", checkedAt);
	const candidate = exact[0];
	if (Object.keys(candidate.fields).length === 0) throw new Error("Google Books returned no usable metadata");
	return {
		state: "matched",
		providerId: "google-books",
		providerLabel: "Google Books",
		recordId: candidate.recordId,
		mediaKind: "book",
		matchedBy: isbn?.scheme ?? "title-creator",
		matchQuality: isbn ? "exact-identifier" : "exact-title-creator",
		fields: candidate.fields,
		checkedAt,
		informationLink: officialInformationLink(candidate.informationLink),
	};
}

export async function enrichGoogleBooks(input, authorization, transport = fetchText, clock = () => new Date()) {
	const key = authorization?.value;
	if (authorization?.kind !== "api-key" || typeof key !== "string" || key.length < 16 || key.length > 1024 || CONTROL_CHARACTER.test(key)) throw new Error("invalid application credential");
	const request = buildGoogleBooksRequest(input);
	const checkedAt = clock().toISOString();
	if (!request) return noMatch("NO_EXACT_MATCH", checkedAt);
	let source;
	try {
		source = await transport(request.url, {
			allowedHosts: manifest.runtime.allowedHosts,
			headers: { "X-Goog-Api-Key": key },
			maxBytes: manifest.runtime.maxResponseBytes,
			maxRedirects: 0,
		});
	} catch {
		throw new Error("Google Books request failed");
	}
	let payload;
	try {
		payload = JSON.parse(source);
	} catch {
		throw new Error("Google Books returned invalid JSON");
	}
	return parseGoogleBooksResponse(payload, input, checkedAt);
}

if (isPluginMain(import.meta.url)) {
	await runCapabilityPlugin(manifest, {
		[CAPABILITY_ID]: { "metadata.enrich": enrichGoogleBooks },
	});
}