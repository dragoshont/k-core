import { readFileSync } from "node:fs";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import registrationsSchema from "../../../contracts/provider-registrations.schema.json";
import keyringSchema from "../../../contracts/provider-token-keyring.schema.json";
import type {
	ProviderConnectorId,
	ProviderConnectorRegistrationSource,
	ProviderConfigurationInvalid,
	ProviderConfigurationRequired,
	ProviderConfigPaths,
	ProviderRegistrationsDocument,
	ProviderRuntimeConfigInput,
	ProviderRuntimeConfigState,
	ProviderTokenKeyringDocument,
} from "./types";
import {
	PROVIDER_CONNECTOR_IDS,
	ProviderConnector,
	ProviderRuntimeConfig,
	ProviderSubjectHashKey,
	ProviderTokenKeyring,
} from "./types";

export const PROVIDER_CONFIGURATION_ERROR = "Provider account configuration is invalid";
const MAX_PROVIDER_CONFIG_BYTES = 64 * 1024;

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateRegistrations = ajv.compile(registrationsSchema as object);
const validateKeyring = ajv.compile(keyringSchema as object);

const CONNECTOR_OWNERSHIP = {
	"google-gmail": {
		callbackPath: "/oauth/callback/google-gmail",
		capabilityId: "google-gmail/identity",
		oidc: true,
		pluginId: "google-gmail",
	},
	"login-with-amazon": {
		callbackPath: "/oauth/callback/login-with-amazon",
		capabilityId: "login-with-amazon/identity",
		oidc: false,
		pluginId: "login-with-amazon",
	},
} as const;

type ProviderConfigPathState =
	| ProviderConfigurationInvalid
	| ProviderConfigurationRequired
	| { configured: true; paths: ProviderConfigPaths; status: "configured" };

export function invalidProviderConfiguration(): ProviderConfigurationInvalid {
	return { configured: false, errors: [PROVIDER_CONFIGURATION_ERROR], status: "invalid" };
}

export function readProviderConfigPaths(env: NodeJS.ProcessEnv): ProviderConfigPathState {
	const registrationsFile = env.PROVIDER_REGISTRATIONS_FILE;
	const keyringFile = env.PROVIDER_TOKEN_KEYRING_FILE;
	const subjectHashKeyFile = env.PROVIDER_SUBJECT_HASH_KEY_FILE;
	const configuredCount = [registrationsFile, keyringFile, subjectHashKeyFile]
		.filter((value) => value !== undefined).length;

	if (configuredCount === 0) {
		return { configured: false, status: "configuration-required" };
	}
	if (configuredCount !== 3 || !registrationsFile || !keyringFile || !subjectHashKeyFile) {
		return invalidProviderConfiguration();
	}

	return {
		configured: true,
		paths: { keyringFile, registrationsFile, subjectHashKeyFile },
		status: "configured",
	};
}

function readJsonFile(path: string, validate: ValidateFunction) {
	const source = readFileSync(path);
	if (source.byteLength > MAX_PROVIDER_CONFIG_BYTES) throw new Error(PROVIDER_CONFIGURATION_ERROR);
	const value = JSON.parse(source.toString("utf8")) as unknown;
	if (!validate(value)) throw new Error(PROVIDER_CONFIGURATION_ERROR);
	return value;
}

function decodeTokenKey(value: string) {
	let key: Buffer;
	if (/^[A-Za-z0-9_-]{43}$/.test(value)) {
		key = Buffer.from(value, "base64url");
		if (key.toString("base64url") !== value) throw new Error(PROVIDER_CONFIGURATION_ERROR);
	} else if (/^[A-Za-z0-9+/]{43}=$/.test(value)) {
		key = Buffer.from(value, "base64");
		if (key.toString("base64") !== value) throw new Error(PROVIDER_CONFIGURATION_ERROR);
	} else {
		throw new Error(PROVIDER_CONFIGURATION_ERROR);
	}
	if (key.byteLength !== 32) throw new Error(PROVIDER_CONFIGURATION_ERROR);
	return key;
}

function hostAllowed(hostname: string, patterns: readonly string[]) {
	return patterns.some((pattern) => pattern.startsWith("*.")
		? hostname.endsWith(pattern.slice(1)) && hostname !== pattern.slice(2)
		: hostname === pattern);
}

function endpointAllowed(value: string, allowedHosts: readonly string[]) {
	const url = new URL(value);
	return url.protocol === "https:"
		&& !url.username
		&& !url.password
		&& !url.search
		&& !url.hash
		&& hostAllowed(url.hostname, allowedHosts);
}

function sameStringSet(left: readonly string[], right: readonly string[]) {
	return left.length === right.length && left.every((value) => right.includes(value));
}

