import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationSecrets } from "../../src/modules/common/application-secrets";
import type { AppConfig } from "../../src/modules/config";
import { hmacSha256Hex } from "../../src/modules/common/crypto";
import { createDatabase, type Database } from "../../src/modules/db/database";
import { migrate } from "../../src/modules/db/migrator";
import { PluginCatalogService } from "../../src/modules/plugins/catalog";
import { discoverPlugins } from "../../src/modules/plugins/manifests";
import { loadReviewedPublicInventory } from "../../src/modules/plugins/public-inventory";
import { startPostgresHarness, type PostgresHarness } from "./helpers/postgres";

describe("profile plugin catalog", () => {
	let config: AppConfig;
	let database: Database;
	let harness: PostgresHarness;
	const temporaryRoots: string[] = [];
	const installedPlugins = discoverPlugins("plugins");
	const publicPluginInventory = loadReviewedPublicInventory("plugins", installedPlugins);
	const member1ProfileId = "00000000-0000-4000-8000-000000000001";
	const member2ProfileId = "00000000-0000-4000-8000-000000000002";

	beforeEach(async () => {
		harness = await startPostgresHarness();
		config = {
			allowedPrivateClientCidrs: [], allowMigrationDown: true, databaseUrl: harness.connectionString,
			installedPlugins,
			outboundContact: "test@example.invalid",
			pinPepper: "pepper", pinReuseSecret: "reuse", pluginRoots: { publicDirectory: "plugins" }, port: 3000,
			publicPluginInventory,
			publicOrigin: new URL("https://k.example.invalid"), sessionSigningKey: "session",
			sourceHashSecret: "source", trustedProxyCidrs: [], userAgent: "k-test",
		};
		database = createDatabase(config);
		await migrate(database, { allowDown: true });
	});

	afterEach(async () => {
		await database.close();
		await harness.stop();
		await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
	});

	it("lists all installed plugins as deployment-active read-only sources", async () => {
		const service = new PluginCatalogService(database, config);
		const plugins = await service.listInstalledPlugins();
		expect(plugins.map((plugin) => plugin.pluginId)).toEqual(["internet-archive", "project-gutenberg", "standard-ebooks"]);
		expect(plugins.every((plugin) => plugin.installed && plugin.support === "available")).toBe(true);
	});

	it("searches and caches installed plugins while preserving profile-independent source data", async () => {
		const plugin = discoverPlugins("plugins").find((candidate) => candidate.manifest.pluginId === "project-gutenberg")!;
		const item = { acquisitionOptions: [], authors: ["Jane Austen"], capability: "candidate" as const, capabilityReason: "public domain", checkedAt: new Date().toISOString(), itemId: "1342", language: "en", pluginId: "project-gutenberg", publishedYear: 1813, source: "Project Gutenberg", title: "Pride and Prejudice" };
		const host = {
			detail: vi.fn(async () => ({ ...item, acquisitionOptions: [{ estimatedBytes: 1000, format: "epub" as const, optionId: "epub3-images", rightsBasis: "public-domain" as const }] })),
			search: vi.fn(async (_plugin, query: string) => ({ items: [item], query, searchedAt: new Date().toISOString() })),
		} as never;
		const service = new PluginCatalogService(database, config, [plugin], host);
		const first = await service.search(member1ProfileId, "pride");
		const second = await service.search(member1ProfileId, "pride");
		expect(first.items[0]).toMatchObject({ catalogRef: "plugin:project-gutenberg:1342", title: "Pride and Prejudice" });
		expect(second.items).toEqual(first.items);
		expect((host as { search: ReturnType<typeof vi.fn> }).search).toHaveBeenCalledTimes(1);
		await expect(service.detail(member2ProfileId, "plugin:project-gutenberg:1342")).resolves.toMatchObject({ title: "Pride and Prejudice" });
	});

	it("keeps Google Books configuration-required when the optional key is missing", async () => {
		const plugins = discoverPlugins("plugins");
		const source = plugins.find((candidate) => candidate.manifest.pluginId === "project-gutenberg")!;
		const metadata = plugins.find((candidate) => candidate.manifest.pluginId === "google-books")!;
		const item = { acquisitionOptions: [], authors: ["Jane Austen"], capability: "candidate" as const, capabilityReason: "public domain", checkedAt: new Date().toISOString(), itemId: "1342", language: "en", pluginId: "project-gutenberg", publishedYear: 1813, source: "Project Gutenberg", title: "Pride and Prejudice" };
		const invokeCapability = vi.fn();
		const host = { invokeCapability, search: vi.fn(async (_plugin, query: string) => ({ items: [item], query, searchedAt: new Date().toISOString() })) } as never;
		const result = await new PluginCatalogService(database, config, [source, metadata], host).search(member1ProfileId, "pride");
		expect(result.partial).toBe(false);
		expect(result.items[0]).toMatchObject({ creators: ["Jane Austen"], identifiers: [], mediaKind: "book", metadataEvidence: [] });
		expect(result.items[0]?.capabilityEvidence.map((evidence) => [evidence.capability, evidence.state])).toEqual([
			["reviews", "unsupported"],
			["product-availability", "eligibility-required"],
			["kindle-unlimited", "not-exposed"],
		]);
		expect(result.providers.find((provider) => provider.capabilityId === "google-books/metadata")).toMatchObject({ providerAvailability: "configuration-required", reasonCode: "CONNECTOR_CONFIGURATION_REQUIRED" });
		expect(invokeCapability).not.toHaveBeenCalled();
	});

	it("attaches exact metadata, preserves rights, and caches by digest, capability, and normalized identity", async () => {
		config.applicationSecrets = ApplicationSecrets.fromGoogleBooksApiKey("configured-google-books-key");
		const plugins = discoverPlugins("plugins");
		const source = plugins.find((candidate) => candidate.manifest.pluginId === "project-gutenberg")!;
		const metadata = plugins.find((candidate) => candidate.manifest.pluginId === "google-books")!;
		const item = {
			acquisitionOptions: [{ estimatedBytes: 1000, format: "epub" as const, optionId: "epub", rightsBasis: "public-domain" as const }],
			authors: ["Jane   Austen"], capability: "candidate" as const, capabilityReason: "public domain", checkedAt: new Date().toISOString(),
			identifiers: [{ scheme: "isbn-13" as const, value: "978-1-4028-9462-6" }], itemId: "1342", language: "en", pluginId: "project-gutenberg", publishedYear: 1813, source: "Project Gutenberg", title: "Pride and  Prejudice",
		};
		const invokeCapability = vi.fn(async () => ({
			checkedAt: "2026-07-18T16:00:00.000Z", fields: { averageRating: 4.5, ratingsCount: 42, title: "Pride and Prejudice" }, informationLink: "https://books.google.com/books?id=record_1", matchedBy: "isbn-13", matchQuality: "exact-identifier", mediaKind: "book", providerId: "google-books", providerLabel: "Google Books", recordId: "record_1", state: "matched",
		}));
		const host = {
			detail: vi.fn(async () => item),
			invokeCapability,
			search: vi.fn(async (_plugin, query: string) => ({ items: [item], query, searchedAt: new Date().toISOString() })),
		} as never;
		const service = new PluginCatalogService(database, config, [source, metadata], host);
		const first = await service.search(member1ProfileId, "pride");
		const second = await service.search(member2ProfileId, "pride");
		const detail = await service.detail(member1ProfileId, "plugin:project-gutenberg:1342");
		expect(first.items[0]).toMatchObject({
			acquisitionOptions: [{ optionId: "epub", rightsBasis: "public-domain" }],
			capability: "candidate",
			metadataEvidence: [{ averageRating: 4.5, contributedFields: ["title", "average-rating", "ratings-count", "information-link"], ratingsCount: 42, recordId: "record_1" }],
		});
		expect(second.items[0]?.metadataEvidence).toEqual(first.items[0]?.metadataEvidence);
		expect(detail.metadataEvidence).toEqual(first.items[0]?.metadataEvidence);
		expect(invokeCapability).toHaveBeenCalledTimes(1);
		expect(invokeCapability.mock.calls[0]![2]).toBeUndefined();
		const identity = JSON.stringify({ creators: ["jane austen"], identifiers: ["isbn-13:9781402894626"], mediaKind: "book", title: "pride and prejudice" });
		const cache = await database.query<{ cache_key: string; fresh_seconds: string; stale_seconds: string }>(`
			select cache_key,
			       extract(epoch from fresh_until - fetched_at)::text as fresh_seconds,
			       extract(epoch from stale_until - fetched_at)::text as stale_seconds
			from plugin_cache where plugin_id = 'google-books' and resource_kind = 'metadata'
		`);
		expect(cache.rows).toHaveLength(1);
		expect(cache.rows[0]!.cache_key).toBe(hmacSha256Hex(config.sourceHashSecret, `plugin:metadata:${metadata.digest}:google-books/metadata:${identity}`));
		expect(Number(cache.rows[0]!.fresh_seconds)).toBe(86400);
		expect(Number(cache.rows[0]!.stale_seconds)).toBe(604800);
	});

	it("caches exact no-match results without making static policy rows partial", async () => {
		config.applicationSecrets = ApplicationSecrets.fromGoogleBooksApiKey("configured-google-books-key");
		const plugins = discoverPlugins("plugins");
		const source = plugins.find((candidate) => candidate.manifest.pluginId === "project-gutenberg")!;
		const metadata = plugins.find((candidate) => candidate.manifest.pluginId === "google-books")!;
		const item = { acquisitionOptions: [], authors: ["Unknown Author"], capability: "candidate" as const, capabilityReason: "public domain", checkedAt: new Date().toISOString(), itemId: "no-match", language: "en", pluginId: "project-gutenberg", publishedYear: 1900, source: "Project Gutenberg", title: "Unknown Book" };
		const invokeCapability = vi.fn(async () => ({ checkedAt: "2026-07-18T16:00:00.000Z", mediaKind: "book", providerId: "google-books", providerLabel: "Google Books", reasonCode: "NO_EXACT_MATCH", state: "no-match" }));
		const host = { invokeCapability, search: vi.fn(async (_plugin, query: string) => ({ items: [item], query, searchedAt: new Date().toISOString() })) } as never;
		const service = new PluginCatalogService(database, config, [source, metadata], host);
		const first = await service.search(member1ProfileId, "unknown");
		const second = await service.search(member1ProfileId, "unknown");
		expect(first.items[0]?.metadataEvidence).toEqual([]);
		expect(second.partial).toBe(false);
		expect(invokeCapability).toHaveBeenCalledTimes(1);
		const cached = await database.query<{ state: string }>("select normalized_json->>'state' as state from plugin_cache where resource_kind = 'metadata'");
		expect(cached.rows).toEqual([{ state: "no-match" }]);
	});

	it("uses a stale match with stale unavailable evidence when a configured live request fails", async () => {
		config.applicationSecrets = ApplicationSecrets.fromGoogleBooksApiKey("configured-google-books-key");
		const plugins = discoverPlugins("plugins");
		const source = plugins.find((candidate) => candidate.manifest.pluginId === "project-gutenberg")!;
		const metadata = plugins.find((candidate) => candidate.manifest.pluginId === "google-books")!;
		const item = { acquisitionOptions: [], authors: ["Jane Austen"], capability: "candidate" as const, capabilityReason: "public domain", checkedAt: new Date().toISOString(), itemId: "1342", language: "en", pluginId: "project-gutenberg", publishedYear: 1813, source: "Project Gutenberg", title: "Pride and Prejudice" };
		const matched = { checkedAt: "2026-07-17T16:00:00.000Z", fields: { averageRating: 4.25 }, informationLink: "https://books.google.com/books?id=stale", matchedBy: "title-creator", matchQuality: "exact-title-creator", mediaKind: "book", providerId: "google-books", providerLabel: "Google Books", recordId: "stale", state: "matched" };
		const invokeCapability = vi.fn().mockResolvedValueOnce(matched).mockRejectedValueOnce(new Error("provider unavailable"));
		const host = { invokeCapability, search: vi.fn(async (_plugin, query: string) => ({ items: [item], query, searchedAt: new Date().toISOString() })) } as never;
		const service = new PluginCatalogService(database, config, [source, metadata], host);
		await service.search(member1ProfileId, "pride");
		await database.query("update plugin_cache set fetched_at = now() - interval '2 days', fresh_until = now() - interval '1 day', stale_until = now() + interval '5 days' where resource_kind = 'metadata'");
		const result = await service.search(member1ProfileId, "pride");
		const provider = result.providers.find((candidate) => candidate.capabilityId === "google-books/metadata");
		expect(result.partial).toBe(true);
		expect(result.items[0]?.metadataEvidence).toEqual([expect.objectContaining({ checkedAt: matched.checkedAt, recordId: "stale" })]);
		expect(provider).toMatchObject({ providerAvailability: "unavailable", reasonCode: "PROVIDER_REQUEST_FAILED", evidence: { freshness: "stale", sourceKind: "cached-api" } });
		expect(result.items[0]).toMatchObject({
			acquisitionOptions: [],
			capability: "candidate",
			capabilityReason: "Core policy verified the reviewed public-domain source and current plugin digest.",
			provenance: "verified-public-domain",
		});
	});

	it("keeps source results on a configured metadata failure without stale evidence", async () => {
		config.applicationSecrets = ApplicationSecrets.fromGoogleBooksApiKey("configured-google-books-key");
		const plugins = discoverPlugins("plugins");
		const source = plugins.find((candidate) => candidate.manifest.pluginId === "project-gutenberg")!;
		const metadata = plugins.find((candidate) => candidate.manifest.pluginId === "google-books")!;
		const item = { acquisitionOptions: [], authors: ["Jane Austen"], capability: "candidate" as const, capabilityReason: "public domain", checkedAt: new Date().toISOString(), itemId: "1342", language: "en", pluginId: "project-gutenberg", publishedYear: 1813, source: "Project Gutenberg", title: "Pride and Prejudice" };
		const host = { invokeCapability: vi.fn(async () => { throw new Error("provider unavailable"); }), search: vi.fn(async (_plugin, query: string) => ({ items: [item], query, searchedAt: new Date().toISOString() })) } as never;
		const result = await new PluginCatalogService(database, config, [source, metadata], host).search(member1ProfileId, "pride");
		expect(result).toMatchObject({ items: [expect.objectContaining({ metadataEvidence: [], title: "Pride and Prejudice" })], partial: true });
		expect(result.providers.find((provider) => provider.capabilityId === "google-books/metadata")).toMatchObject({ providerAvailability: "unavailable" });
		const detailHost = { detail: vi.fn(async () => item), invokeCapability: vi.fn(async () => { throw new Error("provider unavailable"); }) } as never;
		await expect(new PluginCatalogService(database, config, [source, metadata], detailHost).detail(member1ProfileId, "plugin:project-gutenberg:1342")).resolves.toMatchObject({ metadataEvidence: [], title: "Pride and Prejudice" });
	});

	it("enriches only the final bounded 24 source results", async () => {
		config.applicationSecrets = ApplicationSecrets.fromGoogleBooksApiKey("configured-google-books-key");
		const plugins = discoverPlugins("plugins");
		const source = plugins.find((candidate) => candidate.manifest.pluginId === "project-gutenberg")!;
		const metadata = plugins.find((candidate) => candidate.manifest.pluginId === "google-books")!;
		const items = Array.from({ length: 25 }, (_, index) => ({ acquisitionOptions: [], authors: ["Author"], capability: "candidate" as const, capabilityReason: "public domain", checkedAt: new Date().toISOString(), itemId: `book-${index}`, language: "en", pluginId: "project-gutenberg", publishedYear: 1900, source: "Project Gutenberg", title: `Book ${index}` }));
		const invokeCapability = vi.fn(async () => ({ checkedAt: "2026-07-18T16:00:00.000Z", mediaKind: "book", providerId: "google-books", providerLabel: "Google Books", reasonCode: "NO_EXACT_MATCH", state: "no-match" }));
		const host = { invokeCapability, search: vi.fn(async (_plugin, query: string) => ({ items, query, searchedAt: new Date().toISOString() })) } as never;
		const result = await new PluginCatalogService(database, config, [source, metadata], host).search(member1ProfileId, "books");
		expect(result.items).toHaveLength(24);
		expect(invokeCapability).toHaveBeenCalledTimes(24);
		expect(invokeCapability.mock.calls.some((call) => call[1].input.item.title === "Book 24")).toBe(false);
	});

	it("does not serve metadata cache entries after the discovered metadata plugin digest changes", async () => {
		config.applicationSecrets = ApplicationSecrets.fromGoogleBooksApiKey("configured-google-books-key");
		const source = discoverPlugins("plugins").find((candidate) => candidate.manifest.pluginId === "project-gutenberg")!;
		const root = await mkdtemp(join(tmpdir(), "k-google-books-digest-test-"));
		temporaryRoots.push(root);
		await mkdir(join(root, "google-books"));
		await mkdir(join(root, "lib"));
		await writeFile(join(root, "google-books/plugin.json"), await readFile("plugins/google-books/plugin.json"));
		await writeFile(join(root, "google-books/index.mjs"), await readFile("plugins/google-books/index.mjs"));
		await writeFile(join(root, "lib/runtime.mjs"), await readFile("plugins/lib/runtime.mjs"));
		const metadata = discoverPlugins(root)[0]!;
		const item = { acquisitionOptions: [], authors: ["Jane Austen"], capability: "candidate" as const, capabilityReason: "public domain", checkedAt: new Date().toISOString(), itemId: "1342", language: "en", pluginId: "project-gutenberg", publishedYear: 1813, source: "Project Gutenberg", title: "Pride and Prejudice" };
		const invokeCapability = vi.fn(async () => ({ checkedAt: "2026-07-18T16:00:00.000Z", fields: { title: "Pride and Prejudice" }, informationLink: "https://books.google.com/books?id=cached", matchedBy: "title-creator", matchQuality: "exact-title-creator", mediaKind: "book", providerId: "google-books", providerLabel: "Google Books", recordId: "cached", state: "matched" }));
		const host = { invokeCapability, search: vi.fn(async (_plugin, query: string) => ({ items: [item], query, searchedAt: new Date().toISOString() })) } as never;
		const service = new PluginCatalogService(database, config, [source, metadata], host);
		expect((await service.search(member1ProfileId, "pride")).items[0]?.metadataEvidence).toHaveLength(1);
		await writeFile(metadata.entrypointPath, `${await readFile(metadata.entrypointPath, "utf8")}\n`);
		const changed = await service.search(member1ProfileId, "pride");
		expect(changed.items[0]?.metadataEvidence).toEqual([]);
		expect(changed.providers.find((provider) => provider.capabilityId === "google-books/metadata")).toMatchObject({ providerAvailability: "configuration-required" });
		expect(invokeCapability).toHaveBeenCalledTimes(1);
	});

	it("searches only public-domain book catalog capabilities and scopes v2 cache identity", async () => {
		const root = await mkdtemp(join(tmpdir(), "k-capability-catalog-test-"));
		temporaryRoots.push(root);
		const manifests = [
			{
				schemaVersion: 2, protocolVersion: 2, pluginId: "book-source-v2", displayName: "Book Source V2", version: "1.0.0", entrypoint: "index.mjs",
				runtime: { allowedHosts: ["books.example.invalid"], timeoutMs: 3000, maxRequestBytes: 4096, maxResponseBytes: 4096, maxArtifactBytes: 1024 },
				capabilities: [{ capabilityId: "book-source-v2/books", family: "catalog-source", version: 1, commands: ["catalog.search", "catalog.detail", "catalog.acquire"], authorization: { kind: "none" }, mediaKinds: ["book"], rightsBases: ["public-domain"] }],
				review: { policyRef: "docs/providers/policy.md", reviewedAt: "2026-07-18" },
			},
			{
				schemaVersion: 2, protocolVersion: 2, pluginId: "book-source-ambiguous-v2", displayName: "Ambiguous Book Source V2", version: "1.0.0", entrypoint: "index.mjs",
				runtime: { allowedHosts: ["ambiguous.example.invalid"], timeoutMs: 3000, maxRequestBytes: 4096, maxResponseBytes: 4096, maxArtifactBytes: 1024 },
				capabilities: ["primary", "secondary"].map((name) => ({ capabilityId: `book-source-ambiguous-v2/${name}`, family: "catalog-source", version: 1, commands: ["catalog.search", "catalog.detail", "catalog.acquire"], authorization: { kind: "none" }, mediaKinds: ["book"], rightsBases: ["public-domain"] })),
				review: { policyRef: "docs/providers/policy.md", reviewedAt: "2026-07-18" },
			},
			{
				schemaVersion: 2, protocolVersion: 2, pluginId: "movie-source-v2", displayName: "Movie Source V2", version: "1.0.0", entrypoint: "index.mjs",
				runtime: { allowedHosts: ["movies.example.invalid"], timeoutMs: 3000, maxRequestBytes: 4096, maxResponseBytes: 4096, maxArtifactBytes: 1024 },
				capabilities: [{ capabilityId: "movie-source-v2/movies", family: "catalog-source", version: 1, commands: ["catalog.search", "catalog.detail", "catalog.acquire"], authorization: { kind: "none" }, mediaKinds: ["movie"], rightsBases: ["public-domain"] }],
				review: { policyRef: "docs/providers/policy.md", reviewedAt: "2026-07-18" },
			},
			JSON.parse(await readFile("tests/fixtures/plugins/google-books.v2.json", "utf8")),
			JSON.parse(await readFile("tests/fixtures/plugins/login-with-amazon.v2.json", "utf8")),
			JSON.parse(await readFile("tests/fixtures/plugins/google-gmail.v2.json", "utf8")),
			JSON.parse(await readFile("tests/fixtures/plugins/microsoft-onedrive.v2.json", "utf8")),
		];
		for (const manifest of manifests) {
			const pluginDirectory = join(root, manifest.pluginId);
			await mkdir(pluginDirectory);
			await writeFile(join(pluginDirectory, "plugin.json"), JSON.stringify(manifest));
			await writeFile(join(pluginDirectory, "index.mjs"), "process.stdout.write('{}\\n');");
		}
		const plugins = discoverPlugins(root);
		const item = { acquisitionOptions: [], authors: ["Author"], capability: "candidate" as const, capabilityReason: "public domain", checkedAt: new Date().toISOString(), itemId: "book-1", language: "en", pluginId: "book-source-v2", publishedYear: 1900, source: "Book Source V2", title: "A Book" };
		const host = { search: vi.fn(async (_plugin, query: string) => ({ items: [item], query, searchedAt: new Date().toISOString() })) } as never;
		const service = new PluginCatalogService(database, config, plugins, host);

		await expect(service.listInstalledPlugins()).resolves.toEqual([
			expect.objectContaining({ capabilities: ["search", "detail"], pluginId: "book-source-v2", provenance: "unverified-provenance", reasonCode: "UNVERIFIED_PROVENANCE", rightsBasis: null, support: "available" }),
		]);
		await expect(service.search(member1ProfileId, "foundation")).resolves.toMatchObject({ items: [expect.objectContaining({ acquisitionOptions: [], capability: "metadata-only", catalogRef: "plugin:book-source-v2:book-1", provenance: "unverified-provenance" })] });
		const search = (host as { search: ReturnType<typeof vi.fn> }).search;
		expect(search).toHaveBeenCalledTimes(1);
		expect(search.mock.calls[0]![0].manifest.pluginId).toBe("book-source-v2");
		await expect(service.detail(member1ProfileId, "plugin:book-source-ambiguous-v2:book-1")).rejects.toMatchObject({ code: "plugin_not_found", status: 404 });
		const source = plugins.find((plugin) => plugin.manifest.pluginId === "book-source-v2")!;
		const cache = await database.query<{ cache_key: string }>("select cache_key from plugin_cache where plugin_id = $1", ["book-source-v2"]);
		expect(cache.rows).toEqual([{ cache_key: hmacSha256Hex(config.sourceHashSecret, `plugin:search:${source.digest}:book-source-v2/books:foundation`) }]);
	});

	it("normalizes an unverified process to metadata-only and rejects acquisition options", async () => {
		const root = await mkdtemp(join(tmpdir(), "k-unverified-catalog-test-"));
		temporaryRoots.push(root);
		const pluginDirectory = join(root, "unverified-book-source");
		await mkdir(pluginDirectory);
		await writeFile(join(pluginDirectory, "plugin.json"), await readFile("tests/fixtures/plugins/unverified-book-source.v2.json"));
		await writeFile(join(pluginDirectory, "index.mjs"), `
			let source = ""; for await (const chunk of process.stdin) source += chunk;
			const request = JSON.parse(source);
			const item = {
				acquisitionOptions: request.command === "catalog.detail" || request.input.query === "forged" ? [{ estimatedBytes: 100, format: "epub", optionId: "forged", rightsBasis: "public-domain" }] : [],
				authors: ["Fixture Author"], capability: "deliverable", capabilityReason: "Plugin claims verified public-domain rights",
				checkedAt: "2026-07-19T00:00:00.000Z", itemId: "fixture-book", language: "en", pluginId: "unverified-book-source",
				publishedYear: 1900, source: "Unverified Book Source", title: "Fixture Book"
			};
			const result = request.command === "catalog.search" ? { items: [item], query: request.input.query, searchedAt: item.checkedAt } : item;
			process.stdout.write(JSON.stringify({ protocolVersion: 2, invocationId: request.invocationId, capabilityId: request.capabilityId, command: request.command, ok: true, result }) + "\\n");
		`);
		const unverified = discoverPlugins(root)[0]!;
		const service = new PluginCatalogService(database, config, [unverified]);
		const result = await service.search(member1ProfileId, "fixture");
		expect(result.items).toEqual([
			expect.objectContaining({
				acquisitionOptions: [],
				capability: "metadata-only",
				capabilityReason: "Source provenance is not verified by core policy; acquisition is unavailable.",
				provenance: "unverified-provenance",
			}),
		]);
		expect(result.providers.find((provider) => provider.pluginId === "unverified-book-source")).toMatchObject({
			providerAvailability: "available",
			reasonCode: "UNVERIFIED_PROVENANCE",
		});
		await expect(service.search(member1ProfileId, "forged")).rejects.toMatchObject({ code: "all_plugins_failed", status: 503 });
		await expect(service.detail(member1ProfileId, "plugin:unverified-book-source:fixture-book")).rejects.toThrow("metadata-only source returned acquisition options");
		await expect(service.listInstalledPlugins()).resolves.toEqual([
			expect.objectContaining({
				capabilities: ["search", "detail"],
				pluginId: "unverified-book-source",
				provenance: "unverified-provenance",
				reasonCode: "UNVERIFIED_PROVENANCE",
				rightsBasis: null,
			}),
		]);
	});

	it("keeps an unlisted public-domain plugin searchable but strips effect authority", async () => {
		const root = await mkdtemp(join(tmpdir(), "k-unlisted-public-source-test-"));
		temporaryRoots.push(root);
		const pluginDirectory = join(root, "unlisted-public-source");
		await mkdir(pluginDirectory);
		const manifest = {
			schemaVersion: 2, protocolVersion: 2, pluginId: "unlisted-public-source", displayName: "Unlisted Public Source", version: "1.0.0", entrypoint: "index.mjs",
			runtime: { allowedHosts: ["catalog.example.invalid"], timeoutMs: 3000, maxRequestBytes: 4096, maxResponseBytes: 65536, maxArtifactBytes: 1024 },
			capabilities: [{ capabilityId: "unlisted-public-source/books", family: "catalog-source", version: 1, commands: ["catalog.search", "catalog.detail", "catalog.acquire"], authorization: { kind: "none" }, mediaKinds: ["book"], rightsBases: ["public-domain"] }],
			review: { policyRef: "docs/providers/policy.md", reviewedAt: "2026-07-19" },
		};
		await writeFile(join(pluginDirectory, "plugin.json"), JSON.stringify(manifest));
		await writeFile(join(pluginDirectory, "index.mjs"), "process.stdout.write('{}\\n');");
		const unlisted = discoverPlugins(root)[0]!;
		const item = { acquisitionOptions: [], authors: [], capability: "candidate" as const, capabilityReason: "claimed", checkedAt: new Date().toISOString(), itemId: "book", language: null, pluginId: "unlisted-public-source", publishedYear: null, source: "Unlisted Public Source", title: "Book" };
		const host = { search: vi.fn(async (_plugin, query: string) => ({ items: [item], query, searchedAt: new Date().toISOString() })) } as never;
		const service = new PluginCatalogService(database, config, [unlisted], host);
		await expect(service.search(member1ProfileId, "book")).resolves.toMatchObject({ items: [expect.objectContaining({ acquisitionOptions: [], capability: "metadata-only", provenance: "unverified-provenance" })] });
		await expect(service.listInstalledPlugins()).resolves.toEqual([expect.objectContaining({ capabilities: ["search", "detail"], rightsBasis: null })]);
	});

	it("does not serve a warm cache after an installed plugin file disappears", async () => {
		const root = await mkdtemp(join(tmpdir(), "k-plugin-cache-test-"));
		temporaryRoots.push(root);
		const pluginDirectory = join(root, "project-gutenberg");
		await mkdir(pluginDirectory);
		await writeFile(join(pluginDirectory, "plugin.json"), await readFile("plugins/project-gutenberg/plugin.json"));
		await writeFile(join(pluginDirectory, "index.mjs"), "process.stdout.write('{}\\n');");
		const plugin = discoverPlugins(root)[0]!;
		const copiedInventory = {
			...publicPluginInventory,
			plugins: publicPluginInventory.plugins.map((entry) => entry.pluginId === plugin.normalized.pluginId ? { ...entry, digest: plugin.digest } : entry),
		};
		const item = { acquisitionOptions: [], authors: ["Jane Austen"], capability: "candidate" as const, capabilityReason: "public domain", checkedAt: new Date().toISOString(), itemId: "1342", language: "en", pluginId: "project-gutenberg", publishedYear: 1813, source: "Project Gutenberg", title: "Pride and Prejudice" };
		const host = { search: vi.fn(async (_plugin, query: string) => ({ items: [item], query, searchedAt: new Date().toISOString() })) } as never;
		const service = new PluginCatalogService(database, { ...config, publicPluginInventory: copiedInventory }, [plugin], host);
		await expect(service.search(member1ProfileId, "pride")).resolves.toMatchObject({ items: [expect.objectContaining({ title: "Pride and Prejudice" })] });
		await rm(plugin.entrypointPath);
		await expect(service.search(member1ProfileId, "pride")).rejects.toMatchObject({ code: "all_plugins_failed", status: 503 });
		expect((host as { search: ReturnType<typeof vi.fn> }).search).toHaveBeenCalledTimes(1);
	});
});