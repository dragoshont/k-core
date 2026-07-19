import { resolve } from "node:path";
import ipaddr from "ipaddr.js";
import { ApplicationSecrets } from "../common/application-secrets";
import { ProblemError } from "../http/problems";
import { findRepoRoot } from "../platform/root";
import { discoverPlugins, type PluginRootDirectories } from "../plugins/manifests";
import { loadReviewedPublicInventory } from "../plugins/public-inventory";
import type { InstalledPlugin, ReviewedPublicInventory } from "../plugins/types";
import {
	invalidProviderConfiguration,
	loadProviderRuntimeConfig,
	PROVIDER_CONFIGURATION_ERROR,
	readProviderConfigPaths,
} from "../provider-accounts/config";
import type { ProviderRuntimeConfigState } from "../provider-accounts/types";
import {
	loadProfileConfig,
	PROFILE_CONFIGURATION_INVALID,
	type ProfileConfigState,
} from "./profile-config";

export * from "./profile-config";

export const PLUGIN_CONFIGURATION_INVALID = "PLUGIN_CONFIGURATION_INVALID";

export interface ParsedCidr {
	address: ipaddr.IPv4 | ipaddr.IPv6;
	prefix: number;
	raw: string;
}

export interface AppConfig {
	allowedPrivateClientCidrs: ParsedCidr[];
	allowMigrationDown: boolean;
	applicationSecrets?: ApplicationSecrets;
	databaseUrl: string;
	outboundContact: string;
	pinPepper: string;
	pinReuseSecret: string;
	port: number;
	installedPlugins?: readonly InstalledPlugin[];
	pluginRoots?: PluginRootDirectories;
	profileConfig?: ProfileConfigState;
	providerRuntimeConfig?: ProviderRuntimeConfigState;
	publicPluginInventory?: ReviewedPublicInventory;
	quarantineDirectory?: string;
	smtpFrom?: string;
	smtpHost?: string;
	smtpPassword?: string;
	smtpPort?: number;
	smtpUser?: string;
	publicOrigin: URL;
	sessionSigningKey: string;
	sourceHashSecret: string;
	trustedProxyCidrs: ParsedCidr[];
	userAgent: string;
}

export interface ConfigState {
	errors: string[];
	ok: boolean;
	value?: AppConfig;
}

export function readinessConfigErrors(config: AppConfig) {
	const errors: string[] = [];
	if (config.publicOrigin.protocol !== "https:" || config.publicOrigin.pathname !== "/" || config.publicOrigin.search || config.publicOrigin.hash) {
		errors.push("PUBLIC_ORIGIN must be an HTTPS origin");
	}
	if (config.trustedProxyCidrs.length === 0) {
		errors.push("TRUSTED_PROXY_CIDRS must contain at least one private or local CIDR");
	}
	if (config.allowedPrivateClientCidrs.length === 0) {
		errors.push("ALLOWED_PRIVATE_CLIENT_CIDRS must contain at least one private or local CIDR");
	}
	for (const [name, cidrs] of [
		["TRUSTED_PROXY_CIDRS", config.trustedProxyCidrs],
		["ALLOWED_PRIVATE_CLIENT_CIDRS", config.allowedPrivateClientCidrs],
	] as const) {
		for (const cidr of cidrs) {
			if (!isPrivateAddress(cidr.address) || !isPrivateCidr(cidr.address, cidr.prefix)) {
				errors.push(`${name} must contain only private or local CIDRs (${cidr.raw})`);
			}
		}
	}
	for (const [name, value] of [
		["PIN_PEPPER", config.pinPepper],
		["PIN_REUSE_SECRET", config.pinReuseSecret],
		["SESSION_SIGNING_KEY", config.sessionSigningKey],
		["SOURCE_HASH_SECRET", config.sourceHashSecret],
	] as const) {
		if (Buffer.byteLength(value, "utf8") < 32) {
			errors.push(`${name} must be at least 32 bytes`);
		}
	}
	if (!config.databaseUrl) {
		errors.push("DATABASE_URL is required");
	}
	if (!config.outboundContact) {
		errors.push("OUTBOUND_CONTACT is required");
	}
	if (config.providerRuntimeConfig?.status === "invalid") {
		errors.push(PROVIDER_CONFIGURATION_ERROR);
	}
	if (config.pluginRoots) {
		try {
			const installedPlugins = discoverPlugins(config.pluginRoots);
			const publicPluginInventory = loadReviewedPublicInventory(config.pluginRoots.publicDirectory, installedPlugins);
			const installedSnapshot = installedPlugins.map((plugin) => [plugin.normalized.pluginId, plugin.root, plugin.digest]);
			const configuredSnapshot = config.installedPlugins?.map((plugin) => [plugin.normalized.pluginId, plugin.root, plugin.digest]);
			if (!configuredSnapshot || JSON.stringify(installedSnapshot) !== JSON.stringify(configuredSnapshot)
				|| !config.publicPluginInventory || JSON.stringify(publicPluginInventory) !== JSON.stringify(config.publicPluginInventory)) {
				throw new Error(PLUGIN_CONFIGURATION_INVALID);
			}
		} catch {
			errors.push(PLUGIN_CONFIGURATION_INVALID);
		}
	}
	return errors;
}

