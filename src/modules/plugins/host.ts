import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { catalogSourceCapability, requirePluginCapability } from "./capabilities";
import { assertProtocolV2Envelope } from "./conformance";
import type { CapabilityCommand, CapabilityInvocationAuthorization, InstalledPlugin, PluginCatalogItem, PluginSearchResult, ReviewedPublicInventory } from "./types";
import { pluginDigestIsCurrent } from "./manifests";
import { catalogRightsPolicy } from "./rights-policy";

const MAX_STDERR_BYTES = 16 * 1024;
const EMBEDDED_URI = /(?:[a-z][a-z0-9+.-]*:\/\/|(?:blob|data|file|javascript|mailto|tel|urn|vbscript):)/i;

async function fileSha256(path: string) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

export class PluginHost {
	constructor(private readonly userAgent: string, private readonly publicInventory?: ReviewedPublicInventory) {}

	private execute<T>(plugin: InstalledPlugin, request: Record<string, unknown>, protocolVersion: 1 | 2, reflectedCredential?: string): Promise<T> {
		return new Promise((resolveInvoke, reject) => {
			if (!pluginDigestIsCurrent(plugin)) {
				reject(new Error(`plugin ${plugin.manifest.pluginId} changed after discovery`));
				return;
			}
			const serialized = `${JSON.stringify(request)}\n`;
			if (Buffer.byteLength(serialized, "utf8") > plugin.normalized.runtime.maxRequestBytes) {
				reject(new Error("plugin request is too large"));
				return;
			}
			const child = spawn(process.execPath, [plugin.entrypointPath], {
				cwd: plugin.path,
				env: { K_PLUGIN_USER_AGENT: this.userAgent, NODE_ENV: process.env.NODE_ENV ?? "production" },
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = Buffer.alloc(0);
			let stderr = Buffer.alloc(0);
			let settled = false;
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				child.kill("SIGKILL");
				reject(error);
			};
			const timeout = setTimeout(() => fail(new Error(`plugin ${plugin.manifest.pluginId} timed out`)), plugin.normalized.runtime.timeoutMs);
			child.stdout.on("data", (chunk: Buffer) => {
				stdout = Buffer.concat([stdout, chunk]);
				if (stdout.byteLength > plugin.normalized.runtime.maxResponseBytes) fail(new Error("plugin response is too large"));
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = Buffer.concat([stderr, chunk]);
				if (stderr.byteLength > MAX_STDERR_BYTES) fail(new Error("plugin diagnostics are too large"));
			});
			child.once("error", fail);
			child.once("close", (code) => {
				clearTimeout(timeout);
				if (settled) return;
				if (code !== 0) return fail(protocolVersion === 1
					? new Error(`plugin failed (${code}): ${stderr.toString("utf8").trim().slice(0, 300)}`)
					: new Error(`plugin ${plugin.manifest.pluginId} failed`));
				const text = stdout.toString("utf8").trim();
				if (!text || text.includes("\n")) return fail(new Error("plugin must return exactly one JSON object"));
				try {
					const parsed = JSON.parse(text) as { capabilityId?: string; command?: string; error?: { code?: string; message?: string }; invocationId?: string; ok?: boolean; result?: T };
					if (protocolVersion === 2) {
						if (parsed.ok === true && "result" in parsed) assertSafeV2Result(parsed.result, plugin.normalized.runtime.allowedHosts, reflectedCredential);
						assertProtocolV2Envelope(parsed);
						if (parsed.invocationId !== request.invocationId) throw new Error("plugin response invocation does not match request");
						if (parsed.ok === true && (parsed.capabilityId !== request.capabilityId || parsed.command !== request.command)) throw new Error("plugin response capability does not match request");
					}
					if (parsed.ok !== true || !("result" in parsed)) return fail(new Error(`plugin error: ${parsed.error?.code ?? "invalid_response"}`));
					settled = true;
					resolveInvoke(parsed.result as T);
				} catch (error) {
					fail(error instanceof Error ? error : new Error("invalid plugin JSON"));
				}
			});
			child.stdin.end(serialized);
		});
	}

	private invokeLegacy<T>(plugin: InstalledPlugin, command: string, input: Record<string, unknown>) {
		return this.execute<T>(plugin, { command, input, protocolVersion: 1 }, 1);
	}

	async invokeCapability<T>(plugin: InstalledPlugin, input: { authorization?: CapabilityInvocationAuthorization; capabilityId: string; command: CapabilityCommand; input: Record<string, unknown> }) {
		if (plugin.normalized.protocolVersion !== 2) throw new Error("canonical capability invocation requires a protocol-v2 plugin");
		if (input.command === "catalog.search" || input.command === "catalog.detail" || input.command === "catalog.acquire") {
			if (!pluginDigestIsCurrent(plugin)) throw new Error(`plugin ${plugin.manifest.pluginId} changed after discovery`);
			const decision = catalogRightsPolicy(plugin, this.publicInventory);
			if (decision.state === "blocked" || input.command === "catalog.acquire" && !decision.effectAuthorized) {
				throw new Error("plugin catalog command is blocked by core rights policy");
			}
		}
		const capability = requirePluginCapability(plugin, input.capabilityId, input.command);
		const authorization = authorizeCapability(capability.authorization, input.authorization);
		const request = {
			protocolVersion: 2,
			invocationId: randomUUID(),
			capabilityId: input.capabilityId,
			command: input.command,
			...(authorization ? { authorization } : {}),
			input: input.input,
		};
		assertProtocolV2Envelope(request);
		return this.execute<T>(plugin, request, 2, authorization?.value);
	}

	describe(plugin: InstalledPlugin) {
		if (plugin.normalized.protocolVersion !== 1) throw new Error("protocol-v2 plugins are described by their manifest");
		return this.invokeLegacy<Record<string, unknown>>(plugin, "describe", {});
	}

	async search(plugin: InstalledPlugin, query: string) {
		if (!pluginDigestIsCurrent(plugin)) throw new Error(`plugin ${plugin.manifest.pluginId} changed after discovery`);
		const decision = catalogRightsPolicy(plugin, this.publicInventory);
		if (decision.state === "blocked") throw new Error("plugin is not an authorized book catalog source");
		const capability = requireCatalogSource(plugin, "catalog.search");
		return plugin.normalized.protocolVersion === 1
			? this.invokeLegacy<PluginSearchResult>(plugin, "search", { query })
			: this.invokeCapability<PluginSearchResult>(plugin, { capabilityId: capability.capabilityId, command: "catalog.search", input: { mediaKind: "book", query } });
	}

	async detail(plugin: InstalledPlugin, itemId: string) {
		if (!pluginDigestIsCurrent(plugin)) throw new Error(`plugin ${plugin.manifest.pluginId} changed after discovery`);
		const decision = catalogRightsPolicy(plugin, this.publicInventory);
		if (decision.state === "blocked") throw new Error("plugin is not an authorized book catalog source");
		const capability = requireCatalogSource(plugin, "catalog.detail");
		return plugin.normalized.protocolVersion === 1
			? this.invokeLegacy<PluginCatalogItem>(plugin, "detail", { itemId })
			: this.invokeCapability<PluginCatalogItem>(plugin, { capabilityId: capability.capabilityId, command: "catalog.detail", input: { itemId, mediaKind: "book" } });
	}

	async acquire(plugin: InstalledPlugin, input: { itemId: string; optionId: string }, quarantineDirectory: string) {
		if (!pluginDigestIsCurrent(plugin)) throw new Error(`plugin ${plugin.manifest.pluginId} changed after discovery`);
		const decision = catalogRightsPolicy(plugin, this.publicInventory);
		if (!decision.effectAuthorized) throw new Error("plugin acquisition is blocked by core rights policy");
		const capability = requireCatalogSource(plugin, "catalog.acquire");
		await mkdir(quarantineDirectory, { recursive: true });
		const path = resolve(quarantineDirectory, `${randomUUID()}.part`);
		try {
			const result = plugin.normalized.protocolVersion === 1
				? await this.invokeLegacy<{ mediaType: string; sha256: string; sizeBytes: number }>(plugin, "acquire", { ...input, destinationPath: path })
				: await this.invokeCapability<{ mediaType: string; sha256: string; sizeBytes: number }>(plugin, { capabilityId: capability.capabilityId, command: "catalog.acquire", input: { ...input, destinationPath: path } });
			const info = await stat(path);
			if (!info.isFile() || info.size < 4 || info.size > plugin.normalized.runtime.maxArtifactBytes || info.size !== result.sizeBytes) throw new Error("plugin artifact size is invalid");
			const prefix = await readFile(path).then((content) => content.subarray(0, 4));
			if (!prefix.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) || result.mediaType !== "application/epub+zip") throw new Error("plugin artifact is not an EPUB ZIP");
			const digest = await fileSha256(path);
			if (digest !== result.sha256) throw new Error("plugin artifact hash mismatch");
			return { ...result, path };
		} catch (error) {
			await rm(path, { force: true });
			throw error;
		}
	}
}

