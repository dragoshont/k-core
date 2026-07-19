import { afterEach, describe, expect, it } from "vitest";
import { startPostgresHarness, type PostgresHarness } from "./helpers/postgres";
import { createDatabase, type Database } from "../../src/modules/db/database";
import { latestMigrationVersion, loadMigrations, migrate, readCurrentSchemaVersion } from "../../src/modules/db/migrator";
import type { ProfileConfigState } from "../../src/modules/config/profile-config";

const customProfileConfig = {
	explicitFile: true,
	value: {
		profiles: [
			{ displayName: "Reader 1", profileId: "00000000-0000-4000-8000-000000000001", slug: "reader-1" },
			{ displayName: "Reader 2", profileId: "00000000-0000-4000-8000-000000000002", slug: "reader-2" },
			{ displayName: "Reader 3", profileId: "00000000-0000-4000-8000-000000000003", slug: "reader-3" },
		],
		schemaVersion: 1,
	},
} satisfies ProfileConfigState;

describe("migrator", () => {
	let harness: PostgresHarness | undefined;
	const databases: Database[] = [];

	function createTestDatabase() {
		if (!harness) {
			throw new Error("PostgreSQL harness is not started");
		}
		const database = createDatabase({
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
			userAgent: "k-test",
		});
		databases.push(database);
		return database;
	}

	async function expectSqlState(promise: Promise<unknown>, code: string) {
		await expect(promise).rejects.toMatchObject({ code });
	}

	afterEach(async () => {
		await Promise.all(databases.splice(0).map((database) => database.close()));
		if (harness) {
			await harness.stop();
			harness = undefined;
		}
	});

	it("migrates up, seeds fixed profiles, and migrates down", async () => {
		harness = await startPostgresHarness();
		const database = createTestDatabase();

		await migrate(database, { allowDown: true });
		await migrate(database, { allowDown: true });
		const seedMigration = loadMigrations().find((migration) => migration.version === 2);
		expect(seedMigration).toBeDefined();
		await database.query(seedMigration!.up);
		expect(await readCurrentSchemaVersion(database)).toBe(latestMigrationVersion());
		const profiles = await database.query<{ credential_state: string; display_name: string; profile_id: string; slug: string }>(
			"select profile_id, slug, display_name, credential_state from profiles order by profile_id",
		);
		expect(profiles.rows).toEqual([
			{ credential_state: "setup-required", display_name: "Member 1", profile_id: "00000000-0000-4000-8000-000000000001", slug: "member-1" },
			{ credential_state: "setup-required", display_name: "Member 2", profile_id: "00000000-0000-4000-8000-000000000002", slug: "member-2" },
			{ credential_state: "setup-required", display_name: "Member 3", profile_id: "00000000-0000-4000-8000-000000000003", slug: "member-3" },
		]);
		await expectSqlState(database.query(
			"update profiles set profile_id = '00000000-0000-4000-8000-000000000099' where slug = 'member-1'",
		), "23514");
		await database.query(`
			insert into audit_events (
				audit_event_id, actor_kind, actor_label, action, target_kind, target_id,
				outcome, correlation_id
			) values (
				'00000000-0000-4000-8000-000000000010', 'system', 'migration-test',
				'migration.verify', 'profile', 'fixed-profiles', 'succeeded',
				'00000000-0000-4000-8000-000000000011'
			)
		`);
		await expect(database.query("update audit_events set actor_label = 'tampered'"))
			.rejects.toMatchObject({ code: "55000" });
		await expect(database.query("delete from audit_events"))
			.rejects.toMatchObject({ code: "55000" });
		await expect(database.query("truncate audit_events"))
			.rejects.toMatchObject({ code: "55000" });

		await migrate(database, { allowDown: true, direction: "down", targetVersion: 0 });
		expect(await readCurrentSchemaVersion(database)).toBe(0);
	});

	it("serializes concurrent migration attempts with an advisory lock", async () => {
		harness = await startPostgresHarness();
		const first = createTestDatabase();
		const second = createTestDatabase();
		await Promise.all([migrate(first, { allowDown: true }), migrate(second, { allowDown: true })]);
		const versions = await first.query<{ count: string }>("select count(*)::text as count from schema_migrations");
		const profiles = await first.query<{ count: string }>("select count(*)::text as count from profiles");
		expect(versions.rows[0]?.count).toBe(String(latestMigrationVersion()));
		expect(profiles.rows[0]?.count).toBe("3");
	});

	it("refuses a schema version newer than the binary", async () => {
		harness = await startPostgresHarness();
		const database = createTestDatabase();
		await database.query(`
			create table schema_migrations (
				version integer primary key,
				name text not null,
				applied_at timestamptz not null default now()
			)
		`);
		await database.query("insert into schema_migrations (version, name) values (9999, 'future')");
		await expect(migrate(database, { allowDown: true })).rejects.toMatchObject({ code: "newer_schema_detected", status: 409 });
		const profiles = await database.query<{ table_name: string | null }>("select to_regclass('public.profiles')::text as table_name");
		expect(profiles.rows[0]?.table_name).toBeNull();
	});

	it("enforces identity and provider constraints in PostgreSQL", async () => {
		harness = await startPostgresHarness();
		const database = createTestDatabase();
		await migrate(database, { allowDown: true });

		await expectSqlState(database.query(`
			insert into profiles (profile_id, slug, display_name, credential_state)
			values ('00000000-0000-4000-8000-000000000099', 'other', 'Other', 'setup-required')
		`), "23514");
		await expectSqlState(database.query("update profiles set credential_state = 'invalid' where slug = 'member-1'"), "23514");
		await database.query("update profiles set pin_fingerprint = decode(repeat('aa', 32), 'hex') where slug = 'member-1'");
		await expectSqlState(database.query("update profiles set pin_fingerprint = decode(repeat('aa', 32), 'hex') where slug = 'member-2'"), "23505");

		await expectSqlState(database.query(`
			insert into credential_codes (
				credential_code_id, profile_id, purpose, credential_revision, digest,
				issuer_label, reason, expires_at
			) values (
				'00000000-0000-4000-8000-000000000020',
				'00000000-0000-4000-8000-000000000001', 'setup', 0, decode('aa', 'hex'),
				'test', 'constraint', now() + interval '15 minutes'
			)
		`), "23514");
		await database.query(`
			insert into credential_codes (
				credential_code_id, profile_id, purpose, credential_revision, digest,
				issuer_label, reason, expires_at
			) values (
				'00000000-0000-4000-8000-000000000021',
				'00000000-0000-4000-8000-000000000001', 'setup', 0, decode(repeat('ab', 32), 'hex'),
				'test', 'constraint', now() + interval '15 minutes'
			)
		`);
		await expectSqlState(database.query(`
			insert into credential_codes (
				credential_code_id, profile_id, purpose, credential_revision, digest,
				issuer_label, reason, expires_at
			) values (
				'00000000-0000-4000-8000-000000000022',
				'00000000-0000-4000-8000-000000000001', 'setup', 0, decode(repeat('ac', 32), 'hex'),
				'test', 'constraint', now() + interval '15 minutes'
			)
		`), "23505");

		await expectSqlState(database.query(`
			insert into sessions (
				session_id, profile_id, token_digest, idle_expires_at, absolute_expires_at
			) values (
				'00000000-0000-4000-8000-000000000030',
				'00000000-0000-4000-8000-000000000001', decode(repeat('ba', 32), 'hex'),
				now() - interval '1 minute', now() + interval '1 hour'
			)
		`), "23514");
		await expectSqlState(database.query(`
			insert into auth_throttles (
				scope, category, subject_key, failure_count, lock_level
			) values ('source', 'pin', 'raw-address', 1, 0)
		`), "23514");

		await expectSqlState(database.query(`
			insert into provider_cache (
				provider_id, resource_kind, cache_key, http_status, normalized_json,
				fetched_at, fresh_until, stale_until, last_accessed_at
			) values (
				'open-library', 'search', repeat('c', 64), 199, '{}'::jsonb,
				now(), now() + interval '1 minute', now() + interval '2 minutes', now()
			)
		`), "23514");
		await expectSqlState(database.query(`
			insert into provider_cache (
				provider_id, resource_kind, cache_key, http_status, normalized_json,
				fetched_at, fresh_until, stale_until, last_accessed_at
			) values (
				'open-library', 'detail', repeat('d', 64), 200, '{}'::jsonb,
				now(), now(), now() + interval '2 minutes', now()
			)
		`), "23514");
	});

	it("creates plugin cache without per-profile plugin configuration state", async () => {
		harness = await startPostgresHarness();
		const database = createTestDatabase();
		await migrate(database, { allowDown: true });
		const cache = await database.query<{ table_name: string | null }>("select to_regclass('public.plugin_cache')::text as table_name");
		expect(cache.rows[0]?.table_name).toBe("plugin_cache");
		const enablements = await database.query<{ table_name: string | null }>("select to_regclass('public.profile_plugin_enablements')::text as table_name");
		expect(enablements.rows[0]?.table_name).toBeNull();
	});

	it("applies explicit aliases atomically and reconciles idempotently", async () => {
		harness = await startPostgresHarness();
		const database = createTestDatabase();
		await migrate(database, { allowDown: true, profileConfig: customProfileConfig });
		const first = await database.query<{ display_name: string; profile_id: string; slug: string; updated_at: Date }>(
			"select profile_id, slug, display_name, updated_at from profiles order by profile_id",
		);
		expect(first.rows.map(({ display_name, profile_id, slug }) => ({ display_name, profile_id, slug }))).toEqual([
			{ display_name: "Reader 1", profile_id: "00000000-0000-4000-8000-000000000001", slug: "reader-1" },
			{ display_name: "Reader 2", profile_id: "00000000-0000-4000-8000-000000000002", slug: "reader-2" },
			{ display_name: "Reader 3", profile_id: "00000000-0000-4000-8000-000000000003", slug: "reader-3" },
		]);

		await migrate(database, { allowDown: true, profileConfig: customProfileConfig });
		const second = await database.query<{ updated_at: Date }>("select updated_at from profiles order by profile_id");
		expect(second.rows.map((row) => row.updated_at.toISOString()))
			.toEqual(first.rows.map((row) => row.updated_at.toISOString()));
		await expectSqlState(database.query("update profiles set slug = 'bypass' where profile_id = '00000000-0000-4000-8000-000000000001'"), "55000");
	});

	it("refuses a non-neutral legacy database without an explicit file before mutation", async () => {
		harness = await startPostgresHarness();
		const database = createTestDatabase();
		await migrate(database, { allowDown: true, targetVersion: 6 });
		await database.query(`
			update profiles
			set slug = 'legacy-1', display_name = 'Legacy 1'
			where profile_id = '00000000-0000-4000-8000-000000000001'
		`);

		await expect(migrate(database, { allowDown: true })).rejects.toMatchObject({
			code: "profile_configuration_mismatch",
			status: 503,
		});
		expect(await readCurrentSchemaVersion(database)).toBe(6);
		const state = await database.query<{ backup_table: string | null; display_name: string; slug: string }>(`
			select to_regclass('public.profile_alias_migration_backup')::text as backup_table,
				slug, display_name
			from profiles
			where profile_id = '00000000-0000-4000-8000-000000000001'
		`);
		expect(state.rows).toEqual([{ backup_table: null, display_name: "Legacy 1", slug: "legacy-1" }]);
	});

	it("preserves profile-owned credentials and sessions and restores captured aliases down to 6", async () => {
		harness = await startPostgresHarness();
		const database = createTestDatabase();
		await migrate(database, { allowDown: true, targetVersion: 6 });
		await database.query(`
			update profiles
			set slug = case profile_id
					when '00000000-0000-4000-8000-000000000001' then 'legacy-1'
					when '00000000-0000-4000-8000-000000000002' then 'legacy-2'
					else 'legacy-3'
				end,
				display_name = case profile_id
					when '00000000-0000-4000-8000-000000000001' then 'Legacy 1'
					when '00000000-0000-4000-8000-000000000002' then 'Legacy 2'
					else 'Legacy 3'
				end
		`);
		await database.query(`
			update profiles
			set credential_state = 'ready', credential_revision = 4,
				pin_verifier = 'verifier-fixture',
				pin_fingerprint = decode(repeat('94', 32), 'hex'),
				pin_updated_at = '2026-07-19T00:00:00Z',
				kindle_address = 'member1@kindle.com', destination_revision = 2
			where profile_id = '00000000-0000-4000-8000-000000000001'
		`);
		await database.query(`
			insert into credential_codes (
				credential_code_id, profile_id, purpose, credential_revision, digest,
				issuer_label, reason, expires_at
			) values (
				'00000000-0000-4000-8000-000000000090',
				'00000000-0000-4000-8000-000000000001', 'setup', 0,
				decode(repeat('91', 32), 'hex'), 'migration-test', 'preservation',
				now() + interval '15 minutes'
			)
		`);
		await database.query(`
			insert into sessions (
				session_id, profile_id, token_digest, idle_expires_at, absolute_expires_at
			) values (
				'00000000-0000-4000-8000-000000000092',
				'00000000-0000-4000-8000-000000000001', decode(repeat('93', 32), 'hex'),
				now() + interval '30 minutes', now() + interval '12 hours'
			)
		`);
		const readPreservedValues = () => database.query<{
			credential_digest: string;
			credential_profile_id: string;
			credential_revision: number;
			credential_state: string;
			destination_revision: number;
			kindle_address: string;
			pin_fingerprint: string;
			pin_updated_at: Date;
			pin_verifier: string;
			session_profile_id: string;
			token_digest: string;
		}>(`
			select profile.credential_state, profile.credential_revision,
				profile.pin_verifier, encode(profile.pin_fingerprint, 'hex') as pin_fingerprint,
				profile.pin_updated_at, profile.kindle_address, profile.destination_revision,
				credential.profile_id as credential_profile_id,
				encode(credential.digest, 'hex') as credential_digest,
				session.profile_id as session_profile_id,
				encode(session.token_digest, 'hex') as token_digest
			from profiles as profile
			join credential_codes as credential on credential.profile_id = profile.profile_id
			join sessions as session on session.profile_id = profile.profile_id
			where credential.credential_code_id = '00000000-0000-4000-8000-000000000090'
				and session.session_id = '00000000-0000-4000-8000-000000000092'
		`);
		const beforeMigration = await readPreservedValues();

		await migrate(database, { allowDown: true, profileConfig: customProfileConfig });
		expect((await readPreservedValues()).rows).toEqual(beforeMigration.rows);

		await migrate(database, {
			allowDown: true,
			direction: "down",
			profileConfig: customProfileConfig,
			targetVersion: 6,
		});
		expect(await readCurrentSchemaVersion(database)).toBe(6);
		const rolledBack = await database.query<{ display_name: string; slug: string }>(
			"select slug, display_name from profiles order by profile_id",
		);
		expect(rolledBack.rows).toEqual([
			{ display_name: "Legacy 1", slug: "legacy-1" },
			{ display_name: "Legacy 2", slug: "legacy-2" },
			{ display_name: "Legacy 3", slug: "legacy-3" },
		]);
		expect((await readPreservedValues()).rows).toEqual(beforeMigration.rows);
		await database.query("update profiles set slug = 'rollback-1', display_name = 'Rollback 1' where profile_id = '00000000-0000-4000-8000-000000000001'");
		const structures = await database.query<{ backup_table: string | null; guard_function: string | null }>(`
			select to_regclass('public.profile_alias_migration_backup')::text as backup_table,
				to_regprocedure('guard_profile_alias_mutation()')::text as guard_function
		`);
		expect(structures.rows).toEqual([{ backup_table: null, guard_function: null }]);
		const dependentRows = await database.query<{ credentials: string; sessions: string }>(`
			select
				(select count(*)::text from credential_codes where profile_id = '00000000-0000-4000-8000-000000000001') as credentials,
				(select count(*)::text from sessions where profile_id = '00000000-0000-4000-8000-000000000001') as sessions
		`);
		expect(dependentRows.rows).toEqual([{ credentials: "1", sessions: "1" }]);
	});

	it("migrates durable delivery tables up and down on an empty database", async () => {
		harness = await startPostgresHarness();
		const database = createTestDatabase();
		await migrate(database, { allowDown: true });
		for (const table of ["delivery_preflights", "operations", "operation_stages", "artifacts", "delivery_attempts"]) {
			const result = await database.query<{ table_name: string | null }>("select to_regclass($1)::text as table_name", [`public.${table}`]);
			expect(result.rows[0]?.table_name).toBe(table);
		}
		await migrate(database, { allowDown: true, direction: "down", targetVersion: 3 });
		expect(await readCurrentSchemaVersion(database)).toBe(3);
		const operations = await database.query<{ table_name: string | null }>("select to_regclass('public.operations')::text as table_name");
		expect(operations.rows[0]?.table_name).toBeNull();
	});

	it("refuses to roll back durable delivery tables after an operation exists", async () => {
		harness = await startPostgresHarness();
		const database = createTestDatabase();
		await migrate(database, { allowDown: true });
		await database.query(`
			insert into delivery_preflights (
				preflight_id, profile_id, plugin_id, item_id, option_id, plugin_digest,
				destination_revision, item_json, ready, expires_at
			) values (
				'00000000-0000-4000-8000-000000000040',
				'00000000-0000-4000-8000-000000000001', 'project-gutenberg', '1342',
				'epub', repeat('a', 64), 0, '{}'::jsonb, true, now() + interval '5 minutes'
			)
		`);
		await database.query(`
			insert into operations (
				operation_id, profile_id, preflight_id, idempotency_key, status,
				target_json, correlation_id
			) values (
				'00000000-0000-4000-8000-000000000041',
				'00000000-0000-4000-8000-000000000001',
				'00000000-0000-4000-8000-000000000040',
				'00000000-0000-4000-8000-000000000042', 'queued', '{}'::jsonb,
				'00000000-0000-4000-8000-000000000043'
			)
		`);

		await expectSqlState(migrate(database, { allowDown: true, direction: "down", targetVersion: 3 }), "55000");
		expect(await readCurrentSchemaVersion(database)).toBe(latestMigrationVersion());
		const operations = await database.query<{ count: string }>("select count(*)::text as count from operations");
		expect(operations.rows[0]?.count).toBe("1");
	});

	it("creates constrained Phase 3 provider-account tables and metadata cache", async () => {
		harness = await startPostgresHarness();
		const database = createTestDatabase();
		await migrate(database, { allowDown: true });

		for (const table of ["provider_accounts", "oauth_authorizations", "oauth_completion_receipts"]) {
			const result = await database.query<{ table_name: string | null }>("select to_regclass($1)::text as table_name", [`public.${table}`]);
			expect(result.rows[0]?.table_name).toBe(table);
		}
		await database.query(`
			insert into plugin_cache (
				plugin_id, resource_kind, cache_key, normalized_json, fetched_at,
				fresh_until, stale_until, last_accessed_at
			) values (
				'google-books', 'metadata', repeat('a', 64), '{"state":"no-match"}'::jsonb,
				now(), now() + interval '5 minutes', now() + interval '1 hour', now()
			)
		`);
		await database.query(`
			insert into audit_events (
				audit_event_id, actor_kind, actor_label, action, target_kind, target_id,
				outcome, correlation_id
			) values (
				'00000000-0000-4000-8000-000000000050', 'system', 'phase3-test',
				'metadata.cache', 'metadata-contribution', 'google-books:fixture', 'succeeded',
				'00000000-0000-4000-8000-000000000051'
			)
		`);
	});

	it("enforces provider account and open authorization uniqueness", async () => {
		harness = await startPostgresHarness();
		const database = createTestDatabase();
		await migrate(database, { allowDown: true });
		await database.query(`
			insert into sessions (
				session_id, profile_id, token_digest, idle_expires_at, absolute_expires_at
			) values (
				'00000000-0000-4000-8000-000000000060',
				'00000000-0000-4000-8000-000000000001', decode(repeat('61', 32), 'hex'),
				now() + interval '30 minutes', now() + interval '12 hours'
			)
		`);
		const accountSql = `
			insert into provider_accounts (
				account_id, profile_id, connector_id, issuer, subject_hash, masked_account,
				granted_scopes, capabilities, state, access_ciphertext, access_nonce,
				access_tag, access_key_id, access_expires_at
			) values ($1, $2, $3, 'https://accounts.example.invalid', decode(repeat($4, 32), 'hex'),
				'm•••••@example.invalid', '["openid"]'::jsonb, '["identity-only"]'::jsonb,
				'connected', decode('aa', 'hex'), decode(repeat('bb', 12), 'hex'),
				decode(repeat('cc', 16), 'hex'), 'active', now() + interval '1 hour')
		`;
		await database.query(accountSql, [
			"00000000-0000-4000-8000-000000000061", "00000000-0000-4000-8000-000000000001", "google-gmail", "62",
		]);
		await expectSqlState(database.query(accountSql, [
			"00000000-0000-4000-8000-000000000062", "00000000-0000-4000-8000-000000000001", "google-gmail", "63",
		]), "23505");
		await expectSqlState(database.query(accountSql, [
			"00000000-0000-4000-8000-000000000063", "00000000-0000-4000-8000-000000000002", "google-gmail", "62",
		]), "23505");
		await expectSqlState(database.query(`
			update provider_accounts set access_nonce = decode('aa', 'hex')
			where account_id = '00000000-0000-4000-8000-000000000061'
		`), "23514");

		const authorizationSql = `
			insert into oauth_authorizations (
				authorization_id, profile_id, session_id, connector_id, purpose, issuer,
				callback_uri, plugin_id, capability_id, plugin_digest, requested_capabilities,
				requested_scopes, state_digest, browser_binding_digest, pkce_ciphertext,
				pkce_nonce, pkce_tag, pkce_key_id, expires_at
			) values ($1, '00000000-0000-4000-8000-000000000001',
				'00000000-0000-4000-8000-000000000060', 'login-with-amazon', 'connect',
				'https://www.amazon.com', 'https://k.example.invalid/oauth/callback/login-with-amazon',
				'login-with-amazon', 'login-with-amazon/identity', repeat('a', 64),
				'["identity-only"]'::jsonb, '["profile:user_id"]'::jsonb,
				decode(repeat($2, 32), 'hex'), decode(repeat('72', 32), 'hex'), decode('aa', 'hex'),
				decode(repeat('bb', 12), 'hex'), decode(repeat('cc', 16), 'hex'), 'active',
				now() + interval '10 minutes')
		`;
		await database.query(authorizationSql, ["00000000-0000-4000-8000-000000000070", "71"]);
		await expectSqlState(database.query(`
			update oauth_authorizations
			set connector_id = 'google-gmail'
			where authorization_id = '00000000-0000-4000-8000-000000000070'
		`), "23514");
		await expectSqlState(database.query(`
			update oauth_authorizations
			set oidc_nonce_digest = decode(repeat('73', 32), 'hex')
			where authorization_id = '00000000-0000-4000-8000-000000000070'
		`), "23514");
		await expectSqlState(database.query(authorizationSql, ["00000000-0000-4000-8000-000000000071", "74"]), "23505");
		await expectSqlState(database.query(`
			update oauth_authorizations
			set exchange_claim_digest = decode(repeat('75', 32), 'hex')
			where authorization_id = '00000000-0000-4000-8000-000000000070'
		`), "23514");
		await expectSqlState(database.query(`
			update oauth_authorizations
			set exchange_claim_digest = decode(repeat('75', 32), 'hex'),
				exchange_claimed_at = now(),
				exchange_claim_expires_at = now() + interval '3 minutes'
			where authorization_id = '00000000-0000-4000-8000-000000000070'
		`), "23514");
		await database.query(`
			update oauth_authorizations
			set exchange_claim_digest = decode(repeat('75', 32), 'hex'),
				exchange_claimed_at = now(),
				exchange_claim_expires_at = now() + interval '2 minutes'
			where authorization_id = '00000000-0000-4000-8000-000000000070'
		`);
	});

	it("refuses Phase 3 rollback after any provider-account durable write", async () => {
		harness = await startPostgresHarness();
		const database = createTestDatabase();
		await migrate(database, { allowDown: true });
		await database.query(`
			insert into oauth_completion_receipts (
				receipt_id, receipt_digest, outcome, expires_at
			) values (
				'00000000-0000-4000-8000-000000000080', decode(repeat('81', 32), 'hex'),
				'invalid', now() + interval '60 seconds'
			)
		`);

		await expectSqlState(migrate(database, { allowDown: true, direction: "down", targetVersion: 5 }), "55000");
		expect(await readCurrentSchemaVersion(database)).toBe(latestMigrationVersion());
		const receipts = await database.query<{ count: string }>("select count(*)::text as count from oauth_completion_receipts");
		expect(receipts.rows[0]?.count).toBe("1");
	});
});