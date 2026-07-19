import { pluginDigestIsCurrent } from "./manifests";
import type { CapabilityDescriptor, InstalledPlugin, PluginAcquisitionOption, ReviewedPublicInventory } from "./types";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

export type CatalogRightsDecision = {
	acquisitionOptions: PluginAcquisitionOption[];
	capability: "candidate" | "metadata-only";
	catalogCapability: CapabilityDescriptor | null;
	effectAuthorized: boolean;
	provenance: "unverified-provenance" | "verified-public-domain";
	reason: string;
	reasonCode: string;
	reviewedAt: string | null;
	state: "blocked" | "effect-authorized" | "metadata-only";
};

export interface CatalogEffectAuthorization {
	decision: CatalogRightsDecision;
	option: PluginAcquisitionOption;
}

function sameValues(actual: readonly string[] | undefined, expected: readonly string[]) {
	return actual !== undefined && actual.length === expected.length && expected.every((value) => actual.includes(value as never));
}

function blocked(reasonCode: string, reason: string): CatalogRightsDecision {
	return {
		acquisitionOptions: [],
		capability: "metadata-only",
		catalogCapability: null,
		effectAuthorized: false,
		provenance: "unverified-provenance",
		reason,
		reasonCode,
		reviewedAt: null,
		state: "blocked",
	};
}

function normalizeOptions(plugin: InstalledPlugin, rawItem: unknown): PluginAcquisitionOption[] {
	if (!rawItem || typeof rawItem !== "object") return [];
	const value = rawItem as { acquisitionOptions?: unknown };
	if (value.acquisitionOptions === undefined) return [];
	if (!Array.isArray(value.acquisitionOptions) || value.acquisitionOptions.length > 8) throw new Error("plugin returned invalid acquisition options");
	return value.acquisitionOptions.map((rawOption) => {
		if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) throw new Error("plugin returned an invalid acquisition option");
		const option = rawOption as Record<string, unknown>;
		if (!OPAQUE_ID.test(String(option.optionId ?? "")) || option.format !== "epub" || option.rightsBasis !== "public-domain") throw new Error("plugin returned an invalid acquisition option");
		const estimatedBytes = option.estimatedBytes === null || option.estimatedBytes === undefined
			? null
			: Number.isInteger(option.estimatedBytes) && Number(option.estimatedBytes) >= 0 && Number(option.estimatedBytes) <= plugin.normalized.runtime.maxArtifactBytes
				? Number(option.estimatedBytes)
				: null;
		return { estimatedBytes, format: "epub", optionId: String(option.optionId), rightsBasis: "public-domain" };
	});
}

function reviewedPublicDomain(plugin: InstalledPlugin, inventory: ReviewedPublicInventory | undefined, capability: CapabilityDescriptor) {
	if (!inventory || inventory.schemaVersion !== 1 || inventory.reviewRef !== "docs/providers/policy.md" || plugin.root !== "public" || !pluginDigestIsCurrent(plugin)) return null;
	const reviewed = inventory.plugins.find((candidate) => candidate.pluginId === plugin.normalized.pluginId);
	if (!reviewed || reviewed.digest !== plugin.digest || reviewed.schemaVersion !== plugin.normalized.schemaVersion || reviewed.protocolVersion !== plugin.normalized.protocolVersion) return null;
	if (reviewed.capabilities.length !== 1 || reviewed.capabilities[0]?.capabilityId !== capability.capabilityId || reviewed.capabilities[0].classification !== "public-domain-acquisition") return null;
	if (plugin.normalized.capabilities.filter((candidate) => candidate.family === "catalog-source" && candidate.mediaKinds?.includes("book")).length !== 1
		|| capability.authorization.kind !== "none"
		|| !sameValues(capability.commands, ["catalog.search", "catalog.detail", "catalog.acquire"])
		|| !sameValues(capability.mediaKinds, ["book"])
		|| !sameValues(capability.rightsBases, ["public-domain"])) return null;
	if (plugin.manifest.schemaVersion === 1) {
		if (plugin.manifest.rightsBasis !== "public-domain" || plugin.manifest.rightsReviewedAt !== reviewed.reviewedAt) return null;
	} else if (plugin.manifest.review.policyRef !== inventory.reviewRef || plugin.manifest.review.reviewedAt !== reviewed.reviewedAt) return null;
	return reviewed;
}

