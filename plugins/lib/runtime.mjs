import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { isIP } from "node:net";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import ipaddr from "ipaddr.js";

const MAX_REQUEST_BYTES = 64 * 1024;

function hostAllowed(hostname, patterns) {
	return patterns.some((pattern) => pattern.startsWith("*.")
		? hostname.endsWith(pattern.slice(1)) && hostname !== pattern.slice(2)
		: hostname === pattern);
}

async function assertPublicHost(hostname) {
	if (isIP(hostname)) {
		const address = ipaddr.process(hostname);
		if (address.range() !== "unicast") throw new Error("source address is not public");
		return;
	}
	const addresses = await lookup(hostname, { all: true, verbatim: true });
	if (addresses.length === 0) throw new Error("source host did not resolve");
	for (const result of addresses) {
		if (ipaddr.process(result.address).range() !== "unicast") throw new Error("source host resolved to a non-public address");
	}
}

async function openResponse(input, { allowedHosts, headers = {}, maxRedirects = 0 }) {
	let url = new URL(input);
	for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
		if (url.protocol !== "https:" || !hostAllowed(url.hostname, allowedHosts)) throw new Error("source URL is outside the manifest policy");
		await assertPublicHost(url.hostname);
		const response = await fetch(url, { headers: { accept: "*/*", "user-agent": process.env.K_PLUGIN_USER_AGENT ?? "k-plugin/1", ...headers }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location || redirect === maxRedirects) throw new Error("source redirect is not allowed");
			url = new URL(location, url);
			continue;
		}
		if (!response.ok) throw new Error(`source returned ${response.status}`);
		return response;
	}
	throw new Error("source redirect limit exceeded");
}

async function boundedBytes(response, maxBytes) {
	const declared = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
	if (declared > maxBytes) throw new Error("source response is too large");
	const reader = response.body?.getReader();
	if (!reader) return Buffer.alloc(0);
	const chunks = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel().catch(() => undefined);
			throw new Error("source response is too large");
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks, size);
}

export async function fetchText(url, policy) {
	const response = await openResponse(url, policy);
	return (await boundedBytes(response, policy.maxBytes)).toString("utf8");
}

export async function downloadFile(url, destinationPath, policy) {
	const response = await openResponse(url, policy);
	const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	if (contentType !== "application/epub+zip" && contentType !== "application/octet-stream") throw new Error("source did not return an EPUB");
	const reader = response.body?.getReader();
	if (!reader) throw new Error("source returned no body");
	const output = createWriteStream(destinationPath, { flags: "wx", mode: 0o600 });
	const hash = createHash("sha256");
	let sizeBytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			sizeBytes += value.byteLength;
			if (sizeBytes > policy.maxBytes) throw new Error("source artifact is too large");
			hash.update(value);
			if (!output.write(value)) await once(output, "drain");
		}
		output.end();
		await once(output, "close");
		return { mediaType: "application/epub+zip", sha256: hash.digest("hex"), sizeBytes };
	} catch (error) {
		output.destroy();
		await rm(destinationPath, { force: true });
		throw error;
	}
}

export async function runPlugin(descriptor, handlers) {
	let source = "";
	for await (const chunk of process.stdin) {
		source += chunk;
		if (Buffer.byteLength(source, "utf8") > MAX_REQUEST_BYTES) throw new Error("plugin request is too large");
	}
	try {
		const request = JSON.parse(source);
		if (request.protocolVersion !== 1 || typeof request.command !== "string" || !request.input || typeof request.input !== "object") throw new Error("invalid plugin request");
		const result = request.command === "describe" ? descriptor : await handlers[request.command]?.(request.input);
		if (result === undefined) throw new Error("unsupported plugin command");
		process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
	} catch (error) {
		process.stdout.write(`${JSON.stringify({ error: { code: "plugin_failed", message: error instanceof Error ? error.message : "plugin failed" }, ok: false })}\n`);
	}
}

export async function runCapabilityPlugin(manifest, handlers) {
	let source = "";
	const maximum = Math.min(manifest?.runtime?.maxRequestBytes ?? MAX_REQUEST_BYTES, 1024 * 1024);
	for await (const chunk of process.stdin) {
		source += chunk;
		if (Buffer.byteLength(source, "utf8") > maximum) throw new Error("plugin request is too large");
	}
	let invocationId = randomUUID();
	try {
		const request = JSON.parse(source);
		if (request.protocolVersion !== 2 || typeof request.invocationId !== "string" || typeof request.capabilityId !== "string" || typeof request.command !== "string" || !request.input || typeof request.input !== "object") throw new Error("invalid plugin request");
		invocationId = request.invocationId;
		const capability = manifest.capabilities?.find((candidate) => candidate.capabilityId === request.capabilityId);
		if (!capability || !capability.commands?.includes(request.command)) throw new Error("unsupported plugin command");
		if (capability.authorization?.kind === "none" && request.authorization !== undefined) throw new Error("authorization is not accepted");
		if (capability.authorization?.kind === "application" && request.authorization?.kind !== "api-key") throw new Error("application authorization is required");
		if (capability.authorization?.kind === "profile-oauth2" && request.authorization?.kind !== "bearer") throw new Error("profile authorization is required");
		const result = await handlers[request.capabilityId]?.[request.command]?.(request.input, request.authorization);
		if (result === undefined) throw new Error("unsupported plugin command");
		process.stdout.write(`${JSON.stringify({ protocolVersion: 2, invocationId, capabilityId: request.capabilityId, command: request.command, ok: true, result })}\n`);
	} catch {
		process.stdout.write(`${JSON.stringify({ protocolVersion: 2, invocationId, ok: false, error: { code: "plugin_failed", message: "Plugin invocation failed.", retryable: false } })}\n`);
	}
}

export function isPluginMain(importMetaUrl) {
	return Boolean(process.argv[1]) && importMetaUrl === pathToFileURL(process.argv[1]).href;
}