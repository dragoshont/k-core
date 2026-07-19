import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig } from "../../src/modules/config";
import {
	MAX_PROFILE_CONFIG_BYTES,
	NEUTRAL_PROFILE_CONFIG,
	PROFILE_CONFIGURATION_INVALID,
	loadProfileConfig,
} from "../../src/modules/config/profile-config";

const temporaryDirectories: string[] = [];

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

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function writeConfig(value: unknown, fileName = "profiles.json") {
	const directory = await mkdtemp(join(tmpdir(), "k-profile-config-"));
	temporaryDirectories.push(directory);
	const path = join(directory, fileName);
	await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
	return path;
}

function customConfig() {
	return {
		profiles: [
			{ displayName: "Reader One", profileId: "00000000-0000-4000-8000-000000000001", slug: "reader-one" },
			{ displayName: "Reader Two", profileId: "00000000-0000-4000-8000-000000000002", slug: "reader-two" },
			{ displayName: "Reader Three", profileId: "00000000-0000-4000-8000-000000000003", slug: "reader-three" },
		],
		schemaVersion: 1,
	};
}

async function expectInvalid(value: unknown) {
	const path = await writeConfig(value, "private-alias-secret.json");
	let thrown: unknown;
	try {
		loadProfileConfig({ PROFILE_CONFIG_FILE: path });
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(Error);
	expect((thrown as Error).message).toBe(PROFILE_CONFIGURATION_INVALID);
	expect(String(thrown)).not.toContain(path);
	expect(String(thrown)).not.toContain("private-alias-secret");
}

describe("profile configuration", () => {
	it("uses the exact immutable neutral profile slots when the file is absent", () => {
		const state = loadProfileConfig({});
		expect(state).toEqual({ explicitFile: false, value: NEUTRAL_PROFILE_CONFIG });
		expect(state.value.profiles.map(({ displayName, slug }) => ({ displayName, slug }))).toEqual([
			{ displayName: "Member 1", slug: "member-1" },
			{ displayName: "Member 2", slug: "member-2" },
			{ displayName: "Member 3", slug: "member-3" },
		]);
		expect(Object.isFrozen(state.value)).toBe(true);
		expect(Object.isFrozen(state.value.profiles[0])).toBe(true);
	});

	it("loads a valid custom profile document and records explicit configuration", async () => {
		const path = await writeConfig(customConfig());
		expect(loadProfileConfig({ PROFILE_CONFIG_FILE: path })).toEqual({
			explicitFile: true,
			value: customConfig(),
		});
	});

	it("rejects oversized, malformed, unknown-field, and invalid UTF-8 documents", async () => {
		const oversizedPath = await writeConfig("x".repeat(MAX_PROFILE_CONFIG_BYTES + 1));
		expect(() => loadProfileConfig({ PROFILE_CONFIG_FILE: oversizedPath })).toThrow(PROFILE_CONFIGURATION_INVALID);
		await expectInvalid("{not-json");
		await expectInvalid({ ...customConfig(), secretAlias: "must-not-leak" });

		const invalidUtf8Path = await writeConfig(Buffer.from([0xc3, 0x28]) as unknown as string);
		await writeFile(invalidUtf8Path, Buffer.from([0xc3, 0x28]));
		expect(() => loadProfileConfig({ PROFILE_CONFIG_FILE: invalidUtf8Path })).toThrow(PROFILE_CONFIGURATION_INVALID);
	});

	it("rejects a profile UUID outside its ordered fixed slot", async () => {
		const value = customConfig();
		[value.profiles[0]!.profileId, value.profiles[1]!.profileId] = [value.profiles[1]!.profileId, value.profiles[0]!.profileId];
		await expectInvalid(value);
	});

	it.each([
		["duplicate", "reader-two"],
		["reserved", "admin"],
		["UUID-shaped", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
	])("rejects a %s slug", async (_label, slug) => {
		const value = customConfig();
		value.profiles[0]!.slug = slug;
		await expectInvalid(value);
	});

	it.each([
		["leading whitespace", " Reader One"],
		["non-NFKC text", "Ｒeader One"],
		["an invisible format character", "Reader\u200bOne"],
	])("rejects display names with %s", async (_label, displayName) => {
		const value = customConfig();
		value.profiles[0]!.displayName = displayName;
		await expectInvalid(value);
	});

	it("rejects display names that collide after NFKC locale-independent lowercasing", async () => {
		const value = customConfig();
		value.profiles[0]!.displayName = "READER";
		value.profiles[1]!.displayName = "Reader";
		await expectInvalid(value);
	});

	it("uses one fixed error for an empty path, missing file, and secret alias content", async () => {
		expect(() => loadProfileConfig({ PROFILE_CONFIG_FILE: "" })).toThrow(PROFILE_CONFIGURATION_INVALID);
		expect(() => loadProfileConfig({ PROFILE_CONFIG_FILE: "/private/missing/profiles.json" })).toThrow(PROFILE_CONFIGURATION_INVALID);
		const value = customConfig();
		value.profiles[0]!.displayName = "private-alias-secret\u200b";
		await expectInvalid(value);
	});

	it("makes readConfig fail with only the fixed generic error", async () => {
		const value = customConfig();
		value.profiles[0]!.displayName = "private-alias-secret\u200b";
		const path = await writeConfig(value, "private-path-secret.json");
		const state = readConfig({ ...appEnv, PROFILE_CONFIG_FILE: path });
		expect(state).toEqual({ errors: [PROFILE_CONFIGURATION_INVALID], ok: false });
		expect(JSON.stringify(state)).not.toContain(path);
		expect(JSON.stringify(state)).not.toContain("private-alias-secret");
	});
});