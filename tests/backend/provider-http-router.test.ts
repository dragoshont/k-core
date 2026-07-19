import { describe, expect, it, vi } from "vitest";
import * as ipaddr from "ipaddr.js";
import { ApplicationSecrets } from "../../src/modules/common/application-secrets";
import type { AppConfig } from "../../src/modules/config";
import type { Database } from "../../src/modules/db/database";
import type { DeliveryService } from "../../src/modules/delivery/service";
import { issueCsrf } from "../../src/modules/http/cookies";
import type { AppRequest, AppResponse } from "../../src/modules/http/app-types";
import { ProblemError } from "../../src/modules/http/problems";
import { createRouter } from "../../src/modules/http/router";
import type { ActiveSession } from "../../src/modules/identity/types";
import type { ProfilePluginView } from "../../src/modules/plugins/catalog";
import { discoverPlugins } from "../../src/modules/plugins/manifests";
import type { InstalledPlugin } from "../../src/modules/plugins/types";
import type { ProviderCompletionResult, ProviderExchangeInput } from "../../src/modules/provider-accounts/provider-exchange";
import type { ProviderAccountListView, StartAuthorizationResult } from "../../src/modules/provider-accounts/service";
import {
	ProviderConnector,
	type ProviderConnectorId,
	type ProviderConnectorRegistration,
	ProviderRuntimeConfig,
	ProviderSubjectHashKey,
	ProviderTokenKeyring,
} from "../../src/modules/provider-accounts/types";

const HOST = "k.example.invalid";
const BROWSER_BINDING = "b".repeat(43);
const STATE = "s".repeat(43);
const RECEIPT = "r".repeat(43);
const PROFILE_ID = "00000000-0000-4000-8000-000000000002";

const session: ActiveSession = {
	absoluteExpiresAt: new Date("2099-01-01T00:00:00Z"),
	createdAt: new Date("2026-07-18T10:00:00Z"),
	idleExpiresAt: new Date("2099-01-01T00:00:00Z"),
	lastSeenAt: new Date("2026-07-18T10:00:00Z"),
	profile: { checkedAt: "2026-07-18T10:00:00Z", credentialState: "ready", displayName: "Member 2", profileId: PROFILE_ID, slug: "member-2" },
	recentAuthAt: new Date(),
	revocationReason: null,
	revokedAt: null,
	sessionId: "00000000-0000-4000-8000-000000000010",
	tokenDigest: Buffer.alloc(32),
};

function registration(host: string, connectorId: ProviderConnectorId): ProviderConnectorRegistration {
	const google = connectorId === "google-gmail";
	const providerOrigin = google ? "https://openidconnect.googleapis.com" : "https://api.amazon.com";
	return {
		authorizationEndpoint: `${providerOrigin}/authorize`,
		callbackPath: `/oauth/callback/${connectorId}`,
		callbackUri: `https://${host}/oauth/callback/${connectorId}`,
		capabilityId: google ? "google-gmail/identity" : "login-with-amazon/identity",
		capabilityScopes: { "identity-only": google ? ["openid", "email"] : ["profile:user_id"] },
		clientId: `${connectorId}-client`,
		clientSecretConfigured: true,
		connectorId,
		identityEndpoint: google ? `${providerOrigin}/userinfo` : `${providerOrigin}/user/profile`,
		issuer: providerOrigin,
		jwksUri: google ? `${providerOrigin}/jwks` : null,
		oidc: google,
		pluginDigest: `${connectorId}-digest`,
		pluginId: connectorId,
		registrationId: connectorId,
		revocationEndpoint: null,
		tokenEndpoint: `${providerOrigin}/token`,
		tokenEndpointAuthMethod: "client_secret_post",
	};
}

function providerRuntimeConfig(host = HOST) {
	const registrations = (["google-gmail", "login-with-amazon"] as const).map((connectorId) => registration(host, connectorId));
	const connectors = new Map<ProviderConnectorId, ProviderConnector>(registrations.map((value) => [
		value.connectorId,
		new ProviderConnector(value, `${value.connectorId}-client-secret-never-leak`),
	]));
	return new ProviderRuntimeConfig({
		connectors,
		keyring: new ProviderTokenKeyring("test-key", new Map([["test-key", Buffer.alloc(32, "k")]])),
		registrations,
		subjectHashKey: new ProviderSubjectHashKey(Buffer.alloc(32, "h")),
	});
}

