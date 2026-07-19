import { describe, expect, it, vi } from "vitest";
import * as ipaddr from "ipaddr.js";
import { issueCsrf } from "../../src/modules/http/cookies";
import { createRouter } from "../../src/modules/http/router";
import type { AppConfig } from "../../src/modules/config";
import type { Database } from "../../src/modules/db/database";
import type { ActiveSession } from "../../src/modules/identity/types";

function config(host: string): AppConfig {
	return {
		allowedPrivateClientCidrs: [{ address: ipaddr.parse("10.0.0.0"), prefix: 8, raw: "10.0.0.0/8" }],
		allowMigrationDown: true,
		databaseUrl: "postgres://unused",
		outboundContact: "test@example.invalid",
		pinPepper: "p".repeat(32),
		pinReuseSecret: "r".repeat(32),
		port: 3000,
		publicOrigin: new URL(`https://${host}`),
		sessionSigningKey: "s".repeat(32),
		sourceHashSecret: "h".repeat(32),
		trustedProxyCidrs: [{ address: ipaddr.parse("10.1.0.0"), prefix: 16, raw: "10.1.0.0/16" }],
		userAgent: "k-test",
	};
}

const session: ActiveSession = {
	absoluteExpiresAt: new Date("2099-01-01T00:00:00Z"),
	createdAt: new Date("2026-07-17T00:00:00Z"),
	idleExpiresAt: new Date("2099-01-01T00:00:00Z"),
	lastSeenAt: new Date("2026-07-17T00:00:00Z"),
	profile: { checkedAt: "2026-07-17T00:00:00Z", credentialState: "ready", displayName: "Member 2", profileId: "00000000-0000-4000-8000-000000000002", slug: "member-2" },
	recentAuthAt: new Date(),
	revocationReason: null,
	revokedAt: null,
	sessionId: "00000000-0000-4000-8000-000000000010",
	tokenDigest: Buffer.alloc(32),
};

const neutralProfileRows = [
	{ display_name: "Member 1", profile_id: "00000000-0000-4000-8000-000000000001", slug: "member-1" },
	{ display_name: "Member 2", profile_id: "00000000-0000-4000-8000-000000000002", slug: "member-2" },
	{ display_name: "Member 3", profile_id: "00000000-0000-4000-8000-000000000003", slug: "member-3" },
];

function database(schemaVersion = 3, profileMatches = true, profileQueryFails = false) {
	const queries: string[] = [];
	const db = {
		queries,
		async close() {},
		pool: {} as never,
		async query(text: string) {
			queries.push(text);
			if (text.includes("to_regclass")) return { rows: [{ table_name: schemaVersion === 0 ? null : "schema_migrations" }] };
			if (text.includes("max(version)")) return { rows: [{ version: schemaVersion }] };
			if (text.includes("from profiles") && profileQueryFails) throw new Error("offline");
			if (text.includes("from profiles")) return {
				rows: profileMatches
					? neutralProfileRows
					: [{ ...neutralProfileRows[0], slug: "drifted" }, ...neutralProfileRows.slice(1)],
			};
			return { rows: [] };
		},
		async withClient() { throw new Error("not used"); },
		async withTransaction() { throw new Error("not used"); },
	} as unknown as Database & { queries: string[] };
	return db;
}

function identity() {
	return {
		changePin: vi.fn(async () => undefined),
		listProfiles: vi.fn(async () => []),
		login: vi.fn(async () => { throw new Error("login result not configured"); }),
		logout: vi.fn(async () => undefined),
		readSession: vi.fn(),
		reauthenticate: vi.fn(),
		redeemCredential: vi.fn(),
		requiresRecentAuth: vi.fn(() => false),
		sessionFromToken: vi.fn(async () => session),
	};
}

