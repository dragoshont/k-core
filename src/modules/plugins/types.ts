export const LEGACY_PLUGIN_PROTOCOL_VERSION = 1;
export const CAPABILITY_PLUGIN_PROTOCOL_VERSION = 2;
export const PLUGIN_PROTOCOL_VERSION = LEGACY_PLUGIN_PROTOCOL_VERSION;

export type PluginCapability = "acquire" | "detail" | "search";
export type CapabilityFamily = "catalog-source" | "delivery-destination" | "identity-provider" | "mail-sender" | "metadata-enricher";
export type CapabilityCommand =
	| "catalog.acquire"
	| "catalog.detail"
	| "catalog.search"
	| "destination.deliver"
	| "destination.preflight"
	| "destination.reconcile"
	| "identity.resolve"
	| "mail.preflight"
	| "mail.send"
	| "metadata.enrich";
export type MediaKind = "book" | "movie";
export type BookIdentifierScheme = "isbn-10" | "isbn-13" | "lccn" | "oclc";
export type ProviderAvailability = "available" | "configuration-required" | "eligibility-required" | "not-exposed" | "unavailable" | "unsupported";

export type CapabilityAuthorization =
	| { kind: "application"; registrationId: string }
	| { kind: "none" }
	| { kind: "profile-oauth2"; registrationId: string; requiredScopes: string[] };

export interface CapabilityDescriptor {
	artifactMediaTypes?: string[];
	authorization: CapabilityAuthorization;
	capabilityId: string;
	commands: CapabilityCommand[];
	family: CapabilityFamily;
	mediaKinds?: MediaKind[];
	rightsBases?: Array<"licensed-private" | "public-domain" | "user-owned">;
	version: 1;
}

export interface SourcePluginManifestV1 {
	allowedHosts: string[];
	capabilities: PluginCapability[];
	displayName: string;
	entrypoint: string;
	formats: ["epub"];
	maxArtifactBytes: number;
	maxResponseBytes: number;
	pluginId: string;
	protocolVersion: 1;
	rightsBasis: "public-domain";
	rightsJurisdiction: string;
	rightsReviewedAt: string;
	schemaVersion: 1;
	timeoutMs: number;
	version: string;
}

export interface CapabilityPluginManifestV2 {
	capabilities: CapabilityDescriptor[];
	displayName: string;
	entrypoint: string;
	pluginId: string;
	protocolVersion: 2;
	review: {
		policyRef: "docs/providers/policy.md";
		reviewedAt: string;
	};
	runtime: {
		allowedHosts: string[];
		maxArtifactBytes: number;
		maxRequestBytes: number;
		maxResponseBytes: number;
		timeoutMs: number;
	};
	schemaVersion: 2;
	version: string;
}

export type PluginManifest = CapabilityPluginManifestV2 | SourcePluginManifestV1;

export interface NormalizedPluginRuntime {
	allowedHosts: string[];
	maxArtifactBytes: number;
	maxRequestBytes: number;
	maxResponseBytes: number;
	timeoutMs: number;
}

export interface NormalizedPluginManifest {
	capabilities: CapabilityDescriptor[];
	displayName: string;
	entrypoint: string;
	pluginId: string;
	protocolVersion: 1 | 2;
	runtime: NormalizedPluginRuntime;
	schemaVersion: 1 | 2;
	version: string;
}

export interface InstalledPlugin {
	digest: string;
	entrypointPath: string;
	legacyDigest: string | null;
	manifest: PluginManifest;
	normalized: NormalizedPluginManifest;
	path: string;
	root: "private" | "public";
}

export type PublicPluginEffectClassification = "identity-only" | "metadata-only" | "profile-bound-effect" | "public-domain-acquisition";

export interface ReviewedPublicCapability {
	capabilityId: string;
	classification: PublicPluginEffectClassification;
}

export interface ReviewedPublicPlugin {
	capabilities: ReviewedPublicCapability[];
	digest: string;
	pluginId: string;
	protocolVersion: 1 | 2;
	reviewedAt: string;
	schemaVersion: 1 | 2;
}

export interface ReviewedPublicInventory {
	plugins: ReviewedPublicPlugin[];
	reviewRef: "docs/providers/policy.md";
	schemaVersion: 1;
}

