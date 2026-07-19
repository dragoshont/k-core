import { resolve } from "node:path";
import type { AppConfig } from "../config";
import type { Database, SqlExecutor } from "../db/database";
import { hmacSha256Hex } from "../common/crypto";
import { ProblemError } from "../http/problems";
import { findRepoRoot } from "../platform/root";
import { PluginHost } from "./host";
import { discoverPlugins, pluginDigestIsCurrent } from "./manifests";
import { assertProtocolV2Envelope } from "./conformance";
import type { BookIdentifierScheme, CatalogCapabilityEvidence, CatalogItem, CatalogMetadataEvidence, InstalledPlugin, PluginCatalogItem, PluginMetadataResult, PluginSearchResult, PublicCapabilityView, PublicEvidenceStamp } from "./types";
import { googleBooksMetadataCapability, legacyCatalogCapabilities } from "./capabilities";
import { catalogRightsPolicy, type CatalogRightsDecision } from "./rights-policy";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const CATALOG_REF = /^plugin:([a-z0-9][a-z0-9-]{0,63}):([A-Za-z0-9][A-Za-z0-9._~-]{0,127})$/;

interface CacheRow {
	fetched_at: Date;
	fresh_until: Date;
	normalized_json: unknown;
	stale_until: Date;
}

type CacheKind = "detail" | "metadata" | "search";
type MetadataOrigin = "fresh-cache" | "live" | "stale-cache";

interface SourceProviderStatus {
	checkedAt: string;
	decision: CatalogRightsDecision;
	displayName: string;
	freshness: "fresh" | "stale";
	plugin: InstalledPlugin;
	reason: string | null;
	sourceKind: "cached-api" | "live-api";
	support: "available" | "unavailable";
}

interface MetadataOutcome {
	checkedAt: string;
	failed: boolean;
	item: CatalogItem;
	origin: MetadataOrigin;
}

export interface ProfilePluginView {
	capabilities: Array<"acquire" | "detail" | "search">;
	checkedAt: string;
	displayName: string;
	installed: true;
	pluginId: string;
	provenance: "unverified-provenance" | "verified-public-domain";
	reason: string | null;
	reasonCode: string;
	rightsBasis: "public-domain" | null;
	support: "available" | "blocked" | "unavailable";
	version: string;
}

function boundedText(value: unknown, maximum: number, fallback?: string) {
	if (typeof value !== "string" || !value.trim()) {
		if (fallback !== undefined) return fallback;
		throw new Error("plugin returned missing text");
	}
	return Array.from(value.trim()).slice(0, maximum).join("");
}

function normalizeIdentifier(identifier: { scheme: BookIdentifierScheme; value: string }) {
	if (!identifier || !["isbn-10", "isbn-13", "lccn", "oclc"].includes(identifier.scheme)) throw new Error("plugin returned an invalid identifier");
	const raw = boundedText(identifier.value, 128);
	const value = identifier.scheme === "isbn-10" || identifier.scheme === "isbn-13"
		? raw.normalize("NFKC").replace(/[\s-]+/gu, "").toUpperCase()
		: raw.normalize("NFKC").replace(/\s+/gu, " ");
	if ((identifier.scheme === "isbn-10" && !/^\d{9}[\dX]$/.test(value))
		|| (identifier.scheme === "isbn-13" && !/^\d{13}$/.test(value))) throw new Error("plugin returned an invalid ISBN");
	return { scheme: identifier.scheme, value };
}

function policyEvidence(checkedAt: string): PublicEvidenceStamp {
	return { checkedAt, freshness: "not-applicable", scope: { id: null, kind: "public-catalog" }, sourceId: "provider-policy", sourceKind: "static-policy", sourceLabel: "Provider policy" };
}

function staticCapabilityEvidence(checkedAt: string): CatalogCapabilityEvidence[] {
	return [
		{ capability: "reviews", evidence: policyEvidence(checkedAt), providerId: "goodreads", reason: "Goodreads has no supported new API integration and no scraping fallback.", reasonCode: "GOODREADS_API_UNAVAILABLE", state: "unsupported" },
		{ capability: "product-availability", evidence: policyEvidence(checkedAt), prerequisite: "Current Amazon Creators API eligibility and reviewed response fixtures.", providerId: "amazon", reason: "Current Amazon Creators API eligibility and reviewed fixtures are required.", reasonCode: "AMAZON_CREATORS_ELIGIBILITY_REQUIRED", state: "eligibility-required" },
		{ capability: "kindle-unlimited", evidence: policyEvidence(checkedAt), providerId: "amazon", reason: "No supported API exposes a trustworthy Kindle Unlimited entitlement signal.", reasonCode: "KINDLE_UNLIMITED_NOT_EXPOSED", state: "not-exposed" },
	];
}

