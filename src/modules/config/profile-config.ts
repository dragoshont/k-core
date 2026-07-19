import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import profileConfigSchema from "../../../contracts/profile-config.schema.json";

export const PROFILE_CONFIGURATION_INVALID = "PROFILE_CONFIGURATION_INVALID";
export const MAX_PROFILE_CONFIG_BYTES = 16 * 1024;

export interface ProfileAlias {
	displayName: string;
	profileId: string;
	slug: string;
}

export interface ProfileConfig {
	profiles: readonly ProfileAlias[];
	schemaVersion: 1;
}

export interface ProfileConfigState {
	explicitFile: boolean;
	value: ProfileConfig;
}

export const PROFILE_IDS = Object.freeze([
	"00000000-0000-4000-8000-000000000001",
	"00000000-0000-4000-8000-000000000002",
	"00000000-0000-4000-8000-000000000003",
] as const);

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateProfileConfig = ajv.compile(profileConfigSchema as object);

function freezeProfileConfig(value: ProfileConfig): ProfileConfig {
	return Object.freeze({
		profiles: Object.freeze(value.profiles.map((profile) => Object.freeze({ ...profile }))),
		schemaVersion: 1,
	});
}

export const NEUTRAL_PROFILE_CONFIG = freezeProfileConfig({
	profiles: [
		{ displayName: "Member 1", profileId: "00000000-0000-4000-8000-000000000001", slug: "member-1" },
		{ displayName: "Member 2", profileId: "00000000-0000-4000-8000-000000000002", slug: "member-2" },
		{ displayName: "Member 3", profileId: "00000000-0000-4000-8000-000000000003", slug: "member-3" },
	],
	schemaVersion: 1,
});

export const NEUTRAL_PROFILE_CONFIG_STATE: ProfileConfigState = Object.freeze({
	explicitFile: false,
	value: NEUTRAL_PROFILE_CONFIG,
});

export function profileConfigState(config: { profileConfig?: ProfileConfigState }) {
	return config.profileConfig ?? NEUTRAL_PROFILE_CONFIG_STATE;
}

export function isProfileId(value: unknown): value is typeof PROFILE_IDS[number] {
	return typeof value === "string" && (PROFILE_IDS as readonly string[]).includes(value);
}

function invalidProfileConfiguration(): never {
	throw new Error(PROFILE_CONFIGURATION_INVALID);
}

function readBoundedFile(path: string) {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, "r");
		const initialStat = fstatSync(descriptor);
		if (!initialStat.isFile() || initialStat.size > MAX_PROFILE_CONFIG_BYTES) {
			return invalidProfileConfiguration();
		}

		const source = Buffer.alloc(initialStat.size);
		let offset = 0;
		while (offset < source.byteLength) {
			const bytesRead = readSync(descriptor, source, offset, source.byteLength - offset, offset);
			if (bytesRead === 0) return invalidProfileConfiguration();
			offset += bytesRead;
		}
		const finalStat = fstatSync(descriptor);
		if (finalStat.size !== initialStat.size || finalStat.size > MAX_PROFILE_CONFIG_BYTES) {
			return invalidProfileConfiguration();
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(source);
	} catch {
		return invalidProfileConfiguration();
	} finally {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				// The read result is already bounded and detached from the descriptor.
			}
		}
	}
}

function assertSemanticValidity(value: ProfileConfig) {
	const slugs = new Set<string>();
	const displayNames = new Set<string>();
	for (const profile of value.profiles) {
		if (slugs.has(profile.slug)) invalidProfileConfiguration();
		slugs.add(profile.slug);

		const displayName = profile.displayName;
		const normalizedDisplayName = displayName.normalize("NFKC");
		if ([...displayName].length > 120
			|| displayName.trim() !== displayName
			|| normalizedDisplayName !== displayName
			|| /\p{Cf}/u.test(displayName)) {
			invalidProfileConfiguration();
		}
		const displayKey = normalizedDisplayName.toLocaleLowerCase("und");
		if (displayNames.has(displayKey)) invalidProfileConfiguration();
		displayNames.add(displayKey);
	}
}

export function loadProfileConfig(env: NodeJS.ProcessEnv = process.env): ProfileConfigState {
	const path = env.PROFILE_CONFIG_FILE;
	if (path === undefined) {
		return NEUTRAL_PROFILE_CONFIG_STATE;
	}
	if (!path) invalidProfileConfiguration();

	try {
		const parsed = JSON.parse(readBoundedFile(path)) as unknown;
		if (!validateProfileConfig(parsed)) invalidProfileConfiguration();
		const value = parsed as ProfileConfig;
		assertSemanticValidity(value);
		return { explicitFile: true, value: freezeProfileConfig(value) };
	} catch {
		return invalidProfileConfiguration();
	}
}