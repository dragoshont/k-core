import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha256Buffer } from "../common/crypto";
import {
	NEUTRAL_PROFILE_CONFIG,
	NEUTRAL_PROFILE_CONFIG_STATE,
	type ProfileConfigState,
} from "../config/profile-config";
import { assertProfileConfigurationParity } from "../config/profile-parity";
import { ProblemError } from "../http/problems";
import { readMigrationDirectory } from "../platform/root";
import type { Database, SqlExecutor } from "./database";

export interface Migration {
	down: string;
	fileName: string;
	name: string;
	up: string;
	version: number;
}

const LOCK_BYTES = sha256Buffer("k-phase2-migrator");
const LOCK_KEY_A = LOCK_BYTES.readInt32BE(0);
const LOCK_KEY_B = LOCK_BYTES.readInt32BE(4);
const PROFILE_ALIAS_MIGRATION_VERSION = 7;

interface DatabaseProfileAlias {
	display_name: string;
	profile_id: string;
	slug: string;
}

export interface MigrateOptions {
	allowDown?: boolean;
	direction?: "up" | "down";
	profileConfig?: ProfileConfigState;
	targetVersion?: number;
}

function parseSection(source: string, marker: "up" | "down") {
	const pattern = marker === "up" ? /^--\s*up\s*$/im : /^--\s*down\s*$/im;
	const match = pattern.exec(source);
	if (!match) {
		return null;
	}

	const start = match.index + match[0].length;
	const nextMatch = /^--\s*(up|down)\s*$/gim;
		nextMatch.lastIndex = start;
	const next = nextMatch.exec(source);
	return source.slice(start, next ? next.index : source.length).trim();
}

export function loadMigrations(root?: string) {
	const directory = readMigrationDirectory(root);
	return directory.files.map((fileName) => {
		const versionMatch = fileName.match(/^(\d{4})_(.+)\.sql$/);
		if (!versionMatch) {
			throw new Error(`Migration file name must look like 0001_name.sql: ${fileName}`);
		}

		const source = readFileSync(resolve(directory.path, fileName), "utf8");
		const up = parseSection(source, "up");
		const down = parseSection(source, "down");
		if (!up || !down) {
			throw new Error(`Migration ${fileName} must contain -- up and -- down sections`);
		}

		return {
			down,
			fileName,
			name: versionMatch[2],
			up,
			version: Number.parseInt(versionMatch[1], 10),
		} satisfies Migration;
	});
}

export function latestMigrationVersion(root?: string) {
	const migrations = loadMigrations(root);
	return migrations[migrations.length - 1]?.version ?? 0;
}

async function ensureSchemaTable(executor: SqlExecutor) {
	await executor.query(`
		create table if not exists schema_migrations (
			version integer primary key,
			name text not null,
			applied_at timestamptz not null default now()
		)
	`);
}

async function currentVersions(executor: SqlExecutor) {
	const result = await executor.query<{ version: number }>("select version from schema_migrations order by version asc");
	return result.rows.map((row) => row.version);
}

function profileConfigurationMismatch(): never {
	throw new ProblemError(503, "profile_configuration_mismatch", "Service is not ready");
}

async function preflightProfiles(executor: SqlExecutor, profileConfig: ProfileConfigState) {
	const table = await executor.query<{ table_name: string | null }>("select to_regclass('public.profiles')::text as table_name");
	if (!table.rows[0]?.table_name) return;

	const result = await executor.query<DatabaseProfileAlias>(`
		select profile_id, slug, display_name
		from profiles
		order by profile_id
		for update
	`);
	if (result.rows.length === 0) return;
	if (result.rows.length !== profileConfig.value.profiles.length) profileConfigurationMismatch();

	const expectedIds = profileConfig.value.profiles.map((profile) => profile.profileId);
	if (!result.rows.every((row, index) => row.profile_id === expectedIds[index])) {
		profileConfigurationMismatch();
	}
	const neutral = result.rows.every((row, index) => {
		const expected = NEUTRAL_PROFILE_CONFIG.profiles[index];
		return row.profile_id === expected?.profileId
			&& row.slug === expected.slug
			&& row.display_name === expected.displayName;
	});
	if (!neutral && !profileConfig.explicitFile) profileConfigurationMismatch();
}