function normalizeItem(plugin: InstalledPlugin, inventory: AppConfig["publicPluginInventory"], value: PluginCatalogItem): CatalogItem {
	if (!value || typeof value !== "object" || value.pluginId !== plugin.manifest.pluginId || !OPAQUE_ID.test(value.itemId)) {
		throw new Error("plugin returned an invalid item identity");
	}
	const policy = catalogRightsPolicy(plugin, inventory, value);
	if (policy.state === "blocked") throw new Error(policy.reason);
	const checkedAt = new Date(value.checkedAt).toString() === "Invalid Date" ? new Date().toISOString() : new Date(value.checkedAt).toISOString();
	const identifiers = Array.isArray(value.identifiers)
		? [...new Map(value.identifiers.slice(0, 20).map(normalizeIdentifier).map((identifier) => [`${identifier.scheme}:${identifier.value}`, identifier])).values()]
		: [];
	return {
		acquisitionOptions: policy.acquisitionOptions,
		capability: policy.capability,
		capabilityEvidence: staticCapabilityEvidence(checkedAt),
		capabilityReason: policy.reason,
		catalogRef: `plugin:${plugin.manifest.pluginId}:${value.itemId}`,
		checkedAt,
		creators: Array.isArray(value.authors) ? value.authors.map((author) => boundedText(author, 300)).slice(0, 20) : [],
		edition: null,
		identifiers,
		itemId: value.itemId,
		language: typeof value.language === "string" ? boundedText(value.language, 80) : null,
		mediaKind: "book",
		metadataEvidence: [],
		pluginId: plugin.manifest.pluginId,
		provenance: policy.provenance,
		publishedYear: Number.isInteger(value.publishedYear) && value.publishedYear! >= 1 && value.publishedYear! <= 9999 ? value.publishedYear : null,
		source: boundedText(value.source, 120, plugin.manifest.displayName),
		title: boundedText(value.title, 500, "Untitled"),
	};
}

async function readCache(executor: SqlExecutor, pluginId: string, kind: CacheKind, key: string) {
	const result = await executor.query<CacheRow>(`
		select normalized_json, fetched_at, fresh_until, stale_until
		from plugin_cache
		where plugin_id = $1 and resource_kind = $2 and cache_key = $3
	`, [pluginId, kind, key]);
	return result.rows[0] ?? null;
}

async function writeCache(executor: SqlExecutor, pluginId: string, kind: CacheKind, key: string, value: unknown, now: Date) {
	const [freshFor, staleFor] = kind === "metadata" ? ["1 day", "7 days"] : ["5 minutes", "1 hour"];
	await executor.query(`
		insert into plugin_cache (plugin_id, resource_kind, cache_key, normalized_json, fetched_at, fresh_until, stale_until, last_accessed_at)
		values ($1, $2, $3, $4::jsonb, $5::timestamptz, $5::timestamptz + $6::interval, $5::timestamptz + $7::interval, $5::timestamptz)
		on conflict (plugin_id, resource_kind, cache_key)
		do update set normalized_json = excluded.normalized_json,
		              fetched_at = excluded.fetched_at,
		              fresh_until = excluded.fresh_until,
		              stale_until = excluded.stale_until,
		              last_accessed_at = excluded.last_accessed_at
	`, [pluginId, kind, key, JSON.stringify(value), now, freshFor, staleFor]);
}