function config(configured = true): AppConfig {
	return {
		allowedPrivateClientCidrs: [{ address: ipaddr.parse("10.0.0.0"), prefix: 8, raw: "10.0.0.0/8" }],
		allowMigrationDown: true,
		databaseUrl: "postgres://unused",
		outboundContact: "test@example.invalid",
		pinPepper: "p".repeat(32),
		pinReuseSecret: "r".repeat(32),
		port: 3000,
		providerRuntimeConfig: configured ? providerRuntimeConfig() : { configured: false, status: "configuration-required" },
		publicOrigin: new URL(`https://${HOST}`),
		sessionSigningKey: "s".repeat(32),
		sourceHashSecret: "h".repeat(32),
		trustedProxyCidrs: [{ address: ipaddr.parse("10.1.0.0"), prefix: 16, raw: "10.1.0.0/16" }],
		userAgent: "k-router-test",
	};
}

function database() {
	return {
		async close() {},
		pool: {} as never,
		async query(text: string) {
			if (text.includes("from profiles")) {
				return { rows: [
					{ display_name: "Member 1", profile_id: "00000000-0000-4000-8000-000000000001", slug: "member-1" },
					{ display_name: "Member 2", profile_id: "00000000-0000-4000-8000-000000000002", slug: "member-2" },
					{ display_name: "Member 3", profile_id: "00000000-0000-4000-8000-000000000003", slug: "member-3" },
				] };
			}
			return { rows: [] };
		},
		async withClient() { throw new Error("not used"); },
		async withTransaction() { throw new Error("not used"); },
	} as unknown as Database;
}

function identity(recentAuthenticationRequired = false) {
	return {
		changePin: vi.fn(async () => undefined),
		listProfiles: vi.fn(async () => []),
		login: vi.fn(),
		logout: vi.fn(async () => undefined),
		readSession: vi.fn(),
		reauthenticate: vi.fn(),
		redeemCredential: vi.fn(),
		requiresRecentAuth: vi.fn(() => recentAuthenticationRequired),
		sessionFromToken: vi.fn(async (token: string | undefined) => token === "session-token" ? session : null),
	};
}

const catalogPlugins: ProfilePluginView[] = [
	{ capabilities: ["acquire", "detail", "search"], checkedAt: "2026-07-18T12:00:00Z", displayName: "Project Gutenberg", installed: true, pluginId: "project-gutenberg", reason: null, rightsBasis: "public-domain", support: "available", version: "1.0.0" },
	{ capabilities: ["acquire", "detail", "search"], checkedAt: "2026-07-18T12:00:00Z", displayName: "Standard Ebooks", installed: true, pluginId: "standard-ebooks", reason: null, rightsBasis: "public-domain", support: "available", version: "1.0.0" },
	{ capabilities: ["acquire", "detail", "search"], checkedAt: "2026-07-18T12:00:00Z", displayName: "Internet Archive", installed: true, pluginId: "internet-archive", reason: null, rightsBasis: "public-domain", support: "available", version: "1.0.0" },
];

const installedPlugins = ([
	{
		digest: "google-gmail-digest",
		normalized: {
			capabilities: [
				{ authorization: { kind: "profile-oauth2", registrationId: "google-gmail", requiredScopes: ["openid", "email"] }, capabilityId: "google-gmail/identity", commands: ["identity.resolve"], family: "identity-provider", version: 1 },
				{ artifactMediaTypes: ["message/rfc822"], authorization: { kind: "profile-oauth2", registrationId: "google-gmail", requiredScopes: ["https://www.googleapis.com/auth/gmail.send"] }, capabilityId: "google-gmail/mail", commands: ["mail.send"], family: "mail-sender", version: 1 },
			],
			pluginId: "google-gmail",
		},
	},
	{
		digest: "login-with-amazon-digest",
		normalized: {
			capabilities: [{ authorization: { kind: "profile-oauth2", registrationId: "login-with-amazon", requiredScopes: ["profile:user_id"] }, capabilityId: "login-with-amazon/identity", commands: ["identity.resolve"], family: "identity-provider", version: 1 }],
			pluginId: "login-with-amazon",
		},
	},
] as unknown) as InstalledPlugin[];

