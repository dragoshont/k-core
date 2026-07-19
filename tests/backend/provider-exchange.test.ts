import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/modules/config";
import { createDatabase, type Database } from "../../src/modules/db/database";
import { migrate } from "../../src/modules/db/migrator";
import type { ActiveSession, ProfileSummary } from "../../src/modules/identity/types";
import { discoverPlugins } from "../../src/modules/plugins/manifests";
import type { InstalledPlugin, PluginIdentityResult } from "../../src/modules/plugins/types";
import {
	buildProviderAuthorizationUrl,
	createProviderMediatedFetch,
	ProviderExchangeAdapter,
	type ProviderIdentityHost,
} from "../../src/modules/provider-accounts/provider-exchange";
import { ProviderAccountService, type StartAuthorizationResult } from "../../src/modules/provider-accounts/service";
import type {
	ProviderConnectorId,
	ProviderConnectorRegistration,
	ProviderRuntimeConfig,
} from "../../src/modules/provider-accounts/types";
import { startPostgresHarness, type PostgresHarness } from "./helpers/postgres";
import { createProviderFixture, type ProviderFixture } from "./helpers/provider-config";

const PROFILE = {
	displayName: "Member 1",
	profileId: "00000000-0000-4000-8000-000000000001",
	slug: "member-1",
} as const;
const GOOGLE_SUBJECT = "google-subject-123";
const GOOGLE_ACCESS_TOKEN = "google-access-token-must-remain-secret";
const GOOGLE_REFRESH_TOKEN = "google-refresh-token-must-remain-secret";
const AMAZON_ACCESS_TOKEN = "amazon-access-token-must-remain-secret";
const TEST_USER_AGENT = "k-provider-exchange-test/1 (test@example.invalid)";

interface FakeScenario {
	tokenMode?: "declared-oversize" | "malformed-json" | "redirect" | "streaming-oversize" | "timeout";
	tokenResponse?: Record<string, unknown>;
	userInfo?: Record<string, unknown>;
}

interface FakeCall {
	method: string;
	redirect: RequestRedirect | undefined;
	url: string;
	userAgent: string | null;
}

class FakeProvider {
	readonly calls: FakeCall[] = [];
	readonly tokenBodies: URLSearchParams[] = [];
	scenario: FakeScenario = {};

	constructor(private readonly jwk: Record<string, unknown>) {}

	reset() {
		this.calls.splice(0);
		this.tokenBodies.splice(0);
		this.scenario = {};
	}

	fetch = (async (resource: URL | RequestInfo, init?: RequestInit) => {
		const url = resource instanceof URL
			? resource.href
			: typeof resource === "string"
				? resource
				: resource.url;
		const headers = new Headers(init?.headers);
		this.calls.push({
			method: init?.method ?? "GET",
			redirect: init?.redirect,
			url,
			userAgent: headers.get("user-agent"),
		});

		if (url === "https://openidconnect.googleapis.com/token"
			|| url === "https://api.amazon.com/token") {
			if (init?.body instanceof URLSearchParams) {
				this.tokenBodies.push(new URLSearchParams(init.body));
			}
			switch (this.scenario.tokenMode) {
				case "declared-oversize":
					return new Response("{}", {
						headers: { "content-length": String(1024 * 1024 + 1), "content-type": "application/json" },
						status: 200,
					});
				case "malformed-json":
					return new Response("not-json", { headers: { "content-type": "application/json" }, status: 200 });
				case "redirect":
					return new Response(null, { headers: { location: "https://evil.example.invalid/token" }, status: 302 });
				case "streaming-oversize": {
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array(1024 * 1024));
							controller.enqueue(new Uint8Array([1]));
							controller.close();
						},
					});
					return new Response(stream, { headers: { "content-type": "application/json" }, status: 200 });
				}
				case "timeout":
					return new Promise<Response>((_resolve, reject) => {
						const signal = init?.signal;
						if (signal?.aborted) reject(signal.reason);
						else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
				default:
					return Response.json(this.scenario.tokenResponse ?? {}, {
						headers: { "cache-control": "no-store" },
						status: 200,
					});
			}
		}
		if (url === "https://openidconnect.googleapis.com/jwks") {
			return Response.json({ keys: [this.jwk] }, {
				headers: { "cache-control": "max-age=300", "set-cookie": "must-not-pass=true" },
				status: 200,
			});
		}
		if (url === "https://openidconnect.googleapis.com/userinfo") {
			return Response.json(this.scenario.userInfo ?? { sub: GOOGLE_SUBJECT }, { status: 200 });
		}
		throw new Error(`unexpected fake-provider request: ${url}`);
	}) as typeof globalThis.fetch;
}

