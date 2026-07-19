import { inspect } from "node:util";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_CONFIGURATION_INVALID, readinessConfigErrors, readConfig } from "../../src/modules/config";
import { validatePrivateBoundary, validateSameOrigin } from "../../src/modules/http/security";

const env = {
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

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("private boundary", () => {
	it("fails closed for untrusted proxies", () => {
		const config = readConfig(env).value!;
		const result = validatePrivateBoundary({
			bodyText: "",
			headers: { "x-forwarded-for": "10.20.30.40", "x-forwarded-host": "k.example.invalid", "x-forwarded-proto": "https" },
			method: "GET",
			remoteAddress: "192.168.1.10",
			url: new URL("https://k.example.invalid/search"),
		}, config);
		expect(result.ok).toBe(false);
	});

	it("accepts a trusted proxy and private client with matching origin", () => {
		const config = readConfig(env).value!;
		const result = validatePrivateBoundary({
			bodyText: "",
			headers: { "x-forwarded-for": "10.20.30.40", "x-forwarded-host": "k.example.invalid", "x-forwarded-proto": "https" },
			method: "GET",
			remoteAddress: "10.1.2.3",
			url: new URL("https://k.example.invalid/search"),
		}, config);
		expect(result.ok).toBe(true);
		expect(validateSameOrigin({ bodyText: "", headers: { origin: "https://k.example.invalid" }, method: "POST", remoteAddress: "10.1.2.3", url: new URL("https://k.example.invalid/profile") }, config)).toBe(true);
	});

	it("rejects CIDRs whose private base address covers public space", () => {
		const state = readConfig({ ...env, ALLOWED_PRIVATE_CLIENT_CIDRS: "10.0.0.0/0" });
		expect(state.ok).toBe(false);
		expect(state.errors).toContain("ALLOWED_PRIVATE_CLIENT_CIDRS must contain only private or local CIDRs (10.0.0.0/0)");
	});

	it("rejects caller-appended forwarding chains", () => {
		const config = readConfig(env).value!;
		const result = validatePrivateBoundary({
			bodyText: "",
			headers: { "x-forwarded-for": "203.0.113.8, 10.20.30.40", "x-forwarded-host": "k.example.invalid", "x-forwarded-proto": "https" },
			method: "GET",
			remoteAddress: "10.1.2.3",
			url: new URL("https://k.example.invalid/search"),
		}, config);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("untrusted_client");
	});

	it("rejects low-entropy security secrets", () => {
		const state = readConfig({ ...env, PIN_PEPPER: "short" });
		expect(state.ok).toBe(false);
		expect(state.errors).toContain("PIN_PEPPER must be at least 32 bytes");
	});

	it("requires a contact for identified plugin requests", () => {
		const state = readConfig({ ...env, OUTBOUND_CONTACT: undefined });
		expect(state.ok).toBe(false);
		expect(state.errors).toContain("OUTBOUND_CONTACT is required");
	});

	it("accepts the legacy public root, explicit public root, and a distinct optional private root", async () => {
		const publicDirectory = resolve("plugins");
		const privateDirectory = await mkdtemp(join(tmpdir(), "k-private-plugin-config-"));
		temporaryPaths.push(privateDirectory);
		for (const pluginEnv of [
			{ PLUGIN_DIR: publicDirectory },
			{ PUBLIC_PLUGIN_DIR: publicDirectory },
			{ PRIVATE_PLUGIN_DIR: privateDirectory, PUBLIC_PLUGIN_DIR: publicDirectory },
		]) {
			const state = readConfig({ ...env, ...pluginEnv });
			expect(state.ok).toBe(true);
			expect(state.value?.pluginRoots).toEqual({ privateDirectory: pluginEnv.PRIVATE_PLUGIN_DIR, publicDirectory });
			expect(state.value?.installedPlugins).toHaveLength(6);
		}
	});

	it("fails plugin root configuration with one generic error", async () => {
		const publicDirectory = resolve("plugins");
		const linkedDirectory = join(await mkdtemp(join(tmpdir(), "k-plugin-link-parent-")), "plugins");
		temporaryPaths.push(linkedDirectory.replace(/\/plugins$/, ""));
		await symlink(publicDirectory, linkedDirectory);
		for (const pluginEnv of [
			{ PLUGIN_DIR: publicDirectory, PUBLIC_PLUGIN_DIR: publicDirectory },
			{ PLUGIN_DIR: publicDirectory, PRIVATE_PLUGIN_DIR: resolve("plugins/google-books") },
			{ PUBLIC_PLUGIN_DIR: resolve("plugins/missing") },
			{ PUBLIC_PLUGIN_DIR: linkedDirectory },
			{ PRIVATE_PLUGIN_DIR: publicDirectory, PUBLIC_PLUGIN_DIR: publicDirectory },
			{ PRIVATE_PLUGIN_DIR: resolve("plugins/google-books"), PUBLIC_PLUGIN_DIR: publicDirectory },
			{ PRIVATE_PLUGIN_DIR: publicDirectory, PUBLIC_PLUGIN_DIR: resolve("plugins/google-books") },
		]) {
			expect(readConfig({ ...env, ...pluginEnv })).toEqual({ errors: [PLUGIN_CONFIGURATION_INVALID], ok: false });
		}
	});

	it("fails readiness when the configured plugin inventory changes after startup", async () => {
		const root = await mkdtemp(join(tmpdir(), "k-plugin-readiness-"));
		temporaryPaths.push(root);
		const publicDirectory = join(root, "plugins");
		await cp(resolve("plugins"), publicDirectory, { recursive: true });
		const state = readConfig({ ...env, PUBLIC_PLUGIN_DIR: publicDirectory });
		expect(state.ok).toBe(true);
		const entrypoint = join(publicDirectory, "project-gutenberg/index.mjs");
		await writeFile(entrypoint, `${await readFile(entrypoint, "utf8")}\n`);
		expect(readinessConfigErrors(state.value!)).toContain(PLUGIN_CONFIGURATION_INVALID);
	});

	it("loads the optional Google Books key through a callback without serializing or inspecting it", () => {
		const key = "google-books-test-key-never-print";
		const state = readConfig({ ...env, GOOGLE_BOOKS_API_KEY: key });
		expect(state.ok).toBe(true);
		expect(JSON.stringify(state.value)).not.toContain(key);
		expect(inspect(state.value)).not.toContain(key);
		const callback = vi.fn(() => "used");
		expect(state.value?.applicationSecrets?.withGoogleBooksApiKey(callback)).toBe("used");
		expect(callback).toHaveBeenCalledWith(key);
		expect(readConfig(env).value?.applicationSecrets?.hasGoogleBooksApiKey()).toBe(false);
	});

	it("rejects a malformed present Google Books key without reflecting it", () => {
		const key = "google-books-key-with-control\nvalue";
		const state = readConfig({ ...env, GOOGLE_BOOKS_API_KEY: key });
		expect(state).toEqual({ errors: ["GOOGLE_BOOKS_API_KEY is invalid"], ok: false });
		expect(JSON.stringify(state)).not.toContain(key);
	});
});