function catalog() {
	return {
		detail: vi.fn(),
		installed: installedPlugins,
		listInstalledPlugins: vi.fn(async () => catalogPlugins),
		search: vi.fn(),
	};
}

type CompletionReceiptResult =
	| { outcome: "connected" | "denied" | "expired" | "invalid"; valid: true }
	| { outcome: "invalid"; valid: false };

function started(connectorId: ProviderConnectorId): StartAuthorizationResult {
	const providerRegistration = registration(HOST, connectorId);
	return {
		authorizationId: "00000000-0000-4000-8000-000000000099",
		authorizationUrl: {
			authorizationEndpoint: providerRegistration.authorizationEndpoint,
			callbackUri: providerRegistration.callbackUri,
			clientId: providerRegistration.clientId,
			...(providerRegistration.oidc ? { nonce: "n".repeat(43) } : {}),
			pkceChallenge: "p".repeat(43),
			pkceMethod: "S256",
			scopes: providerRegistration.capabilityScopes["identity-only"],
		},
		browserBinding: BROWSER_BINDING,
		state: STATE,
	};
}

function providerService(accountRows: ProviderAccountListView[] = []) {
	return {
		consumeCompletionReceipt: vi.fn(async (_receipt: string): Promise<CompletionReceiptResult> => ({ outcome: "invalid", valid: false })),
		issueCompletionReceipt: vi.fn(async (_input: { authorizationId: string | null; connectorId: ProviderConnectorId | null; outcome: "connected" | "denied" | "expired" | "invalid"; profileId: string | null }) => RECEIPT),
		listAccountRows: vi.fn(async (_profileId: string): Promise<ProviderAccountListView[]> => accountRows),
		startAuthorization: vi.fn(async (_session: ActiveSession, connectorId: ProviderConnectorId, _purpose: "connect" | "reconnect") => started(connectorId)),
	};
}

function providerExchange() {
	return {
		authorizationUrl: vi.fn((_started: StartAuthorizationResult, connectorId: ProviderConnectorId) => {
			const url = new URL(registration(HOST, connectorId).authorizationEndpoint);
			url.searchParams.set("state", STATE);
			return url;
		}),
		exchange: vi.fn(async (_input: ProviderExchangeInput): Promise<ProviderCompletionResult> => ({ completionPath: "/profile/integrations/complete", receipt: RECEIPT })),
	};
}

function deliveryService() {
	return {
		readSettings: vi.fn(async () => ({
			destinationStatus: "ready",
			maskedAddress: "m***@kindle.com",
			revision: 1,
			sender: { checkedAt: "2026-07-18T12:00:00Z", reason: null, source: "Household mail relay", status: "ready" },
		})),
	} as unknown as DeliveryService;
}

function request(input: {
	bodyText?: string;
	contentType?: string;
	cookies?: Record<string, string>;
	csrfToken?: string;
	method?: string;
	origin?: string;
	path: string;
	sid?: boolean;
}): AppRequest {
	const cookieValues = [
		...(input.sid === false ? [] : ["__Host-k.sid=session-token"]),
		...Object.entries(input.cookies ?? {}).map(([name, value]) => `${name}=${encodeURIComponent(value)}`),
	];
	return {
		bodyText: input.bodyText ?? "",
		headers: {
			...(cookieValues.length > 0 ? { cookie: cookieValues.join("; ") } : {}),
			...(input.contentType ? { "content-type": input.contentType } : {}),
			origin: input.origin ?? `https://${HOST}`,
			...(input.csrfToken ? { "x-csrf-token": input.csrfToken } : {}),
			"x-forwarded-for": "10.20.30.40",
			"x-forwarded-host": HOST,
			"x-forwarded-proto": "https",
		},
		method: input.method ?? "GET",
		remoteAddress: "10.1.2.3",
		url: new URL(`https://${HOST}${input.path}`),
	};
}

function responseCookies(result: AppResponse) {
	const value = result.headers?.["set-cookie"];
	return Array.isArray(value) ? value : value ? [value] : [];
}

function normalizedCallback(result: AppResponse) {
	return {
		body: String(result.body),
		cookies: responseCookies(result).map((cookie) => cookie.replace(/^[^=]+=[^;]*/, (pair) => `${pair.slice(0, pair.indexOf("="))}=<opaque>`)),
		location: result.headers?.location,
		status: result.status,
	};
}