describe("provider exchange adapter", () => {
	let adapter: ProviderExchangeAdapter;
	let amazonIdentity: unknown;
	let database: Database;
	let fakeProvider: FakeProvider;
	let fixture: ProviderFixture;
	let harness: PostgresHarness;
	let hostCalls: Array<{
		authorization: { expiresAt: string; grantedScopes: string[]; kind: "bearer"; value: string } | undefined;
		capabilityId: string;
		command: string;
		pluginId: string;
	}>;
	let installedPlugins: InstalledPlugin[];
	let privateKey: CryptoKey;
	let runtime: ProviderRuntimeConfig;
	let service: ProviderAccountService;
	let session: ActiveSession;

	beforeEach(async () => {
		harness = await startPostgresHarness();
		const config: AppConfig = {
			allowedPrivateClientCidrs: [],
			allowMigrationDown: true,
			databaseUrl: harness.connectionString,
			outboundContact: "test@example.invalid",
			pinPepper: "pepper",
			pinReuseSecret: "reuse",
			port: 3000,
			publicOrigin: new URL("https://k.example.invalid"),
			sessionSigningKey: "session",
			sourceHashSecret: "source",
			trustedProxyCidrs: [],
			userAgent: TEST_USER_AGENT,
		};
		database = createDatabase(config);
		await migrate(database, { allowDown: true });
		fixture = await createProviderFixture();
		const loaded = fixture.load();
		if (loaded.status !== "configured") throw new Error("expected configured provider runtime");
		runtime = loaded;
		service = new ProviderAccountService(database, runtime);
		installedPlugins = discoverPlugins(fixture.pluginRoot);
		session = await createSession(database);

		const keys = await generateKeyPair("RS256", { extractable: true });
		privateKey = keys.privateKey;
		const jwk = await exportJWK(keys.publicKey) as Record<string, unknown>;
		Object.assign(jwk, { alg: "RS256", kid: "test-google-key", use: "sig" });
		fakeProvider = new FakeProvider(jwk);
		amazonIdentity = {
			checkedAt: new Date().toISOString(),
			maskedAccount: "a*****@example.invalid",
			providerId: "login-with-amazon",
			subject: "amazon-subject-123",
		} satisfies PluginIdentityResult;
		hostCalls = [];
		const host = {
			async invokeCapability<T>(plugin: InstalledPlugin, input: {
				authorization?: { expiresAt: string; grantedScopes: string[]; kind: "bearer"; value: string };
				capabilityId: string;
				command: "identity.resolve";
				input: Record<string, unknown>;
			}) {
				hostCalls.push({
					authorization: input.authorization,
					capabilityId: input.capabilityId,
					command: input.command,
					pluginId: plugin.normalized.pluginId,
				});
				return amazonIdentity as T;
			},
		} satisfies ProviderIdentityHost;
		adapter = new ProviderExchangeAdapter({
			config: runtime,
			fetch: fakeProvider.fetch,
			host,
			installedPlugins,
			service,
			timeoutMs: 100,
			userAgent: TEST_USER_AGENT,
		});
	});

	afterEach(async () => {
		await database?.close();
		await fixture?.cleanup();
		await harness?.stop();
	});

	async function start(connectorId: ProviderConnectorId) {
		return service.startAuthorization(session, connectorId, "connect");
	}

	function callback(started: StartAuthorizationResult, connectorId: ProviderConnectorId, code = "provider-code") {
		const url = new URL(runtime.connector(connectorId)!.registration.callbackUri);
		url.searchParams.set("code", code);
		url.searchParams.set("state", started.state);
		return url;
	}

	async function googleIdToken(
		started: StartAuthorizationResult,
		overrides: {
			audience?: string | string[];
			expiresAt?: number;
			issuedAt?: number;
			issuer?: string;
			nonce?: null | string;
			privateKey?: CryptoKey;
			subject?: string;
			azp?: string;
		} = {},
	) {
		const now = Math.floor(Date.now() / 1000);
		const payload: Record<string, unknown> = {
			azp: overrides.azp ?? "google-client",
			nonce: overrides.nonce === undefined ? started.authorizationUrl.nonce : overrides.nonce,
		};
		if (payload.nonce === null) delete payload.nonce;
		return new SignJWT(payload)
			.setProtectedHeader({ alg: "RS256", kid: "test-google-key", typ: "JWT" })
			.setIssuer(overrides.issuer ?? "https://openidconnect.googleapis.com")
			.setAudience(overrides.audience ?? "google-client")
			.setSubject(overrides.subject ?? GOOGLE_SUBJECT)
			.setIssuedAt(overrides.issuedAt ?? now)
			.setExpirationTime(overrides.expiresAt ?? now + 300)
			.sign(overrides.privateKey ?? privateKey);
	}

	async function setGoogleSuccess(
		started: StartAuthorizationResult,
		input: {
			idToken?: string;
			scope?: string | undefined;
			userInfo?: Record<string, unknown>;
		} = {},
	) {
		fakeProvider.scenario = {
			tokenResponse: {
				access_token: GOOGLE_ACCESS_TOKEN,
				expires_in: 3600,
				id_token: input.idToken ?? await googleIdToken(started),
				refresh_token: GOOGLE_REFRESH_TOKEN,
				...(input.scope === undefined ? {} : { scope: input.scope }),
				token_type: "Bearer",
			},
			userInfo: input.userInfo ?? {
				email: "member@example.invalid",
				sub: GOOGLE_SUBJECT,
			},
		};
	}

	function exchangeInput(started: StartAuthorizationResult, connectorId: ProviderConnectorId, callbackUrl = callback(started, connectorId)) {
		return {
			browserBinding: started.browserBinding,
			callbackUrl,
			connectorId,
			state: started.state,
		};
	}

	it("builds exact fixed authorization URLs with nonce only for OIDC", async () => {
		const google = await start("google-gmail");
		const googleUrl = adapter.authorizationUrl(google, "google-gmail");
		expect(`${googleUrl.origin}${googleUrl.pathname}`).toBe("https://openidconnect.googleapis.com/authorize");
		expect(Object.fromEntries(googleUrl.searchParams)).toEqual({
			client_id: "google-client",
			code_challenge: google.authorizationUrl.pkceChallenge,
			code_challenge_method: "S256",
			nonce: google.authorizationUrl.nonce,
			redirect_uri: "https://k.example.invalid/oauth/callback/google-gmail",
			response_type: "code",
			scope: "openid email",
			state: google.state,
		});
		expect(googleUrl.searchParams.has("next")).toBe(false);
		expect(googleUrl.searchParams.has("prompt")).toBe(false);
		expect(googleUrl.searchParams.has("resource")).toBe(false);
		expect(googleUrl.href).not.toContain("client-secret");

		const amazon = await start("login-with-amazon");
		const amazonUrl = adapter.authorizationUrl(amazon, "login-with-amazon");
		expect(`${amazonUrl.origin}${amazonUrl.pathname}`).toBe("https://api.amazon.com/authorize");
		expect(Object.fromEntries(amazonUrl.searchParams)).toEqual({
			client_id: "amazon-client",
			code_challenge: amazon.authorizationUrl.pkceChallenge,
			code_challenge_method: "S256",
			redirect_uri: "https://k.example.invalid/oauth/callback/login-with-amazon",
			response_type: "code",
			scope: "profile:user_id",
			state: amazon.state,
		});
		expect(amazonUrl.searchParams.has("nonce")).toBe(false);

		const replacement = structuredClone(google);
		replacement.authorizationUrl.authorizationEndpoint = "https://evil.example.invalid/authorize";
		expect(() => buildProviderAuthorizationUrl(replacement, runtime.connector("google-gmail")!.registration))
			.toThrow("Provider authorization request is invalid");
	});

	it("rejects callback origin, path, and fragments before a durable exchange claim", async () => {
		for (const makeUrl of [
			(started: StartAuthorizationResult) => new URL(`https://evil.example.invalid/oauth/callback/google-gmail?code=x&state=${started.state}`),
			(started: StartAuthorizationResult) => new URL(`https://k.example.invalid/oauth/callback/login-with-amazon?code=x&state=${started.state}`),
			(started: StartAuthorizationResult) => new URL(`https://k.example.invalid/oauth/callback/google-gmail?code=x&state=${started.state}#fragment`),
		]) {
			const started = await start("google-gmail");
			const result = await adapter.exchange(exchangeInput(started, "google-gmail", makeUrl(started)));
			expect(result).toEqual({ completionPath: "/profile/integrations/complete", receipt: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
			const row = await database.query<{ consumed_reason: string; exchange_claimed_at: Date | null }>(`
				select consumed_reason, exchange_claimed_at
				from oauth_authorizations where authorization_id = $1
			`, [started.authorizationId]);
			expect(row.rows[0]).toEqual({ consumed_reason: "invalid", exchange_claimed_at: null });
		}
		expect(fakeProvider.calls).toHaveLength(0);
		const claims = await database.query<{ count: string }>(`
			select count(*)::text as count from audit_events where action = 'provider-authorization.claim'
		`);
		expect(claims.rows[0]?.count).toBe("0");
	});

	it("completes Google OIDC with signed claims, exact UserInfo subject, and omitted-scope RFC semantics", async () => {
		const started = await start("google-gmail");
		await setGoogleSuccess(started);
		const result = await adapter.exchange(exchangeInput(started, "google-gmail"));
		expect(result).toEqual({ completionPath: "/profile/integrations/complete", receipt: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
		expect(await service.consumeCompletionReceipt(result.receipt)).toEqual({ outcome: "connected", valid: true });
		expect(fakeProvider.calls.map((call) => [call.method, call.url])).toEqual([
			["POST", "https://openidconnect.googleapis.com/token"],
			["GET", "https://openidconnect.googleapis.com/jwks"],
			["GET", "https://openidconnect.googleapis.com/userinfo"],
		]);
		expect(fakeProvider.calls.every((call) => call.redirect === "manual" && call.userAgent === TEST_USER_AGENT)).toBe(true);
		const tokenBody = fakeProvider.tokenBodies[0]!;
		expect(tokenBody.get("code")).toBe("provider-code");
		expect(tokenBody.get("client_id")).toBe("google-client");
		expect(tokenBody.get("client_secret")).toBe(fixture.env.GOOGLE_CLIENT_SECRET);
		expect(tokenBody.get("redirect_uri")).toBe("https://k.example.invalid/oauth/callback/google-gmail");
		expect(tokenBody.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);

		const accounts = await service.listAccountRows(PROFILE.profileId);
		expect(accounts).toEqual([expect.objectContaining({
			authorizationPending: false,
			connectorId: "google-gmail",
			grantedScopes: ["openid", "email"],
			maskedAccount: "m*****@example.invalid",
			state: "connected",
		})]);
		const authorization = await database.query<{
			consumed_reason: string;
			oidc_nonce_ciphertext: Buffer | null;
			pkce_ciphertext: Buffer | null;
		}>(`
			select consumed_reason, oidc_nonce_ciphertext, pkce_ciphertext
			from oauth_authorizations where authorization_id = $1
		`, [started.authorizationId]);
		expect(authorization.rows[0]).toEqual({
			consumed_reason: "completed",
			oidc_nonce_ciphertext: null,
			pkce_ciphertext: null,
		});
	});

	it("fails every invalid Google exchange generically, clears secrets, and rejects replay before fetch", async () => {
		const otherKeys = await generateKeyPair("RS256");
		const now = Math.floor(Date.now() / 1000);
		const cases: Array<{
			configure(started: StartAuthorizationResult): Promise<void>;
			name: string;
		}> = [
			{ name: "missing nonce", configure: async (started) => setGoogleSuccess(started, { idToken: await googleIdToken(started, { nonce: null }), scope: "openid email" }) },
			{ name: "wrong nonce", configure: async (started) => setGoogleSuccess(started, { idToken: await googleIdToken(started, { nonce: "wrong-nonce" }), scope: "openid email" }) },
			{ name: "wrong issuer", configure: async (started) => setGoogleSuccess(started, { idToken: await googleIdToken(started, { issuer: "https://issuer.example.invalid" }), scope: "openid email" }) },
			{ name: "wrong audience", configure: async (started) => setGoogleSuccess(started, { idToken: await googleIdToken(started, { audience: "other-client" }), scope: "openid email" }) },
			{ name: "wrong authorized party", configure: async (started) => setGoogleSuccess(started, { idToken: await googleIdToken(started, { audience: ["google-client", "other-client"], azp: "other-client" }), scope: "openid email" }) },
			{ name: "expired token", configure: async (started) => setGoogleSuccess(started, { idToken: await googleIdToken(started, { expiresAt: now - 120 }), scope: "openid email" }) },
			{ name: "stale issued-at", configure: async (started) => setGoogleSuccess(started, { idToken: await googleIdToken(started, { issuedAt: now - 7200 }), scope: "openid email" }) },
			{ name: "future issued-at", configure: async (started) => setGoogleSuccess(started, { idToken: await googleIdToken(started, { issuedAt: now + 120 }), scope: "openid email" }) },
			{ name: "wrong signature", configure: async (started) => setGoogleSuccess(started, { idToken: await googleIdToken(started, { privateKey: otherKeys.privateKey }), scope: "openid email" }) },
			{ name: "UserInfo subject mismatch", configure: async (started) => setGoogleSuccess(started, { scope: "openid email", userInfo: { email: "member@example.invalid", sub: "other-subject" } }) },
			{ name: "missing scope", configure: async (started) => setGoogleSuccess(started, { scope: "openid" }) },
			{ name: "additional scope", configure: async (started) => setGoogleSuccess(started, { scope: "openid email profile" }) },
			{ name: "malformed ID token", configure: async () => { fakeProvider.scenario = { tokenResponse: { access_token: GOOGLE_ACCESS_TOKEN, expires_in: 3600, id_token: "malformed", scope: "openid email", token_type: "Bearer" } }; } },
			{ name: "token timeout", configure: async () => { fakeProvider.scenario = { tokenMode: "timeout" }; } },
			{ name: "declared oversize", configure: async () => { fakeProvider.scenario = { tokenMode: "declared-oversize" }; } },
			{ name: "streaming oversize", configure: async () => { fakeProvider.scenario = { tokenMode: "streaming-oversize" }; } },
			{ name: "off-list redirect", configure: async () => { fakeProvider.scenario = { tokenMode: "redirect" }; } },
			{ name: "malformed token response", configure: async () => { fakeProvider.scenario = { tokenMode: "malformed-json" }; } },
		];

		for (const testCase of cases) {
			fakeProvider.reset();
			const started = await start("google-gmail");
			await testCase.configure(started);
			const result = await adapter.exchange(exchangeInput(started, "google-gmail"));
			expect(result, testCase.name).toEqual({
				completionPath: "/profile/integrations/complete",
				receipt: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			});
			expect(await service.consumeCompletionReceipt(result.receipt), testCase.name)
				.toEqual({ outcome: "invalid", valid: true });
			const row = await database.query<{
				consumed_reason: string;
				oidc_nonce_ciphertext: Buffer | null;
				pkce_ciphertext: Buffer | null;
			}>(`
				select consumed_reason, oidc_nonce_ciphertext, pkce_ciphertext
				from oauth_authorizations where authorization_id = $1
			`, [started.authorizationId]);
			expect(row.rows[0], testCase.name).toEqual({
				consumed_reason: "failed",
				oidc_nonce_ciphertext: null,
				pkce_ciphertext: null,
			});
			const fetchCount = fakeProvider.calls.length;
			const replay = await adapter.exchange(exchangeInput(started, "google-gmail"));
			expect(replay.completionPath, testCase.name).toBe("/profile/integrations/complete");
			expect(fakeProvider.calls.length, testCase.name).toBe(fetchCount);
		}
	});

	it("resolves Login with Amazon only through the selected typed plugin host", async () => {
		const started = await start("login-with-amazon");
		fakeProvider.scenario = {
			tokenResponse: {
				access_token: AMAZON_ACCESS_TOKEN,
				expires_in: 3600,
				refresh_token: "amazon-refresh-token-must-remain-secret",
				scope: "profile:user_id",
				token_type: "Bearer",
			},
		};
		const result = await adapter.exchange(exchangeInput(started, "login-with-amazon"));
		expect(await service.consumeCompletionReceipt(result.receipt)).toEqual({ outcome: "connected", valid: true });
		expect(fakeProvider.calls.map((call) => call.url)).toEqual(["https://api.amazon.com/token"]);
		expect(hostCalls).toEqual([{
			authorization: {
				expiresAt: expect.any(String),
				grantedScopes: ["profile:user_id"],
				kind: "bearer",
				value: AMAZON_ACCESS_TOKEN,
			},
			capabilityId: "login-with-amazon/identity",
			command: "identity.resolve",
			pluginId: "login-with-amazon",
		}]);
		expect(await service.listAccountRows(PROFILE.profileId)).toEqual([expect.objectContaining({
			connectorId: "login-with-amazon",
			grantedScopes: ["profile:user_id"],
			state: "connected",
		})]);
	});

	it("rejects wrong-provider and malformed Amazon plugin identities", async () => {
		for (const identity of [
			{ checkedAt: new Date().toISOString(), maskedAccount: null, providerId: "google-gmail", subject: "subject" },
			{ checkedAt: new Date().toISOString(), maskedAccount: null, providerId: "login-with-amazon", subject: "bad\nsubject" },
			{ checkedAt: new Date().toISOString(), extra: true, maskedAccount: null, providerId: "login-with-amazon", subject: "subject" },
		]) {
			fakeProvider.reset();
			amazonIdentity = identity;
			const started = await start("login-with-amazon");
			fakeProvider.scenario = { tokenResponse: {
				access_token: AMAZON_ACCESS_TOKEN,
				expires_in: 3600,
				scope: "profile:user_id",
				token_type: "Bearer",
			} };
			const result = await adapter.exchange(exchangeInput(started, "login-with-amazon"));
			expect(await service.consumeCompletionReceipt(result.receipt)).toEqual({ outcome: "invalid", valid: true });
			const row = await database.query<{ consumed_reason: string }>(
				"select consumed_reason from oauth_authorizations where authorization_id = $1",
				[started.authorizationId],
			);
			expect(row.rows[0]?.consumed_reason).toBe("failed");
		}
	});

	it("consumes provider denial without token fetch and rejects replay", async () => {
		const started = await start("google-gmail");
		const deniedUrl = new URL(runtime.connector("google-gmail")!.registration.callbackUri);
		deniedUrl.searchParams.set("error", "access_denied");
		deniedUrl.searchParams.set("error_description", "sensitive provider text must not escape");
		deniedUrl.searchParams.set("state", started.state);
		const input = exchangeInput(started, "google-gmail", deniedUrl);
		const denied = await adapter.exchange(input);
		expect(await service.consumeCompletionReceipt(denied.receipt)).toEqual({ outcome: "denied", valid: true });
		expect(fakeProvider.calls).toHaveLength(0);
		const row = await database.query<{ consumed_reason: string }>(
			"select consumed_reason from oauth_authorizations where authorization_id = $1",
			[started.authorizationId],
		);
		expect(row.rows[0]?.consumed_reason).toBe("denied");
		const replay = await adapter.exchange(input);
		expect(await service.consumeCompletionReceipt(replay.receipt)).toEqual({ outcome: "invalid", valid: true });
		expect(fakeProvider.calls).toHaveLength(0);
		expect(JSON.stringify([denied, replay])).not.toContain("sensitive provider text");
	});

	it("allows only one concurrent callback to reach the token endpoint", async () => {
		const started = await start("google-gmail");
		await setGoogleSuccess(started, { scope: "openid email" });
		const input = exchangeInput(started, "google-gmail");
		const results = await Promise.all([adapter.exchange(input), adapter.exchange(input)]);
		expect(results).toHaveLength(2);
		expect(fakeProvider.calls.filter((call) => call.url.endsWith("/token"))).toHaveLength(1);
		const outcomes = await Promise.all(results.map((result) => service.consumeCompletionReceipt(result.receipt)));
		expect(outcomes.map((result) => result.outcome).sort()).toEqual(["connected", "invalid"]);
	});

	it("blocks off-list and wrong-method fetches before the injected fetch and reconstructs safe bounded responses", async () => {
		const registration = runtime.connector("google-gmail")!.registration;
		let injectedCalls = 0;
		let observedSignal: AbortSignal | null = null;
		const mediated = createProviderMediatedFetch({
			fetch: (async (_resource, init) => {
				injectedCalls += 1;
				observedSignal = init?.signal ?? null;
				return new Response("{}", {
					headers: {
						"content-type": "application/json",
						location: "https://evil.example.invalid/redirect",
						"set-cookie": "secret=true",
					},
					status: 200,
				});
			}) as typeof globalThis.fetch,
			registration,
			timeoutMs: 100,
			userAgent: TEST_USER_AGENT,
		});
		const getOptions = { body: undefined, headers: {}, method: "GET", redirect: "manual" as const };
		for (const url of [
			"https://evil.example.invalid/token",
			"https://openidconnect.googleapis.com/token/other",
			"https://user:password@openidconnect.googleapis.com/token",
			"https://openidconnect.googleapis.com/token#fragment",
		]) {
			await expect(mediated(url, getOptions)).rejects.toThrow("Provider request is not allowed");
		}
		await expect(mediated(registration.tokenEndpoint, getOptions)).rejects.toThrow("Provider request is not allowed");
		await expect(mediated(registration.identityEndpoint, {
			...getOptions,
			body: new URLSearchParams(),
			method: "POST",
		})).rejects.toThrow("Provider request is not allowed");
		expect(injectedCalls).toBe(0);

		const caller = new AbortController();
		const response = await mediated(registration.identityEndpoint, { ...getOptions, signal: caller.signal });
		expect(injectedCalls).toBe(1);
		expect(observedSignal).not.toBe(caller.signal);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("{}");
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(response.headers.get("content-length")).toBe("2");
		expect(response.headers.has("location")).toBe(false);
		expect(response.headers.has("set-cookie")).toBe(false);
		expect(() => createProviderMediatedFetch({ registration, timeoutMs: 15_001, userAgent: TEST_USER_AGENT }))
			.toThrow("Provider request configuration is invalid");
	});

	it("returns and audits no client secret, token, code, state, nonce, subject, or provider error text", async () => {
		const started = await start("google-gmail");
		await setGoogleSuccess(started, { scope: "openid email" });
		const code = "authorization-code-must-remain-secret";
		const result = await adapter.exchange(exchangeInput(started, "google-gmail", callback(started, "google-gmail", code)));
		const audit = await database.query<{ details_json: Record<string, unknown> }>(`
			select details_json from audit_events
			where target_id = $1 or target_kind = 'oauth-completion'
			order by created_at
		`, [started.authorizationId]);
		const serialized = JSON.stringify({ audit: audit.rows, result });
		for (const secret of [
			fixture.env.GOOGLE_CLIENT_SECRET!,
			GOOGLE_ACCESS_TOKEN,
			GOOGLE_REFRESH_TOKEN,
			code,
			started.state,
			started.browserBinding,
			started.authorizationUrl.nonce!,
			GOOGLE_SUBJECT,
			"member@example.invalid",
		]) {
			expect(serialized).not.toContain(secret);
		}
		expect(Object.keys(result).sort()).toEqual(["completionPath", "receipt"]);
	});

	it("normalizes the reviewed Amazon plugin identity without exposing raw email or name", async () => {
		const moduleUrl = pathToFileURL(resolve("plugins/login-with-amazon/index.mjs")).href;
		const amazonPlugin = await import(moduleUrl) as {
			parseAmazonIdentity(source: string, checkedAt?: Date): PluginIdentityResult;
		};
		const result = amazonPlugin.parseAmazonIdentity(JSON.stringify({
			email: "person@example.invalid",
			name: "Person Name",
			user_id: "amazon-user-id",
		}), new Date("2026-07-18T20:00:00Z"));
		expect(result).toEqual({
			checkedAt: "2026-07-18T20:00:00.000Z",
			maskedAccount: "p*****@example.invalid",
			providerId: "login-with-amazon",
			subject: "amazon-user-id",
		});
		expect(JSON.stringify(result)).not.toContain("person@example.invalid");
		expect(JSON.stringify(result)).not.toContain("Person Name");
		expect(() => amazonPlugin.parseAmazonIdentity(JSON.stringify({ user_id: "bad\nsubject" })))
			.toThrow("Amazon identity response is invalid");
	});
});

async function createSession(database: Database): Promise<ActiveSession> {
	const now = new Date();
	const createdAt = new Date(now.getTime() - 1000);
	const idleExpiresAt = new Date(now.getTime() + 30 * 60_000);
	const absoluteExpiresAt = new Date(now.getTime() + 12 * 60 * 60_000);
	const sessionId = randomUUID();
	const tokenDigest = randomBytes(32);
	await database.query(`
		insert into sessions (
			session_id, profile_id, token_digest, created_at, last_seen_at,
			recent_auth_at, idle_expires_at, absolute_expires_at
		) values ($1, $2, $3, $4, $4, $5, $6, $7)
	`, [sessionId, PROFILE.profileId, tokenDigest, createdAt, now, idleExpiresAt, absoluteExpiresAt]);
	const profile: ProfileSummary = {
		checkedAt: now.toISOString(),
		credentialState: "setup-required",
		displayName: PROFILE.displayName,
		profileId: PROFILE.profileId,
		slug: PROFILE.slug,
	};
	return {
		absoluteExpiresAt,
		createdAt,
		idleExpiresAt,
		lastSeenAt: createdAt,
		profile,
		recentAuthAt: now,
		revocationReason: null,
		revokedAt: null,
		sessionId,
		tokenDigest,
	};
}