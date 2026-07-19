import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import yazl from "yazl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/modules/config";
import { createDatabase, type Database } from "../../src/modules/db/database";
import { migrate } from "../../src/modules/db/migrator";
import type { MailSender } from "../../src/modules/delivery/mail";
import { DeliveryService } from "../../src/modules/delivery/service";
import { DeliveryWorker } from "../../src/modules/delivery/worker";
import { PluginCatalogService } from "../../src/modules/plugins/catalog";
import { discoverPlugins } from "../../src/modules/plugins/manifests";
import { loadReviewedPublicInventory } from "../../src/modules/plugins/public-inventory";
import type { ActiveSession } from "../../src/modules/identity/types";
import { startPostgresHarness, type PostgresHarness } from "./helpers/postgres";

describe("plugin acquisition and delivery workflow", () => {
	let config: AppConfig;
	let database: Database;
	let harness: PostgresHarness;
	let root: string;
	const profileId = "00000000-0000-4000-8000-000000000001";
	const otherProfileId = "00000000-0000-4000-8000-000000000002";
	const installedPlugins = discoverPlugins("plugins");
	const publicPluginInventory = loadReviewedPublicInventory("plugins", installedPlugins);
	const plugin = installedPlugins.find((candidate) => candidate.manifest.pluginId === "project-gutenberg")!;
	const session: ActiveSession = {
		absoluteExpiresAt: new Date("2099-01-01T00:00:00Z"), createdAt: new Date(), idleExpiresAt: new Date("2099-01-01T00:00:00Z"), lastSeenAt: new Date(),
		profile: { checkedAt: new Date().toISOString(), credentialState: "ready", displayName: "Member 1", profileId, slug: "member-1" }, recentAuthAt: new Date(), revocationReason: null, revokedAt: null, sessionId: randomUUID(), tokenDigest: Buffer.alloc(32),
	};

	beforeEach(async () => {
		harness = await startPostgresHarness();
		root = await mkdtemp(join(tmpdir(), "k-delivery-test-"));
		config = {
			allowedPrivateClientCidrs: [], allowMigrationDown: true, databaseUrl: harness.connectionString,
			installedPlugins,
			outboundContact: "test@example.invalid",
			pinPepper: "pepper", pinReuseSecret: "reuse", pluginRoots: { publicDirectory: "plugins" }, port: 3000,
			publicOrigin: new URL("https://k.example.invalid"), quarantineDirectory: root, sessionSigningKey: "session",
			publicPluginInventory,
			sourceHashSecret: "source", smtpFrom: "sender@example.invalid", trustedProxyCidrs: [], userAgent: "k-test",
		};
		database = createDatabase(config);
		await migrate(database, { allowDown: true });
	});

	afterEach(async () => {
		await database.close();
		await harness.stop();
		await rm(root, { force: true, recursive: true });
	});

	function catalogHost() {
		const item = { acquisitionOptions: [{ estimatedBytes: 1000, format: "epub" as const, optionId: "epub", rightsBasis: "public-domain" as const }], authors: ["H. G. Wells"], capability: "candidate" as const, capabilityReason: "public domain", checkedAt: new Date().toISOString(), itemId: "84", language: "en", pluginId: plugin.manifest.pluginId, publishedYear: 1895, source: plugin.manifest.displayName, title: "The Time Machine" };
		return { detail: vi.fn(async () => item), search: vi.fn(async (_plugin, query) => ({ items: [item], query, searchedAt: new Date().toISOString() })) } as never;
	}

	function mail(send: MailSender["send"]): MailSender {
		return { ready: () => true, send };
	}

	async function readyPreflight(delivery: DeliveryService) {
		await delivery.updateSettings(session, "member1@kindle.com");
		const preflight = await delivery.preflight(session, { itemId: "84", optionId: "epub", pluginId: plugin.manifest.pluginId });
		expect(preflight.ready).toBe(true);
		return preflight;
	}

	async function prepare(delivery: DeliveryService) {
		const preflight = await readyPreflight(delivery);
		const idempotencyKey = randomUUID();
		const first = await delivery.queue(session, { idempotencyKey, preflightId: preflight.preflightId });
		const second = await delivery.queue(session, { idempotencyKey, preflightId: preflight.preflightId });
		expect(second.operationId).toBe(first.operationId);
		return first.operationId;
	}

	it("reports configuration blockers without acquiring and invalidates changed destination snapshots", async () => {
		const catalog = new PluginCatalogService(database, config, [plugin], catalogHost());
		const blocked = new DeliveryService(database, config, catalog, { ready: () => false, async send() { throw new Error("not configured"); } });
		const preflight = await blocked.preflight(session, { itemId: "84", optionId: "epub", pluginId: plugin.manifest.pluginId });
		expect(preflight.ready).toBe(false);
		expect(preflight.blockers.map((item) => item.code)).toEqual(["destination_required", "sender_configuration_required"]);
		await blocked.updateSettings(session, "member1@kindle.com");
		const readyMail = mail(async () => ({ accepted: true, response: "250 accepted" }));
		const ready = new DeliveryService(database, config, catalog, readyMail);
		const snapshot = await ready.preflight(session, { itemId: "84", optionId: "epub", pluginId: plugin.manifest.pluginId });
		await ready.updateSettings(session, "changed@kindle.com");
		await expect(ready.queue(session, { idempotencyKey: randomUUID(), preflightId: snapshot.preflightId })).rejects.toMatchObject({ code: "stale_preflight", status: 409 });
	});

	it("blocks metadata-only preflight before invoking plugin detail", async () => {
		const pluginDirectory = join(root, "unverified-book-source");
		await require("node:fs/promises").mkdir(pluginDirectory);
		await require("node:fs/promises").writeFile(join(pluginDirectory, "plugin.json"), await readFile("tests/fixtures/plugins/unverified-book-source.v2.json"));
		await require("node:fs/promises").writeFile(join(pluginDirectory, "index.mjs"), "throw new Error('must not launch');\n");
		const metadataOnly = discoverPlugins(root)[0]!;
		const host = { detail: vi.fn() } as never;
		const catalog = new PluginCatalogService(database, config, [metadataOnly], host);
		const delivery = new DeliveryService(database, config, catalog, mail(vi.fn()));
		await expect(delivery.preflight(session, { itemId: "fixture-book", optionId: "forged", pluginId: metadataOnly.normalized.pluginId })).rejects.toMatchObject({ code: "acquisition_blocked", status: 409 });
		expect((host as { detail: ReturnType<typeof vi.fn> }).detail).not.toHaveBeenCalled();
		const persisted = await database.query("select preflight_id from delivery_preflights where plugin_id = $1", [metadataOnly.normalized.pluginId]);
		expect(persisted.rows).toEqual([]);
	});

	it("ignores a forged detail cache when authorizing preflight", async () => {
		const host = catalogHost() as unknown as { detail: ReturnType<typeof vi.fn>; search: ReturnType<typeof vi.fn> };
		const catalog = new PluginCatalogService(database, config, [plugin], host as never);
		await catalog.detail(profileId, "plugin:project-gutenberg:84");
		const forged = {
			acquisitionOptions: [{ estimatedBytes: 1000, format: "epub", optionId: "forged", rightsBasis: "public-domain" }],
			authors: [], capability: "deliverable", capabilityReason: "forged cache", checkedAt: new Date().toISOString(), itemId: "84", language: null,
			pluginId: plugin.normalized.pluginId, publishedYear: null, source: plugin.manifest.displayName, title: "Forged",
		};
		await database.query("update plugin_cache set normalized_json = $1::jsonb where plugin_id = $2 and resource_kind = 'detail'", [JSON.stringify(forged), plugin.normalized.pluginId]);
		const delivery = new DeliveryService(database, config, catalog, mail(vi.fn()));
		await expect(delivery.preflight(session, { itemId: "84", optionId: "forged", pluginId: plugin.normalized.pluginId })).rejects.toMatchObject({ code: "acquisition_blocked", status: 409 });
		expect(host.detail).toHaveBeenCalledTimes(2);
	});

	it("rejects forged persisted provenance and stale preflight digests before queue creation", async () => {
		const catalog = new PluginCatalogService(database, config, [plugin], catalogHost());
		const delivery = new DeliveryService(database, config, catalog, mail(vi.fn()));
		const forged = await readyPreflight(delivery);
		const forgedRow = await database.query<{ item_json: Record<string, unknown> }>("select item_json from delivery_preflights where preflight_id = $1", [forged.preflightId]);
		await database.query("update delivery_preflights set item_json = $2::jsonb where preflight_id = $1", [forged.preflightId, JSON.stringify({ ...forgedRow.rows[0]!.item_json, provenance: "unverified-provenance" })]);
		await expect(delivery.queue(session, { idempotencyKey: randomUUID(), preflightId: forged.preflightId })).rejects.toMatchObject({ code: "stale_preflight", status: 409 });

		const stale = await delivery.preflight(session, { itemId: "84", optionId: "epub", pluginId: plugin.normalized.pluginId });
		await database.query("update delivery_preflights set plugin_digest = $2 where preflight_id = $1", [stale.preflightId, "0".repeat(64)]);
		await expect(delivery.queue(session, { idempotencyKey: randomUUID(), preflightId: stale.preflightId })).rejects.toMatchObject({ code: "stale_preflight", status: 409 });
		const operations = await database.query("select operation_id from operations");
		expect(operations.rows).toEqual([]);
	});

	it("cannot promote a forged metadata-only preflight into an operation", async () => {
		const pluginDirectory = join(root, "unverified-book-source");
		await mkdir(pluginDirectory);
		await writeFile(join(pluginDirectory, "plugin.json"), await readFile("tests/fixtures/plugins/unverified-book-source.v2.json"));
		await writeFile(join(pluginDirectory, "index.mjs"), "process.stdout.write('{}\\n');\n");
		const metadataOnly = discoverPlugins(root)[0]!;
		const rawItem = { acquisitionOptions: [], authors: [], capability: "candidate", capabilityReason: "claimed", checkedAt: new Date().toISOString(), itemId: "fixture-book", language: null, pluginId: metadataOnly.normalized.pluginId, publishedYear: null, source: "Unverified", title: "Fixture" };
		const host = { detail: vi.fn(async () => rawItem) } as never;
		const catalog = new PluginCatalogService(database, config, [metadataOnly], host);
		const sender = mail(vi.fn());
		const delivery = new DeliveryService(database, config, catalog, sender);
		await delivery.updateSettings(session, "member1@kindle.com");
		const profile = await database.query<{ destination_revision: number }>("select destination_revision from profiles where profile_id = $1", [profileId]);
		const preflightId = randomUUID();
		const forgedItem = { ...rawItem, acquisitionOptions: [{ estimatedBytes: 100, format: "epub", optionId: "forged", rightsBasis: "public-domain" }], capability: "candidate", capabilityReason: "Core policy verified the reviewed public-domain source and current plugin digest.", provenance: "verified-public-domain" };
		await database.query(`
			insert into delivery_preflights (preflight_id, profile_id, plugin_id, item_id, option_id, plugin_digest, destination_revision, item_json, ready, blockers_json, warnings_json, expires_at)
			values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,true,'[]'::jsonb,'[]'::jsonb,now() + interval '5 minutes')
		`, [preflightId, profileId, metadataOnly.normalized.pluginId, "fixture-book", "forged", metadataOnly.digest, profile.rows[0]!.destination_revision, JSON.stringify(forgedItem)]);
		await expect(delivery.queue(session, { idempotencyKey: randomUUID(), preflightId })).rejects.toMatchObject({ code: "stale_preflight", status: 409 });
		expect((host as { detail: ReturnType<typeof vi.fn> }).detail).toHaveBeenCalledOnce();
		expect((await database.query("select operation_id from operations")).rows).toEqual([]);
		expect(sender.send as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});

	it("acquires only through the plugin host, validates EPUB, and records Submitted", async () => {
		const catalog = new PluginCatalogService(database, config, [plugin], catalogHost());
		const sender = mail(vi.fn(async () => ({ accepted: true, response: "250 accepted" })));
		const delivery = new DeliveryService(database, config, catalog, sender);
		const operationId = await prepare(delivery);
		const host = { acquire: vi.fn(async (_plugin, _input, quarantine) => createArtifact(quarantine)) } as never;
		const worker = new DeliveryWorker(database, config, catalog, delivery, host);
		expect(await worker.runOnce("test-worker")).toBe(true);
		const operation = await delivery.read(profileId, operationId);
		expect(operation).toMatchObject({ deliveryEvidence: { state: "mail-server-accepted" }, status: "succeeded" });
		expect(operation.stages.find((stage: any) => stage.name === "validate")?.status).toBe("succeeded");
		await expect(delivery.read(otherProfileId, operationId)).rejects.toMatchObject({ code: "not_found", status: 404 });
		const artifact = await database.query<{ storage_path: string }>("select storage_path from artifacts where operation_id = $1", [operationId]);
		expect(await stat(artifact.rows[0]!.storage_path)).toMatchObject({ size: expect.any(Number) });
		expect((sender.send as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
		await database.query("update artifacts set retain_until = now() - interval '1 second' where operation_id = $1", [operationId]);
		expect(await worker.runOnce("cleanup-worker")).toBe(false);
		await expect(stat(artifact.rows[0]!.storage_path)).rejects.toMatchObject({ code: "ENOENT" });
		const retained = await database.query<{ deleted_at: Date | null }>("select deleted_at from artifacts where operation_id = $1", [operationId]);
		expect(retained.rows[0]?.deleted_at).toBeInstanceOf(Date);
	});

	it("keeps all three reviewed public sources searchable and effect-authorized", async () => {
		await new DeliveryService(database, config, new PluginCatalogService(database, config), mail(vi.fn())).updateSettings(session, "member1@kindle.com");
		const sender = mail(vi.fn(async () => ({ accepted: true, response: "250 accepted" })));
		for (const source of installedPlugins.filter((candidate) => ["internet-archive", "project-gutenberg", "standard-ebooks"].includes(candidate.normalized.pluginId))) {
			const item = { acquisitionOptions: [{ estimatedBytes: 1000, format: "epub" as const, optionId: "epub", rightsBasis: "public-domain" as const }], authors: ["Author"], capability: "candidate" as const, capabilityReason: "claimed", checkedAt: new Date().toISOString(), itemId: "book", language: "en", pluginId: source.normalized.pluginId, publishedYear: 1900, source: source.manifest.displayName, title: `Book from ${source.manifest.displayName}` };
			const catalog = new PluginCatalogService(database, config, [source], {
				detail: vi.fn(async () => item),
				search: vi.fn(async (_plugin, query: string) => ({ items: [item], query, searchedAt: new Date().toISOString() })),
			} as never);
			const delivery = new DeliveryService(database, config, catalog, sender);
			await expect(catalog.search(profileId, "book")).resolves.toMatchObject({ items: [expect.objectContaining({ capability: "candidate", provenance: "verified-public-domain" })] });
			await expect(catalog.detail(profileId, `plugin:${source.normalized.pluginId}:book`)).resolves.toMatchObject({ capability: "candidate", provenance: "verified-public-domain" });
			const preflight = await delivery.preflight(session, { itemId: "book", optionId: "epub", pluginId: source.normalized.pluginId });
			const receipt = await delivery.queue(session, { idempotencyKey: randomUUID(), preflightId: preflight.preflightId });
			const host = { acquire: vi.fn(async (_plugin, _input, quarantine) => createArtifact(quarantine)) } as never;
			expect(await new DeliveryWorker(database, config, catalog, delivery, host).runOnce(`worker-${source.normalized.pluginId}`)).toBe(true);
			await expect(delivery.read(profileId, receipt.operationId)).resolves.toMatchObject({ status: "succeeded" });
			expect((host as { acquire: ReturnType<typeof vi.fn> }).acquire).toHaveBeenCalledOnce();
		}
		expect(sender.send as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(3);
	});

	it("preserves exact legacy-v1 digest snapshot compatibility through queue and worker", async () => {
		expect(plugin.legacyDigest).not.toBeNull();
		const catalog = new PluginCatalogService(database, config, [plugin], catalogHost());
		const sender = mail(vi.fn(async () => ({ accepted: true, response: "250 accepted" })));
		const delivery = new DeliveryService(database, config, catalog, sender);
		const preflight = await readyPreflight(delivery);
		await database.query("update delivery_preflights set plugin_digest = $2 where preflight_id = $1", [preflight.preflightId, plugin.legacyDigest]);
		const receipt = await delivery.queue(session, { idempotencyKey: randomUUID(), preflightId: preflight.preflightId });
		const host = { acquire: vi.fn(async (_plugin, _input, quarantine) => createArtifact(quarantine)) } as never;
		expect(await new DeliveryWorker(database, config, catalog, delivery, host).runOnce("legacy-v1-worker")).toBe(true);
		await expect(delivery.read(profileId, receipt.operationId)).resolves.toMatchObject({ status: "succeeded" });
		expect((host as { acquire: ReturnType<typeof vi.fn> }).acquire).toHaveBeenCalledOnce();
		expect(sender.send as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
	});

	it("blocks when the destination changes after queueing and never acquires", async () => {
		const catalog = new PluginCatalogService(database, config, [plugin], catalogHost());
		const sender = mail(vi.fn(async () => ({ accepted: true, response: "250 accepted" })));
		const delivery = new DeliveryService(database, config, catalog, sender);
		const operationId = await prepare(delivery);
		await delivery.updateSettings(session, "changed@kindle.com");
		const host = { acquire: vi.fn() } as never;
		const worker = new DeliveryWorker(database, config, catalog, delivery, host);
		expect(await worker.runOnce("test-worker")).toBe(true);
		await expect(delivery.read(profileId, operationId)).resolves.toMatchObject({ deliveryEvidence: { state: "not-submitted" }, status: "blocked" });
		expect((host as any).acquire).not.toHaveBeenCalled();
		expect(sender.send as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});

	it("blocks a forged queued item before acquisition", async () => {
		const catalog = new PluginCatalogService(database, config, [plugin], catalogHost());
		const sender = mail(vi.fn(async () => ({ accepted: true, response: "250 accepted" })));
		const delivery = new DeliveryService(database, config, catalog, sender);
		const operationId = await prepare(delivery);
		await database.query(`
			update delivery_preflights set item_json = jsonb_set(item_json, '{provenance}', '"unverified-provenance"'::jsonb)
			where preflight_id = (select preflight_id from operations where operation_id = $1)
		`, [operationId]);
		const host = { acquire: vi.fn() } as never;
		const worker = new DeliveryWorker(database, config, catalog, delivery, host);
		expect(await worker.runOnce("forged-item-worker")).toBe(true);
		await expect(delivery.read(profileId, operationId)).resolves.toMatchObject({ status: "blocked" });
		expect((host as { acquire: ReturnType<typeof vi.fn> }).acquire).not.toHaveBeenCalled();
		expect(sender.send as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});

	it("blocks a stale queued plugin digest before acquisition", async () => {
		const catalog = new PluginCatalogService(database, config, [plugin], catalogHost());
		const sender = mail(vi.fn(async () => ({ accepted: true, response: "250 accepted" })));
		const delivery = new DeliveryService(database, config, catalog, sender);
		const operationId = await prepare(delivery);
		await database.query("update delivery_preflights set plugin_digest = $2 where preflight_id = (select preflight_id from operations where operation_id = $1)", [operationId, "0".repeat(64)]);
		const host = { acquire: vi.fn() } as never;
		expect(await new DeliveryWorker(database, config, catalog, delivery, host).runOnce("stale-digest-worker")).toBe(true);
		await expect(delivery.read(profileId, operationId)).resolves.toMatchObject({ status: "blocked" });
		expect((host as { acquire: ReturnType<typeof vi.fn> }).acquire).not.toHaveBeenCalled();
		expect(sender.send as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});

	it("revalidates immediately before acquisition", async () => {
		const validItem = { acquisitionOptions: [{ estimatedBytes: 1000, format: "epub" as const, optionId: "epub", rightsBasis: "public-domain" as const }], authors: ["H. G. Wells"], capability: "candidate" as const, capabilityReason: "claimed", checkedAt: new Date().toISOString(), itemId: "84", language: "en", pluginId: plugin.normalized.pluginId, publishedYear: 1895, source: plugin.manifest.displayName, title: "The Time Machine" };
		const changedItem = { ...validItem, acquisitionOptions: [] };
		const detail = vi.fn().mockResolvedValueOnce(validItem).mockResolvedValueOnce(validItem).mockResolvedValueOnce(validItem).mockResolvedValueOnce(changedItem);
		const catalog = new PluginCatalogService(database, config, [plugin], { detail, search: vi.fn() } as never);
		const sender = mail(vi.fn(async () => ({ accepted: true, response: "250 accepted" })));
		const delivery = new DeliveryService(database, config, catalog, sender);
		const operationId = await prepare(delivery);
		const host = { acquire: vi.fn() } as never;
		const worker = new DeliveryWorker(database, config, catalog, delivery, host);
		expect(await worker.runOnce("pre-acquire-worker")).toBe(true);
		await expect(delivery.read(profileId, operationId)).resolves.toMatchObject({ status: "blocked" });
		expect(detail).toHaveBeenCalledTimes(4);
		expect((host as { acquire: ReturnType<typeof vi.fn> }).acquire).not.toHaveBeenCalled();
		expect(sender.send as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});

	it("revalidates immediately before delivery and removes acquired bytes when evidence changes", async () => {
		const validItem = { acquisitionOptions: [{ estimatedBytes: 1000, format: "epub" as const, optionId: "epub", rightsBasis: "public-domain" as const }], authors: ["H. G. Wells"], capability: "candidate" as const, capabilityReason: "claimed", checkedAt: new Date().toISOString(), itemId: "84", language: "en", pluginId: plugin.normalized.pluginId, publishedYear: 1895, source: plugin.manifest.displayName, title: "The Time Machine" };
		const changedItem = { ...validItem, acquisitionOptions: [] };
		const detail = vi.fn().mockResolvedValueOnce(validItem).mockResolvedValueOnce(validItem).mockResolvedValueOnce(validItem).mockResolvedValueOnce(validItem).mockResolvedValueOnce(changedItem);
		const catalog = new PluginCatalogService(database, config, [plugin], { detail, search: vi.fn() } as never);
		const sender = mail(vi.fn(async () => ({ accepted: true, response: "250 accepted" })));
		const delivery = new DeliveryService(database, config, catalog, sender);
		const operationId = await prepare(delivery);
		let artifactPath = "";
		const host = { acquire: vi.fn(async (_plugin, _input, quarantine) => {
			const artifact = await createArtifact(quarantine);
			artifactPath = artifact.path;
			return artifact;
		}) } as never;
		const worker = new DeliveryWorker(database, config, catalog, delivery, host);
		expect(await worker.runOnce("pre-delivery-worker")).toBe(true);
		await expect(delivery.read(profileId, operationId)).resolves.toMatchObject({ status: "blocked" });
		expect((host as { acquire: ReturnType<typeof vi.fn> }).acquire).toHaveBeenCalledOnce();
		expect(sender.send as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
		await expect(stat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await database.query<{ deleted_at: Date | null }>("select deleted_at from artifacts where operation_id = $1", [operationId])).rows).toEqual([{ deleted_at: expect.any(Date) }]);
		expect((await database.query("select delivery_attempt_id from delivery_attempts where operation_id = $1", [operationId])).rows).toEqual([]);
	});

	it("rejects encrypted EPUBs before delivery and removes quarantined bytes", async () => {
		const catalog = new PluginCatalogService(database, config, [plugin], catalogHost());
		const sender = mail(vi.fn(async () => ({ accepted: true, response: "250 accepted" })));
		const delivery = new DeliveryService(database, config, catalog, sender);
		const operationId = await prepare(delivery);
		let artifactPath = "";
		const host = { acquire: vi.fn(async (_plugin, _input, quarantine) => {
			const artifact = await createArtifact(quarantine, { encrypted: true });
			artifactPath = artifact.path;
			return artifact;
		}) } as never;
		const worker = new DeliveryWorker(database, config, catalog, delivery, host);
		expect(await worker.runOnce("test-worker")).toBe(true);
		await expect(delivery.read(profileId, operationId)).resolves.toMatchObject({ status: "failed" });
		expect(sender.send as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
		await expect(stat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("blocks ambiguous SMTP outcomes and never marks them submitted", async () => {
		const catalog = new PluginCatalogService(database, config, [plugin], catalogHost());
		const delivery = new DeliveryService(database, config, catalog, mail(async () => { throw new Error("socket closed after DATA"); }));
		const operationId = await prepare(delivery);
		const worker = new DeliveryWorker(database, config, catalog, delivery, { acquire: vi.fn(async (_plugin, _input, quarantine) => createArtifact(quarantine)) } as never);
		await worker.runOnce("test-worker");
		await expect(delivery.read(profileId, operationId)).resolves.toMatchObject({ deliveryEvidence: { state: "unknown" }, status: "blocked" });
		const attempt = await database.query<{ status: string }>("select status from delivery_attempts where operation_id = $1", [operationId]);
		expect(attempt.rows).toEqual([{ status: "unknown" }]);
	});

	it("recovers an expired sending lease as unknown without acquiring or resending", async () => {
		const catalog = new PluginCatalogService(database, config, [plugin], catalogHost());
		const sender = mail(vi.fn(async () => ({ accepted: true, response: "250 accepted" })));
		const delivery = new DeliveryService(database, config, catalog, sender);
		const operationId = await prepare(delivery);
		await database.query("update operations set status = 'running', lease_owner = 'expired-worker', lease_expires_at = now() - interval '1 second' where operation_id = $1", [operationId]);
		await database.query("insert into delivery_attempts (delivery_attempt_id, operation_id, message_id, destination_hash, status) values ($1,$2,$3,$4,'sending')", [randomUUID(), operationId, delivery.messageId(operationId), delivery.destinationHash("member1@kindle.com")]);
		const host = { acquire: vi.fn() } as never;
		const worker = new DeliveryWorker(database, config, catalog, delivery, host);
		expect(await worker.runOnce("recovery-worker")).toBe(true);
		await expect(delivery.read(profileId, operationId)).resolves.toMatchObject({ deliveryEvidence: { state: "unknown" }, status: "blocked" });
		expect((host as any).acquire).not.toHaveBeenCalled();
		expect(sender.send as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
		const attempt = await database.query<{ status: string }>("select status from delivery_attempts where operation_id = $1", [operationId]);
		expect(attempt.rows).toEqual([{ status: "unknown" }]);
	});

	it("refuses to clean up or claim work when profile configuration drifts", async () => {
		const catalog = new PluginCatalogService(database, config, [plugin], catalogHost());
		const sender = mail(vi.fn(async () => ({ accepted: true, response: "250 accepted" })));
		const delivery = new DeliveryService(database, config, catalog, sender);
		const operationId = await prepare(delivery);
		const host = { acquire: vi.fn() } as never;
		const worker = new DeliveryWorker(database, config, catalog, delivery, host);
		await database.withTransaction(async (client) => {
			await client.query("select set_config('k.profile_alias_migration', 'on', true)");
			await client.query("update profiles set slug = 'drifted-member' where profile_id = $1", [profileId]);
		});

		await expect(worker.runOnce("drift-worker")).rejects.toMatchObject({
			code: "profile_configuration_mismatch",
			status: 503,
		});
		const operation = await database.query<{ lease_owner: string | null; status: string }>(
			"select status, lease_owner from operations where operation_id = $1",
			[operationId],
		);
		expect(operation.rows).toEqual([{ lease_owner: null, status: "queued" }]);
		expect((host as { acquire: ReturnType<typeof vi.fn> }).acquire).not.toHaveBeenCalled();
		expect(sender.send as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});
});

async function createArtifact(directory: string, options: { encrypted?: boolean } = {}) {
	const path = join(directory, `${randomUUID()}.part`);
	const zip = new yazl.ZipFile();
	zip.addBuffer(Buffer.from("application/epub+zip"), "mimetype", { compress: false });
	zip.addBuffer(Buffer.from(`<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`), "META-INF/container.xml");
	if (options.encrypted) zip.addBuffer(Buffer.from("<encryption/>"), "META-INF/encryption.xml");
	zip.addBuffer(Buffer.from("<package/>") , "OEBPS/content.opf");
	zip.end();
	zip.outputStream.pipe(createWriteStream(path));
	await once(zip.outputStream, "end");
	const bytes = await readFile(path);
	return { mediaType: "application/epub+zip", path, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
}