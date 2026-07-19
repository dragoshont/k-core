import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { sha256Hex } from "../common/crypto";
import { assertManifestConforms } from "./conformance";
import type { InstalledPlugin, NormalizedPluginManifest, PluginManifest } from "./types";

const MAX_MANIFEST_BYTES = 32 * 1024;
const PUBLIC_INVENTORY_FILE = "public-inventory.json";

export interface PluginRootDirectories {
	privateDirectory?: string;
	publicDirectory: string;
}

export function parsePluginManifest(source: string): PluginManifest {
	if (Buffer.byteLength(source, "utf8") > MAX_MANIFEST_BYTES) {
		throw new Error("plugin manifest is too large");
	}
	const value = JSON.parse(source) as unknown;
	assertManifestConforms(value);
	return value;
}

export function normalizePluginManifest(manifest: PluginManifest): NormalizedPluginManifest {
	if (manifest.schemaVersion === 1) {
		return {
			capabilities: [{
				authorization: { kind: "none" },
				capabilityId: `${manifest.pluginId}/catalog`,
				commands: ["catalog.search", "catalog.detail", "catalog.acquire"],
				family: "catalog-source",
				mediaKinds: ["book"],
				rightsBases: ["public-domain"],
				version: 1,
			}],
			displayName: manifest.displayName,
			entrypoint: manifest.entrypoint,
			pluginId: manifest.pluginId,
			protocolVersion: 1,
			runtime: {
				allowedHosts: manifest.allowedHosts,
				maxArtifactBytes: manifest.maxArtifactBytes,
				maxRequestBytes: 64 * 1024,
				maxResponseBytes: manifest.maxResponseBytes,
				timeoutMs: manifest.timeoutMs,
			},
			schemaVersion: 1,
			version: manifest.version,
		};
	}
	return {
		capabilities: manifest.capabilities,
		displayName: manifest.displayName,
		entrypoint: manifest.entrypoint,
		pluginId: manifest.pluginId,
		protocolVersion: 2,
		runtime: manifest.runtime,
		schemaVersion: 2,
		version: manifest.version,
	};
}

function isWithin(parent: string, child: string) {
	const path = relative(parent, child);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function resolveRoot(path: string) {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("plugin root must be a regular directory");
	return realpathSync(path);
}

function discoverRoot(root: string, ownership: InstalledPlugin["root"]) {
	const installed: InstalledPlugin[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
		if (entry.isSymbolicLink()) throw new Error("plugin root entries must not be symlinks");
		if (entry.name === "lib") {
			if (!entry.isDirectory()) throw new Error("plugin shared runtime must be a directory");
			regularFiles(resolve(root, entry.name), "shared");
			continue;
		}
		if (entry.name === PUBLIC_INVENTORY_FILE && ownership === "public") {
			if (!entry.isFile()) throw new Error("public plugin inventory must be a regular file");
			continue;
		}
		if (!entry.isDirectory()) throw new Error("plugin root contains an unexpected entry");
		const path = resolve(root, entry.name);
		const actualPath = realpathSync(path);
		if (!isWithin(root, actualPath) || actualPath === root) throw new Error("plugin directory escapes plugin root");
		const manifestPath = resolve(actualPath, "plugin.json");
		const manifestStat = lstatSync(manifestPath);
		if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("plugin manifest must be a regular file");
		const source = readFileSync(manifestPath, "utf8");
		const manifest = parsePluginManifest(source);
		if (basename(actualPath) !== manifest.pluginId) throw new Error(`plugin folder must match pluginId: ${manifest.pluginId}`);
		const entrypointPath = resolve(actualPath, manifest.entrypoint);
		const entrypointStat = lstatSync(entrypointPath);
		if (!entrypointStat.isFile() || entrypointStat.isSymbolicLink() || !isWithin(actualPath, realpathSync(entrypointPath)) || realpathSync(entrypointPath) === actualPath) throw new Error("plugin entrypoint must be a regular file inside its directory");
		installed.push({
			digest: currentPluginDigest({ entrypointPath, path: actualPath }),
			entrypointPath,
			legacyDigest: manifest.schemaVersion === 1 ? legacyPluginDigest({ entrypointPath, path: actualPath }) : null,
			manifest,
			normalized: normalizePluginManifest(manifest),
			path: actualPath,
			root: ownership,
		});
	}
	return installed;
}

export function discoverPlugins(input: PluginRootDirectories | string) {
	const directories = typeof input === "string" ? { publicDirectory: input } : input;
	const publicRoot = resolveRoot(directories.publicDirectory);
	const privateRoot = directories.privateDirectory ? resolveRoot(directories.privateDirectory) : undefined;
	if (privateRoot && (isWithin(publicRoot, privateRoot) || isWithin(privateRoot, publicRoot))) {
		throw new Error("plugin roots must not overlap");
	}

	const installed = [
		...discoverRoot(publicRoot, "public"),
		...(privateRoot ? discoverRoot(privateRoot, "private") : []),
	];
	const pluginIds = new Set<string>();
	const capabilityIds = new Set<string>();
	for (const plugin of installed) {
		for (const capability of plugin.normalized.capabilities) {
			if (capabilityIds.has(capability.capabilityId)) throw new Error(`duplicate capabilityId: ${capability.capabilityId}`);
			capabilityIds.add(capability.capabilityId);
		}
		if (pluginIds.has(plugin.normalized.pluginId)) throw new Error(`duplicate pluginId: ${plugin.normalized.pluginId}`);
		pluginIds.add(plugin.normalized.pluginId);
	}
	return installed;
}

function regularFiles(root: string, prefix: string) {
	if (!existsSync(root)) return [];
	const files: Array<{ label: string; path: string }> = [];
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = resolve(directory, entry.name);
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) throw new Error("plugin integrity tree must not contain symlinks");
			if (stat.isDirectory()) visit(path);
			else if (stat.isFile()) files.push({ label: `${prefix}/${relative(root, path).split(sep).join("/")}`, path });
			else throw new Error("plugin integrity tree contains a special file");
		}
	};
	visit(root);
	return files;
}

