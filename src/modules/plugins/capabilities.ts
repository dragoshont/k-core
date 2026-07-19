import type { CapabilityCommand, CapabilityDescriptor, InstalledPlugin, MediaKind } from "./types";

export function pluginCapability(plugin: InstalledPlugin, capabilityId: string) {
	return plugin.normalized.capabilities.find((capability) => capability.capabilityId === capabilityId) ?? null;
}

export function requirePluginCapability(plugin: InstalledPlugin, capabilityId: string, command: CapabilityCommand) {
	const capability = pluginCapability(plugin, capabilityId);
	if (!capability || !capability.commands.includes(command)) throw new Error("plugin capability does not declare this command");
	return capability;
}

export function catalogSourceCapability(plugin: InstalledPlugin, mediaKind: MediaKind = "book") {
	const capabilities = plugin.normalized.capabilities.filter((capability) => capability.family === "catalog-source"
		&& capability.mediaKinds?.includes(mediaKind)
		&& capability.commands.includes("catalog.search"));
	return capabilities.length === 1 ? capabilities[0]! : null;
}

export function metadataEnricherCapability(plugin: InstalledPlugin, mediaKind: MediaKind = "book") {
	const capabilities = plugin.normalized.capabilities.filter((capability) => capability.family === "metadata-enricher"
		&& capability.mediaKinds?.includes(mediaKind)
		&& capability.commands.length === 1
		&& capability.commands[0] === "metadata.enrich");
	return capabilities.length === 1 ? capabilities[0]! : null;
}

export function googleBooksMetadataCapability(plugin: InstalledPlugin) {
	const capability = metadataEnricherCapability(plugin, "book");
	return plugin.normalized.pluginId === "google-books"
		&& capability?.capabilityId === "google-books/metadata"
		&& capability.authorization.kind === "application"
		&& capability.authorization.registrationId === "google-books-api"
		? capability
		: null;
}

export function legacyCatalogCapabilities(capability: CapabilityDescriptor) {
	return [
		capability.commands.includes("catalog.search") ? "search" as const : null,
		capability.commands.includes("catalog.detail") ? "detail" as const : null,
		capability.commands.includes("catalog.acquire") ? "acquire" as const : null,
	].filter((value): value is "acquire" | "detail" | "search" => value !== null);
}