export function catalogRightsPolicy(plugin: InstalledPlugin, inventory?: ReviewedPublicInventory, rawItem?: unknown): CatalogRightsDecision {
	if (!pluginDigestIsCurrent(plugin)) return blocked("PLUGIN_INTEGRITY_FAILED", "Installed plugin changed after discovery.");
	const catalogCapabilities = plugin.normalized.capabilities.filter((capability) => capability.family === "catalog-source" && capability.mediaKinds?.includes("book"));
	if (catalogCapabilities.length !== 1) return blocked("CATALOG_CAPABILITY_AMBIGUOUS", "The plugin does not expose one unambiguous book catalog capability.");
	const capability = catalogCapabilities[0]!;
	if (capability.authorization.kind !== "none" || !sameValues(capability.mediaKinds, ["book"]) || !capability.commands.includes("catalog.search") || !capability.commands.includes("catalog.detail")) {
		return blocked("CATALOG_CAPABILITY_INVALID", "The plugin book catalog contract is not supported.");
	}

	const reviewed = reviewedPublicDomain(plugin, inventory, capability);
	if (reviewed) {
		return {
			acquisitionOptions: normalizeOptions(plugin, rawItem),
			capability: "candidate",
			catalogCapability: capability,
			effectAuthorized: true,
			provenance: "verified-public-domain",
			reason: "Core policy verified the reviewed public-domain source and current plugin digest.",
			reasonCode: "VERIFIED_PUBLIC_DOMAIN",
			reviewedAt: reviewed.reviewedAt,
			state: "effect-authorized",
		};
	}

	if (plugin.normalized.protocolVersion === 1) return blocked("PUBLIC_INVENTORY_REQUIRED", "Legacy sources require core-reviewed public inventory evidence.");
	if (!sameValues(capability.commands, capability.commands.includes("catalog.acquire")
		? ["catalog.search", "catalog.detail", "catalog.acquire"]
		: ["catalog.search", "catalog.detail"])) return blocked("CATALOG_CAPABILITY_INVALID", "The plugin book catalog contract is not supported.");
	if (!capability.commands.includes("catalog.acquire") && capability.rightsBases !== undefined) return blocked("CATALOG_CAPABILITY_INVALID", "A metadata-only source cannot declare acquisition rights.");
	if (rawItem && typeof rawItem === "object" && !Array.isArray(rawItem)) {
		const rawOptions = (rawItem as { acquisitionOptions?: unknown }).acquisitionOptions;
		if (rawOptions !== undefined && (!Array.isArray(rawOptions) || rawOptions.length > 0)) throw new Error("metadata-only source returned acquisition options");
	}

	const evidenceRequired = capability.rightsBases?.some((basis) => basis === "user-owned" || basis === "licensed-private");
	return {
		acquisitionOptions: [],
		capability: "metadata-only",
		catalogCapability: capability,
		effectAuthorized: false,
		provenance: "unverified-provenance",
		reason: evidenceRequired
			? "Profile-bound ownership or license evidence is not implemented; this source is metadata-only."
			: "Source provenance is not verified by core policy; acquisition is unavailable.",
		reasonCode: evidenceRequired ? "PROFILE_RIGHTS_EVIDENCE_REQUIRED" : "UNVERIFIED_PROVENANCE",
		reviewedAt: null,
		state: "metadata-only",
	};
}

function canonicalOption(value: unknown): PluginAcquisitionOption | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const option = value as Record<string, unknown>;
	if (Object.keys(option).sort().join("\0") !== ["estimatedBytes", "format", "optionId", "rightsBasis"].sort().join("\0")
		|| typeof option.optionId !== "string" || !OPAQUE_ID.test(option.optionId)
		|| option.format !== "epub" || option.rightsBasis !== "public-domain"
		|| !(option.estimatedBytes === null || Number.isInteger(option.estimatedBytes) && Number(option.estimatedBytes) >= 0)) return null;
	return { estimatedBytes: option.estimatedBytes as number | null, format: "epub", optionId: option.optionId, rightsBasis: "public-domain" };
}

function sameOption(left: PluginAcquisitionOption, right: PluginAcquisitionOption) {
	return left.optionId === right.optionId && left.format === right.format && left.rightsBasis === right.rightsBasis && left.estimatedBytes === right.estimatedBytes;
}

export function authorizeCatalogEffect(plugin: InstalledPlugin, inventory: ReviewedPublicInventory | undefined, item: unknown, expected: { itemId: string; optionId: string }): CatalogEffectAuthorization | null {
	const decision = catalogRightsPolicy(plugin, inventory, item);
	if (!decision.effectAuthorized || !item || typeof item !== "object" || Array.isArray(item)) return null;
	const value = item as Record<string, unknown>;
	if (value.pluginId !== plugin.normalized.pluginId || value.itemId !== expected.itemId || value.capability !== decision.capability
		|| value.capabilityReason !== decision.reason || value.provenance !== decision.provenance || !Array.isArray(value.acquisitionOptions)
		|| value.acquisitionOptions.length !== decision.acquisitionOptions.length) return null;
	const options = value.acquisitionOptions.map(canonicalOption);
	if (options.some((option) => option === null)) return null;
	for (const [index, option] of (options as PluginAcquisitionOption[]).entries()) {
		if (!sameOption(option, decision.acquisitionOptions[index]!)) return null;
	}
	const option = (options as PluginAcquisitionOption[]).find((candidate) => candidate.optionId === expected.optionId);
	return option ? { decision, option } : null;
}

export function catalogEffectSnapshotsMatch(plugin: InstalledPlugin, inventory: ReviewedPublicInventory | undefined, persisted: unknown, current: unknown, expected: { itemId: string; optionId: string }) {
	const persistedAuthorization = authorizeCatalogEffect(plugin, inventory, persisted, expected);
	const currentAuthorization = authorizeCatalogEffect(plugin, inventory, current, expected);
	if (!persistedAuthorization || !currentAuthorization) return false;
	return persistedAuthorization.decision.acquisitionOptions.length === currentAuthorization.decision.acquisitionOptions.length
		&& persistedAuthorization.decision.acquisitionOptions.every((option, index) => sameOption(option, currentAuthorization.decision.acquisitionOptions[index]!));
}