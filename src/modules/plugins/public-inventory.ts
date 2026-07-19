import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CapabilityDescriptor, InstalledPlugin, PublicPluginEffectClassification, ReviewedPublicInventory } from "./types";

const MAX_INVENTORY_BYTES = 32 * 1024;
const REVIEW_REF = "docs/providers/policy.md" as const;

const EXPECTED = [
	{ pluginId: "project-gutenberg", schemaVersion: 1, protocolVersion: 1, capabilities: [{ capabilityId: "project-gutenberg/catalog", classification: "public-domain-acquisition" }] },
	{ pluginId: "standard-ebooks", schemaVersion: 1, protocolVersion: 1, capabilities: [{ capabilityId: "standard-ebooks/catalog", classification: "public-domain-acquisition" }] },
	{ pluginId: "internet-archive", schemaVersion: 1, protocolVersion: 1, capabilities: [{ capabilityId: "internet-archive/catalog", classification: "public-domain-acquisition" }] },
	{ pluginId: "google-books", schemaVersion: 2, protocolVersion: 2, capabilities: [{ capabilityId: "google-books/metadata", classification: "metadata-only" }] },
	{ pluginId: "google-gmail", schemaVersion: 2, protocolVersion: 2, capabilities: [{ capabilityId: "google-gmail/identity", classification: "identity-only" }, { capabilityId: "google-gmail/mail", classification: "profile-bound-effect" }] },
	{ pluginId: "login-with-amazon", schemaVersion: 2, protocolVersion: 2, capabilities: [{ capabilityId: "login-with-amazon/identity", classification: "identity-only" }] },
] as const;

function object(value: unknown) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("public plugin inventory is invalid");
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
	if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error("public plugin inventory is invalid");
}

function exactStrings(value: unknown, expected: readonly string[]) {
	return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]);
}

function capabilityMatchesClassification(capability: CapabilityDescriptor, classification: PublicPluginEffectClassification) {
	switch (classification) {
		case "public-domain-acquisition":
			return capability.family === "catalog-source"
				&& capability.authorization.kind === "none"
				&& exactStrings(capability.commands, ["catalog.search", "catalog.detail", "catalog.acquire"])
				&& exactStrings(capability.mediaKinds, ["book"])
				&& exactStrings(capability.rightsBases, ["public-domain"]);
		case "metadata-only":
			return capability.family === "metadata-enricher"
				&& exactStrings(capability.commands, ["metadata.enrich"])
				&& exactStrings(capability.mediaKinds, ["book"])
				&& capability.rightsBases === undefined;
		case "identity-only":
			return capability.family === "identity-provider"
				&& exactStrings(capability.commands, ["identity.resolve"])
				&& capability.rightsBases === undefined;
		case "profile-bound-effect":
			return capability.family === "mail-sender"
				&& exactStrings(capability.commands, ["mail.preflight", "mail.send"])
				&& capability.rightsBases === undefined;
	}
}

export function loadReviewedPublicInventory(publicDirectory: string, installedPlugins: readonly InstalledPlugin[]): ReviewedPublicInventory {
	const path = resolve(publicDirectory, "public-inventory.json");
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INVENTORY_BYTES) throw new Error("public plugin inventory is invalid");
	const root = object(JSON.parse(readFileSync(path, "utf8")) as unknown);
	exactKeys(root, ["schemaVersion", "reviewRef", "plugins"]);
	if (root.schemaVersion !== 1 || root.reviewRef !== REVIEW_REF || !Array.isArray(root.plugins) || root.plugins.length !== EXPECTED.length) throw new Error("public plugin inventory is invalid");

	const snapshots = root.plugins.map((rawPlugin, index) => {
		const value = object(rawPlugin);
		exactKeys(value, ["pluginId", "schemaVersion", "protocolVersion", "reviewedAt", "capabilities"]);
		const expected = EXPECTED[index]!;
		if (value.pluginId !== expected.pluginId || value.schemaVersion !== expected.schemaVersion || value.protocolVersion !== expected.protocolVersion
			|| typeof value.reviewedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.reviewedAt)
			|| !Array.isArray(value.capabilities) || value.capabilities.length !== expected.capabilities.length) throw new Error("public plugin inventory is invalid");
		const capabilities = value.capabilities.map((rawCapability, capabilityIndex) => {
			const capability = object(rawCapability);
			exactKeys(capability, ["capabilityId", "classification"]);
			const expectedCapability = expected.capabilities[capabilityIndex]!;
			if (capability.capabilityId !== expectedCapability.capabilityId || capability.classification !== expectedCapability.classification) throw new Error("public plugin inventory is invalid");
			return { capabilityId: expectedCapability.capabilityId, classification: expectedCapability.classification };
		});
		const plugin = installedPlugins.find((candidate) => candidate.root === "public" && candidate.normalized.pluginId === expected.pluginId);
		if (!plugin || plugin.normalized.schemaVersion !== expected.schemaVersion || plugin.normalized.protocolVersion !== expected.protocolVersion
			|| !exactStrings(plugin.normalized.capabilities.map((capability) => capability.capabilityId), expected.capabilities.map((capability) => capability.capabilityId))) throw new Error("public plugin inventory is invalid");
		for (const [capabilityIndex, reviewedCapability] of capabilities.entries()) {
			if (!capabilityMatchesClassification(plugin.normalized.capabilities[capabilityIndex]!, reviewedCapability.classification)) throw new Error("public plugin inventory is invalid");
		}
		const reviewedAt = value.reviewedAt;
		if (plugin.manifest.schemaVersion === 1) {
			if (plugin.manifest.rightsReviewedAt !== reviewedAt) throw new Error("public plugin inventory is invalid");
		} else if (plugin.manifest.review.policyRef !== REVIEW_REF || plugin.manifest.review.reviewedAt !== reviewedAt) throw new Error("public plugin inventory is invalid");
		return { capabilities, digest: plugin.digest, pluginId: expected.pluginId, protocolVersion: expected.protocolVersion, reviewedAt, schemaVersion: expected.schemaVersion };
	});

	return { plugins: snapshots, reviewRef: REVIEW_REF, schemaVersion: 1 };
}