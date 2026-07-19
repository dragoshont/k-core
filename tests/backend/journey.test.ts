import * as ipaddr from "ipaddr.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/modules/config";
import { createDatabase, type Database } from "../../src/modules/db/database";
import { migrate } from "../../src/modules/db/migrator";
import type { AppRequest, AppResponse } from "../../src/modules/http/app-types";
import { createRouter } from "../../src/modules/http/router";
import { IdentityService } from "../../src/modules/identity/service";
import { PluginCatalogService } from "../../src/modules/plugins/catalog";
import { discoverPlugins } from "../../src/modules/plugins/manifests";
import { loadReviewedPublicInventory } from "../../src/modules/plugins/public-inventory";
import { DeliveryService } from "../../src/modules/delivery/service";
import { startPostgresHarness, type PostgresHarness } from "./helpers/postgres";

function extractHidden(html: string, name: string) {
	const match = html.match(new RegExp(`<input[^>]+name="${name}"[^>]+value="([^"]*)"`));
	if (!match) throw new Error(`Missing hidden field ${name}`);
	return match[1]!;
}

function updateCookieJar(jar: Map<string, string>, response: AppResponse) {
	const values = response.headers?.["set-cookie"];
	for (const cookie of Array.isArray(values) ? values : values ? [values] : []) {
		const pair = cookie.split(";", 1)[0]!;
		const index = pair.indexOf("=");
		const name = pair.slice(0, index);
		const value = pair.slice(index + 1);
		if (value) jar.set(name, decodeURIComponent(value)); else jar.delete(name);
	}
}

function cookieHeader(jar: Map<string, string>) {
	return [...jar.entries()].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
}

