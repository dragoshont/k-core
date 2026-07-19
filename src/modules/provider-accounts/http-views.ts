import type { ProfilePluginView } from "../plugins/catalog";
import { googleBooksMetadataCapability } from "../plugins/capabilities";
import { pluginDigestIsCurrent } from "../plugins/manifests";
import type { CapabilityDescriptor, InstalledPlugin, MediaKind } from "../plugins/types";
import type { ProviderAccountListView } from "./service";
import type { ProviderConnectorId, ProviderRuntimeConfigState } from "./types";

export interface EvidenceStamp {
	checkedAt: string;
	freshness: "fresh" | "not-applicable" | "stale";
	scope: { id: string | null; kind: "destination" | "operation" | "profile" | "public-catalog" };
	sourceId: string;
	sourceKind: "cached-api" | "live-api" | "operation-record" | "profile-record" | "static-policy";
	sourceLabel: string;
}

export interface AccountConnectionView {
	accountId: string | null;
	authorizationPending: boolean;
	canConnect: boolean;
	canDisconnect: false;
	canReconnect: boolean;
	capabilities: ["identity-only"];
	connectedAt: string | null;
	connectorId: ProviderConnectorId;
	displayName: string;
	evidence: EvidenceStamp;
	grantedScopes: string[];
	lastValidatedAt: string | null;
	maskedAccount: string | null;
	providerAvailability: "available" | "configuration-required";
	reason: string;
	reasonCode: string;
	revision: number;
	state: "connected" | "connecting" | "error" | "expired-or-revoked" | "not-configured";
}

export interface CapabilityView {
	capabilityId: string;
	displayName: string;
	evidence: EvidenceStamp;
	family: "catalog-source" | "identity-provider" | "metadata-enricher" | "provider-policy";
	installed: boolean;
	maturity: "policy-only" | "stable";
	mediaKinds: MediaKind[];
	pluginId: string | null;
	provenance?: "unverified-provenance" | "verified-public-domain";
	providerAvailability: "available" | "configuration-required" | "eligibility-required" | "not-exposed" | "unavailable" | "unsupported";
	reason: string;
	reasonCode: string;
	version: number;
}

const CONNECTORS: Record<ProviderConnectorId, { displayName: string; unconfiguredReason: string }> = {
	"google-gmail": {
		displayName: "Google",
		unconfiguredReason: "The operator must register the exact Google callback before accounts can connect.",
	},
	"login-with-amazon": {
		displayName: "Login with Amazon",
		unconfiguredReason: "The operator must register the exact Login with Amazon callback before accounts can connect.",
	},
};

const CONNECTOR_IDS = Object.keys(CONNECTORS) as ProviderConnectorId[];

export function configuredProviderConnectorIds(config: ProviderRuntimeConfigState | undefined) {
	return config?.configured
		? config.registrations.map((registration) => registration.connectorId)
		: [];
}

function accountReason(connectorId: ProviderConnectorId, state: AccountConnectionView["state"], configured: boolean) {
	if (!configured) {
		return { code: "CONNECTOR_CONFIGURATION_REQUIRED", text: CONNECTORS[connectorId].unconfiguredReason };
	}
	if (state === "connecting") {
		return { code: "AUTHORIZATION_PENDING", text: "The identity authorization response has not completed." };
	}
	if (state === "connected") {
		return connectorId === "google-gmail"
			? { code: "ACCOUNT_CONNECTED", text: "Google identity is connected to this profile. It does not enable Gmail sending." }
			: { code: "ACCOUNT_CONNECTED", text: "Identity only. Kindle purchases, library access, and Kindle Unlimited are not exposed." };
	}
	if (state === "expired-or-revoked") {
		return { code: "ACCOUNT_REAUTHORIZATION_REQUIRED", text: "The identity grant expired or was revoked. Reconnect to replace it." };
	}
	if (state === "error") {
		return { code: "ACCOUNT_ERROR", text: "The identity connection could not be validated. Reconnect to replace it." };
	}
	return connectorId === "google-gmail"
		? { code: "ACCOUNT_NOT_CONNECTED", text: "Connect Google identity to this profile. It does not enable Gmail sending." }
		: { code: "ACCOUNT_NOT_CONNECTED", text: "Connect Login with Amazon for identity only. Kindle purchases, library access, and Kindle Unlimited are not exposed." };
}

