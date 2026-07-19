import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { currentPluginDigest, discoverPlugins, normalizePluginManifest, parsePluginManifest, pluginDigestIsCurrent, pluginDigestMatchesSnapshot } from "../../src/modules/plugins/manifests";
import { PluginHost } from "../../src/modules/plugins/host";
import { loadReviewedPublicInventory } from "../../src/modules/plugins/public-inventory";

const pluginRoot = resolve("plugins");
const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("installed source plugins", () => {
	it("discovers the three reviewed sources and three reviewed capability plugins", () => {
		const plugins = discoverPlugins(pluginRoot);
		expect(plugins.map((plugin) => plugin.manifest.pluginId)).toEqual([
			"google-books",
			"google-gmail",
			"internet-archive",
			"login-with-amazon",
			"project-gutenberg",
			"standard-ebooks",
		]);
		const sources = plugins.filter((plugin) => plugin.manifest.schemaVersion === 1);
		expect(sources).toHaveLength(3);
		expect(plugins.every((plugin) => plugin.root === "public")).toBe(true);
		expect(sources.every((plugin) => plugin.manifest.schemaVersion === 1
			&& plugin.manifest.capabilities.join(",") === "search,detail,acquire")).toBe(true);
	});

	it("discovers distinct public and private roots without shadowing or shared-runtime crossover", async () => {
		const publicRoot = await mkdtemp(join(tmpdir(), "k-public-plugins-"));
		const privateRoot = await mkdtemp(join(tmpdir(), "k-private-plugins-"));
		temporaryPaths.push(publicRoot, privateRoot);
		const createSource = async (root: string, pluginId: string) => {
			await mkdir(join(root, pluginId));
			await mkdir(join(root, "lib"), { recursive: true });
			await writeFile(join(root, "lib/runtime.mjs"), `export const owner = ${JSON.stringify(pluginId)};`);
			await writeFile(join(root, pluginId, "plugin.json"), JSON.stringify({
				allowedHosts: ["example.invalid"], capabilities: ["search", "detail", "acquire"],
				displayName: pluginId, entrypoint: "index.mjs", formats: ["epub"],
				maxArtifactBytes: 1024, maxResponseBytes: 65536, pluginId,
				protocolVersion: 1, rightsBasis: "public-domain", rightsJurisdiction: "test",
				rightsReviewedAt: "2026-07-19", schemaVersion: 1, timeoutMs: 3000, version: "1.0.0",
			}));
			await writeFile(join(root, pluginId, "index.mjs"), "process.stdout.write('{}\\n');");
		};
		await createSource(publicRoot, "public-source");
		await createSource(privateRoot, "private-source");

		const plugins = discoverPlugins({ privateDirectory: privateRoot, publicDirectory: publicRoot });
		expect(plugins.map((plugin) => [plugin.normalized.pluginId, plugin.root])).toEqual([
			["public-source", "public"],
			["private-source", "private"],
		]);
		const privateDigest = plugins[1]!.digest;
		await writeFile(join(publicRoot, "lib/runtime.mjs"), "export const owner = 'changed';");
		expect(currentPluginDigest(plugins[1]!)).toBe(privateDigest);
	});

	it("rejects symlinked, overlapping, malformed, and shadowed plugin roots", async () => {
		const publicRoot = await mkdtemp(join(tmpdir(), "k-public-root-"));
		const privateRoot = await mkdtemp(join(tmpdir(), "k-private-root-"));
		temporaryPaths.push(publicRoot, privateRoot);
		const linkedRoot = `${publicRoot}-link`;
		temporaryPaths.push(linkedRoot);
		await symlink(publicRoot, linkedRoot);
		expect(() => discoverPlugins(linkedRoot)).toThrow("regular directory");
		expect(() => discoverPlugins({ privateDirectory: publicRoot, publicDirectory: publicRoot })).toThrow("must not overlap");
		const nestedRoot = join(publicRoot, "nested");
		await mkdir(nestedRoot);
		expect(() => discoverPlugins({ privateDirectory: nestedRoot, publicDirectory: publicRoot })).toThrow("must not overlap");
		expect(() => discoverPlugins({ privateDirectory: publicRoot, publicDirectory: nestedRoot })).toThrow("must not overlap");

		await rm(nestedRoot, { recursive: true });
		await writeFile(join(publicRoot, "unexpected.txt"), "not an inventory");
		expect(() => discoverPlugins(publicRoot)).toThrow("unexpected entry");
		await rm(join(publicRoot, "unexpected.txt"));

		await mkdir(join(publicRoot, "project-gutenberg"));
		await writeFile(join(publicRoot, "project-gutenberg/plugin.json"), await readFile("plugins/project-gutenberg/plugin.json"));
		await writeFile(join(publicRoot, "project-gutenberg/index.mjs"), "process.stdout.write('{}\\n');");
		await mkdir(join(privateRoot, "project-gutenberg"));
		await writeFile(join(privateRoot, "project-gutenberg/plugin.json"), JSON.stringify({
			schemaVersion: 2, protocolVersion: 2, pluginId: "project-gutenberg", displayName: "Shadow", version: "1.0.0", entrypoint: "index.mjs",
			runtime: { allowedHosts: ["example.invalid"], timeoutMs: 3000, maxRequestBytes: 4096, maxResponseBytes: 4096, maxArtifactBytes: 0 },
			capabilities: [{ capabilityId: "project-gutenberg/private-books", family: "catalog-source", version: 1, commands: ["catalog.search", "catalog.detail"], authorization: { kind: "none" }, mediaKinds: ["book"] }],
			review: { policyRef: "docs/providers/policy.md", reviewedAt: "2026-07-19" },
		}));
		await writeFile(join(privateRoot, "project-gutenberg/index.mjs"), "process.stdout.write('{}\\n');");
		expect(() => discoverPlugins({ privateDirectory: privateRoot, publicDirectory: publicRoot })).toThrow("duplicate pluginId");
	});

	it("rejects symlink entries, special files, invalid private plugins, and duplicate capabilities across roots", async () => {
		const publicRoot = await mkdtemp(join(tmpdir(), "k-public-malformed-root-"));
		const privateRoot = await mkdtemp(join(tmpdir(), "k-private-malformed-root-"));
		temporaryPaths.push(publicRoot, privateRoot);
		const linkedEntry = join(publicRoot, "linked-plugin");
		await symlink(resolve("plugins/project-gutenberg"), linkedEntry);
		expect(() => discoverPlugins(publicRoot)).toThrow("entries must not be symlinks");
		await rm(linkedEntry);

		const socketPath = join(publicRoot, "unexpected.sock");
		const server = createServer();
		await new Promise<void>((resolveListen, reject) => server.once("error", reject).listen(socketPath, resolveListen));
		try {
			expect(() => discoverPlugins(publicRoot)).toThrow("unexpected entry");
		} finally {
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		}

		await mkdir(join(privateRoot, "broken-private"));
		await writeFile(join(privateRoot, "broken-private/plugin.json"), "{}");
		await writeFile(join(privateRoot, "broken-private/index.mjs"), "");
		expect(() => discoverPlugins({ privateDirectory: privateRoot, publicDirectory: publicRoot })).toThrow();
		await rm(join(privateRoot, "broken-private"), { recursive: true });

		const duplicateManifest = JSON.parse(await readFile("tests/fixtures/plugins/unverified-book-source.v2.json", "utf8"));
		for (const [root, entrypoint] of [[publicRoot, "public"], [privateRoot, "private"]] as const) {
			await mkdir(join(root, duplicateManifest.pluginId));
			await writeFile(join(root, duplicateManifest.pluginId, "plugin.json"), JSON.stringify(duplicateManifest));
			await writeFile(join(root, duplicateManifest.pluginId, "index.mjs"), `export const owner = ${JSON.stringify(entrypoint)};`);
		}
		expect(() => discoverPlugins({ privateDirectory: privateRoot, publicDirectory: publicRoot })).toThrow("duplicate capabilityId");
	});

	it("validates the core-owned public inventory exactly and binds current digests", async () => {
		const plugins = discoverPlugins(pluginRoot);
		const inventory = loadReviewedPublicInventory(pluginRoot, plugins);
		expect(inventory.plugins.map((entry) => entry.pluginId)).toEqual([
			"project-gutenberg",
			"standard-ebooks",
			"internet-archive",
			"google-books",
			"google-gmail",
			"login-with-amazon",
		]);
		for (const entry of inventory.plugins) {
			expect(entry.digest).toBe(plugins.find((plugin) => plugin.normalized.pluginId === entry.pluginId)?.digest);
		}

		const root = await mkdtemp(join(tmpdir(), "k-public-inventory-tamper-"));
		temporaryPaths.push(root);
		for (const entry of await require("node:fs/promises").readdir(pluginRoot, { withFileTypes: true })) {
			if (entry.name === "public-inventory.json") continue;
			await require("node:fs/promises").cp(join(pluginRoot, entry.name), join(root, entry.name), { recursive: true });
		}
		const source = JSON.parse(await readFile(join(pluginRoot, "public-inventory.json"), "utf8"));
		source.plugins[0].capabilities[0].classification = "metadata-only";
		await writeFile(join(root, "public-inventory.json"), JSON.stringify(source));
		expect(() => loadReviewedPublicInventory(root, discoverPlugins(root))).toThrow("public plugin inventory is invalid");
	});

	it("rejects prohibited IDs, source hosts, path traversal, and unknown fields", () => {
		const base = JSON.parse(readFileSync(resolve(pluginRoot, "project-gutenberg/plugin.json"), "utf8")) as Record<string, unknown>;
		for (const patch of [
			{ pluginId: "annas-archive" },
			{ allowedHosts: ["vk.com"] },
			{ entrypoint: "../escape.mjs" },
			{ extra: true },
		]) {
			expect(() => parsePluginManifest(JSON.stringify({ ...base, ...patch }))).toThrow();
		}
	});

	it("parses capability-v2 fixtures and normalizes legacy sources without changing their wire contract", async () => {
		const fixtureNames = ["google-books", "google-gmail", "login-with-amazon", "microsoft-onedrive"];
		for (const fixtureName of fixtureNames) {
			const source = await readFile(resolve(`tests/fixtures/plugins/${fixtureName}.v2.json`), "utf8");
			const manifest = parsePluginManifest(source);
			expect(manifest.schemaVersion).toBe(2);
			expect(normalizePluginManifest(manifest)).toMatchObject({ pluginId: fixtureName, protocolVersion: 2, schemaVersion: 2 });
		}

		const legacy = parsePluginManifest(await readFile(resolve(pluginRoot, "project-gutenberg/plugin.json"), "utf8"));
		expect(normalizePluginManifest(legacy)).toMatchObject({
			capabilities: [{
				authorization: { kind: "none" },
				capabilityId: "project-gutenberg/catalog",
				commands: ["catalog.search", "catalog.detail", "catalog.acquire"],
				family: "catalog-source",
				mediaKinds: ["book"],
				rightsBases: ["public-domain"],
			}],
			pluginId: "project-gutenberg",
			protocolVersion: 1,
			schemaVersion: 1,
		});
	});

	it("rejects invalid v2 capability ownership, duplicates, hosts, and family commands", async () => {
		const base = JSON.parse(await readFile("tests/fixtures/plugins/google-gmail.v2.json", "utf8")) as Record<string, unknown>;
		const capabilities = base.capabilities as Array<Record<string, unknown>>;
		const cases = [
			{ ...base, capabilities: [{ ...capabilities[0], capabilityId: "other/identity" }, capabilities[1]] },
			{ ...base, capabilities: [{ ...capabilities[0] }, { ...capabilities[1], capabilityId: capabilities[0]!.capabilityId }] },
			{ ...base, runtime: { ...(base.runtime as Record<string, unknown>), allowedHosts: ["api..example.com"] } },
			{ ...base, capabilities: [{ ...capabilities[0], commands: ["mail.send"] }, capabilities[1]] },
		];
		for (const value of cases) expect(() => parsePluginManifest(JSON.stringify(value))).toThrow();
	});

	it("runs a fixture plugin through the process host and validates its EPUB", async () => {
		const root = await mkdtemp(join(tmpdir(), "k-plugin-test-"));
		temporaryPaths.push(root);
		const pluginDirectory = join(root, "project-gutenberg");
		const quarantine = join(root, "quarantine");
		const requestLog = join(root, "requests.jsonl");
		await mkdir(pluginDirectory);
		await writeFile(join(pluginDirectory, "plugin.json"), await readFile("plugins/project-gutenberg/plugin.json"));
		await writeFile(join(pluginDirectory, "index.mjs"), `
			import { createHash } from "node:crypto";
			import { appendFile, writeFile } from "node:fs/promises";
			let source = ""; for await (const chunk of process.stdin) source += chunk;
			const request = JSON.parse(source);
			await appendFile(${JSON.stringify(requestLog)}, JSON.stringify(request) + "\\n");
			if (request.command === "search") process.stdout.write(JSON.stringify({ok:true,result:{items:[],query:request.input.query,searchedAt:new Date(0).toISOString()}}) + "\\n");
			else if (request.command === "acquire") { const bytes = Buffer.from([0x50,0x4b,0x03,0x04,1,2,3,4]); await writeFile(request.input.destinationPath, bytes, {flag:"wx"}); process.stdout.write(JSON.stringify({ok:true,result:{mediaType:"application/epub+zip",sizeBytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")}}) + "\\n"); }
			else process.stdout.write(JSON.stringify({ok:true,result:{pluginId:"project-gutenberg"}}) + "\\n");
		`);
		const plugin = discoverPlugins(root)[0]!;
		const installed = discoverPlugins(pluginRoot);
		const inventory = loadReviewedPublicInventory(pluginRoot, installed);
		const fixtureInventory = { ...inventory, plugins: inventory.plugins.map((entry) => entry.pluginId === plugin.normalized.pluginId ? { ...entry, digest: plugin.digest } : entry) };
		const host = new PluginHost("k-test", fixtureInventory);
		await expect(host.describe(plugin)).resolves.toMatchObject({ pluginId: "project-gutenberg" });
		await expect(host.search(plugin, "test")).resolves.toMatchObject({ query: "test" });
		await expect(host.detail(plugin, "item")).resolves.toMatchObject({ pluginId: "project-gutenberg" });
		const artifact = await host.acquire(plugin, { itemId: "item", optionId: "epub" }, quarantine);
		expect(artifact.sizeBytes).toBe(8);
		expect((await readFile(artifact.path)).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
		const requests = (await readFile(requestLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		expect(requests).toEqual([
			{ command: "describe", input: {}, protocolVersion: 1 },
			{ command: "search", input: { query: "test" }, protocolVersion: 1 },
			{ command: "detail", input: { itemId: "item" }, protocolVersion: 1 },
			{ command: "acquire", input: { itemId: "item", optionId: "epub", destinationPath: artifact.path }, protocolVersion: 1 },
		]);
		await writeFile(join(pluginDirectory, "index.mjs"), "process.stdout.write('{}\\n');");
		await expect(host.search(plugin, "changed")).rejects.toThrow("changed after discovery");
	});

	it("executes protocol-v2 capabilities with pre-spawn command and scope mediation", async () => {
		const root = await mkdtemp(resolve(".k-plugin-v2-test-"));
		temporaryPaths.push(root);
		const pluginId = "fixture-v2";
		const pluginDirectory = join(root, pluginId);
		const sharedDirectory = join(root, "lib");
		const launchMarker = join(root, "launched");
		await mkdir(pluginDirectory);
		await mkdir(sharedDirectory);
		await writeFile(join(sharedDirectory, "runtime.mjs"), await readFile("plugins/lib/runtime.mjs"));
		const manifest = {
			schemaVersion: 2, protocolVersion: 2, pluginId, displayName: "Fixture V2", version: "1.0.0", entrypoint: "index.mjs",
			runtime: { allowedHosts: ["metadata.example.invalid"], timeoutMs: 3000, maxRequestBytes: 4096, maxResponseBytes: 4096, maxArtifactBytes: 1024 },
			capabilities: [
				{ capabilityId: `${pluginId}/metadata`, family: "metadata-enricher", version: 1, commands: ["metadata.enrich"], authorization: { kind: "application", registrationId: "fixture-api" }, mediaKinds: ["book"] },
				{ capabilityId: `${pluginId}/open-metadata`, family: "metadata-enricher", version: 1, commands: ["metadata.enrich"], authorization: { kind: "none" }, mediaKinds: ["book"] },
				{ capabilityId: `${pluginId}/mail`, family: "mail-sender", version: 1, commands: ["mail.preflight", "mail.send"], authorization: { kind: "profile-oauth2", registrationId: "fixture-mail", requiredScopes: ["mail.send"] }, artifactMediaTypes: ["message/rfc822"] },
			],
			review: { policyRef: "docs/providers/policy.md", reviewedAt: "2026-07-18" },
		};
		await writeFile(join(pluginDirectory, "plugin.json"), JSON.stringify(manifest));
		await writeFile(join(pluginDirectory, "index.mjs"), `
			import { writeFile } from "node:fs/promises";
			import { runCapabilityPlugin } from "../lib/runtime.mjs";
			const manifest = ${JSON.stringify(manifest)};
			await writeFile(${JSON.stringify(launchMarker)}, "launched");
			await runCapabilityPlugin(manifest, {
				"fixture-v2/metadata": { "metadata.enrich": async (input, authorization) => {
					if (input.item.title === "secret-field") return { password: "must-not-leak" };
					if (input.item.title === "api-key-field") return { apiKey: "must-not-leak" };
					if (input.item.title === "private-key-field") return { private_key: "must-not-leak" };
					if (input.item.title === "reflection") return { summary: "prefix-" + authorization.value };
					if (input.item.title === "unsafe-url") return { informationLink: "https://evil.example/book" };
					if (input.item.title === "embedded-url") return { summary: "Read https://evil.example/book" };
					if (input.item.title === "credentialed-url") return { informationLink: "https://user:pass@metadata.example.invalid/book" };
					if (input.item.title === "deep") { let value = {}; for (let index = 0; index < 20; index += 1) value = { nested: value }; return value; }
					if (input.item.title === "too-many-properties") return Object.fromEntries(Array.from({ length: 101 }, (_, index) => ["field" + index, index]));
					if (input.item.title === "too-many-items") return { items: Array.from({ length: 1001 }, (_, index) => index) };
					if (input.item.title === "oversized") return { summary: "x".repeat(10000) };
					return { state: "matched", providerId: "fixture-v2", providerLabel: "Fixture V2", recordId: "record", mediaKind: "book", matchedBy: "title-creator", matchQuality: "exact-title-creator", fields: { title: input.item.title }, checkedAt: "2026-07-18T16:00:00Z", informationLink: "https://metadata.example.invalid/book" };
				} },
				"fixture-v2/open-metadata": { "metadata.enrich": async () => ({ state: "matched", providerId: "fixture-v2", providerLabel: "Fixture V2", recordId: "open", mediaKind: "book", matchedBy: "title-creator", matchQuality: "exact-title-creator", fields: { title: "Safe" }, checkedAt: "2026-07-18T16:00:00Z", informationLink: "https://metadata.example.invalid/book" }) },
				"fixture-v2/mail": { "mail.preflight": async () => ({ ready: true }) },
			});
		`);
		const plugin = discoverPlugins(root)[0]!;
		const host = new PluginHost("k-test");
		const metadataInput = (title: string, identifiers = []) => ({ mediaKind: "book" as const, item: { title, creators: ["Author"], identifiers } });

		const bearer = { kind: "bearer" as const, value: "fixture-bearer-token-value", expiresAt: "2099-01-01T00:00:00Z", grantedScopes: ["mail.send"] };
		await expect(host.invokeCapability(plugin, { capabilityId: `${pluginId}/unknown`, command: "metadata.enrich", input: metadataInput("safe") })).rejects.toThrow("does not declare");
		await expect(host.invokeCapability(plugin, { capabilityId: `${pluginId}/metadata`, command: "mail.preflight", input: { messageBytes: 1, attachmentBytes: 1 } })).rejects.toThrow("does not declare");
		await expect(host.invokeCapability(plugin, { capabilityId: `${pluginId}/metadata`, command: "metadata.enrich", input: metadataInput("safe") })).rejects.toThrow("requires an application credential");
		await expect(host.invokeCapability(plugin, { capabilityId: `${pluginId}/mail`, command: "mail.preflight", input: { messageBytes: 100, attachmentBytes: 50 } })).rejects.toThrow("requires a profile OAuth access token");
		await expect(host.invokeCapability(plugin, { authorization: { kind: "api-key", value: "fixture-api-key-value" }, capabilityId: `${pluginId}/open-metadata`, command: "metadata.enrich", input: metadataInput("safe") })).rejects.toThrow("does not accept authorization");
		await expect(host.invokeCapability(plugin, { authorization: { ...bearer, expiresAt: "2000-01-01T00:00:00Z" }, capabilityId: `${pluginId}/mail`, command: "mail.preflight", input: { messageBytes: 100, attachmentBytes: 50 } })).rejects.toThrow("access token is expired");
		await expect(host.invokeCapability(plugin, { authorization: { ...bearer, grantedScopes: [] }, capabilityId: `${pluginId}/mail`, command: "mail.preflight", input: { messageBytes: 100, attachmentBytes: 50 } })).rejects.toThrow("missing a required scope");
		await expect(readFile(launchMarker)).rejects.toThrow();

		const apiKey = "fixture-api-key-value";
		await expect(host.invokeCapability(plugin, { authorization: { kind: "api-key", value: apiKey }, capabilityId: `${pluginId}/metadata`, command: "metadata.enrich", input: metadataInput("safe") })).resolves.toMatchObject({ informationLink: "https://metadata.example.invalid/book" });
		await expect(host.invokeCapability(plugin, { capabilityId: `${pluginId}/open-metadata`, command: "metadata.enrich", input: metadataInput("safe") })).resolves.toMatchObject({ recordId: "open" });
		for (const title of ["secret-field", "api-key-field", "private-key-field"]) {
			await expect(host.invokeCapability(plugin, { authorization: { kind: "api-key", value: apiKey }, capabilityId: `${pluginId}/metadata`, command: "metadata.enrich", input: metadataInput(title) })).rejects.toThrow("protocol response is invalid");
		}
		await expect(host.invokeCapability(plugin, { authorization: { kind: "api-key", value: apiKey }, capabilityId: `${pluginId}/metadata`, command: "metadata.enrich", input: metadataInput("reflection") })).rejects.toThrow("reflected a credential");
		await expect(host.invokeCapability(plugin, { authorization: { kind: "api-key", value: apiKey }, capabilityId: `${pluginId}/metadata`, command: "metadata.enrich", input: metadataInput("unsafe-url") })).rejects.toThrow("unsafe URL");
		await expect(host.invokeCapability(plugin, { authorization: { kind: "api-key", value: apiKey }, capabilityId: `${pluginId}/metadata`, command: "metadata.enrich", input: metadataInput("embedded-url") })).rejects.toThrow("unsafe URL");
		await expect(host.invokeCapability(plugin, { authorization: { kind: "api-key", value: apiKey }, capabilityId: `${pluginId}/metadata`, command: "metadata.enrich", input: metadataInput("credentialed-url") })).rejects.toThrow("unsafe URL");
		await expect(host.invokeCapability(plugin, { authorization: { kind: "api-key", value: apiKey }, capabilityId: `${pluginId}/metadata`, command: "metadata.enrich", input: metadataInput("deep") })).rejects.toThrow("deeply nested");
		await expect(host.invokeCapability(plugin, { authorization: { kind: "api-key", value: apiKey }, capabilityId: `${pluginId}/metadata`, command: "metadata.enrich", input: metadataInput("too-many-properties") })).rejects.toThrow("protocol response is invalid");
		await expect(host.invokeCapability(plugin, { authorization: { kind: "api-key", value: apiKey }, capabilityId: `${pluginId}/metadata`, command: "metadata.enrich", input: metadataInput("too-many-items") })).rejects.toThrow("protocol response is invalid");
		await expect(host.invokeCapability(plugin, { authorization: { kind: "api-key", value: apiKey }, capabilityId: `${pluginId}/metadata`, command: "metadata.enrich", input: metadataInput("oversized") })).rejects.toThrow("response is too large");

		await expect(host.invokeCapability(plugin, { authorization: bearer, capabilityId: `${pluginId}/mail`, command: "mail.preflight", input: { messageBytes: 100, attachmentBytes: 50 } })).resolves.toEqual({ ready: true });

		const largeIdentifiers = Array.from({ length: 20 }, (_, index) => ({ scheme: "isbn-13", value: `${index}`.padEnd(128, "0") }));
		const largeInput = { mediaKind: "book" as const, item: { title: "large", creators: Array.from({ length: 20 }, (_, index) => `${index}`.padEnd(300, "a")), identifiers: largeIdentifiers } };
		await expect(host.invokeCapability(plugin, { authorization: { kind: "api-key", value: apiKey }, capabilityId: `${pluginId}/metadata`, command: "metadata.enrich", input: largeInput })).rejects.toThrow("request is too large");
	});

	it("rejects metadata-only acquisition before spawning the plugin", async () => {
		const root = await mkdtemp(join(tmpdir(), "k-metadata-only-acquire-test-"));
		temporaryPaths.push(root);
		const pluginDirectory = join(root, "unverified-book-source");
		const launchMarker = join(root, "launched");
		await mkdir(pluginDirectory);
		await writeFile(join(pluginDirectory, "plugin.json"), await readFile("tests/fixtures/plugins/unverified-book-source.v2.json"));
		await writeFile(join(pluginDirectory, "index.mjs"), `await import("node:fs/promises").then(({ writeFile }) => writeFile(${JSON.stringify(launchMarker)}, "launched"));`);
		const plugin = discoverPlugins(root)[0]!;
		await expect(new PluginHost("k-test").acquire(plugin, { itemId: "fixture-book", optionId: "forged" }, join(root, "quarantine"))).rejects.toThrow("blocked by core rights policy");
		await expect(readFile(launchMarker)).rejects.toThrow();
	});

	it("rejects mismatched v2 invocation IDs and never surfaces v2 stderr", async () => {
		const createManualPlugin = async (pluginId: string, entrypoint: string) => {
			const root = await mkdtemp(join(tmpdir(), `k-plugin-${pluginId}-`));
			temporaryPaths.push(root);
			const pluginDirectory = join(root, pluginId);
			await mkdir(pluginDirectory);
			const manifest = {
				schemaVersion: 2, protocolVersion: 2, pluginId, displayName: pluginId, version: "1.0.0", entrypoint: "index.mjs",
				runtime: { allowedHosts: ["metadata.example.invalid"], timeoutMs: 3000, maxRequestBytes: 4096, maxResponseBytes: 4096, maxArtifactBytes: 0 },
				capabilities: [{ capabilityId: `${pluginId}/metadata`, family: "metadata-enricher", version: 1, commands: ["metadata.enrich"], authorization: { kind: "application", registrationId: "fixture" }, mediaKinds: ["book"] }],
				review: { policyRef: "docs/providers/policy.md", reviewedAt: "2026-07-18" },
			};
			await writeFile(join(pluginDirectory, "plugin.json"), JSON.stringify(manifest));
			await writeFile(join(pluginDirectory, "index.mjs"), entrypoint);
			return discoverPlugins(root)[0]!;
		};
		const input = { mediaKind: "book" as const, item: { title: "Safe", creators: [], identifiers: [] } };
		const authorization = { kind: "api-key" as const, value: "fixture-api-key-value" };
		const mismatched = await createManualPlugin("mismatch-v2", `
			let source = ""; for await (const chunk of process.stdin) source += chunk;
			const request = JSON.parse(source);
			process.stdout.write(JSON.stringify({protocolVersion:2,invocationId:"550e8400-e29b-41d4-a716-446655440000",capabilityId:request.capabilityId,command:request.command,ok:true,result:{state:"no-match",providerId:"mismatch-v2",providerLabel:"Mismatch V2",mediaKind:"book",reasonCode:"NO_EXACT_MATCH",checkedAt:"2026-07-18T16:00:00Z"}}) + "\\n");
		`);
		await expect(new PluginHost("k-test").invokeCapability(mismatched, { authorization, capabilityId: "mismatch-v2/metadata", command: "metadata.enrich", input })).rejects.toThrow("does not match");

		const wrongCapability = await createManualPlugin("wrong-capability-v2", `
			let source = ""; for await (const chunk of process.stdin) source += chunk;
			const request = JSON.parse(source);
			process.stdout.write(JSON.stringify({protocolVersion:2,invocationId:request.invocationId,capabilityId:"other/metadata",command:request.command,ok:true,result:{state:"no-match",providerId:"wrong-capability-v2",providerLabel:"Wrong Capability V2",mediaKind:"book",reasonCode:"NO_EXACT_MATCH",checkedAt:"2026-07-18T16:00:00Z"}}) + "\\n");
		`);
		await expect(new PluginHost("k-test").invokeCapability(wrongCapability, { authorization, capabilityId: "wrong-capability-v2/metadata", command: "metadata.enrich", input })).rejects.toThrow("capability does not match");

		const multiple = await createManualPlugin("multiple-v2", `
			let source = ""; for await (const chunk of process.stdin) source += chunk;
			const request = JSON.parse(source);
			const response = JSON.stringify({protocolVersion:2,invocationId:request.invocationId,capabilityId:request.capabilityId,command:request.command,ok:true,result:{state:"no-match",providerId:"multiple-v2",providerLabel:"Multiple V2",mediaKind:"book",reasonCode:"NO_EXACT_MATCH",checkedAt:"2026-07-18T16:00:00Z"}});
			process.stdout.write(response + "\\n" + response + "\\n");
		`);
		await expect(new PluginHost("k-test").invokeCapability(multiple, { authorization, capabilityId: "multiple-v2/metadata", command: "metadata.enrich", input })).rejects.toThrow("exactly one JSON object");

		const stderrSecret = "stderr-secret-must-not-surface";
		const failed = await createManualPlugin("failed-v2", `process.stderr.write(${JSON.stringify(stderrSecret)}); process.exit(1);`);
		try {
			await new PluginHost("k-test").invokeCapability(failed, { authorization, capabilityId: "failed-v2/metadata", command: "metadata.enrich", input });
			throw new Error("expected v2 plugin failure");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe("plugin failed-v2 failed");
			expect((error as Error).message).not.toContain(stderrSecret);
		}
	});

	it("hashes the complete plugin and shared runtime trees deterministically", async () => {
		const createTree = async (order: "forward" | "reverse") => {
			const root = await mkdtemp(join(tmpdir(), `k-plugin-digest-${order}-`));
			temporaryPaths.push(root);
			const pluginDirectory = join(root, "fixture-source");
			const sharedDirectory = join(root, "lib");
			await mkdir(join(pluginDirectory, "nested"), { recursive: true });
			await mkdir(sharedDirectory);
			const entries = [
				[join(pluginDirectory, "plugin.json"), "{}"],
				[join(pluginDirectory, "index.mjs"), "export const value = 1;"],
				[join(pluginDirectory, "nested/helper.mjs"), "export const helper = true;"],
				[join(sharedDirectory, "runtime.mjs"), "export const runtime = true;"],
			] as const;
			for (const [path, content] of order === "forward" ? entries : [...entries].reverse()) await writeFile(path, content);
			return { entrypointPath: join(pluginDirectory, "index.mjs"), path: pluginDirectory };
		};
		const first = await createTree("forward");
		const second = await createTree("reverse");
		expect(currentPluginDigest(first)).toBe(currentPluginDigest(second));

		const original = currentPluginDigest(first);
		await writeFile(join(first.path, "nested/helper.mjs"), "export const helper = false;");
		expect(currentPluginDigest(first)).not.toBe(original);
		await writeFile(join(first.path, "nested/helper.mjs"), "export const helper = true;");
		await writeFile(join(first.path, "nested/added.mjs"), "export const added = true;");
		const added = currentPluginDigest(first);
		expect(added).not.toBe(original);
		await rename(join(first.path, "nested/added.mjs"), join(first.path, "nested/renamed.mjs"));
		expect(currentPluginDigest(first)).not.toBe(added);
		await rm(join(first.path, "nested/renamed.mjs"));
		expect(currentPluginDigest(first)).toBe(original);
		await writeFile(join(first.path, "../lib/runtime.mjs"), "export const runtime = false;");
		expect(currentPluginDigest(first)).not.toBe(original);
	});

	it("rejects integrity-tree symlinks and accepts only an unchanged legacy v1 snapshot", async () => {
		const exactRoot = await mkdtemp(join(tmpdir(), "k-plugin-legacy-exact-test-"));
		temporaryPaths.push(exactRoot);
		const exactPluginDirectory = join(exactRoot, "project-gutenberg");
		const exactSharedDirectory = join(exactRoot, "lib");
		await mkdir(exactPluginDirectory);
		await mkdir(exactSharedDirectory);
		await writeFile(join(exactPluginDirectory, "plugin.json"), await readFile("plugins/project-gutenberg/plugin.json"));
		await writeFile(join(exactPluginDirectory, "index.mjs"), "process.stdout.write('{}\\n');");
		await writeFile(join(exactSharedDirectory, "runtime.mjs"), "export const runtime = true;");
		const exactPlugin = discoverPlugins(exactRoot)[0]!;
		expect(exactPlugin.legacyDigest).not.toBeNull();
		expect(pluginDigestMatchesSnapshot(exactPlugin, exactPlugin.legacyDigest!)).toBe(true);

		const root = await mkdtemp(join(tmpdir(), "k-plugin-integrity-test-"));
		temporaryPaths.push(root);
		const pluginDirectory = join(root, "project-gutenberg");
		const sharedDirectory = join(root, "lib");
		await mkdir(join(pluginDirectory, "nested"), { recursive: true });
		await mkdir(sharedDirectory);
		await writeFile(join(pluginDirectory, "plugin.json"), await readFile("plugins/project-gutenberg/plugin.json"));
		await writeFile(join(pluginDirectory, "index.mjs"), "process.stdout.write('{}\\n');");
		await writeFile(join(sharedDirectory, "runtime.mjs"), "export const runtime = true;");
		await writeFile(join(pluginDirectory, "nested/helper.mjs"), "export const helper = true;");
		const plugin = discoverPlugins(root)[0]!;
		expect(plugin.legacyDigest).not.toBeNull();
		expect(pluginDigestMatchesSnapshot(plugin, plugin.legacyDigest!)).toBe(false);
		expect(pluginDigestMatchesSnapshot(plugin, plugin.digest)).toBe(true);

		await writeFile(join(pluginDirectory, "nested/helper.mjs"), "export const helper = false;");
		expect(pluginDigestIsCurrent(plugin)).toBe(false);
		expect(pluginDigestMatchesSnapshot(plugin, plugin.legacyDigest!)).toBe(false);
		await writeFile(join(pluginDirectory, "nested/helper.mjs"), "export const helper = true;");
		await symlink(join(pluginDirectory, "index.mjs"), join(pluginDirectory, "nested/link.mjs"));
		expect(() => currentPluginDigest(plugin)).toThrow("must not contain symlinks");
	});
});

function readFileSync(path: string, encoding: BufferEncoding) {
	return require("node:fs").readFileSync(path, encoding) as string;
}