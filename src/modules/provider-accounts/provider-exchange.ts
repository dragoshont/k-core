import {
	authorizationCodeGrant,
	ClientSecretBasic,
	ClientSecretPost,
	Configuration,
	customFetch,
	enableNonRepudiationChecks,
	fetchUserInfo,
	type ClientAuth,
	type CustomFetch,
	type ServerMetadata,
} from "openid-client";
import { PluginHost } from "../plugins/host";
import type { InstalledPlugin, PluginIdentityResult } from "../plugins/types";
import type {
	AuthorizationSuccessResult,
	ProviderAuthorizationClaim,
	StartAuthorizationResult,
} from "./service";
import { ProviderAccountService } from "./service";
import type {
	ProviderConnector,
	ProviderConnectorId,
	ProviderConnectorRegistration,
} from "./types";
import { PROVIDER_CONNECTOR_IDS, ProviderRuntimeConfig } from "./types";

const COMPLETION_PATH = "/profile/integrations/complete";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 15_000;
const MAX_ACCESS_TOKEN_SECONDS = 24 * 60 * 60;
const MAX_ID_TOKEN_AGE_SECONDS = 60 * 60;
const ID_TOKEN_CLOCK_TOLERANCE_SECONDS = 30;
const MAX_TOKEN_BYTES = 64 * 1024;
const SAFE_RESPONSE_HEADERS = [
	"cache-control",
	"content-type",
	"date",
	"etag",
	"expires",
	"last-modified",
	"www-authenticate",
] as const;

export interface ProviderCompletionResult {
	completionPath: typeof COMPLETION_PATH;
	receipt: string;
}

export interface ProviderExchangeInput {
	browserBinding: string;
	callbackUrl: string | URL;
	connectorId: ProviderConnectorId;
	state: string;
}

export interface ProviderIdentityHost {
	invokeCapability<T>(plugin: InstalledPlugin, input: {
		authorization?: { expiresAt: string; grantedScopes: string[]; kind: "bearer"; value: string };
		capabilityId: string;
		command: "identity.resolve";
		input: Record<string, unknown>;
	}): Promise<T>;
}

export interface ProviderExchangeAdapterInput {
	config: ProviderRuntimeConfig;
	fetch?: typeof globalThis.fetch;
	host?: ProviderIdentityHost;
	installedPlugins: readonly InstalledPlugin[];
	service: ProviderAccountService;
	timeoutMs?: number;
	userAgent: string;
}

interface ValidCallback {
	code: string | null;
	error: string | null;
	url: URL;
}

function genericError(message: string) {
	return new Error(message);
}

function exactUrl(value: string) {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
		throw genericError("Provider endpoint is invalid");
	}
	return url;
}

function sameStringSet(left: readonly string[], right: readonly string[]) {
	return left.length === right.length
		&& new Set(left).size === left.length
		&& left.every((value) => right.includes(value));
}

function singletonParameter(url: URL, name: string) {
	const values = url.searchParams.getAll(name);
	if (values.length > 1) throw genericError("Provider callback is invalid");
	return values[0] ?? null;
}

function validateCallback(
	input: ProviderExchangeInput,
	registration: ProviderConnectorRegistration,
): ValidCallback {
	const source = typeof input.callbackUrl === "string" ? input.callbackUrl : input.callbackUrl.href;
	if (source.length > 8192 || source.includes("#")) throw genericError("Provider callback is invalid");
	const url = new URL(source);
	const expected = exactUrl(registration.callbackUri);
	if (url.protocol !== "https:"
		|| url.username
		|| url.password
		|| url.origin !== expected.origin
		|| url.pathname !== expected.pathname
		|| url.hash) {
		throw genericError("Provider callback is invalid");
	}
	const state = singletonParameter(url, "state");
	const code = singletonParameter(url, "code");
	const error = singletonParameter(url, "error");
	if (state !== input.state
		|| (code !== null && error !== null)
		|| (code === null && error === null)
		|| (code !== null && (code.length < 1 || code.length > 4096))
		|| (error !== null && (error.length < 1 || error.length > 128))) {
		throw genericError("Provider callback is invalid");
	}
	return { code, error, url };
}