export function buildAccountConnectionViews(input: {
	accountRows: readonly ProviderAccountListView[];
	authorizationAvailable: boolean;
	checkedAt?: string;
	configuredConnectorIds: readonly ProviderConnectorId[];
	profileId: string;
}): AccountConnectionView[] {
	const checkedAt = input.checkedAt ?? new Date().toISOString();
	const configured = new Set(input.configuredConnectorIds);
	const rows = new Map(input.accountRows.map((row) => [row.connectorId, row]));
	return CONNECTOR_IDS.map((connectorId) => {
		const row = rows.get(connectorId);
		const connectorConfigured = configured.has(connectorId);
		const state = row?.state ?? "not-configured";
		const authorizationPending = row?.authorizationPending ?? false;
		const accountId = row?.accountId ?? null;
		const reason = accountReason(connectorId, state, connectorConfigured);
		return {
			accountId,
			authorizationPending,
			canConnect: connectorConfigured && input.authorizationAvailable && state === "not-configured" && !authorizationPending,
			canDisconnect: false,
			canReconnect: connectorConfigured && input.authorizationAvailable && accountId !== null && !authorizationPending,
			capabilities: ["identity-only"],
			connectedAt: row?.connectedAt ?? null,
			connectorId,
			displayName: CONNECTORS[connectorId].displayName,
			evidence: {
				checkedAt,
				freshness: "fresh",
				scope: { id: input.profileId, kind: "profile" },
				sourceId: connectorConfigured ? "provider-account-record" : "provider-configuration",
				sourceKind: connectorConfigured ? "profile-record" : "static-policy",
				sourceLabel: connectorConfigured ? "Provider account record" : "Deployment capability inventory",
			},
			grantedScopes: [...(row?.grantedScopes ?? [])],
			lastValidatedAt: row?.lastValidatedAt ?? null,
			maskedAccount: row?.maskedAccount ?? null,
			providerAvailability: connectorConfigured ? "available" : "configuration-required",
			reason: reason.text,
			reasonCode: reason.code,
			revision: row?.revision ?? 0,
			state,
		};
	});
}

function capabilityEvidence(checkedAt: string, sourceId = "capability-inventory", sourceLabel = "Deployment capability inventory"): EvidenceStamp {
	return {
		checkedAt,
		freshness: "fresh",
		scope: { id: null, kind: "public-catalog" },
		sourceId,
		sourceKind: "static-policy",
		sourceLabel,
	};
}

function installedCapability(installedPlugins: readonly InstalledPlugin[], capabilityId: string) {
	for (const plugin of installedPlugins) {
		const capability = plugin.normalized.capabilities.find((candidate) => candidate.capabilityId === capabilityId);
		if (capability) return { capability, plugin };
	}
	return null;
}

function catalogCapability(installedPlugins: readonly InstalledPlugin[], pluginId: string): CapabilityDescriptor | null {
	return installedPlugins
		.find((plugin) => plugin.normalized.pluginId === pluginId)
		?.normalized.capabilities.find((capability) => capability.family === "catalog-source") ?? null;
}