function normalizeAddress(value: string) {
	return ipaddr.process(value.trim());
}

function isPrivateAddress(address: ipaddr.IPv4 | ipaddr.IPv6) {
	return ["linkLocal", "loopback", "private", "uniqueLocal"].includes(address.range());
}

const ALLOWED_PRIVATE_RANGES = [
	ipaddr.parseCIDR("10.0.0.0/8"),
	ipaddr.parseCIDR("172.16.0.0/12"),
	ipaddr.parseCIDR("192.168.0.0/16"),
	ipaddr.parseCIDR("127.0.0.0/8"),
	ipaddr.parseCIDR("169.254.0.0/16"),
	ipaddr.parseCIDR("fc00::/7"),
	ipaddr.parseCIDR("fe80::/10"),
	ipaddr.parseCIDR("::1/128"),
] as Array<[ipaddr.IPv4 | ipaddr.IPv6, number]>;

function isPrivateCidr(address: ipaddr.IPv4 | ipaddr.IPv6, prefix: number) {
	return ALLOWED_PRIVATE_RANGES.some(([allowedAddress, allowedPrefix]) =>
		address.kind() === allowedAddress.kind()
		&& prefix >= allowedPrefix
		&& address.match([allowedAddress, allowedPrefix]),
	);
}

function parseCidrList(value: string | undefined, fieldName: string, errors: string[]) {
	if (!value) {
		errors.push(`${fieldName} is required`);
		return [];
	}

	return value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)
		.flatMap((raw) => {
			try {
				const [address, prefix] = ipaddr.parseCIDR(raw);
				if (!isPrivateAddress(address) || !isPrivateCidr(address, prefix)) {
					errors.push(`${fieldName} must contain only private or local CIDRs (${raw})`);
					return [];
				}

				return [{ address, prefix, raw } satisfies ParsedCidr];
			} catch {
				errors.push(`${fieldName} contains an invalid CIDR (${raw})`);
				return [];
			}
		});
}

function parseRequiredUrl(value: string | undefined, fieldName: string, errors: string[]) {
	if (!value) {
		errors.push(`${fieldName} is required`);
		return undefined;
	}

	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "https:") {
			errors.push(`${fieldName} must use https`);
		}
		if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
			errors.push(`${fieldName} must be an origin without a path, query, or hash`);
		}
		return parsed;
	} catch {
		errors.push(`${fieldName} must be a valid URL`);
		return undefined;
	}
}