function normalizedIdentityText(value: string) {
	return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function metadataContribution(result: Extract<PluginMetadataResult, { state: "matched" }>): CatalogMetadataEvidence {
	const names = [
		["title", "title"], ["subtitle", "subtitle"], ["creators", "creators"], ["publisher", "publisher"],
		["publishedDate", "published-date"], ["description", "description"], ["pageCount", "page-count"],
		["categories", "categories"], ["averageRating", "average-rating"], ["ratingsCount", "ratings-count"],
	] as const;
	const contributedFields = names.filter(([key]) => result.fields[key] !== undefined).map(([, name]) => name) as CatalogMetadataEvidence["contributedFields"];
	contributedFields.push("information-link");
	return {
		averageRating: result.fields.averageRating ?? null,
		checkedAt: result.checkedAt,
		contributedFields,
		informationLink: result.informationLink,
		matchedBy: result.matchedBy,
		matchQuality: result.matchQuality,
		mediaKind: "book",
		providerId: result.providerId,
		providerLabel: result.providerLabel,
		ratingsCount: result.fields.ratingsCount ?? null,
		recordId: result.recordId,
	};
}

function validatedMetadataResult(value: unknown): PluginMetadataResult {
	assertProtocolV2Envelope({
		protocolVersion: 2,
		invocationId: "00000000-0000-4000-8000-000000000000",
		capabilityId: "google-books/metadata",
		command: "metadata.enrich",
		ok: true,
		result: value,
	});
	const result = value as PluginMetadataResult;
	if (result.providerId !== "google-books" || result.providerLabel !== "Google Books" || result.mediaKind !== "book") throw new Error("metadata cache has invalid provider evidence");
	if (result.state === "matched") {
		const url = new URL(result.informationLink);
		if (url.protocol !== "https:" || url.hostname !== "books.google.com" || url.port || url.username || url.password) throw new Error("metadata cache has an invalid information link");
	}
	return result;
}

function withMetadata(item: CatalogItem, value: unknown) {
	const result = validatedMetadataResult(value);
	if (result.state === "no-match") return { ...item, metadataEvidence: [] };
	if (result.state !== "matched") throw new Error("metadata plugin returned an invalid result");
	return { ...item, metadataEvidence: [metadataContribution(result)] };
}

function staticPolicyCapabilityViews(checkedAt: string): PublicCapabilityView[] {
	return [
		{ capabilityId: "provider-policy/goodreads-reviews", displayName: "Goodreads reviews", evidence: policyEvidence(checkedAt), family: "provider-policy", installed: false, maturity: "policy-only", mediaKinds: ["book"], pluginId: null, providerAvailability: "unsupported", reason: "Goodreads has no supported new API integration and no scraping fallback.", reasonCode: "GOODREADS_API_UNAVAILABLE", version: 1 },
		{ capabilityId: "provider-policy/amazon-product-availability", displayName: "Amazon product availability", evidence: policyEvidence(checkedAt), family: "provider-policy", installed: false, maturity: "policy-only", mediaKinds: ["book"], pluginId: null, providerAvailability: "eligibility-required", reason: "Current Amazon Creators API eligibility and reviewed fixtures are required.", reasonCode: "AMAZON_CREATORS_ELIGIBILITY_REQUIRED", version: 1 },
		{ capabilityId: "provider-policy/kindle-unlimited", displayName: "Kindle Unlimited entitlement", evidence: policyEvidence(checkedAt), family: "provider-policy", installed: false, maturity: "policy-only", mediaKinds: ["book"], pluginId: null, providerAvailability: "not-exposed", reason: "No supported API exposes a trustworthy Kindle Unlimited entitlement signal.", reasonCode: "KINDLE_UNLIMITED_NOT_EXPOSED", version: 1 },
	];
}

export class PluginCatalogService {
	readonly installed: InstalledPlugin[];
	private readonly byId: Map<string, InstalledPlugin>;
	private readonly host: PluginHost;
	private readonly metadataPlugin: { capabilityId: string; plugin: InstalledPlugin } | null;

	constructor(private readonly database: Database, private readonly config: AppConfig, plugins?: InstalledPlugin[], host?: PluginHost) {
		this.installed = plugins ?? [...(config.installedPlugins ?? discoverPlugins(config.pluginRoots ?? { publicDirectory: resolve(findRepoRoot(), "plugins") }))];
		this.byId = new Map(this.installed.filter((plugin) => catalogRightsPolicy(plugin, config.publicPluginInventory).state !== "blocked").map((plugin) => [plugin.manifest.pluginId, plugin]));
		this.host = host ?? new PluginHost(config.userAgent, config.publicPluginInventory);
		const metadataPlugins = this.installed.flatMap((plugin) => {
			const capability = googleBooksMetadataCapability(plugin);
			return capability ? [{ capabilityId: capability.capabilityId, plugin }] : [];
		});
		this.metadataPlugin = metadataPlugins.length === 1 ? metadataPlugins[0]! : null;
	}

	private cacheKey(kind: "detail" | "search", value: string) {
		return hmacSha256Hex(this.config.sourceHashSecret, `plugin:${kind}:${value}`);
	}

	private sourceCacheValue(plugin: InstalledPlugin, value: string) {
		const capability = catalogRightsPolicy(plugin, this.config.publicPluginInventory).catalogCapability;
		if (!capability) throw new Error("plugin book catalog capability is unavailable");
		return `${plugin.digest}:${capability.capabilityId}:${value}`;
	}

	private metadataCacheKey(item: CatalogItem, plugin: InstalledPlugin, capabilityId: string) {
		const identity = JSON.stringify({
			creators: item.creators.map(normalizedIdentityText),
			identifiers: item.identifiers.map((identifier) => `${identifier.scheme}:${identifier.value}`).sort(),
			mediaKind: item.mediaKind,
			title: normalizedIdentityText(item.title),
		});
		return hmacSha256Hex(this.config.sourceHashSecret, `plugin:metadata:${plugin.digest}:${capabilityId}:${identity}`);
	}

	private metadataReady() {
		return this.metadataPlugin
			&& pluginDigestIsCurrent(this.metadataPlugin.plugin)
			&& this.config.applicationSecrets?.hasGoogleBooksApiKey()
			? this.metadataPlugin
			: null;
	}

	private invokeMetadata(item: CatalogItem, plugin: InstalledPlugin, capabilityId: string) {
		const invocation = this.config.applicationSecrets?.withGoogleBooksApiKey((value) => this.host.invokeCapability<PluginMetadataResult>(plugin, {
			authorization: { kind: "api-key", value },
			capabilityId,
			command: "metadata.enrich",
			input: { mediaKind: "book", item: { creators: item.creators, identifiers: item.identifiers, title: item.title } },
		}));
		if (!invocation) throw new Error("Google Books configuration is required");
		return invocation;
	}

	private async enrichItem(item: CatalogItem, now: Date, metadata: { capabilityId: string; plugin: InstalledPlugin }): Promise<MetadataOutcome> {
		const key = this.metadataCacheKey(item, metadata.plugin, metadata.capabilityId);
		if (!pluginDigestIsCurrent(metadata.plugin)) return { checkedAt: now.toISOString(), failed: true, item, origin: "live" };
		const cached = await readCache(this.database, metadata.plugin.manifest.pluginId, "metadata", key);
		if (cached && cached.fresh_until > now) {
			const result = cached.normalized_json as PluginMetadataResult;
			return { checkedAt: result.checkedAt, failed: false, item: withMetadata(item, result), origin: "fresh-cache" };
		}
		try {
			const result = await this.invokeMetadata(item, metadata.plugin, metadata.capabilityId);
			await writeCache(this.database, metadata.plugin.manifest.pluginId, "metadata", key, result, now);
			return { checkedAt: result.checkedAt, failed: false, item: withMetadata(item, result), origin: "live" };
		} catch {
			if (cached && cached.stale_until > now) {
				try {
					const result = cached.normalized_json as PluginMetadataResult;
					return { checkedAt: result.checkedAt, failed: true, item: withMetadata(item, result), origin: "stale-cache" };
				} catch {
					// Invalid cached metadata is never served.
				}
			}
			return { checkedAt: now.toISOString(), failed: true, item, origin: "live" };
		}
	}

	private sourceProviderView(status: SourceProviderStatus): PublicCapabilityView {
		const capability = status.decision.catalogCapability!;
		return {
			capabilityId: capability.capabilityId,
			displayName: status.displayName,
			evidence: { checkedAt: status.checkedAt, freshness: status.freshness, scope: { id: null, kind: "public-catalog" }, sourceId: status.plugin.manifest.pluginId, sourceKind: status.sourceKind, sourceLabel: status.displayName },
			family: "catalog-source",
			installed: true,
			maturity: "stable",
			mediaKinds: ["book"],
			pluginId: status.plugin.manifest.pluginId,
			provenance: status.decision.provenance,
			providerAvailability: status.support,
			reason: status.reason ?? status.decision.reason,
			reasonCode: status.support === "available" ? status.decision.reasonCode : "INSTALLED_PLUGIN_UNAVAILABLE",
			version: capability.version,
		};
	}

	private metadataProviderView(now: Date, outcomes: MetadataOutcome[]): PublicCapabilityView {
		const metadata = this.metadataPlugin;
		const configured = this.metadataReady() !== null;
		const failure = outcomes.find((outcome) => outcome.failed && outcome.origin === "stale-cache")
			?? outcomes.find((outcome) => outcome.failed);
		const successful = outcomes.find((outcome) => !outcome.failed);
		const unavailable = configured && failure !== undefined;
		const evidenceOutcome = failure ?? successful;
		const sourceKind = evidenceOutcome?.origin === "live" ? "live-api" as const
			: evidenceOutcome ? "cached-api" as const : "static-policy" as const;
		return {
			capabilityId: "google-books/metadata",
			displayName: "Google Books metadata",
			evidence: {
				checkedAt: evidenceOutcome?.checkedAt ?? now.toISOString(),
				freshness: evidenceOutcome?.origin === "stale-cache" ? "stale" : "fresh",
				scope: { id: null, kind: "public-catalog" },
				sourceId: "google-books",
				sourceKind,
				sourceLabel: "Google Books",
			},
			family: "metadata-enricher",
			installed: metadata !== null,
			maturity: "stable",
			mediaKinds: ["book"],
			pluginId: "google-books",
			providerAvailability: unavailable ? "unavailable" : configured ? "available" : "configuration-required",
			reason: unavailable
				? "Google Books did not complete the current metadata request."
				: configured ? "Configured Google Books metadata enrichment is available." : "Install the reviewed Google Books plugin and configure its deployment API key.",
			reasonCode: unavailable ? "PROVIDER_REQUEST_FAILED" : configured ? "PROVIDER_AVAILABLE" : "CONNECTOR_CONFIGURATION_REQUIRED",
			version: metadata ? googleBooksMetadataCapability(metadata.plugin)?.version ?? 1 : 1,
		};
	}

	private plugin(pluginId: string) {
		const plugin = this.byId.get(pluginId);
		if (!plugin) throw new ProblemError(404, "plugin_not_found", "Plugin not found");
		return plugin;
	}

	async listInstalledPlugins(): Promise<ProfilePluginView[]> {
		const checkedAt = new Date().toISOString();
		return this.installed.flatMap((plugin) => {
			const decision = catalogRightsPolicy(plugin, this.config.publicPluginInventory);
			if (decision.state === "blocked" || !decision.catalogCapability) return [];
			const current = pluginDigestIsCurrent(plugin);
			const capabilities = legacyCatalogCapabilities(decision.catalogCapability).filter((capability) => capability !== "acquire" || decision.effectAuthorized);
			return [{ capabilities, checkedAt, displayName: plugin.manifest.displayName, installed: true as const, pluginId: plugin.manifest.pluginId, provenance: decision.provenance, reason: current ? decision.reason : "Installed plugin changed after discovery.", reasonCode: current ? decision.reasonCode : "PLUGIN_INTEGRITY_FAILED", rightsBasis: decision.effectAuthorized ? "public-domain" as const : null, support: current ? "available" as const : "unavailable" as const, version: plugin.manifest.version }];
		});
	}

	async search(profileId: string, query: string) {
		if (query.length < 2 || query.length > 200) throw new ProblemError(400, "validation_failed", "Validation failed", "Search query must be between 2 and 200 characters.");
		const enabled = [...this.byId.values()];
		const searchedAt = new Date();
		const pluginStatuses: SourceProviderStatus[] = [];
		const allItems: CatalogItem[] = [];
		for (const plugin of enabled) {
			const decision = catalogRightsPolicy(plugin, this.config.publicPluginInventory);
			if (decision.state === "blocked") {
				pluginStatuses.push({ checkedAt: searchedAt.toISOString(), decision, displayName: plugin.manifest.displayName, freshness: "fresh", plugin, reason: decision.reason, sourceKind: "live-api", support: "unavailable" });
				continue;
			}
			const key = this.cacheKey("search", this.sourceCacheValue(plugin, query));
			const cached = await readCache(this.database, plugin.manifest.pluginId, "search", key);
			try {
				let result: PluginSearchResult;
				let sourceKind: "cached-api" | "live-api";
				if (cached && cached.fresh_until > searchedAt) {
					result = cached.normalized_json as PluginSearchResult;
					sourceKind = "cached-api";
				}
				else {
					result = await this.host.search(plugin, query);
					await writeCache(this.database, plugin.manifest.pluginId, "search", key, result, searchedAt);
					sourceKind = "live-api";
				}
				allItems.push(...result.items.map((item) => normalizeItem(plugin, this.config.publicPluginInventory, item)));
				pluginStatuses.push({ checkedAt: searchedAt.toISOString(), decision, displayName: plugin.manifest.displayName, freshness: "fresh", plugin, reason: null, sourceKind, support: "available" });
			} catch (error) {
				if (cached && cached.stale_until > searchedAt) {
					const result = cached.normalized_json as PluginSearchResult;
					allItems.push(...result.items.map((item) => normalizeItem(plugin, this.config.publicPluginInventory, item)));
					pluginStatuses.push({ checkedAt: searchedAt.toISOString(), decision, displayName: plugin.manifest.displayName, freshness: "stale", plugin, reason: "Live source unavailable; cached results shown.", sourceKind: "cached-api", support: "available" });
				} else pluginStatuses.push({ checkedAt: searchedAt.toISOString(), decision, displayName: plugin.manifest.displayName, freshness: "fresh", plugin, reason: process.env.NODE_ENV === "test" && error instanceof Error ? error.message : "Plugin did not return usable results.", sourceKind: "live-api", support: "unavailable" });
			}
		}
		if (pluginStatuses.length > 0 && pluginStatuses.every((status) => status.support === "unavailable")) throw new ProblemError(503, "all_plugins_failed", "Search is unavailable");
		const finalItems = allItems.slice(0, 24);
		const metadata = this.metadataReady();
		const outcomes: MetadataOutcome[] = [];
		if (metadata) {
			for (let offset = 0; offset < finalItems.length; offset += 4) {
				outcomes.push(...await Promise.all(finalItems.slice(offset, offset + 4).map((item) => this.enrichItem(item, searchedAt, metadata))));
			}
		}
		const items = metadata ? outcomes.map((outcome) => outcome.item) : finalItems;
		const providers = [
			...pluginStatuses.map((status) => this.sourceProviderView(status)),
			this.metadataProviderView(searchedAt, outcomes),
			...staticPolicyCapabilityViews(searchedAt.toISOString()),
		];
		return {
			items,
			mediaKind: "book" as const,
			partial: pluginStatuses.some((status) => status.support === "unavailable") || outcomes.some((outcome) => outcome.failed),
			providers,
			query,
			searchedAt: searchedAt.toISOString(),
		};
	}

	async detail(profileId: string, catalogRef: string) {
		const match = catalogRef.match(CATALOG_REF);
		if (!match) throw new ProblemError(404, "not_found", "Not found");
		const plugin = this.plugin(match[1]!);
		if (catalogRightsPolicy(plugin, this.config.publicPluginInventory).state === "blocked") throw new ProblemError(503, "plugin_integrity_failed", "Plugin is unavailable");
		const itemId = match[2]!;
		const now = new Date();
		const key = this.cacheKey("detail", this.sourceCacheValue(plugin, itemId));
		const cached = await readCache(this.database, plugin.manifest.pluginId, "detail", key);
		let item: CatalogItem;
		if (cached && cached.fresh_until > now) item = normalizeItem(plugin, this.config.publicPluginInventory, cached.normalized_json as PluginCatalogItem);
		else try {
			const value = await this.host.detail(plugin, itemId);
			await writeCache(this.database, plugin.manifest.pluginId, "detail", key, value, now);
			item = normalizeItem(plugin, this.config.publicPluginInventory, value);
		} catch (error) {
			if (cached && cached.stale_until > now) item = normalizeItem(plugin, this.config.publicPluginInventory, cached.normalized_json as PluginCatalogItem);
			else throw error;
		}
		const metadata = this.metadataReady();
		if (!metadata) return item;
		try {
			return (await this.enrichItem(item, now, metadata)).item;
		} catch {
			return item;
		}
	}

	async detailForEffect(profileId: string, catalogRef: string) {
		const match = catalogRef.match(CATALOG_REF);
		if (!match) throw new ProblemError(404, "not_found", "Not found");
		const plugin = this.plugin(match[1]!);
		if (catalogRightsPolicy(plugin, this.config.publicPluginInventory).state === "blocked") throw new ProblemError(503, "plugin_integrity_failed", "Plugin is unavailable");
		const value = await this.host.detail(plugin, match[2]!);
		return normalizeItem(plugin, this.config.publicPluginInventory, value);
	}
}