describe("Phase 3 provider HTTP and SSR binding", () => {
	it("returns two honest configuration-required account rows when provider config is absent", async () => {
		const route = createRouter({ catalogService: catalog(), config: config(false), database: database(), identityService: identity(), installedPlugins });
		const result = await route(request({ path: "/api/v1/me/accounts" }));
		const body = JSON.parse(String(result.body));

		expect(result.status).toBe(200);
		expect(body.items).toHaveLength(2);
		expect(body.items.map((item: { connectorId: string }) => item.connectorId)).toEqual(["google-gmail", "login-with-amazon"]);
		for (const item of body.items) {
			expect(item).toMatchObject({
				accountId: null,
				authorizationPending: false,
				canConnect: false,
				canDisconnect: false,
				canReconnect: false,
				capabilities: ["identity-only"],
				grantedScopes: [],
				providerAvailability: "configuration-required",
				reasonCode: "CONNECTOR_CONFIGURATION_REQUIRED",
				state: "not-configured",
			});
			expect(item.evidence).toMatchObject({ sourceKind: "static-policy", scope: { id: PROFILE_ID, kind: "profile" } });
		}
	});

	it("merges configured profile rows and exposes only approved capability records", async () => {
		const accounts = providerService([{
			accountId: "00000000-0000-4000-8000-000000000051",
			authorizationPending: false,
			capabilities: ["identity-only"],
			connectedAt: "2026-07-18T11:00:00.000Z",
			connectorId: "google-gmail",
			grantedScopes: ["openid", "email"],
			lastValidatedAt: "2026-07-18T11:00:00.000Z",
			maskedAccount: "m***@gmail.com",
			revision: 1,
			state: "connected",
		}]);
		const exchange = providerExchange();
		const route = createRouter({ catalogService: catalog(), config: config(), database: database(), identityService: identity(), installedPlugins, providerAccountService: accounts, providerExchangeAdapter: exchange });
		const [accountResult, capabilityResult] = await Promise.all([
			route(request({ path: "/api/v1/me/accounts" })),
			route(request({ path: "/api/v1/me/capabilities" })),
		]);
		const accountBody = JSON.parse(String(accountResult.body));
		const capabilityBody = JSON.parse(String(capabilityResult.body));

		expect(accountBody.items).toHaveLength(2);
		expect(accountBody.items[0]).toMatchObject({ accountId: "00000000-0000-4000-8000-000000000051", canReconnect: true, capabilities: ["identity-only"], connectorId: "google-gmail", grantedScopes: ["openid", "email"], state: "connected" });
		expect(accountBody.items[1]).toMatchObject({ accountId: null, canConnect: true, connectorId: "login-with-amazon", state: "not-configured" });

		expect(capabilityBody.items).toHaveLength(9);
		const byId = new Map(capabilityBody.items.map((item: { capabilityId: string }) => [item.capabilityId, item]));
		expect(byId.get("google-books/metadata")).toMatchObject({ installed: false, providerAvailability: "configuration-required" });
		expect(byId.get("google-gmail/identity")).toMatchObject({ installed: true, providerAvailability: "available", reasonCode: "IDENTITY_PROVIDER_AVAILABLE" });
		expect(byId.get("login-with-amazon/identity")).toMatchObject({ installed: true, providerAvailability: "available" });
		expect(byId.get("provider-policy/goodreads-reviews")).toMatchObject({ maturity: "policy-only", providerAvailability: "unsupported", reasonCode: "GOODREADS_API_UNAVAILABLE" });
		expect(byId.get("provider-policy/amazon-product-availability")).toMatchObject({ providerAvailability: "eligibility-required", reasonCode: "AMAZON_CREATORS_ELIGIBILITY_REQUIRED" });
		expect(byId.get("provider-policy/kindle-unlimited")).toMatchObject({ providerAvailability: "not-exposed", reasonCode: "KINDLE_UNLIMITED_NOT_EXPOSED" });
		const serialized = JSON.stringify({ accountBody, capabilityBody });
		expect(serialized).not.toContain("google-gmail/mail");
		expect(serialized).not.toContain("gmail.send");
		expect(serialized.toLowerCase()).not.toContain("onedrive");
		expect(serialized).not.toContain("client-secret-never-leak");
		expect(serialized).not.toContain("subject");
	});

	it("reports Google Books available only with the current plugin and private deployment key", async () => {
		const appConfig = config();
		appConfig.applicationSecrets = ApplicationSecrets.fromGoogleBooksApiKey("configured-google-books-key");
		const route = createRouter({ catalogService: catalog(), config: appConfig, database: database(), identityService: identity(), installedPlugins: discoverPlugins("plugins") });
		const result = await route(request({ path: "/api/v1/me/capabilities" }));
		const body = JSON.parse(String(result.body));
		const googleBooks = body.items.find((item: { capabilityId: string }) => item.capabilityId === "google-books/metadata");
		expect(googleBooks).toMatchObject({ installed: true, pluginId: "google-books", providerAvailability: "available", reasonCode: "PROVIDER_AVAILABLE" });
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("configured-google-books-key");
		expect(serialized).not.toContain("google-gmail/mail");
		expect(serialized.toLowerCase()).not.toContain("onedrive");
	});

	it("requires exact Origin, CSRF, and recent PIN before starting authorization", async () => {
		const appConfig = config();
		const csrf = issueCsrf(appConfig.sessionSigningKey);
		const accounts = providerService();
		const exchange = providerExchange();
		const bodyText = JSON.stringify({ purpose: "connect", requestedCapabilities: ["identity-only"] });

		const recentRoute = createRouter({ catalogService: catalog(), config: appConfig, database: database(), identityService: identity(true), installedPlugins, providerAccountService: accounts, providerExchangeAdapter: exchange });
		const recent = await recentRoute(request({ bodyText, contentType: "application/json", cookies: { "__Host-k.csrf": csrf.cookieValue }, csrfToken: csrf.token, method: "POST", path: "/api/v1/me/accounts/google-gmail/authorizations" }));
		const recentHtml = await recentRoute(request({ bodyText: new URLSearchParams({ csrfToken: csrf.token }).toString(), contentType: "application/x-www-form-urlencoded", cookies: { "__Host-k.csrf": csrf.cookieValue }, method: "POST", path: "/profile/integrations/google-gmail/connect" }));
		expect(recent.status).toBe(403);
		expect(recentHtml.status).toBe(403);

		const secureRoute = createRouter({ catalogService: catalog(), config: appConfig, database: database(), identityService: identity(), installedPlugins, providerAccountService: accounts, providerExchangeAdapter: exchange });
		const wrongOrigin = await secureRoute(request({ bodyText, contentType: "application/json", cookies: { "__Host-k.csrf": csrf.cookieValue }, csrfToken: csrf.token, method: "POST", origin: "https://other.example.invalid", path: "/api/v1/me/accounts/google-gmail/authorizations" }));
		const wrongCsrf = await secureRoute(request({ bodyText, contentType: "application/json", cookies: { "__Host-k.csrf": csrf.cookieValue }, csrfToken: "wrong", method: "POST", path: "/api/v1/me/accounts/google-gmail/authorizations" }));
		const wrongHtmlOrigin = await secureRoute(request({ bodyText: new URLSearchParams({ csrfToken: csrf.token }).toString(), contentType: "application/x-www-form-urlencoded", cookies: { "__Host-k.csrf": csrf.cookieValue }, method: "POST", origin: "https://other.example.invalid", path: "/profile/integrations/google-gmail/connect" }));
		expect(wrongOrigin.status).toBe(401);
		expect(wrongCsrf.status).toBe(401);
		expect(wrongHtmlOrigin.status).toBe(401);
		expect(accounts.startAuthorization).not.toHaveBeenCalled();
	});

	it("starts JSON and ordinary HTML identity-only flows with a fixed redirect and binding cookie", async () => {
		const appConfig = config();
		const csrf = issueCsrf(appConfig.sessionSigningKey);
		const accounts = providerService();
		const exchange = providerExchange();
		const route = createRouter({ catalogService: catalog(), config: appConfig, database: database(), identityService: identity(), installedPlugins, providerAccountService: accounts, providerExchangeAdapter: exchange });
		const jsonResult = await route(request({
			bodyText: JSON.stringify({ purpose: "connect", requestedCapabilities: ["identity-only"] }),
			contentType: "application/json",
			cookies: { "__Host-k.csrf": csrf.cookieValue },
			csrfToken: csrf.token,
			method: "POST",
			path: "/api/v1/me/accounts/google-gmail/authorizations",
		}));

		expect(jsonResult.status).toBe(303);
		expect(jsonResult.headers?.location).toBe(`https://openidconnect.googleapis.com/authorize?state=${STATE}`);
		expect(responseCookies(jsonResult)).toEqual([`__Host-k.oauth=${BROWSER_BINDING}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`]);
		expect(accounts.startAuthorization).toHaveBeenLastCalledWith(session, "google-gmail", "connect");

		const htmlResult = await route(request({
			bodyText: new URLSearchParams({ csrfToken: csrf.token }).toString(),
			contentType: "application/x-www-form-urlencoded",
			cookies: { "__Host-k.csrf": csrf.cookieValue },
			method: "POST",
			path: "/profile/integrations/login-with-amazon/reconnect",
		}));
		expect(htmlResult.status).toBe(303);
		expect(htmlResult.headers?.location).toContain("https://api.amazon.com/authorize");
		expect(accounts.startAuthorization).toHaveBeenLastCalledWith(session, "login-with-amazon", "reconnect");
	});

	it("rejects broadened capability, unknown connector, unconfigured connector, and purpose conflicts", async () => {
		const appConfig = config();
		const csrf = issueCsrf(appConfig.sessionSigningKey);
		const accounts = providerService();
		const exchange = providerExchange();
		const route = createRouter({ catalogService: catalog(), config: appConfig, database: database(), identityService: identity(), installedPlugins, providerAccountService: accounts, providerExchangeAdapter: exchange });
		const post = (path: string, value: unknown) => route(request({ bodyText: JSON.stringify(value), contentType: "application/json", cookies: { "__Host-k.csrf": csrf.cookieValue }, csrfToken: csrf.token, method: "POST", path }));

		expect((await post("/api/v1/me/accounts/google-gmail/authorizations", { purpose: "connect", requestedCapabilities: ["send-mail"] })).status).toBe(422);
		expect((await post("/api/v1/me/accounts/microsoft-onedrive/authorizations", { purpose: "connect", requestedCapabilities: ["identity-only"] })).status).toBe(404);

		const unconfiguredRoute = createRouter({ catalogService: catalog(), config: config(false), database: database(), identityService: identity(), installedPlugins, providerAccountService: accounts, providerExchangeAdapter: exchange });
		const unconfigured = await unconfiguredRoute(request({ bodyText: JSON.stringify({ purpose: "connect", requestedCapabilities: ["identity-only"] }), contentType: "application/json", cookies: { "__Host-k.csrf": csrf.cookieValue }, csrfToken: csrf.token, method: "POST", path: "/api/v1/me/accounts/google-gmail/authorizations" }));
		expect(unconfigured.status).toBe(409);

		accounts.startAuthorization.mockRejectedValueOnce(new ProblemError(409, "provider_account_state_conflict", "Provider account state changed"));
		const conflict = await post("/api/v1/me/accounts/google-gmail/authorizations", { purpose: "reconnect", requestedCapabilities: ["identity-only"] });
		expect(conflict.status).toBe(409);
	});

	it("accepts provider callbacks without SID and always sets fixed opaque completion cookies", async () => {
		const fakeIdentity = identity();
		const accounts = providerService();
		const exchange = providerExchange();
		const route = createRouter({ catalogService: catalog(), config: config(), database: database(), identityService: fakeIdentity, installedPlugins, providerAccountService: accounts, providerExchangeAdapter: exchange });
		const result = await route(request({ cookies: { "__Host-k.oauth": BROWSER_BINDING }, path: `/oauth/callback/google-gmail?state=${STATE}&code=provider-code`, sid: false }));

		expect(result.status).toBe(303);
		expect(result.headers?.location).toBe("/profile/integrations/complete");
		expect(responseCookies(result)).toEqual([
			"__Host-k.oauth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
			`__Host-k.integration=${RECEIPT}; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax`,
		]);
		expect(fakeIdentity.sessionFromToken).not.toHaveBeenCalled();
		expect(exchange.exchange).toHaveBeenCalledOnce();
		const exchangeInput = exchange.exchange.mock.calls[0]![0];
		expect(exchangeInput).toMatchObject({ browserBinding: BROWSER_BINDING, connectorId: "google-gmail", state: STATE });
		expect(exchangeInput.callbackUrl.href).toBe(`https://${HOST}/oauth/callback/google-gmail?state=${STATE}&code=provider-code`);
	});

	it("keeps denial, provider error, missing binding, and wrong binding callback responses non-oracular", async () => {
		const accounts = providerService();
		accounts.issueCompletionReceipt.mockResolvedValue("i".repeat(43));
		const exchange = providerExchange();
		exchange.exchange.mockImplementation(async (input) => {
			if (input.browserBinding !== BROWSER_BINDING) throw new Error("wrong browser binding with provider secret");
			if (new URL(input.callbackUrl).searchParams.get("error") === "access_denied") {
				return { completionPath: "/profile/integrations/complete", receipt: "d".repeat(43) };
			}
			throw new Error("provider raw error: token and user text must not leak");
		});
		const route = createRouter({ catalogService: catalog(), config: config(), database: database(), identityService: identity(), installedPlugins, providerAccountService: accounts, providerExchangeAdapter: exchange });
		const denial = await route(request({ cookies: { "__Host-k.oauth": BROWSER_BINDING }, path: `/oauth/callback/google-gmail?state=${STATE}&error=access_denied`, sid: false }));
		const providerError = await route(request({ cookies: { "__Host-k.oauth": BROWSER_BINDING }, path: `/oauth/callback/google-gmail?state=${STATE}&error=provider_secret_text`, sid: false }));
		const missing = await route(request({ path: `/oauth/callback/google-gmail?state=${STATE}&code=value`, sid: false }));
		const wrong = await route(request({ cookies: { "__Host-k.oauth": "w".repeat(43) }, path: `/oauth/callback/google-gmail?state=${STATE}&code=value`, sid: false }));

		expect(normalizedCallback(providerError)).toEqual(normalizedCallback(denial));
		expect(normalizedCallback(missing)).toEqual(normalizedCallback(denial));
		expect(normalizedCallback(wrong)).toEqual(normalizedCallback(denial));
		for (const result of [denial, providerError, missing, wrong]) {
			const serialized = JSON.stringify(result);
			expect(serialized).not.toContain("provider_secret_text");
			expect(serialized).not.toContain("token and user text");
			expect(serialized).not.toContain(STATE);
		}
	});

	it("consumes completion receipts once and renders missing, wrong, or replayed values as generic invalid HTML", async () => {
		const accounts = providerService();
		let consumed = false;
		accounts.consumeCompletionReceipt.mockImplementation(async (receipt): Promise<CompletionReceiptResult> => {
			if (receipt === RECEIPT && !consumed) {
				consumed = true;
				return { outcome: "connected", valid: true };
			}
			return { outcome: "invalid", valid: false };
		});
		const route = createRouter({ catalogService: catalog(), config: config(), database: database(), identityService: identity(), installedPlugins, providerAccountService: accounts, providerExchangeAdapter: providerExchange() });
		const first = await route(request({ cookies: { "__Host-k.integration": RECEIPT }, path: "/profile/integrations/complete", sid: false }));
		const replay = await route(request({ cookies: { "__Host-k.integration": RECEIPT }, path: "/profile/integrations/complete", sid: false }));
		const wrong = await route(request({ cookies: { "__Host-k.integration": "w".repeat(43) }, path: "/profile/integrations/complete", sid: false }));
		const expired = await route(request({ cookies: { "__Host-k.integration": "e".repeat(43) }, path: "/profile/integrations/complete", sid: false }));
		const missing = await route(request({ path: "/profile/integrations/complete", sid: false }));

		expect(first.status).toBe(200);
		expect(String(first.body)).toContain("Account connected");
		for (const result of [replay, wrong, expired, missing]) {
			expect(result.status).toBe(200);
			expect(String(result.body)).toContain("Connection response was not accepted");
			expect(String(result.body)).not.toContain("provider_secret_text");
			expect(responseCookies(result)).toEqual(["__Host-k.integration=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax"]);
		}
		expect(String(first.body)).not.toContain("Change PIN");
		expect(String(first.body)).not.toContain("Kindle destination");
		expect(accounts.consumeCompletionReceipt).toHaveBeenCalledTimes(5);
	});

	it("returns a protected, profile-owned, non-submittable disconnect preview", async () => {
		const appConfig = config();
		const csrf = issueCsrf(appConfig.sessionSigningKey);
		const accountId = "00000000-0000-4000-8000-000000000052";
		const accounts = providerService([{
			accountId,
			authorizationPending: false,
			capabilities: ["identity-only"],
			connectedAt: "2026-07-18T11:00:00.000Z",
			connectorId: "login-with-amazon",
			grantedScopes: ["profile:user_id"],
			lastValidatedAt: "2026-07-18T11:00:00.000Z",
			maskedAccount: "a***@example.invalid",
			revision: 2,
			state: "connected",
		}]);
		const route = createRouter({ catalogService: catalog(), config: appConfig, database: database(), identityService: identity(), installedPlugins, providerAccountService: accounts, providerExchangeAdapter: providerExchange() });
		const preview = await route(request({
			cookies: { "__Host-k.csrf": csrf.cookieValue },
			csrfToken: csrf.token,
			method: "POST",
			path: `/api/v1/me/accounts/${accountId}/disconnect-preflights`,
		}));
		const body = JSON.parse(String(preview.body));
		expect(preview.status).toBe(200);
		expect(body).toMatchObject({
			account: { accountId, canDisconnect: false, capabilities: ["identity-only"], connectorId: "login-with-amazon" },
			affectedDestinations: [],
			affectedOperations: { cancelableQueued: 0, running: 0 },
			canSubmit: false,
			reasonCode: "DISCONNECT_AVAILABLE_IN_PHASE_4",
		});
		expect(new Date(body.expiresAt).getTime() - new Date(body.createdAt).getTime()).toBe(5 * 60_000);
		expect(accounts.startAuthorization).not.toHaveBeenCalled();
		expect(accounts.issueCompletionReceipt).not.toHaveBeenCalled();

		const unknown = await route(request({
			cookies: { "__Host-k.csrf": csrf.cookieValue },
			csrfToken: csrf.token,
			method: "POST",
			path: "/api/v1/me/accounts/00000000-0000-4000-8000-000000000099/disconnect-preflights",
		}));
		expect(unknown.status).toBe(404);

		const staleRoute = createRouter({ catalogService: catalog(), config: appConfig, database: database(), identityService: identity(true), installedPlugins, providerAccountService: accounts, providerExchangeAdapter: providerExchange() });
		const stale = await staleRoute(request({
			cookies: { "__Host-k.csrf": csrf.cookieValue },
			csrfToken: csrf.token,
			method: "POST",
			path: `/api/v1/me/accounts/${accountId}/disconnect-preflights`,
		}));
		expect(stale.status).toBe(403);
	});

	it("renders configured and configuration-required account rows in Profile without losing existing settings", async () => {
		const accounts = providerService([{
			accountId: "00000000-0000-4000-8000-000000000052",
			authorizationPending: false,
			capabilities: ["identity-only"],
			connectedAt: "2026-07-18T11:00:00.000Z",
			connectorId: "login-with-amazon",
			grantedScopes: ["profile:user_id"],
			lastValidatedAt: "2026-07-18T11:00:00.000Z",
			maskedAccount: "a***@example.invalid",
			revision: 2,
			state: "expired-or-revoked",
		}]);
		const route = createRouter({ catalogService: catalog(), config: config(), database: database(), deliveryService: deliveryService(), identityService: identity(), installedPlugins, providerAccountService: accounts, providerExchangeAdapter: providerExchange() });
		const configured = await route(request({ path: "/profile" }));
		const html = String(configured.body);

		expect(configured.status).toBe(200);
		expect(html).toContain("Account connections");
		expect(html).toContain('/profile/integrations/google-gmail/connect');
		expect(html).toContain('/profile/integrations/login-with-amazon/reconnect');
		expect(html).toContain("Identity only");
		expect(html).not.toContain(">Disconnect<");
		expect(html).toContain("Kindle destination");
		expect(html).toContain("Project Gutenberg");
		expect(html).toContain("Change PIN");

		const requiredRoute = createRouter({ catalogService: catalog(), config: config(false), database: database(), deliveryService: deliveryService(), identityService: identity(), installedPlugins });
		const required = await requiredRoute(request({ path: "/profile" }));
		const requiredHtml = String(required.body);
		expect(required.status).toBe(200);
		expect(requiredHtml).toContain("operator must register the exact Google callback");
		expect(requiredHtml).toContain("operator must register the exact Login with Amazon callback");
		expect(requiredHtml).not.toContain("/profile/integrations/google-gmail/connect");
	});
});