function requireCatalogSource(plugin: InstalledPlugin, command: "catalog.acquire" | "catalog.detail" | "catalog.search") {
	const capability = catalogSourceCapability(plugin, "book");
	if (!capability || !capability.commands.includes(command)) throw new Error("plugin does not provide the required book catalog capability");
	return capability;
}

function authorizeCapability(requirement: import("./types").CapabilityAuthorization, authorization?: CapabilityInvocationAuthorization) {
	if (requirement.kind === "none") {
		if (authorization) throw new Error("plugin capability does not accept authorization");
		return undefined;
	}
	if (requirement.kind === "application") {
		if (authorization?.kind !== "api-key") throw new Error("plugin capability requires an application credential");
		return { kind: authorization.kind, value: authorization.value };
	}
	if (authorization?.kind !== "bearer") throw new Error("plugin capability requires a profile OAuth access token");
	if (new Date(authorization.expiresAt).getTime() <= Date.now()) throw new Error("plugin capability access token is expired");
	if (!requirement.requiredScopes.every((scope) => authorization.grantedScopes.includes(scope))) throw new Error("plugin capability access token is missing a required scope");
	return { expiresAt: authorization.expiresAt, kind: authorization.kind, value: authorization.value };
}

function hostAllowed(hostname: string, patterns: string[]) {
	return patterns.some((pattern) => pattern.startsWith("*.")
		? hostname.endsWith(pattern.slice(1)) && hostname !== pattern.slice(2)
		: hostname === pattern);
}

function assertSafeV2Result(value: unknown, allowedHosts: string[], reflectedCredential?: string, depth = 0, key = "result") {
	if (depth > 16) throw new Error("plugin response is too deeply nested");
	if (typeof value === "string") {
		if (reflectedCredential && value.includes(reflectedCredential)) throw new Error("plugin response reflected a credential");
		if (key === "informationLink") {
			let url: URL;
			try { url = new URL(value); } catch { throw new Error("plugin response contains an unsafe URL"); }
			if (url.protocol !== "https:" || url.username || url.password || !hostAllowed(url.hostname, allowedHosts)) throw new Error("plugin response contains an unsafe URL");
		} else if (EMBEDDED_URI.test(value)) throw new Error("plugin response contains an unsafe URL");
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) assertSafeV2Result(item, allowedHosts, reflectedCredential, depth + 1, key);
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [childKey, childValue] of Object.entries(value)) assertSafeV2Result(childValue, allowedHosts, reflectedCredential, depth + 1, childKey);
}