function secureRequest(input: { bodyText?: string; contentType?: string; csrfCookie?: string; host: string; method: string; path: string }) {
	return {
		bodyText: input.bodyText ?? "",
		headers: {
			cookie: `__Host-k.sid=session-token${input.csrfCookie ? `; __Host-k.csrf=${encodeURIComponent(input.csrfCookie)}` : ""}`,
			...(input.contentType ? { "content-type": input.contentType } : input.method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
			origin: `https://${input.host}`,
			"x-forwarded-for": "10.20.30.40",
			"x-forwarded-host": input.host,
			"x-forwarded-proto": "https",
		},
		method: input.method,
		remoteAddress: "10.1.2.3",
		url: new URL(`https://${input.host}${input.path}`),
	};
}

const catalog = { detail: vi.fn(), listInstalledPlugins: vi.fn(async () => []), search: vi.fn() };

describe("router mutation security", () => {
	it("renders the no-JavaScript profile picker and only Phase 2 navigation", async () => {
		const fakeIdentity = identity();
		fakeIdentity.listProfiles.mockResolvedValue([
			{ checkedAt: "2026-07-17T00:00:00Z", credentialState: "ready", displayName: "Member 1", profileId: "00000000-0000-4000-8000-000000000001", slug: "member-1" },
			{ checkedAt: "2026-07-17T00:00:00Z", credentialState: "ready", displayName: "Member 2", profileId: "00000000-0000-4000-8000-000000000002", slug: "member-2" },
			{ checkedAt: "2026-07-17T00:00:00Z", credentialState: "setup-required", displayName: "Member 3", profileId: "00000000-0000-4000-8000-000000000003", slug: "member-3" },
		]);
		const route = createRouter({ catalogService: catalog, config: config("k-a.example.invalid"), database: database(), identityService: fakeIdentity });
		const result = await route(secureRequest({ host: "k-a.example.invalid", method: "GET", path: "/unlock" }));
		expect(result.status).toBe(200);
		expect(String(result.body)).toContain("Who is reading?");
		expect(String(result.body)).toContain("Member 1");
		expect(String(result.body)).not.toContain("Household sender");
		expect(String(result.body)).not.toContain("Activity");
	});

	it("uses immutable UUIDs, not slugs, for browser profile query selection", async () => {
		const fakeIdentity = identity();
		fakeIdentity.listProfiles.mockResolvedValue([
			{ checkedAt: "2026-07-17T00:00:00Z", credentialState: "ready", displayName: "Member 1", profileId: "00000000-0000-4000-8000-000000000001", slug: "member-1" },
			{ checkedAt: "2026-07-17T00:00:00Z", credentialState: "setup-required", displayName: "Member 2", profileId: "00000000-0000-4000-8000-000000000002", slug: "member-2" },
			{ checkedAt: "2026-07-17T00:00:00Z", credentialState: "ready", displayName: "Member 3", profileId: "00000000-0000-4000-8000-000000000003", slug: "member-3" },
		]);
		const route = createRouter({ catalogService: catalog, config: config("k-a.example.invalid"), database: database(), identityService: fakeIdentity });
		const slugUnlock = await route(secureRequest({ host: "k-a.example.invalid", method: "GET", path: "/unlock?profile=member-2" }));
		const uuidUnlock = await route(secureRequest({ host: "k-a.example.invalid", method: "GET", path: "/unlock?profile=00000000-0000-4000-8000-000000000002" }));
		const slugSetup = await route(secureRequest({ host: "k-a.example.invalid", method: "GET", path: "/setup?profile=member-2" }));
		expect(String(slugUnlock.body)).toContain("Who is reading?");
		expect(String(uuidUnlock.body)).toContain("Set Member 2's PIN");
		expect(String(slugSetup.body)).toContain("Set Member 1's PIN");
	});

	it("rejects slug-shaped browser and API login/setup mutations", async () => {
		const appConfig = config("k-a.example.invalid");
		const csrf = issueCsrf(appConfig.sessionSigningKey);
		const fakeIdentity = identity();
		const route = createRouter({ catalogService: catalog, config: appConfig, database: database(), identityService: fakeIdentity });
		const requests = [
			secureRequest({ bodyText: JSON.stringify({ csrfToken: csrf.token, pin: "1357", profileId: "member-1" }), contentType: "application/json", csrfCookie: csrf.cookieValue, host: "k-a.example.invalid", method: "POST", path: "/api/v1/auth/login" }),
			secureRequest({ bodyText: JSON.stringify({ credentialCode: "x".repeat(43), csrfToken: csrf.token, pin: "1357", profileId: "member-1" }), contentType: "application/json", csrfCookie: csrf.cookieValue, host: "k-a.example.invalid", method: "POST", path: "/api/v1/auth/credential" }),
			secureRequest({ bodyText: new URLSearchParams({ csrfToken: csrf.token, pin: "1357", profileId: "member-1" }).toString(), csrfCookie: csrf.cookieValue, host: "k-a.example.invalid", method: "POST", path: "/unlock" }),
			secureRequest({ bodyText: new URLSearchParams({ confirmPin: "1357", credentialCode: "x".repeat(43), csrfToken: csrf.token, pin: "1357", profileId: "member-1" }).toString(), csrfCookie: csrf.cookieValue, host: "k-a.example.invalid", method: "POST", path: "/setup" }),
		];
		const results = await Promise.all(requests.map((request) => route(request)));
		expect(results.map((result) => result.status)).toEqual([422, 422, 422, 422]);
		expect(JSON.parse(String(results[0]!.body))).toMatchObject({ code: "validation_failed" });
		expect(JSON.parse(String(results[1]!.body))).toMatchObject({ code: "validation_failed" });
		expect(String(results[2]!.body)).toContain('data-problem-code="validation_failed"');
		expect(String(results[3]!.body)).toContain('data-problem-code="validation_failed"');
		expect(fakeIdentity.login).not.toHaveBeenCalled();
		expect(fakeIdentity.redeemCredential).not.toHaveBeenCalled();
	});

	it("returns the same auth problem code for HTML and JSON login", async () => {
		const appConfig = config("k-a.example.invalid");
		const csrf = issueCsrf(appConfig.sessionSigningKey);
		const fakeIdentity = identity();
		fakeIdentity.login.mockRejectedValue(new (await import("../../src/modules/http/problems")).ProblemError(401, "auth_failed", "PIN not accepted", "The profile or PIN was not accepted."));
		const route = createRouter({ catalogService: catalog, config: appConfig, database: database(), identityService: fakeIdentity });
		const jsonRequest = secureRequest({ bodyText: JSON.stringify({ csrfToken: csrf.token, pin: "9998", profileId: session.profile.profileId }), csrfCookie: csrf.cookieValue, host: "k-a.example.invalid", method: "POST", path: "/api/v1/auth/login" });
		jsonRequest.headers["content-type"] = "application/json";
		const htmlRequest = secureRequest({ bodyText: new URLSearchParams({ csrfToken: csrf.token, pin: "9998", profileId: session.profile.profileId }).toString(), csrfCookie: csrf.cookieValue, host: "k-a.example.invalid", method: "POST", path: "/unlock" });
		const [jsonResult, htmlResult] = await Promise.all([route(jsonRequest), route(htmlRequest)]);
		expect(JSON.parse(String(jsonResult.body)).code).toBe("auth_failed");
		expect(String(htmlResult.body)).toContain('data-problem-code="auth_failed"');
		expect(String(htmlResult.body)).not.toContain("9998");
		expect(jsonResult.status).toBe(401);
		expect(htmlResult.status).toBe(401);
	});

	it("passes the validated forwarded client address to identity throttling", async () => {
		const appConfig = config("k-a.example.invalid");
		const csrf = issueCsrf(appConfig.sessionSigningKey);
		const fakeIdentity = identity();
		fakeIdentity.login.mockResolvedValue({ sessionToken: "new-session", view: {} as never, csrfToken: "unused" });
		const route = createRouter({ catalogService: catalog, config: appConfig, database: database(), identityService: fakeIdentity });
		const body = JSON.stringify({ csrfToken: csrf.token, pin: "1357", profileId: session.profile.profileId });
		const result = await route(secureRequest({ bodyText: body, contentType: "application/json", csrfCookie: csrf.cookieValue, host: "k-a.example.invalid", method: "POST", path: "/api/v1/auth/login" }));
		expect(result.status).toBe(204);
		expect(fakeIdentity.login).toHaveBeenCalledWith(expect.objectContaining({ sourceAddress: "10.20.30.40" }));
	});

	it("passes the authenticated profile to plugin catalog operations", async () => {
		const route = createRouter({ catalogService: catalog, config: config("k-a.example.invalid"), database: database(), identityService: identity() });
		catalog.search.mockResolvedValueOnce({ items: [], mediaKind: "book", partial: false, providers: [], query: "pride", searchedAt: new Date().toISOString() });
		const result = await route(secureRequest({ host: "k-a.example.invalid", method: "GET", path: "/api/v1/catalog/search?q=pride" }));
		expect(result.status).toBe(200);
		expect(catalog.search).toHaveBeenCalledWith(session.profile.profileId, "pride");
	});

	it("keeps catalog API and detail SSR aligned for metadata and static support evidence", async () => {
		const checkedAt = "2026-07-18T16:00:00.000Z";
		const evidence = { checkedAt, freshness: "not-applicable", scope: { id: null, kind: "public-catalog" }, sourceId: "provider-policy", sourceKind: "static-policy", sourceLabel: "Provider policy" };
		const item = {
			acquisitionOptions: [],
			capability: "candidate",
			capabilityEvidence: [
				{ capability: "reviews", evidence, providerId: "goodreads", reason: "Goodreads has no supported API.", reasonCode: "GOODREADS_API_UNAVAILABLE", state: "unsupported" },
				{ capability: "product-availability", evidence, prerequisite: "Amazon Creators eligibility.", providerId: "amazon", reason: "Amazon eligibility is required.", reasonCode: "AMAZON_CREATORS_ELIGIBILITY_REQUIRED", state: "eligibility-required" },
				{ capability: "kindle-unlimited", evidence, providerId: "amazon", reason: "Kindle Unlimited is not exposed.", reasonCode: "KINDLE_UNLIMITED_NOT_EXPOSED", state: "not-exposed" },
			],
			capabilityReason: "Public-domain candidate.",
			catalogRef: "plugin:project-gutenberg:1342",
			checkedAt,
			creators: ["Jane Austen"],
			edition: null,
			identifiers: [{ scheme: "isbn-13", value: "9781402894626" }],
			itemId: "1342",
			language: "en",
			mediaKind: "book",
			metadataEvidence: [{ averageRating: 4.5, checkedAt, contributedFields: ["average-rating", "ratings-count", "information-link"], informationLink: "https://books.google.com/books?id=record_1", matchedBy: "isbn-13", matchQuality: "exact-identifier", mediaKind: "book", providerId: "google-books", providerLabel: "Google Books", ratingsCount: 42, recordId: "record_1" }],
			pluginId: "project-gutenberg",
			publishedYear: 1813,
			source: "Project Gutenberg",
			title: "Pride and Prejudice",
		};
		catalog.detail.mockResolvedValue(item);
		const route = createRouter({ catalogService: catalog, config: config("k-a.example.invalid"), database: database(), identityService: identity() });
		const [apiResult, htmlResult] = await Promise.all([
			route(secureRequest({ host: "k-a.example.invalid", method: "GET", path: "/api/v1/catalog/items/plugin%3Aproject-gutenberg%3A1342" })),
			route(secureRequest({ host: "k-a.example.invalid", method: "GET", path: "/books/plugin%3Aproject-gutenberg%3A1342" })),
		]);
		const apiBody = JSON.parse(String(apiResult.body));
		expect(apiBody).toMatchObject({ creators: ["Jane Austen"], identifiers: [{ scheme: "isbn-13", value: "9781402894626" }], mediaKind: "book", metadataEvidence: [{ providerId: "google-books", ratingsCount: 42 }] });
		expect(apiBody.capabilityEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ reasonCode: "GOODREADS_API_UNAVAILABLE" })]));
		expect(apiBody).not.toHaveProperty("authors");
		const html = String(htmlResult.body);
		expect(html).toContain("Ratings and metadata");
		expect(html).toContain("4.5 out of 5 from 42 ratings");
		expect(html).toContain("https://books.google.com/books?id=record_1");
		expect(html).toContain("Goodreads: Unsupported");
		expect(html).toContain("Amazon: Operator eligibility required");
		expect(html).toContain("Amazon: Not exposed by provider");
		expect(JSON.stringify(apiBody)).not.toMatch(/thumbnail|coverUrl/);
		expect(html).not.toContain("<img");
	});

	it("rejects unsupported media types and malformed JSON before authentication state", async () => {
		const appConfig = config("k-a.example.invalid");
		const csrf = issueCsrf(appConfig.sessionSigningKey);
		const fakeIdentity = identity();
		const route = createRouter({ catalogService: catalog, config: appConfig, database: database(), identityService: fakeIdentity });

		const wrongType = await route(secureRequest({
			bodyText: JSON.stringify({ csrfToken: csrf.token, pin: "1357", profileId: session.profile.profileId }),
			contentType: "text/plain",
			csrfCookie: csrf.cookieValue,
			host: "k-a.example.invalid",
			method: "POST",
			path: "/api/v1/auth/login",
		}));
		expect(wrongType.status).toBe(415);
		expect(JSON.parse(String(wrongType.body)).code).toBe("unsupported_media_type");

		for (const bodyText of ["", "{", "[]", "null"]) {
			const malformed = await route(secureRequest({
				bodyText,
				contentType: "application/json; charset=utf-8",
				csrfCookie: csrf.cookieValue,
				host: "k-a.example.invalid",
				method: "POST",
				path: "/api/v1/auth/login",
			}));
			expect(malformed.status).toBe(400);
			expect(JSON.parse(String(malformed.body)).code).toBe("invalid_json");
		}
		expect(fakeIdentity.login).not.toHaveBeenCalled();
	});

	it("returns raw CSRF in the session DTO and rotates it on reauthentication", async () => {
		const appConfig = config("k-a.example.invalid");
		const csrf = issueCsrf(appConfig.sessionSigningKey);
		const fakeIdentity = identity();
		fakeIdentity.readSession.mockImplementation(async (_token, token) => ({ csrfToken: token } as never));
		fakeIdentity.reauthenticate.mockResolvedValue({ sessionToken: "rotated-session", recentAuthAt: new Date() });
		const route = createRouter({ catalogService: catalog, config: appConfig, database: database(), identityService: fakeIdentity });
		const sessionRequest = secureRequest({ csrfCookie: csrf.cookieValue, host: "k-a.example.invalid", method: "GET", path: "/api/v1/session" });
		const sessionResult = await route(sessionRequest);
		expect(JSON.parse(String(sessionResult.body)).csrfToken).toBe(csrf.token);

		const reauthRequest = secureRequest({ bodyText: JSON.stringify({ csrfToken: csrf.token, pin: "1357" }), contentType: "application/json", csrfCookie: csrf.cookieValue, host: "k-a.example.invalid", method: "POST", path: "/api/v1/auth/reauthenticate" });
		const reauthResult = await route(reauthRequest);
		expect(reauthResult.status).toBe(204);
		const cookies = reauthResult.headers?.["set-cookie"] as string[];
		const csrfCookie = cookies.find((cookie) => cookie.startsWith("__Host-k.csrf="));
		expect(csrfCookie).toBeDefined();
		expect(decodeURIComponent(csrfCookie!.split(";")[0]!.split("=")[1]!)).not.toBe(csrf.cookieValue);
	});

	it("requires recent authentication before changing a PIN", async () => {
		const appConfig = config("k-a.example.invalid");
		const csrf = issueCsrf(appConfig.sessionSigningKey);
		const fakeIdentity = identity();
		fakeIdentity.requiresRecentAuth.mockReturnValue(true);
		const route = createRouter({ catalogService: catalog, config: appConfig, database: database(), identityService: fakeIdentity });
		const body = new URLSearchParams({ csrfToken: csrf.token, currentPin: "0123", newPin: "2468", confirmPin: "2468" }).toString();
		const result = await route(secureRequest({ bodyText: body, csrfCookie: csrf.cookieValue, host: "k-a.example.invalid", method: "POST", path: "/profile/pin" }));
		expect(result.status).toBe(403);
		expect(fakeIdentity.changePin).not.toHaveBeenCalled();
	});

	it("requires CSRF on HTML logout", async () => {
		const appConfig = config("k-a.example.invalid");
		const fakeIdentity = identity();
		const route = createRouter({ catalogService: catalog, config: appConfig, database: database(), identityService: fakeIdentity });
		const result = await route(secureRequest({ bodyText: "", host: "k-a.example.invalid", method: "POST", path: "/logout" }));
		expect(result.status).toBe(401);
		expect(fakeIdentity.logout).not.toHaveBeenCalled();
	});

	it("keeps each router bound to its own origin", async () => {
		const configA = config("k-a.example.invalid");
		const csrf = issueCsrf(configA.sessionSigningKey);
		const identityA = identity();
		const routeA = createRouter({ catalogService: catalog, config: configA, database: database(), identityService: identityA });
		createRouter({ catalogService: catalog, config: config("k-b.example.invalid"), database: database(), identityService: identity() });
		const result = await routeA(secureRequest({ bodyText: `csrfToken=${encodeURIComponent(csrf.token)}`, csrfCookie: csrf.cookieValue, host: "k-a.example.invalid", method: "POST", path: "/logout" }));
		expect(result.status).toBe(303);
		expect(identityA.logout).toHaveBeenCalledOnce();
	});

	it("rejects mismatched PIN confirmation before changing state", async () => {
		const appConfig = config("k-a.example.invalid");
		const csrf = issueCsrf(appConfig.sessionSigningKey);
		const fakeIdentity = identity();
		const route = createRouter({ catalogService: catalog, config: appConfig, database: database(), identityService: fakeIdentity });
		const body = new URLSearchParams({ csrfToken: csrf.token, currentPin: "0123", newPin: "2468", confirmPin: "1357" }).toString();
		const result = await route(secureRequest({ bodyText: body, csrfCookie: csrf.cookieValue, host: "k-a.example.invalid", method: "POST", path: "/profile/pin" }));
		expect(result.status).toBe(422);
		expect(fakeIdentity.changePin).not.toHaveBeenCalled();
	});

	it("reports stale schema without creating migration state", async () => {
		const fakeDatabase = database(0);
		const route = createRouter({ catalogService: catalog, config: config("k-a.example.invalid"), database: fakeDatabase, identityService: identity() });
		const result = await route({ bodyText: "", headers: {}, method: "GET", remoteAddress: "127.0.0.1", url: new URL("https://k-a.example.invalid/readyz") });
		expect(result.status).toBe(503);
		expect(fakeDatabase.queries.some((query) => /create table/i.test(query))).toBe(false);
	});

	it("fails readiness for invalid security prerequisites before querying the database", async () => {
		const appConfig = config("k-a.example.invalid");
		appConfig.allowedPrivateClientCidrs = [];
		appConfig.sessionSigningKey = "weak";
		const fakeDatabase = database();
		const route = createRouter({ catalogService: catalog, config: appConfig, database: fakeDatabase, identityService: identity() });
		const result = await route({ bodyText: "", headers: {}, method: "GET", remoteAddress: "127.0.0.1", url: new URL("https://k-a.example.invalid/readyz") });
		expect(result.status).toBe(503);
		expect(JSON.parse(String(result.body))).toMatchObject({ code: "configuration_required" });
		expect(fakeDatabase.queries).toEqual([]);
	});

	it("reports database unavailability as not ready", async () => {
		const fakeDatabase = database();
		fakeDatabase.query = async () => { throw new Error("offline"); };
		const route = createRouter({ catalogService: catalog, config: config("k-a.example.invalid"), database: fakeDatabase, identityService: identity() });
		const result = await route({ bodyText: "", headers: {}, method: "GET", remoteAddress: "127.0.0.1", url: new URL("https://k-a.example.invalid/readyz") });
		expect(result.status).toBe(503);
		expect(JSON.parse(String(result.body))).toMatchObject({ code: "database_not_ready" });
	});

	it("reports a profile parity query outage as database unavailability", async () => {
		const route = createRouter({ catalogService: catalog, config: config("k-a.example.invalid"), database: database(7, true, true), identityService: identity() });
		const result = await route({ bodyText: "", headers: {}, method: "GET", remoteAddress: "127.0.0.1", url: new URL("https://k-a.example.invalid/readyz") });
		expect(result.status).toBe(503);
		expect(JSON.parse(String(result.body))).toMatchObject({ code: "database_not_ready" });
	});

	it("keeps liveness up while readiness and application routes fail closed on profile drift", async () => {
		const route = createRouter({ catalogService: catalog, config: config("k-a.example.invalid"), database: database(7, false), identityService: identity() });
		const [health, ready, application] = await Promise.all([
			route({ bodyText: "", headers: {}, method: "GET", remoteAddress: "127.0.0.1", url: new URL("https://k-a.example.invalid/healthz") }),
			route({ bodyText: "", headers: {}, method: "GET", remoteAddress: "127.0.0.1", url: new URL("https://k-a.example.invalid/readyz") }),
			route(secureRequest({ host: "k-a.example.invalid", method: "GET", path: "/api/v1/auth/profiles" })),
		]);
		expect(health).toMatchObject({ body: "ok", status: 200 });
		expect(JSON.parse(String(ready.body))).toMatchObject({ code: "profile_configuration_mismatch", status: 503 });
		expect(JSON.parse(String(application.body))).toMatchObject({ code: "profile_configuration_mismatch", status: 503 });
	});
});