export interface PluginAcquisitionOption {
	estimatedBytes: number | null;
	format: "epub";
	optionId: string;
	rightsBasis: "public-domain";
}

export interface PluginCatalogItem {
	acquisitionOptions: PluginAcquisitionOption[];
	authors: string[];
	capability: "candidate" | "deliverable";
	capabilityReason: string;
	checkedAt: string;
	identifiers?: Array<{ scheme: BookIdentifierScheme; value: string }>;
	itemId: string;
	language: string | null;
	pluginId: string;
	publishedYear: number | null;
	source: string;
	title: string;
}

export interface PluginSearchResult {
	items: PluginCatalogItem[];
	query: string;
	searchedAt: string;
}

export interface PluginIdentityResult {
	checkedAt: string;
	maskedAccount: string | null;
	providerId: string;
	subject: string;
}

export interface PluginMetadataFields {
	averageRating?: number;
	categories?: string[];
	creators?: string[];
	description?: string;
	pageCount?: number;
	publishedDate?: string;
	publisher?: string;
	ratingsCount?: number;
	subtitle?: string;
	title?: string;
}

export type PluginMetadataResult = {
	checkedAt: string;
	mediaKind: "book";
	providerId: string;
	providerLabel: string;
	reasonCode: "AMBIGUOUS_MATCH" | "NO_EXACT_MATCH";
	state: "no-match";
} | {
	checkedAt: string;
	fields: PluginMetadataFields;
	informationLink: string;
	matchedBy: BookIdentifierScheme | "title-creator";
	matchQuality: "exact-identifier" | "exact-title-creator";
	mediaKind: "book";
	providerId: string;
	providerLabel: string;
	recordId: string;
	state: "matched";
};

export interface PublicEvidenceStamp {
	checkedAt: string;
	freshness: "fresh" | "not-applicable" | "stale";
	scope: { id: string | null; kind: "destination" | "operation" | "profile" | "public-catalog" };
	sourceId: string;
	sourceKind: "cached-api" | "live-api" | "operation-record" | "profile-record" | "static-policy";
	sourceLabel: string;
}

export interface PublicCapabilityView {
	capabilityId: string;
	displayName: string;
	evidence: PublicEvidenceStamp;
	family: "catalog-source" | "identity-provider" | "metadata-enricher" | "provider-policy";
	installed: boolean;
	maturity: "policy-only" | "stable";
	mediaKinds: MediaKind[];
	pluginId: string | null;
	provenance?: "unverified-provenance" | "verified-public-domain";
	providerAvailability: ProviderAvailability;
	reason: string;
	reasonCode: string;
	version: number;
}

export interface CatalogMetadataEvidence {
	averageRating: number | null;
	checkedAt: string;
	contributedFields: Array<"average-rating" | "categories" | "creators" | "description" | "information-link" | "page-count" | "published-date" | "publisher" | "ratings-count" | "subtitle" | "title">;
	informationLink: string;
	matchedBy: BookIdentifierScheme | "title-creator";
	matchQuality: "exact-identifier" | "exact-title-creator";
	mediaKind: "book";
	providerId: string;
	providerLabel: string;
	ratingsCount: number | null;
	recordId: string;
}

export interface CatalogCapabilityEvidence {
	capability: "kindle-unlimited" | "product-availability" | "reviews";
	evidence: PublicEvidenceStamp;
	prerequisite?: string | null;
	providerId: string;
	reason: string;
	reasonCode: string;
	state: "eligibility-required" | "not-exposed" | "unsupported";
}

export interface CatalogItem {
	acquisitionOptions: PluginAcquisitionOption[];
	capability: "candidate" | "deliverable" | "metadata-only";
	capabilityEvidence: CatalogCapabilityEvidence[];
	capabilityReason: string;
	catalogRef: string;
	checkedAt: string;
	creators: string[];
	edition: string | null;
	identifiers: Array<{ scheme: BookIdentifierScheme; value: string }>;
	itemId: string;
	language: string | null;
	mediaKind: "book";
	metadataEvidence: CatalogMetadataEvidence[];
	pluginId: string;
	provenance: "unverified-provenance" | "verified-public-domain";
	publishedYear: number | null;
	source: string;
	title: string;
}

export type CapabilityInvocationAuthorization =
	| { expiresAt: string; grantedScopes: string[]; kind: "bearer"; value: string }
	| { kind: "api-key"; value: string };