export function currentPluginDigest(plugin: Pick<InstalledPlugin, "entrypointPath" | "path">) {
	const hash = createHash("sha256");
	const sharedRuntimeRoot = resolve(plugin.path, "../lib");
	const files = [
		...regularFiles(plugin.path, "plugin"),
		...regularFiles(sharedRuntimeRoot, "shared"),
	].sort((left, right) => left.label.localeCompare(right.label));
	for (const file of files) {
		const label = Buffer.from(file.label, "utf8");
		const content = readFileSync(file.path);
		const framing = Buffer.allocUnsafe(8);
		framing.writeUInt32BE(label.byteLength, 0);
		framing.writeUInt32BE(content.byteLength, 4);
		hash.update(framing).update(label).update(content);
	}
	return hash.digest("hex");
}

export function legacyPluginDigest(plugin: Pick<InstalledPlugin, "entrypointPath" | "path">) {
	const manifestSource = readFileSync(resolve(plugin.path, "plugin.json"));
	const entrypointSource = readFileSync(plugin.entrypointPath);
	const sharedRuntimePath = resolve(plugin.path, "../lib/runtime.mjs");
	const sharedRuntimeSource = existsSync(sharedRuntimePath) ? readFileSync(sharedRuntimePath) : Buffer.alloc(0);
	return sha256Hex(Buffer.concat([manifestSource, Buffer.from("\0"), entrypointSource, Buffer.from("\0"), sharedRuntimeSource]));
}

export function pluginDigestIsCurrent(plugin: InstalledPlugin) {
	try {
		return currentPluginDigest(plugin) === plugin.digest;
	} catch {
		return false;
	}
}

function legacySnapshotIsStructurallyCompatible(plugin: InstalledPlugin) {
	if (plugin.manifest.schemaVersion !== 1) return false;
	const labels = [
		...regularFiles(plugin.path, "plugin"),
		...regularFiles(resolve(plugin.path, "../lib"), "shared"),
	].map((file) => file.label).sort();
	const entrypointLabel = `plugin/${relative(plugin.path, plugin.entrypointPath).split(sep).join("/")}`;
	return labels.length === 3
		&& labels.includes("plugin/plugin.json")
		&& labels.includes(entrypointLabel)
		&& labels.includes("shared/runtime.mjs");
}

export function pluginDigestMatchesSnapshot(plugin: InstalledPlugin, snapshotDigest: string) {
	if (!pluginDigestIsCurrent(plugin)) return false;
	return snapshotDigest === plugin.digest
		|| (snapshotDigest === plugin.legacyDigest && legacySnapshotIsStructurallyCompatible(plugin));
}