async function reconcileProfiles(executor: SqlExecutor, profileConfig: ProfileConfigState) {
	await executor.query("select set_config('k.profile_alias_migration', 'on', true)");
	await executor.query("set constraints profiles_slug_unique, profiles_display_name_unique deferred");
	const values = profileConfig.value.profiles.flatMap((profile) => [profile.profileId, profile.slug, profile.displayName]);
	const result = await executor.query(`
		update profiles as profile
		set slug = desired.slug,
			display_name = desired.display_name,
			updated_at = case
				when (profile.slug, profile.display_name) is distinct from (desired.slug, desired.display_name) then now()
				else profile.updated_at
			end
		from (values
			($1::uuid, $2::text, $3::text),
			($4::uuid, $5::text, $6::text),
			($7::uuid, $8::text, $9::text)
		) as desired(profile_id, slug, display_name)
		where profile.profile_id = desired.profile_id
	`, values);
	if (result.rowCount !== profileConfig.value.profiles.length) profileConfigurationMismatch();
	await executor.query("set constraints profiles_slug_unique, profiles_display_name_unique immediate");
	await assertProfileConfigurationParity(executor, profileConfig.value);
	await executor.query("select set_config('k.profile_alias_migration', 'off', true)");
}

async function applyMigration(executor: SqlExecutor, migration: Migration, direction: "up" | "down") {
	await executor.query(direction === "up" ? migration.up : migration.down);
	if (direction === "up") {
		await executor.query("insert into schema_migrations (version, name) values ($1, $2)", [migration.version, migration.name]);
	} else {
		await executor.query("delete from schema_migrations where version = $1", [migration.version]);
	}
}

function assertDatabaseNotNewer(appliedVersions: number[], migrations: Migration[]) {
	const knownVersions = new Set(migrations.map((migration) => migration.version));
	const latestKnown = migrations[migrations.length - 1]?.version ?? 0;
	for (const version of appliedVersions) {
		if (!knownVersions.has(version) || version > latestKnown) {
			throw new ProblemError(409, "newer_schema_detected", "Database schema is newer than this binary");
		}
	}
}

export async function migrate(database: Database, options: MigrateOptions = {}) {
	const migrations = loadMigrations();
	const direction = options?.direction ?? "up";
	const targetVersion = options?.targetVersion;
	const profileConfig = options.profileConfig ?? NEUTRAL_PROFILE_CONFIG_STATE;
	if (direction === "down" && !options?.allowDown) {
		throw new ProblemError(403, "migration_down_blocked", "Down migrations are disabled in this environment");
	}

	return database.withTransaction(async (client) => {
		await client.query("select pg_advisory_xact_lock($1, $2)", [LOCK_KEY_A, LOCK_KEY_B]);
		await preflightProfiles(client, profileConfig);
		await ensureSchemaTable(client);
		const appliedVersions = await currentVersions(client);
		assertDatabaseNotNewer(appliedVersions, migrations);
		const appliedSet = new Set(appliedVersions);
		const profileMigrationAlreadyApplied = appliedSet.has(PROFILE_ALIAS_MIGRATION_VERSION);

		if (direction === "up") {
			for (const migration of migrations) {
				if (appliedSet.has(migration.version)) {
					continue;
				}
				if (targetVersion && migration.version > targetVersion) {
					break;
				}
				if (migration.version === PROFILE_ALIAS_MIGRATION_VERSION) {
					await client.query(migration.up);
					await reconcileProfiles(client, profileConfig);
					await client.query("insert into schema_migrations (version, name) values ($1, $2)", [migration.version, migration.name]);
				} else {
					await applyMigration(client, migration, "up");
				}
				appliedSet.add(migration.version);
			}
			if (profileMigrationAlreadyApplied
				&& (!targetVersion || targetVersion >= PROFILE_ALIAS_MIGRATION_VERSION)) {
				await reconcileProfiles(client, profileConfig);
			}
		} else {
			const toRemove = migrations
				.filter((migration) => appliedSet.has(migration.version))
				.filter((migration) => migration.version > (targetVersion ?? 0))
				.sort((left, right) => right.version - left.version);
			for (const migration of toRemove) {
				await applyMigration(client, migration, "down");
				appliedSet.delete(migration.version);
			}
		}
	});
}

export async function readCurrentSchemaVersion(executor: SqlExecutor) {
	const table = await executor.query<{ table_name: string | null }>("select to_regclass('public.schema_migrations')::text as table_name");
	if (!table.rows[0]?.table_name) {
		return 0;
	}
	const result = await executor.query<{ version: number }>("select coalesce(max(version), 0) as version from schema_migrations");
	return result.rows[0]?.version ?? 0;
}