function validateConnector(
	source: ProviderConnectorRegistrationSource,
	input: ProviderRuntimeConfigInput,
) {
	const ownership = CONNECTOR_OWNERSHIP[source.connectorId];
	if (source.callbackPath !== ownership.callbackPath
		|| source.pluginId !== ownership.pluginId
		|| source.capabilityId !== ownership.capabilityId
		|| source.oidc !== ownership.oidc) {
		throw new Error(PROVIDER_CONFIGURATION_ERROR);
	}

	const plugins = input.installedPlugins.filter((plugin) => plugin.normalized.pluginId === source.pluginId);
	if (plugins.length !== 1 || plugins[0]!.normalized.schemaVersion !== 2) {
		throw new Error(PROVIDER_CONFIGURATION_ERROR);
	}
	const plugin = plugins[0]!;
	const capabilities = plugin.normalized.capabilities.filter((capability) => capability.capabilityId === source.capabilityId);
	if (capabilities.length !== 1) throw new Error(PROVIDER_CONFIGURATION_ERROR);
	const capability = capabilities[0]!;
	if (capability.family !== "identity-provider"
		|| capability.commands.length !== 1
		|| capability.commands[0] !== "identity.resolve"
		|| capability.authorization.kind !== "profile-oauth2"
		|| capability.authorization.registrationId !== source.registrationId
		|| !sameStringSet(source.capabilityScopes["identity-only"], capability.authorization.requiredScopes)) {
		throw new Error(PROVIDER_CONFIGURATION_ERROR);
	}

	const endpoints = [
		source.issuer,
		source.authorizationEndpoint,
		source.tokenEndpoint,
		source.identityEndpoint,
		...(source.jwksUri ? [source.jwksUri] : []),
		...(source.revocationEndpoint ? [source.revocationEndpoint] : []),
	];
	if (!endpoints.every((endpoint) => endpointAllowed(endpoint, plugin.normalized.runtime.allowedHosts))) {
		throw new Error(PROVIDER_CONFIGURATION_ERROR);
	}

	const clientSecret = input.env[source.clientSecretEnv];
	if (!clientSecret) throw new Error(PROVIDER_CONFIGURATION_ERROR);
	const callbackUri = new URL(source.callbackPath, input.publicOrigin).toString();
	const registration = Object.freeze({
		authorizationEndpoint: source.authorizationEndpoint,
		callbackPath: source.callbackPath,
		callbackUri,
		capabilityId: source.capabilityId,
		capabilityScopes: Object.freeze({ "identity-only": Object.freeze([...source.capabilityScopes["identity-only"]]) }),
		clientId: source.clientId,
		clientSecretConfigured: true as const,
		connectorId: source.connectorId,
		identityEndpoint: source.identityEndpoint,
		issuer: source.issuer,
		jwksUri: source.jwksUri ?? null,
		oidc: source.oidc,
		pluginId: source.pluginId,
		pluginDigest: plugin.digest,
		registrationId: source.registrationId,
		revocationEndpoint: source.revocationEndpoint ?? null,
		tokenEndpoint: source.tokenEndpoint,
		tokenEndpointAuthMethod: source.tokenEndpointAuthMethod,
	});
	return new ProviderConnector(registration, clientSecret);
}

function loadKeyring(document: ProviderTokenKeyringDocument, env: NodeJS.ProcessEnv) {
	const keyIds = document.keys.map((reference) => reference.keyId);
	if (new Set(keyIds).size !== keyIds.length || !keyIds.includes(document.activeKeyId)) {
		throw new Error(PROVIDER_CONFIGURATION_ERROR);
	}
	const keys = new Map<string, Buffer>();
	try {
		for (const reference of document.keys) {
			const value = env[reference.keyEnv];
			if (!value) throw new Error(PROVIDER_CONFIGURATION_ERROR);
			keys.set(reference.keyId, decodeTokenKey(value));
		}
		return new ProviderTokenKeyring(document.activeKeyId, keys);
	} finally {
		for (const key of keys.values()) key.fill(0);
	}
}

export function loadProviderRuntimeConfig(input: ProviderRuntimeConfigInput): ProviderRuntimeConfigState {
	const pathState = readProviderConfigPaths(input.env);
	if (!pathState.configured) return pathState;

	try {
		if (input.publicOrigin.protocol !== "https:"
			|| input.publicOrigin.username
			|| input.publicOrigin.password
			|| input.publicOrigin.pathname !== "/"
			|| input.publicOrigin.search
			|| input.publicOrigin.hash) {
			throw new Error(PROVIDER_CONFIGURATION_ERROR);
		}
		const registrationsDocument = readJsonFile(pathState.paths.registrationsFile, validateRegistrations) as ProviderRegistrationsDocument;
		const keyringDocument = readJsonFile(pathState.paths.keyringFile, validateKeyring) as ProviderTokenKeyringDocument;
		const connectorIds = registrationsDocument.connectors.map((connector) => connector.connectorId);
		if (new Set(connectorIds).size !== connectorIds.length
			|| PROVIDER_CONNECTOR_IDS.some((connectorId) => !connectorIds.includes(connectorId))) {
			throw new Error(PROVIDER_CONFIGURATION_ERROR);
		}

		const connectors = new Map<ProviderConnectorId, ProviderConnector>();
		for (const connectorId of PROVIDER_CONNECTOR_IDS) {
			const source = registrationsDocument.connectors.find((connector) => connector.connectorId === connectorId)!;
			connectors.set(connectorId, validateConnector(source, input));
		}

		const keyring = loadKeyring(keyringDocument, input.env);
		const subjectKeyBytes = readFileSync(pathState.paths.subjectHashKeyFile);
		try {
			if (subjectKeyBytes.byteLength !== 32) throw new Error(PROVIDER_CONFIGURATION_ERROR);
			const subjectHashKey = new ProviderSubjectHashKey(subjectKeyBytes);
			const registrations = Object.freeze(PROVIDER_CONNECTOR_IDS.map((connectorId) => connectors.get(connectorId)!.registration));
			return new ProviderRuntimeConfig({ connectors, keyring, registrations, subjectHashKey });
		} finally {
			subjectKeyBytes.fill(0);
		}
	} catch {
		return invalidProviderConfiguration();
	}
}