function readPluginRoots(env: NodeJS.ProcessEnv): PluginRootDirectories {
	const legacyConfigured = env.PLUGIN_DIR !== undefined;
	const publicConfigured = env.PUBLIC_PLUGIN_DIR !== undefined;
	const privateConfigured = env.PRIVATE_PLUGIN_DIR !== undefined;
	if (legacyConfigured && (publicConfigured || privateConfigured)) throw new Error(PLUGIN_CONFIGURATION_INVALID);
	const publicDirectory = publicConfigured ? env.PUBLIC_PLUGIN_DIR : legacyConfigured ? env.PLUGIN_DIR : resolve(findRepoRoot(), "plugins");
	if (!publicDirectory || (privateConfigured && !env.PRIVATE_PLUGIN_DIR)) throw new Error(PLUGIN_CONFIGURATION_INVALID);
	return { privateDirectory: env.PRIVATE_PLUGIN_DIR, publicDirectory };
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ConfigState {
	const errors: string[] = [];
	let profileConfig: ProfileConfigState | undefined;
	try {
		profileConfig = loadProfileConfig(env);
	} catch {
		errors.push(PROFILE_CONFIGURATION_INVALID);
	}
	const publicOrigin = parseRequiredUrl(env.PUBLIC_ORIGIN, "PUBLIC_ORIGIN", errors);
	const trustedProxyCidrs = parseCidrList(env.TRUSTED_PROXY_CIDRS, "TRUSTED_PROXY_CIDRS", errors);
	const allowedPrivateClientCidrs = parseCidrList(env.ALLOWED_PRIVATE_CLIENT_CIDRS, "ALLOWED_PRIVATE_CLIENT_CIDRS", errors);
	const databaseUrl = env.DATABASE_URL;
	const pinPepper = env.PIN_PEPPER;
	const pinReuseSecret = env.PIN_REUSE_SECRET;
	const sessionSigningKey = env.SESSION_SIGNING_KEY;
	const sourceHashSecret = env.SOURCE_HASH_SECRET;
	const outboundContact = env.OUTBOUND_CONTACT;
	let applicationSecrets: ApplicationSecrets | undefined;
	try {
		applicationSecrets = ApplicationSecrets.fromEnvironment(env);
	} catch {
		errors.push("GOOGLE_BOOKS_API_KEY is invalid");
	}

	for (const [name, value] of Object.entries({
		DATABASE_URL: databaseUrl,
		OUTBOUND_CONTACT: outboundContact,
		PIN_PEPPER: pinPepper,
		PIN_REUSE_SECRET: pinReuseSecret,
		SESSION_SIGNING_KEY: sessionSigningKey,
		SOURCE_HASH_SECRET: sourceHashSecret,
	})) {
		if (!value) {
			errors.push(`${name} is required`);
		}
	}

	const port = env.PORT ? Number.parseInt(env.PORT, 10) : 3000;
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		errors.push("PORT must be a valid TCP port");
	}

	if (errors.length > 0 || !profileConfig || !applicationSecrets || !publicOrigin || !databaseUrl || !pinPepper || !pinReuseSecret || !sessionSigningKey || !sourceHashSecret || !outboundContact) {
		return { errors, ok: false };
	}

	let installedPlugins: InstalledPlugin[];
	let pluginRoots: PluginRootDirectories;
	let publicPluginInventory: ReviewedPublicInventory;
	try {
		pluginRoots = readPluginRoots(env);
		installedPlugins = discoverPlugins(pluginRoots);
		publicPluginInventory = loadReviewedPublicInventory(pluginRoots.publicDirectory, installedPlugins);
	} catch {
		return { errors: [PLUGIN_CONFIGURATION_INVALID], ok: false };
	}

	const providerPathState = readProviderConfigPaths(env);
	let providerRuntimeConfig: ProviderRuntimeConfigState;
	if (!providerPathState.configured) {
		providerRuntimeConfig = providerPathState;
	} else {
		try {
			providerRuntimeConfig = loadProviderRuntimeConfig({ env, installedPlugins, publicOrigin });
		} catch {
			providerRuntimeConfig = invalidProviderConfiguration();
		}
	}

	const value: AppConfig = {
			allowedPrivateClientCidrs,
			allowMigrationDown: env.ALLOW_MIGRATION_DOWN === "1" || env.NODE_ENV === "development" || env.NODE_ENV === "test" || env.CI === "true",
			applicationSecrets,
			databaseUrl,
			outboundContact,
			pinPepper,
			pinReuseSecret,
			port,
			installedPlugins,
			pluginRoots,
			profileConfig,
			providerRuntimeConfig,
			publicPluginInventory,
			publicOrigin,
			quarantineDirectory: env.QUARANTINE_DIR,
			smtpFrom: env.SMTP_FROM,
			smtpHost: env.SMTP_HOST,
			smtpPassword: env.SMTP_PASSWORD,
			smtpPort: env.SMTP_PORT ? Number.parseInt(env.SMTP_PORT, 10) : undefined,
			smtpUser: env.SMTP_USER,
			sessionSigningKey,
			sourceHashSecret,
			trustedProxyCidrs,
			userAgent: `k/0.3 (${outboundContact})`,
	};
	const readinessErrors = readinessConfigErrors(value);
	return readinessErrors.length > 0
		? { errors: readinessErrors, ok: false }
		: { errors: [], ok: true, value };
}

export function assertConfig(state: ConfigState) {
	if (!state.ok || !state.value) {
		throw new ProblemError(503, "configuration_required", "Configuration required", state.errors.join("; "));
	}

	return state.value;
}

export function isAddressInCidrs(address: string, cidrs: ParsedCidr[]) {
	const parsed = normalizeAddress(address);
	return cidrs.some((cidr) => parsed.kind() === cidr.address.kind() && parsed.match([cidr.address, cidr.prefix]));
}