function assertStartMatchesRegistration(
	started: StartAuthorizationResult,
	registration: ProviderConnectorRegistration,
) {
	const source = started.authorizationUrl;
	if (source.authorizationEndpoint !== registration.authorizationEndpoint
		|| source.callbackUri !== registration.callbackUri
		|| source.clientId !== registration.clientId
		|| source.pkceMethod !== "S256"
		|| !sameStringSet(source.scopes, registration.capabilityScopes["identity-only"])
		|| registration.oidc !== (typeof source.nonce === "string")) {
		throw genericError("Provider authorization request is invalid");
	}
}

export function buildProviderAuthorizationUrl(
	started: StartAuthorizationResult,
	registration: ProviderConnectorRegistration,
) {
	assertStartMatchesRegistration(started, registration);
	const registeredEndpoint = exactUrl(registration.authorizationEndpoint);
	const url = new URL(registeredEndpoint.href);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", registration.clientId);
	url.searchParams.set("redirect_uri", registration.callbackUri);
	url.searchParams.set("scope", registration.capabilityScopes["identity-only"].join(" "));
	url.searchParams.set("state", started.state);
	url.searchParams.set("code_challenge", started.authorizationUrl.pkceChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	if (registration.oidc) url.searchParams.set("nonce", started.authorizationUrl.nonce!);
	if (url.origin !== registeredEndpoint.origin || url.pathname !== registeredEndpoint.pathname) {
		throw genericError("Provider authorization request is invalid");
	}
	return url;
}

function parseDeclaredLength(response: Response) {
	const value = response.headers.get("content-length");
	if (value === null || !/^\d+$/.test(value)) return null;
	const length = Number(value);
	if (!Number.isSafeInteger(length)) throw genericError("Provider response is invalid");
	return length;
}

async function boundedResponseBytes(response: Response) {
	const declared = parseDeclaredLength(response);
	if (declared !== null && declared > MAX_RESPONSE_BYTES) {
		throw genericError("Provider response is too large");
	}
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_RESPONSE_BYTES) {
			await reader.cancel().catch(() => undefined);
			throw genericError("Provider response is too large");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function safeResponseHeaders(source: Headers, bodyLength: number) {
	const headers = new Headers();
	for (const name of SAFE_RESPONSE_HEADERS) {
		const value = source.get(name);
		if (value !== null) headers.set(name, value);
	}
	headers.set("content-length", String(bodyLength));
	return headers;
}

function endpointRequestKind(url: URL, registration: ProviderConnectorRegistration) {
	const href = url.href;
	if (href === exactUrl(registration.tokenEndpoint).href) return "token" as const;
	if (href === exactUrl(registration.identityEndpoint).href) return "identity" as const;
	if (registration.jwksUri && href === exactUrl(registration.jwksUri).href) return "jwks" as const;
	return null;
}

export function createProviderMediatedFetch(input: {
	fetch?: typeof globalThis.fetch;
	registration: ProviderConnectorRegistration;
	timeoutMs?: number;
	userAgent: string;
}): CustomFetch {
	const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS
		|| !input.userAgent || input.userAgent.length > 512 || /[\r\n\0]/.test(input.userAgent)) {
		throw genericError("Provider request configuration is invalid");
	}
	const fetchImplementation = input.fetch ?? globalThis.fetch.bind(globalThis);
	return async (resource, options) => {
		if (typeof resource !== "string" || resource.includes("#")) {
			throw genericError("Provider request is not allowed");
		}
		let url: URL;
		try {
			url = new URL(resource);
		} catch {
			throw genericError("Provider request is not allowed");
		}
		if (url.protocol !== "https:" || url.username || url.password || url.hash) {
			throw genericError("Provider request is not allowed");
		}
		const kind = endpointRequestKind(url, input.registration);
		const method = options.method.toUpperCase();
		if (!kind
			|| (kind === "token" && (method !== "POST" || !(options.body instanceof URLSearchParams)))
			|| (kind !== "token" && (method !== "GET" || (options.body !== null && options.body !== undefined)))) {
			throw genericError("Provider request is not allowed");
		}
		const headers = new Headers(options.headers);
		headers.set("user-agent", input.userAgent);
		const signals = [AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])];
		let response: Response;
		try {
			response = await fetchImplementation(url, {
				body: options.body as BodyInit | null | undefined,
				headers,
				method,
				redirect: "manual",
				signal: AbortSignal.any(signals),
			});
		} catch {
			throw genericError("Provider request failed");
		}
		if (!Number.isInteger(response.status)
			|| response.status < 200
			|| response.status > 599
			|| response.redirected
			|| (response.status >= 300 && response.status < 400)) {
			throw genericError("Provider response is invalid");
		}
		let bytes: Uint8Array;
		try {
			bytes = await boundedResponseBytes(response);
		} catch (error) {
			if (error instanceof Error && error.message === "Provider response is too large") throw error;
			throw genericError("Provider response is invalid");
		}
		const body = response.status === 204 || response.status === 205
			? null
			: new Uint8Array(bytes).buffer;
		return new Response(body, {
			headers: safeResponseHeaders(response.headers, bytes.byteLength),
			status: response.status,
		});
	};
}

