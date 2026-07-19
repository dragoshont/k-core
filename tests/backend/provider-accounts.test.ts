import { createDecipheriv } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { assertConfig, readConfig } from "../../src/modules/config";
import {
	PROVIDER_CONFIGURATION_ERROR,
	loadProviderRuntimeConfig,
	readProviderConfigPaths,
} from "../../src/modules/provider-accounts/config";
import {
	decryptProviderToken,
	encryptProviderToken,
	PROVIDER_TOKEN_DECRYPTION_ERROR,
	providerSubjectHmac,
} from "../../src/modules/provider-accounts/custody";
import {
	ProviderSubjectHashKey,
	ProviderTokenKeyring,
	type ProviderAccountTokenContext,
	type ProviderPkceContext,
} from "../../src/modules/provider-accounts/types";
import { createProviderFixture, type ProviderFixture } from "./helpers/provider-config";

const providerFixtures: ProviderFixture[] = [];

afterEach(async () => {
	await Promise.all(providerFixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function providerFixture() {
	const fixture = await createProviderFixture();
	providerFixtures.push(fixture);
	return fixture;
}

const appEnv = {
	ALLOWED_PRIVATE_CLIENT_CIDRS: "10.0.0.0/8",
	DATABASE_URL: "postgres://example",
	OUTBOUND_CONTACT: "test@example.invalid",
	PIN_PEPPER: "p".repeat(32),
	PIN_REUSE_SECRET: "r".repeat(32),
	PUBLIC_ORIGIN: "https://k.example.invalid",
	SESSION_SIGNING_KEY: "s".repeat(32),
	SOURCE_HASH_SECRET: "h".repeat(32),
	TRUSTED_PROXY_CIDRS: "10.1.0.0/16",
};

describe("provider account configuration", () => {
	it("reports configuration-required when every provider path is absent", () => {
		expect(readProviderConfigPaths({})).toEqual({
			configured: false,
			status: "configuration-required",
		});
		const appState = readConfig(appEnv);
		expect(appState.ok).toBe(true);
		expect(appState.value?.providerRuntimeConfig).toEqual({ configured: false, status: "configuration-required" });
	});

	it("fails closed with a generic error when provider paths are partial", () => {
		expect(readProviderConfigPaths({ PROVIDER_REGISTRATIONS_FILE: "/private/registrations.json" })).toEqual({
			configured: false,
			errors: [PROVIDER_CONFIGURATION_ERROR],
			status: "invalid",
		});
		expect(readProviderConfigPaths({ PROVIDER_REGISTRATIONS_FILE: "" })).toEqual({
			configured: false,
			errors: [PROVIDER_CONFIGURATION_ERROR],
			status: "invalid",
		});
		expect(readConfig({ ...appEnv, PROVIDER_REGISTRATIONS_FILE: "/private/registrations.json" })).toEqual({
			errors: [PROVIDER_CONFIGURATION_ERROR],
			ok: false,
		});
	});

	it("loads exactly the installed Google and Login with Amazon identity connectors", async () => {
		const fixture = await providerFixture();
		const state = fixture.load();
		if (state.status !== "configured") throw new Error("expected configured provider runtime");
		expect(state.registrations).toEqual([
			expect.objectContaining({
				callbackUri: "https://k.example.invalid/oauth/callback/google-gmail",
				capabilityScopes: { "identity-only": ["openid", "email"] },
				clientSecretConfigured: true,
				connectorId: "google-gmail",
					tokenEndpointAuthMethod: "client_secret_post",
			}),
			expect.objectContaining({
				callbackUri: "https://k.example.invalid/oauth/callback/login-with-amazon",
				capabilityScopes: { "identity-only": ["profile:user_id"] },
				clientSecretConfigured: true,
				connectorId: "login-with-amazon",
					tokenEndpointAuthMethod: "client_secret_post",
			}),
		]);
		expect(state.keyring.activeKeyId).toBe("active-2026");
		expect(state.connector("google-gmail")?.useClientSecret((value) => value.length)).toBe("google-client-secret-plaintext".length);

		const appState = readConfig({ ...appEnv, ...fixture.env, PUBLIC_PLUGIN_DIR: resolve("plugins") });
		expect(appState.ok).toBe(true);
		expect(appState.value?.providerRuntimeConfig?.status).toBe("configured");
	});

	it("rejects unknown registration fields through the production schema", async () => {
		const fixture = await providerFixture();
		await writeFile(fixture.registrationsFile, JSON.stringify({ ...fixture.registrations, unexpected: true }));
		expect(fixture.load()).toEqual({ configured: false, errors: [PROVIDER_CONFIGURATION_ERROR], status: "invalid" });

		const connectorRedirect = structuredClone(fixture.registrations);
		Object.assign(connectorRedirect.connectors[0]!, { redirectUri: "https://attacker.example.invalid/callback" });
		await writeFile(fixture.registrationsFile, JSON.stringify(connectorRedirect));
		expect(fixture.load()).toEqual({ configured: false, errors: [PROVIDER_CONFIGURATION_ERROR], status: "invalid" });
	});

	it("requires a supported explicit token endpoint authentication method", async () => {
		const fixture = await providerFixture();
		const missing = structuredClone(fixture.registrations);
		delete (missing.connectors[0] as Partial<typeof missing.connectors[0]>).tokenEndpointAuthMethod;
		await writeFile(fixture.registrationsFile, JSON.stringify(missing));
		expect(fixture.load().status).toBe("invalid");

		const unsupported = structuredClone(fixture.registrations);
		(unsupported.connectors[0] as { tokenEndpointAuthMethod: string }).tokenEndpointAuthMethod = "none";
		await writeFile(fixture.registrationsFile, JSON.stringify(unsupported));
		expect(fixture.load().status).toBe("invalid");
	});

	it("makes assertConfig fail closed before startup for configured invalid provider files", async () => {
		const fixture = await providerFixture();
		await writeFile(fixture.registrationsFile, JSON.stringify({ ...fixture.registrations, unexpected: true }));
		const state = readConfig({ ...appEnv, ...fixture.env, PUBLIC_PLUGIN_DIR: resolve("plugins") });
		expect(state).toEqual({ errors: [PROVIDER_CONFIGURATION_ERROR], ok: false });
		expect(() => assertConfig(state)).toThrow(PROVIDER_CONFIGURATION_ERROR);
	});

	it("rejects duplicate token key IDs and a missing active key", async () => {
		const fixture = await providerFixture();
		await writeFile(fixture.keyringFile, JSON.stringify({
			...fixture.keyring,
			keys: [fixture.keyring.keys[0], fixture.keyring.keys[0]],
		}));
		expect(fixture.load().status).toBe("invalid");

		await writeFile(fixture.keyringFile, JSON.stringify({ ...fixture.keyring, activeKeyId: "missing" }));
		expect(fixture.load().status).toBe("invalid");
	});

	it("rejects duplicate or missing connector IDs", async () => {
		const fixture = await providerFixture();
		await writeFile(fixture.registrationsFile, JSON.stringify({
			...fixture.registrations,
			connectors: [fixture.registrations.connectors[0], fixture.registrations.connectors[0]],
		}));
		expect(fixture.load().status).toBe("invalid");

		await writeFile(fixture.registrationsFile, JSON.stringify({
			...fixture.registrations,
			connectors: [fixture.registrations.connectors[0]],
		}));
		expect(fixture.load().status).toBe("invalid");
	});

	it("rejects missing secret references and non-32-byte decoded token keys", async () => {
		const fixture = await providerFixture();
		const missingSecret = { ...fixture.env };
		delete missingSecret.GOOGLE_CLIENT_SECRET;
		expect(fixture.load(missingSecret).status).toBe("invalid");
		const missingKey = { ...fixture.env };
		delete missingKey.PROVIDER_TOKEN_KEY_ACTIVE;
		expect(fixture.load(missingKey).status).toBe("invalid");

		expect(fixture.load({ ...fixture.env, PROVIDER_TOKEN_KEY_ACTIVE: Buffer.alloc(31).toString("base64url") }).status).toBe("invalid");
	});

	it("rejects a provider subject hash file that is not exactly 32 raw bytes", async () => {
		const fixture = await providerFixture();
		await writeFile(fixture.subjectHashKeyFile, Buffer.alloc(31));
		expect(fixture.load().status).toBe("invalid");
	});

	it("rejects endpoint hosts outside the selected plugin manifest", async () => {
		const fixture = await providerFixture();
		fixture.registrations.connectors[0]!.authorizationEndpoint = "https://evil.example.invalid/authorize";
		await writeFile(fixture.registrationsFile, JSON.stringify(fixture.registrations));
		expect(fixture.load().status).toBe("invalid");
	});

	it("rejects callback mismatch and cross-connector plugin ownership", async () => {
		const fixture = await providerFixture();
		fixture.registrations.connectors[0]!.callbackPath = "/oauth/callback/login-with-amazon";
		await writeFile(fixture.registrationsFile, JSON.stringify(fixture.registrations));
		expect(fixture.load().status).toBe("invalid");

		fixture.registrations.connectors[0]!.callbackPath = "/oauth/callback/google-gmail";
		fixture.registrations.connectors[0]!.registrationId = "login-with-amazon";
		fixture.registrations.connectors[0]!.pluginId = "login-with-amazon";
		fixture.registrations.connectors[0]!.capabilityId = "login-with-amazon/identity";
		await writeFile(fixture.registrationsFile, JSON.stringify(fixture.registrations));
		expect(fixture.load().status).toBe("invalid");
	});

	it("rejects registration, plugin, capability, and OIDC mode mismatches independently", async () => {
		const fixture = await providerFixture();
		const base = structuredClone(fixture.registrations);
		for (const patch of [
			{ registrationId: "login-with-amazon" },
			{ pluginId: "login-with-amazon" },
			{ capabilityId: "login-with-amazon/identity" },
			{ oidc: false },
		]) {
			const document = structuredClone(base);
			Object.assign(document.connectors[0]!, patch);
			await writeFile(fixture.registrationsFile, JSON.stringify(document));
			expect(fixture.load().status).toBe("invalid");
		}
	});

	it("rejects scopes or capabilities beyond the installed Phase 3 identity descriptor", async () => {
		const fixture = await providerFixture();
		fixture.registrations.connectors[0]!.capabilityScopes["identity-only"].push("https://www.googleapis.com/auth/gmail.send");
		await writeFile(fixture.registrationsFile, JSON.stringify(fixture.registrations));
		expect(fixture.load().status).toBe("invalid");

		fixture.registrations.connectors[0]!.capabilityScopes["identity-only"] = ["openid", "email"];
		await writeFile(fixture.registrationsFile, JSON.stringify({
			...fixture.registrations,
			connectors: fixture.registrations.connectors.map((connector, index) => index === 0
				? { ...connector, capabilityScopes: { ...connector.capabilityScopes, "gmail-send": ["gmail.send"] } }
				: connector),
		}));
		expect(fixture.load().status).toBe("invalid");
	});

	it("does not expose client secrets or key plaintext in errors or loggable representations", async () => {
		const fixture = await providerFixture();
		const state = fixture.load();
		if (state.status !== "configured") throw new Error("expected configured provider runtime");
		const sensitiveValues = [
			fixture.env.AMAZON_CLIENT_SECRET!,
			fixture.env.GOOGLE_CLIENT_SECRET!,
			fixture.env.PROVIDER_TOKEN_KEY_ACTIVE!,
			Buffer.alloc(32, "h").toString("utf8"),
		];
		const connector = state.connector("google-gmail")!;
		const representations = [
			String(state), inspect(state), JSON.stringify(state),
			String(connector), inspect(connector), JSON.stringify(connector),
			inspect(state.keyring), JSON.stringify(state.keyring),
			inspect(state.subjectHashKey), JSON.stringify(state.subjectHashKey),
		];
		for (const representation of representations) {
			for (const sensitiveValue of sensitiveValues) expect(representation).not.toContain(sensitiveValue);
		}

		const invalid = fixture.load({ ...fixture.env, PROVIDER_TOKEN_KEY_ACTIVE: "key-plaintext-must-not-leak" });
		expect(JSON.stringify(invalid)).toBe(JSON.stringify({ configured: false, errors: [PROVIDER_CONFIGURATION_ERROR], status: "invalid" }));
		expect(JSON.stringify(invalid)).not.toContain("key-plaintext-must-not-leak");
	});
});

describe("provider token custody", () => {
	const activeKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
	const keyring = new ProviderTokenKeyring("key-1", new Map([["key-1", activeKey]]));
	const context: ProviderAccountTokenContext = {
		accountId: "3ff4dce1-f2b8-4d31-a6a2-49b892269079",
		connectorId: "google-gmail",
		kind: "access",
		profileId: "b52ab4ee-3ed1-43d3-9d6a-080be0aeab40",
		revision: 7,
	};

	it.each(["access", "refresh"] as const)("round trips %s values with a fresh nonce", (kind) => {
		const tokenContext = { ...context, kind };
		const first = encryptProviderToken(`plaintext-${kind}-token`, tokenContext, keyring);
		const second = encryptProviderToken(`plaintext-${kind}-token`, tokenContext, keyring);
		expect(first.keyId).toBe("key-1");
		expect(first.nonce).toHaveLength(12);
		expect(first.tag).toHaveLength(16);
		expect(first.nonce.equals(second.nonce)).toBe(false);
		expect(decryptProviderToken(first, tokenContext, keyring).toString("utf8")).toBe(`plaintext-${kind}-token`);
	});

	it("round trips PKCE with authorization-bound AAD before an account exists", () => {
		const pkceContext: ProviderPkceContext = {
			authorizationId: "f789f9ba-d36f-4e4e-97f3-073354fa96ef",
			connectorId: "google-gmail",
			kind: "pkce",
			profileId: context.profileId,
		};
		const encrypted = encryptProviderToken("pkce-verifier-plaintext", pkceContext, keyring);
		expect(decryptProviderToken(encrypted, pkceContext, keyring).toString("utf8")).toBe("pkce-verifier-plaintext");
		expect(() => decryptProviderToken(encrypted, { ...pkceContext, authorizationId: "wrong-authorization" }, keyring))
			.toThrow(PROVIDER_TOKEN_DECRYPTION_ERROR);
	});

	it("separates encrypted OIDC nonce AAD from PKCE for the same authorization", () => {
		const pkceContext: ProviderPkceContext = {
			authorizationId: "f789f9ba-d36f-4e4e-97f3-073354fa96ef",
			connectorId: "google-gmail",
			kind: "pkce",
			profileId: context.profileId,
		};
		const encrypted = encryptProviderToken("oidc-nonce-plaintext", { ...pkceContext, kind: "oidc-nonce" }, keyring);
		expect(decryptProviderToken(encrypted, { ...pkceContext, kind: "oidc-nonce" }, keyring).toString("utf8"))
			.toBe("oidc-nonce-plaintext");
		expect(() => decryptProviderToken(encrypted, pkceContext, keyring))
			.toThrow(PROVIDER_TOKEN_DECRYPTION_ERROR);
	});

	it("uses the exact ADR NUL-delimited UTF-8 AAD sequence", () => {
		const plaintext = "aad-vector-token";
		const encrypted = encryptProviderToken(plaintext, context, keyring);
		const decipher = createDecipheriv("aes-256-gcm", activeKey, encrypted.nonce, { authTagLength: 16 });
		decipher.setAAD(Buffer.from([
			"k-provider-token-v1",
			"b52ab4ee-3ed1-43d3-9d6a-080be0aeab40",
			"3ff4dce1-f2b8-4d31-a6a2-49b892269079",
			"google-gmail",
			"access",
			"7",
		].join("\0"), "utf8"));
		decipher.setAuthTag(encrypted.tag);
		expect(Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString("utf8")).toBe(plaintext);
	});

	it("decrypts a previous-key value after active-key rotation by stored keyId", () => {
		const encrypted = encryptProviderToken("rotation-token", context, keyring);
		const rotated = new ProviderTokenKeyring("key-2", new Map([
			["key-1", activeKey],
			["key-2", Buffer.alloc(32, 42)],
		]));
		expect(decryptProviderToken(encrypted, context, rotated).toString("utf8")).toBe("rotation-token");
		expect(encryptProviderToken("new-token", context, rotated).keyId).toBe("key-2");
	});

	it("fails generically when any AAD identity or revision field is wrong", () => {
		const encrypted = encryptProviderToken("access-token-plaintext", context, keyring);
		const wrongContexts: ProviderAccountTokenContext[] = [
			{ ...context, profileId: "wrong-profile" },
			{ ...context, accountId: "wrong-account" },
			{ ...context, connectorId: "login-with-amazon" },
			{ ...context, revision: context.revision + 1 },
			{ ...context, kind: "refresh" },
		];
		for (const wrongContext of wrongContexts) {
			expect(() => decryptProviderToken(encrypted, wrongContext, keyring)).toThrow(PROVIDER_TOKEN_DECRYPTION_ERROR);
		}
	});

	it("rejects ciphertext and authentication-tag swaps", () => {
		const first = encryptProviderToken("first-token-plaintext", context, keyring);
		const second = encryptProviderToken("second-token-plaintext", context, keyring);
		expect(() => decryptProviderToken({ ...first, ciphertext: second.ciphertext }, context, keyring)).toThrow(PROVIDER_TOKEN_DECRYPTION_ERROR);
		expect(() => decryptProviderToken({ ...first, tag: second.tag }, context, keyring)).toThrow(PROVIDER_TOKEN_DECRYPTION_ERROR);
	});

	it("fails generically when the referenced key is unavailable", () => {
		const encrypted = encryptProviderToken("access-token-plaintext", context, keyring);
		const missingKeyring = new ProviderTokenKeyring("other-key", new Map([["other-key", Buffer.alloc(32, 7)]]));
		expect(() => decryptProviderToken(encrypted, context, missingKeyring)).toThrow(PROVIDER_TOKEN_DECRYPTION_ERROR);
	});

	it("does not include token plaintext in authentication failures", () => {
		const plaintext = "token-plaintext-must-not-leak";
		const encrypted = encryptProviderToken(plaintext, context, keyring);
		expect(inspect(encrypted)).not.toContain(plaintext);
		expect(JSON.stringify(encrypted)).not.toContain(plaintext);
		try {
			decryptProviderToken(encrypted, { ...context, revision: 8 }, keyring);
			throw new Error("expected decryption failure");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe(PROVIDER_TOKEN_DECRYPTION_ERROR);
			expect(inspect(error)).not.toContain(plaintext);
		}
	});

	it("produces a stable 32-byte subject HMAC separated by exact issuer", () => {
		const subjectKey = new ProviderSubjectHashKey(Buffer.alloc(32, 9));
		const first = providerSubjectHmac("https://issuer.example", "subject-123", subjectKey);
		const repeated = providerSubjectHmac("https://issuer.example", "subject-123", subjectKey);
		const otherIssuer = providerSubjectHmac("https://other-issuer.example", "subject-123", subjectKey);
		expect(first).toHaveLength(32);
		expect(first.toString("hex")).toBe("155f681c6e35635f5e60cc781876d14239b6b58e2e234a2989c5ad0fde60f27a");
		expect(first.equals(repeated)).toBe(true);
		expect(first.equals(otherIssuer)).toBe(false);
	});
});