export function buildCapabilityViews(input: {
	checkedAt?: string;
	configuredConnectorIds: readonly ProviderConnectorId[];
	googleBooksConfigured?: boolean;
	installedPlugins: readonly InstalledPlugin[];
	plugins: readonly ProfilePluginView[];
}): { checkedAt: string; items: CapabilityView[] } {
	const checkedAt = input.checkedAt ?? new Date().toISOString();
	const configured = new Set(input.configuredConnectorIds);
	const catalogRows: CapabilityView[] = input.plugins.map((plugin) => {
		const capability = catalogCapability(input.installedPlugins, plugin.pluginId);
		const providerAvailability = plugin.support === "available"
			? "available" as const
			: plugin.support === "unavailable"
				? "unavailable" as const
				: "configuration-required" as const;
		return {
			capabilityId: capability?.capabilityId ?? `${plugin.pluginId}/catalog`,
			displayName: plugin.displayName,
			evidence: capabilityEvidence(checkedAt, plugin.pluginId, plugin.displayName),
			family: "catalog-source",
			installed: true,
			maturity: "stable",
			mediaKinds: capability?.mediaKinds ? [...capability.mediaKinds] : ["book"],
			pluginId: plugin.pluginId,
			provenance: plugin.provenance,
			providerAvailability,
			reason: plugin.reason ?? (providerAvailability === "available" ? "Installed source capability is available." : "Installed source capability is not available."),
			reasonCode: providerAvailability === "available" ? plugin.reasonCode : providerAvailability === "unavailable" ? "INSTALLED_PLUGIN_UNAVAILABLE" : "INSTALLED_PLUGIN_CONFIGURATION_REQUIRED",
			version: capability?.version ?? 1,
		};
	});

	const googleBooksMatches = input.installedPlugins.flatMap((plugin) => {
		const capability = googleBooksMetadataCapability(plugin);
		return capability ? [{ capability, plugin }] : [];
	});
	const googleBooks = googleBooksMatches.length === 1 ? googleBooksMatches[0]! : null;
	const googleBooksAvailable = Boolean(googleBooks && pluginDigestIsCurrent(googleBooks.plugin) && input.googleBooksConfigured);
	const identityRows = ([
		{ capabilityId: "google-gmail/identity", connectorId: "google-gmail", displayName: "Google identity" },
		{ capabilityId: "login-with-amazon/identity", connectorId: "login-with-amazon", displayName: "Login with Amazon identity" },
	] as const).map(({ capabilityId, connectorId, displayName }): CapabilityView => {
		const installed = installedCapability(input.installedPlugins, capabilityId);
		const available = installed !== null && configured.has(connectorId);
		return {
			capabilityId,
			displayName,
			evidence: capabilityEvidence(checkedAt),
			family: "identity-provider",
			installed: installed !== null,
			maturity: "stable",
			mediaKinds: [],
			pluginId: connectorId,
			providerAvailability: available ? "available" : "configuration-required",
			reason: available ? "Configured for identity-only account connections." : CONNECTORS[connectorId].unconfiguredReason,
			reasonCode: available ? "IDENTITY_PROVIDER_AVAILABLE" : "CONNECTOR_CONFIGURATION_REQUIRED",
			version: installed?.capability.version ?? 1,
		};
	});

	const providerRows: CapabilityView[] = [
		{
			capabilityId: "google-books/metadata",
			displayName: "Google Books metadata",
			evidence: capabilityEvidence(checkedAt),
			family: "metadata-enricher",
			installed: googleBooks !== null,
			maturity: "stable",
			mediaKinds: ["book"],
			pluginId: "google-books",
			providerAvailability: googleBooksAvailable ? "available" : "configuration-required",
			reason: googleBooksAvailable ? "Configured Google Books metadata enrichment is available." : "Install the current reviewed Google Books plugin and configure its deployment API key.",
			reasonCode: googleBooksAvailable ? "PROVIDER_AVAILABLE" : "CONNECTOR_CONFIGURATION_REQUIRED",
			version: googleBooks?.capability.version ?? 1,
		},
		...identityRows,
		{
			capabilityId: "provider-policy/goodreads-reviews",
			displayName: "Goodreads reviews",
			evidence: { ...capabilityEvidence(checkedAt, "provider-policy", "Provider policy"), freshness: "not-applicable" },
			family: "provider-policy",
			installed: false,
			maturity: "policy-only",
			mediaKinds: ["book"],
			pluginId: null,
			providerAvailability: "unsupported",
			reason: "Goodreads has no supported new API integration and no scraping fallback.",
			reasonCode: "GOODREADS_API_UNAVAILABLE",
			version: 1,
		},
		{
			capabilityId: "provider-policy/amazon-product-availability",
			displayName: "Amazon product availability",
			evidence: { ...capabilityEvidence(checkedAt, "provider-policy", "Provider policy"), freshness: "not-applicable" },
			family: "provider-policy",
			installed: false,
			maturity: "policy-only",
			mediaKinds: ["book"],
			pluginId: null,
			providerAvailability: "eligibility-required",
			reason: "Current Amazon Creators API eligibility and reviewed fixtures are required.",
			reasonCode: "AMAZON_CREATORS_ELIGIBILITY_REQUIRED",
			version: 1,
		},
		{
			capabilityId: "provider-policy/kindle-unlimited",
			displayName: "Kindle Unlimited entitlement",
			evidence: { ...capabilityEvidence(checkedAt, "provider-policy", "Provider policy"), freshness: "not-applicable" },
			family: "provider-policy",
			installed: false,
			maturity: "policy-only",
			mediaKinds: ["book"],
			pluginId: null,
			providerAvailability: "not-exposed",
			reason: "No supported API exposes a trustworthy Kindle Unlimited entitlement signal.",
			reasonCode: "KINDLE_UNLIMITED_NOT_EXPOSED",
			version: 1,
		},
	];
	return { checkedAt, items: [...catalogRows, ...providerRows] };
}