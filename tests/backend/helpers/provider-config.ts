import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverPlugins } from "../../../src/modules/plugins/manifests";
import { loadProviderRuntimeConfig } from "../../../src/modules/provider-accounts/config";

export async function createProviderFixture() {
	const root = await mkdtemp(join(tmpdir(), "k-provider-accounts-"));
	const pluginRoot = join(root, "plugins");
	await mkdir(pluginRoot);
	for (const pluginId of ["google-gmail", "login-with-amazon"]) {
		const pluginDirectory = join(pluginRoot, pluginId);
		await mkdir(pluginDirectory);
		await copyFile(resolve(`tests/fixtures/plugins/${pluginId}.v2.json`), join(pluginDirectory, "plugin.json"));
		await writeFile(join(pluginDirectory, "index.mjs"), "process.stdout.write('{}\\n');\n");
	}

	const registrations = {
		schemaVersion: 1,
		connectors: [
			{
				connectorId: "google-gmail", registrationId: "google-gmail",
				issuer: "https://openidconnect.googleapis.com", authorizationEndpoint: "https://openidconnect.googleapis.com/authorize",
				tokenEndpoint: "https://openidconnect.googleapis.com/token", identityEndpoint: "https://openidconnect.googleapis.com/userinfo",
				tokenEndpointAuthMethod: "client_secret_post",
				jwksUri: "https://openidconnect.googleapis.com/jwks",
				revocationEndpoint: null, clientId: "google-client", clientSecretEnv: "GOOGLE_CLIENT_SECRET",
				callbackPath: "/oauth/callback/google-gmail", pluginId: "google-gmail", capabilityId: "google-gmail/identity",
				oidc: true, capabilityScopes: { "identity-only": ["openid", "email"] },
			},
			{
				connectorId: "login-with-amazon", registrationId: "login-with-amazon",
				issuer: "https://api.amazon.com", authorizationEndpoint: "https://api.amazon.com/authorize",
				tokenEndpoint: "https://api.amazon.com/token", identityEndpoint: "https://api.amazon.com/user/profile",
				tokenEndpointAuthMethod: "client_secret_post",
				jwksUri: null,
				revocationEndpoint: null, clientId: "amazon-client", clientSecretEnv: "AMAZON_CLIENT_SECRET",
				callbackPath: "/oauth/callback/login-with-amazon", pluginId: "login-with-amazon", capabilityId: "login-with-amazon/identity",
				oidc: false, capabilityScopes: { "identity-only": ["profile:user_id"] },
			},
		],
	};
	const keyring = {
		schemaVersion: 1,
		activeKeyId: "active-2026",
		keys: [{ keyId: "active-2026", keyEnv: "PROVIDER_TOKEN_KEY_ACTIVE" }],
	};
	const registrationsFile = join(root, "registrations.json");
	const keyringFile = join(root, "keyring.json");
	const subjectHashKeyFile = join(root, "subject.key");
	await writeFile(registrationsFile, JSON.stringify(registrations));
	await writeFile(keyringFile, JSON.stringify(keyring));
	await writeFile(subjectHashKeyFile, Buffer.alloc(32, "h"));
	const env: NodeJS.ProcessEnv = {
		AMAZON_CLIENT_SECRET: "amazon-client-secret-plaintext",
		GOOGLE_CLIENT_SECRET: "google-client-secret-plaintext",
		PROVIDER_REGISTRATIONS_FILE: registrationsFile,
		PROVIDER_SUBJECT_HASH_KEY_FILE: subjectHashKeyFile,
		PROVIDER_TOKEN_KEY_ACTIVE: Buffer.alloc(32, "k").toString("base64url"),
		PROVIDER_TOKEN_KEYRING_FILE: keyringFile,
	};
	const installedPlugins = discoverPlugins(pluginRoot);
	const load = (loadEnv = env) => loadProviderRuntimeConfig({
		env: loadEnv,
		installedPlugins,
		publicOrigin: new URL("https://k.example.invalid"),
	});
	return {
		cleanup: () => rm(root, { force: true, recursive: true }),
		env,
		keyring,
		keyringFile,
		load,
		pluginRoot,
		registrations,
		registrationsFile,
		subjectHashKeyFile,
	};
}

export type ProviderFixture = Awaited<ReturnType<typeof createProviderFixture>>;