function clientAuthentication(connector: ProviderConnector): ClientAuth {
	return connector.useClientSecret((clientSecret) => connector.registration.tokenEndpointAuthMethod === "client_secret_basic"
		? ClientSecretBasic(clientSecret)
		: ClientSecretPost(clientSecret));
}

function staticConfiguration(
	connector: ProviderConnector,
	mediatedFetch: CustomFetch,
	timeoutMs: number,
) {
	const registration = connector.registration;
	const metadata: ServerMetadata = {
		authorization_endpoint: registration.authorizationEndpoint,
		issuer: registration.issuer,
		jwks_uri: registration.jwksUri ?? undefined,
		token_endpoint: registration.tokenEndpoint,
		userinfo_endpoint: registration.identityEndpoint,
	};
	const configuration = new Configuration(
		metadata,
		registration.clientId,
		{ token_endpoint_auth_method: registration.tokenEndpointAuthMethod },
		clientAuthentication(connector),
	);
	configuration.timeout = timeoutMs / 1000;
	configuration[customFetch] = mediatedFetch;
	if (registration.oidc) enableNonRepudiationChecks(configuration);
	return configuration;
}

function exactGrantedScopes(scope: unknown, requested: readonly string[]) {
	// RFC 6749 section 5.1 defines an omitted response scope as identical to the request.
	if (scope === undefined) return [...requested];
	if (typeof scope !== "string" || !scope || /\s{2}|[^\x21\x23-\x5B\x5D-\x7E ]/.test(scope)) {
		throw genericError("Provider token response is invalid");
	}
	const granted = scope.split(" ");
	if (!sameStringSet(granted, requested)) throw genericError("Provider token response is invalid");
	return granted;
}

function accessExpiry(tokens: { expiresIn(): number | undefined }) {
	const expiresIn = tokens.expiresIn();
	if (expiresIn === undefined || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > MAX_ACCESS_TOKEN_SECONDS) {
		throw genericError("Provider token response is invalid");
	}
	const expiresAt = new Date(Date.now() + expiresIn * 1000);
	if (!Number.isFinite(expiresAt.getTime())) throw genericError("Provider token response is invalid");
	return expiresAt;
}

function validToken(value: unknown): value is string {
	return typeof value === "string"
		&& Buffer.byteLength(value, "utf8") >= 1
		&& Buffer.byteLength(value, "utf8") <= MAX_TOKEN_BYTES;
}

function checkedTokenResponse(tokens: Awaited<ReturnType<typeof authorizationCodeGrant>>, requested: readonly string[]) {
	if (!validToken(tokens.access_token)
		|| (tokens.refresh_token !== undefined && !validToken(tokens.refresh_token))) {
		throw genericError("Provider token response is invalid");
	}
	return {
		accessExpiresAt: accessExpiry(tokens),
		accessToken: tokens.access_token,
		grantedScopes: exactGrantedScopes(tokens.scope, requested),
		refreshToken: tokens.refresh_token ?? null,
	};
}

function validSubject(value: unknown): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& Buffer.byteLength(value, "utf8") <= 512
		&& !/[\0\r\n]/.test(value);
}

function googleAccountLabel(value: unknown) {
	if (value === undefined) return null;
	if (typeof value !== "string" || !value || value.length > 254 || /[\0\r\n]/.test(value)) {
		throw genericError("Provider identity response is invalid");
	}
	return value;
}