describe("Phase 3 no-JavaScript journey", () => {
	let config: AppConfig;
	let database: Database;
	let harness: PostgresHarness;
	const installedPlugins = discoverPlugins("plugins");
	const publicPluginInventory = loadReviewedPublicInventory("plugins", installedPlugins);

	beforeEach(async () => {
		harness = await startPostgresHarness();
		config = {
			allowedPrivateClientCidrs: [{ address: ipaddr.parse("10.0.0.0"), prefix: 8, raw: "10.0.0.0/8" }],
			allowMigrationDown: true,
			databaseUrl: harness.connectionString,
			installedPlugins,
			outboundContact: "test@example.invalid",
			pinPepper: "p".repeat(32),
			pinReuseSecret: "r".repeat(32),
			port: 3000,
			publicPluginInventory,
			publicOrigin: new URL("https://k.example.invalid"),
			sessionSigningKey: "s".repeat(32),
			sourceHashSecret: "h".repeat(32),
			trustedProxyCidrs: [{ address: ipaddr.parse("10.1.0.0"), prefix: 16, raw: "10.1.0.0/16" }],
			userAgent: "k-test",
		};
		database = createDatabase(config);
		await migrate(database, { allowDown: true });
	});

	afterEach(async () => {
		await database.close();
		await harness.stop();
	});

	it("sets up, enables a plugin, searches, preflights, queues, changes PIN, and logs out with ordinary HTML forms", async () => {
		const identity = new IdentityService(database, config);
		const issued = await identity.issueCredentialCode({ issuerLabel: "test-operator", profileSlug: "member-2", purpose: "setup", reason: "journey", ttlMinutes: 15 });
		const plugin = installedPlugins.find((candidate) => candidate.manifest.pluginId === "project-gutenberg")!;
		const item = { acquisitionOptions: [{ estimatedBytes: 1000, format: "epub" as const, optionId: "epub3-images", rightsBasis: "public-domain" as const }], authors: ["H. G. Wells"], capability: "candidate" as const, capabilityReason: "Public-domain EPUB candidate", checkedAt: new Date().toISOString(), itemId: "84", language: "en", pluginId: plugin.manifest.pluginId, publishedYear: 1895, source: plugin.manifest.displayName, title: "The Time Machine" };
		const catalog = new PluginCatalogService(database, config, [plugin], {
			detail: async () => item,
			search: async (_plugin, query) => ({ items: [item], query, searchedAt: new Date().toISOString() }),
		} as never);
		const delivery = new DeliveryService(database, config, catalog, { ready: () => true, async send() { return { accepted: true, response: "250 accepted" }; } });
		const route = createRouter({
			catalogService: catalog,
			config,
			database,
			deliveryService: delivery,
		});
		const cookies = new Map<string, string>();
		const request = async (method: string, path: string, bodyText = "") => {
			const headers: Record<string, string> = {
				"x-forwarded-for": "10.20.30.40",
				"x-forwarded-host": "k.example.invalid",
				"x-forwarded-proto": "https",
			};
			if (cookies.size) headers.cookie = cookieHeader(cookies);
			if (method === "POST") {
				headers["content-type"] = "application/x-www-form-urlencoded";
				headers.origin = "https://k.example.invalid";
			}
			const appRequest: AppRequest = { bodyText, headers, method, remoteAddress: "10.1.2.3", url: new URL(`https://k.example.invalid${path}`) };
			const response = await route(appRequest);
			updateCookieJar(cookies, response);
			return response;
		};

		const setupPage = await request("GET", `/setup?profile=${issued.profile.profileId}`);
		expect(setupPage.status).toBe(200);
		const setupHtml = String(setupPage.body);
		const setupCsrf = extractHidden(setupHtml, "csrfToken");
		const setupResult = await request("POST", "/setup", new URLSearchParams({ credentialCode: issued.code, csrfToken: setupCsrf, pin: "1357", confirmPin: "1357", profileId: issued.profile.profileId }).toString());
		expect(setupResult.status).toBe(303);
		expect(setupResult.headers?.location).toBe("/unlock");

		const unlockPage = await request("GET", `/unlock?profile=${issued.profile.profileId}`);
		const unlockHtml = String(unlockPage.body);
		expect(unlockHtml).not.toContain(issued.code);
		const unlockCsrf = extractHidden(unlockHtml, "csrfToken");
		const unlockResult = await request("POST", "/unlock", new URLSearchParams({ csrfToken: unlockCsrf, pin: "1357", profileId: issued.profile.profileId }).toString());
		expect(unlockResult.status).toBe(303);
		expect(unlockResult.headers?.location).toBe("/search");
		expect(cookies.has("__Host-k.sid")).toBe(true);

		const deliveryPage = await request("GET", "/profile");
		expect(String(deliveryPage.body)).toContain("Project Gutenberg");
		expect(String(deliveryPage.body)).toContain("Installed source");
		const deliveryCsrf = extractHidden(String(deliveryPage.body), "csrfToken");
		const destination = await request("POST", "/profile/delivery", new URLSearchParams({ csrfToken: deliveryCsrf, kindleAddress: "member2@kindle.com" }).toString());
		expect(destination.status).toBe(303);

		const searchPage = await request("GET", "/search?q=time");
		expect(searchPage.status).toBe(200);
		expect(String(searchPage.body)).toContain("The Time Machine");
		expect(String(searchPage.body)).toContain("Check availability");
		expect(String(searchPage.body)).toContain("Activity");

		const detailPage = await request("GET", "/books/plugin%3Aproject-gutenberg%3A84");
		expect(detailPage.status).toBe(200);
		expect(String(detailPage.body)).toContain("The Time Machine");
		const preflightCsrf = extractHidden(String(detailPage.body), "csrfToken");
		const preflightPage = await request("POST", "/delivery/preflight", new URLSearchParams({ catalogRef: "plugin:project-gutenberg:84", csrfToken: preflightCsrf, optionId: "epub3-images" }).toString());
		expect(preflightPage.status).toBe(200);
		expect(String(preflightPage.body)).toContain("Review before sending");
		const preflightId = extractHidden(String(preflightPage.body), "preflightId");
		const operationCsrf = extractHidden(String(preflightPage.body), "csrfToken");
		const queued = await request("POST", "/operations", new URLSearchParams({ csrfToken: operationCsrf, preflightId }).toString());
		expect(queued.status).toBe(303);
		expect(String(queued.headers?.location)).toMatch(/^\/activity\/[0-9a-f-]+$/);
		const activity = await request("GET", "/activity");
		expect(activity.status).toBe(200);
		expect(String(activity.body)).toContain("The Time Machine");
		expect(String(activity.body)).toContain("queued");

		const profilePage = await request("GET", "/profile");
		expect(profilePage.status).toBe(200);
		expect(String(profilePage.body)).toContain("Kindle destination");
		expect(String(profilePage.body)).toContain("Installed source");
		const pinCsrf = extractHidden(String(profilePage.body), "csrfToken");
		const pinResult = await request("POST", "/profile/pin", new URLSearchParams({ confirmPin: "2468", csrfToken: pinCsrf, currentPin: "1357", newPin: "2468" }).toString());
		expect(pinResult.status).toBe(303);
		expect(cookies.has("__Host-k.sid")).toBe(false);

		const reloginPage = await request("GET", `/unlock?profile=${issued.profile.profileId}`);
		const reloginCsrf = extractHidden(String(reloginPage.body), "csrfToken");
		const relogin = await request("POST", "/unlock", new URLSearchParams({ csrfToken: reloginCsrf, pin: "2468", profileId: issued.profile.profileId }).toString());
		expect(relogin.status).toBe(303);
		const logoutPage = await request("GET", "/profile");
		const logoutCsrf = extractHidden(String(logoutPage.body), "csrfToken");
		const logout = await request("POST", "/logout", new URLSearchParams({ csrfToken: logoutCsrf }).toString());
		expect(logout.status).toBe(303);
		expect(cookies.has("__Host-k.sid")).toBe(false);

	});
});
