import { inspect } from "node:util";
import type { InstalledPlugin } from "../plugins/types";

export const PROVIDER_CONNECTOR_IDS = ["google-gmail", "login-with-amazon"] as const;

export type ProviderConnectorId = typeof PROVIDER_CONNECTOR_IDS[number];
export type ProviderCapability = "identity-only";
export type ProviderTokenKind = "access" | "refresh";

export interface ProviderConnectorRegistrationSource {
	connectorId: ProviderConnectorId;
	registrationId: string;
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post";
	identityEndpoint: string;
	jwksUri?: string | null;
	revocationEndpoint?: string | null;
	clientId: string;
	clientSecretEnv: string;
	callbackPath: string;
	pluginId: string;
	capabilityId: string;
	oidc: boolean;
	capabilityScopes: Record<ProviderCapability, string[]>;
}

export interface ProviderRegistrationsDocument {
	schemaVersion: 1;
	connectors: ProviderConnectorRegistrationSource[];
}

export interface ProviderTokenKeyReference {
	keyEnv: string;
	keyId: string;
}

export interface ProviderTokenKeyringDocument {
	activeKeyId: string;
	keys: ProviderTokenKeyReference[];
	schemaVersion: 1;
}

export interface ProviderConnectorRegistration {
	authorizationEndpoint: string;
	callbackPath: string;
	callbackUri: string;
	capabilityId: string;
	capabilityScopes: Readonly<Record<ProviderCapability, readonly string[]>>;
	clientId: string;
	clientSecretConfigured: true;
	connectorId: ProviderConnectorId;
	identityEndpoint: string;
	issuer: string;
	jwksUri: string | null;
	oidc: boolean;
	pluginId: string;
	pluginDigest: string;
	registrationId: string;
	revocationEndpoint: string | null;
	tokenEndpoint: string;
	tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post";
}

export class ProviderConnector {
	readonly #clientSecret: string;
	readonly registration: ProviderConnectorRegistration;

	constructor(registration: ProviderConnectorRegistration, clientSecret: string) {
		this.registration = registration;
		this.#clientSecret = clientSecret;
	}

	useClientSecret<T>(use: (clientSecret: string) => T) {
		return use(this.#clientSecret);
	}

	toJSON() {
		return this.registration;
	}

	toString() {
		return "[ProviderConnector]";
	}

	[inspect.custom]() {
		return this.registration;
	}
}

export class ProviderTokenKeyring {
	readonly #keys: Map<string, Buffer>;
	readonly activeKeyId: string;
	readonly keyIds: readonly string[];

	constructor(activeKeyId: string, keys: ReadonlyMap<string, Buffer>) {
		if (!keys.has(activeKeyId) || [...keys.values()].some((key) => key.byteLength !== 32)) {
			throw new Error("Provider token keyring is invalid");
		}
		this.activeKeyId = activeKeyId;
		this.keyIds = Object.freeze([...keys.keys()]);
		this.#keys = new Map([...keys].map(([keyId, key]) => [keyId, Buffer.from(key)]));
	}

	hasKey(keyId: string) {
		return this.#keys.has(keyId);
	}

	useActiveKey<T>(use: (keyId: string, key: Buffer) => T) {
		const key = Buffer.from(this.#keys.get(this.activeKeyId)!);
		try {
			return use(this.activeKeyId, key);
		} finally {
			key.fill(0);
		}
	}

	useKey<T>(keyId: string, use: (key: Buffer) => T): T | undefined {
		const stored = this.#keys.get(keyId);
		if (!stored) return undefined;
		const key = Buffer.from(stored);
		try {
			return use(key);
		} finally {
			key.fill(0);
		}
	}

	toJSON() {
		return { activeKeyId: this.activeKeyId, keyIds: this.keyIds };
	}

	toString() {
		return "[ProviderTokenKeyring]";
	}

	[inspect.custom]() {
		return this.toJSON();
	}
}

export class ProviderSubjectHashKey {
	readonly #key: Buffer;

	constructor(key: Buffer) {
		if (key.byteLength !== 32) throw new Error("Provider subject hash key is invalid");
		this.#key = Buffer.from(key);
	}

	use<T>(use: (key: Buffer) => T) {
		const key = Buffer.from(this.#key);
		try {
			return use(key);
		} finally {
			key.fill(0);
		}
	}

	toJSON() {
		return "[REDACTED]";
	}

	toString() {
		return "[ProviderSubjectHashKey]";
	}

	[inspect.custom]() {
		return this.toString();
	}
}

export interface ProviderConfigPaths {
	keyringFile: string;
	registrationsFile: string;
	subjectHashKeyFile: string;
}

export interface ProviderConfigurationRequired {
	configured: false;
	status: "configuration-required";
}

export interface ProviderConfigurationInvalid {
	configured: false;
	errors: [string];
	status: "invalid";
}

export class ProviderRuntimeConfig {
	readonly #connectors: ReadonlyMap<ProviderConnectorId, ProviderConnector>;
	readonly configured = true;
	readonly keyring: ProviderTokenKeyring;
	readonly registrations: readonly ProviderConnectorRegistration[];
	readonly status = "configured" as const;
	readonly subjectHashKey: ProviderSubjectHashKey;

	constructor(input: {
		connectors: ReadonlyMap<ProviderConnectorId, ProviderConnector>;
		keyring: ProviderTokenKeyring;
		registrations: readonly ProviderConnectorRegistration[];
		subjectHashKey: ProviderSubjectHashKey;
	}) {
		this.#connectors = input.connectors;
		this.keyring = input.keyring;
		this.registrations = input.registrations;
		this.subjectHashKey = input.subjectHashKey;
	}

	connector(connectorId: ProviderConnectorId) {
		return this.#connectors.get(connectorId);
	}

	toJSON() {
		return { configured: true, registrations: this.registrations, status: this.status };
	}

	toString() {
		return "[ProviderRuntimeConfig configured]";
	}

	[inspect.custom]() {
		return this.toJSON();
	}
}

export type ProviderRuntimeConfigState =
	| ProviderConfigurationInvalid
	| ProviderConfigurationRequired
	| ProviderRuntimeConfig;

export interface ProviderRuntimeConfigInput {
	env: NodeJS.ProcessEnv;
	installedPlugins: readonly InstalledPlugin[];
	publicOrigin: URL;
}

export interface ProviderEncryptedValue {
	ciphertext: Buffer;
	keyId: string;
	nonce: Buffer;
	tag: Buffer;
}

export interface ProviderAccountTokenContext {
	accountId: string;
	connectorId: ProviderConnectorId;
	kind: ProviderTokenKind;
	profileId: string;
	revision: number;
}

export interface ProviderPkceContext {
	authorizationId: string;
	connectorId: ProviderConnectorId;
	kind: "oidc-nonce" | "pkce";
	profileId: string;
}

export type ProviderSecretContext = ProviderAccountTokenContext | ProviderPkceContext;