function validatePluginIdentity(
	value: PluginIdentityResult,
	registration: ProviderConnectorRegistration,
) {
	const checkedAt = new Date(value?.checkedAt);
	if (!value
		|| typeof value !== "object"
		|| Array.isArray(value)
		|| Object.keys(value).sort().join(",") !== "checkedAt,maskedAccount,providerId,subject"
		|| value.providerId !== registration.connectorId
		|| !validSubject(value.subject)
		|| (value.maskedAccount !== null
			&& (typeof value.maskedAccount !== "string"
				|| !value.maskedAccount
				|| value.maskedAccount.length > 254
				|| /[\0\r\n]/.test(value.maskedAccount)))
		|| !Number.isFinite(checkedAt.getTime())
		|| Math.abs(Date.now() - checkedAt.getTime()) > 5 * 60_000) {
		throw genericError("Provider identity response is invalid");
	}
	return value;
}

export class ProviderExchangeAdapter {
	readonly #clients = new Map<ProviderConnectorId, Configuration>();
	readonly #config: ProviderRuntimeConfig;
	readonly #host: ProviderIdentityHost;
	readonly #installedPlugins: readonly InstalledPlugin[];
	readonly #service: ProviderAccountService;

	constructor(input: ProviderExchangeAdapterInput) {
		const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#config = input.config;
		this.#host = input.host ?? new PluginHost(input.userAgent);
		this.#installedPlugins = input.installedPlugins;
		this.#service = input.service;
		for (const connectorId of PROVIDER_CONNECTOR_IDS) {
			const connector = input.config.connector(connectorId);
			if (!connector) throw genericError("Provider exchange configuration is invalid");
			const mediatedFetch = createProviderMediatedFetch({
				fetch: input.fetch,
				registration: connector.registration,
				timeoutMs,
				userAgent: input.userAgent,
			});
			this.#clients.set(connectorId, staticConfiguration(connector, mediatedFetch, timeoutMs));
		}
	}

	authorizationUrl(started: StartAuthorizationResult, connectorId: ProviderConnectorId) {
		return buildProviderAuthorizationUrl(started, this.#registration(connectorId));
	}

	async exchange(input: ProviderExchangeInput): Promise<ProviderCompletionResult> {
		let claim: ProviderAuthorizationClaim | null = null;
		let finalizeAttempted = false;
		let receiptContext: Pick<ProviderAuthorizationClaim, "authorizationId" | "connectorId" | "profileId"> | null = null;
		try {
			const registration = this.#registration(input.connectorId);
			let callback: ValidCallback;
			try {
				callback = validateCallback(input, registration);
			} catch {
				await this.#consumeInvalid(input);
				return this.#completion("invalid", null);
			}

			if (callback.error !== null) {
				const denied = callback.error === "access_denied";
				try {
					await this.#service.consumeAuthorization({
						browserBinding: input.browserBinding,
						connectorId: input.connectorId,
						outcome: denied ? "denied" : "invalid",
						reasonCode: denied ? "PROVIDER_DENIED" : "PROVIDER_RESPONSE_INVALID",
						state: input.state,
					});
					return this.#completion(denied ? "denied" : "invalid", null);
				} catch {
					return this.#completion("invalid", null);
				}
			}

			claim = await this.#service.claimAuthorization({
				browserBinding: input.browserBinding,
				connectorId: input.connectorId,
				state: input.state,
			});
			receiptContext = claim;
			const result = registration.oidc
				? await this.#exchangeOidc(claim, callback.url, registration)
				: await this.#exchangeOAuth(claim, callback.url, registration);
			finalizeAttempted = true;
			await this.#service.finalizeAuthorization(claim, result);
			return this.#completion("connected", receiptContext);
		} catch {
			if (claim && !finalizeAttempted) {
				finalizeAttempted = true;
				await this.#service.finalizeAuthorization(claim, {
					outcome: "failed",
					reasonCode: "PROVIDER_EXCHANGE_FAILED",
				}).catch(() => undefined);
			}
			return this.#completion("invalid", receiptContext);
		} finally {
			if (claim && !finalizeAttempted) claim.dispose();
		}
	}

	#registration(connectorId: ProviderConnectorId) {
		const connector = this.#config.connector(connectorId);
		if (!connector) throw genericError("Provider exchange configuration is invalid");
		return connector.registration;
	}

	async #consumeInvalid(input: ProviderExchangeInput) {
		await this.#service.consumeAuthorization({
			browserBinding: input.browserBinding,
			connectorId: input.connectorId,
			outcome: "invalid",
			reasonCode: "PROVIDER_RESPONSE_INVALID",
			state: input.state,
		}).catch(() => undefined);
	}

	async #completion(
		outcome: "connected" | "denied" | "invalid",
		context: Pick<ProviderAuthorizationClaim, "authorizationId" | "connectorId" | "profileId"> | null,
	): Promise<ProviderCompletionResult> {
		const receipt = await this.#service.issueCompletionReceipt({
			authorizationId: context?.authorizationId ?? null,
			connectorId: context?.connectorId ?? null,
			outcome,
			profileId: context?.profileId ?? null,
		});
		return { completionPath: COMPLETION_PATH, receipt };
	}

	async #grant(
		claim: ProviderAuthorizationClaim,
		callbackUrl: URL,
		expectedNonce?: string,
	) {
		const configuration = this.#clients.get(claim.connectorId);
		if (!configuration) throw genericError("Provider exchange configuration is invalid");
		return claim.usePkceVerifier((pkceCodeVerifier) => authorizationCodeGrant(
			configuration,
			callbackUrl,
			{
				...(expectedNonce ? { expectedNonce } : {}),
				expectedState: callbackUrl.searchParams.get("state")!,
				pkceCodeVerifier,
			},
		));
	}

	async #exchangeOidc(
		claim: ProviderAuthorizationClaim,
		callbackUrl: URL,
		registration: ProviderConnectorRegistration,
	): Promise<AuthorizationSuccessResult> {
		const tokens = await claim.useOidcNonce((expectedNonce) => this.#grant(claim, callbackUrl, expectedNonce));
		const checked = checkedTokenResponse(tokens, claim.requestedScopes);
		const claims = tokens.claims();
		const nowSeconds = Math.floor(Date.now() / 1000);
		if (!claims
			|| !validSubject(claims.sub)
			|| typeof claims.iat !== "number"
			|| !Number.isFinite(claims.iat)
			|| claims.iat < nowSeconds - MAX_ID_TOKEN_AGE_SECONDS
			|| claims.iat > nowSeconds + ID_TOKEN_CLOCK_TOLERANCE_SECONDS) {
			throw genericError("Provider identity response is invalid");
		}
		const userInfo = await fetchUserInfo(this.#clients.get(claim.connectorId)!, checked.accessToken, claims.sub);
		if (userInfo.sub !== claims.sub) throw genericError("Provider identity response is invalid");
		return {
			...checked,
			accountLabel: googleAccountLabel(userInfo.email),
			issuer: registration.issuer,
			outcome: "completed",
			subject: claims.sub,
		};
	}

	async #exchangeOAuth(
		claim: ProviderAuthorizationClaim,
		callbackUrl: URL,
		registration: ProviderConnectorRegistration,
	): Promise<AuthorizationSuccessResult> {
		const tokens = await this.#grant(claim, callbackUrl);
		if (tokens.id_token !== undefined) throw genericError("Provider token response is invalid");
		const checked = checkedTokenResponse(tokens, claim.requestedScopes);
		const plugins = this.#installedPlugins.filter((plugin) => plugin.normalized.pluginId === registration.pluginId
			&& plugin.digest === registration.pluginDigest);
		if (plugins.length !== 1) throw genericError("Provider plugin is invalid");
		const identity = validatePluginIdentity(await this.#host.invokeCapability<PluginIdentityResult>(plugins[0]!, {
			authorization: {
				expiresAt: checked.accessExpiresAt.toISOString(),
				grantedScopes: [...checked.grantedScopes],
				kind: "bearer",
				value: checked.accessToken,
			},
			capabilityId: registration.capabilityId,
			command: "identity.resolve",
			input: {},
		}), registration);
		return {
			...checked,
			accountLabel: identity.maskedAccount,
			issuer: registration.issuer,
			outcome: "completed",
			subject: identity.subject,
		};
	}
}