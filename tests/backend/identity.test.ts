import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startPostgresHarness, type PostgresHarness } from "./helpers/postgres";
import { createDatabase, type Database } from "../../src/modules/db/database";
import { migrate } from "../../src/modules/db/migrator";
import { IdentityService } from "../../src/modules/identity/service";
import { sessionDigest, sourceSubjectKey } from "../../src/modules/identity/store";
import type { AppConfig } from "../../src/modules/config";

describe("identity service", () => {
	let harness: PostgresHarness | undefined;
	let config: AppConfig;
	let database: Database;
	let identity: IdentityService;
	let closeDatabase: (() => Promise<void>) | undefined;

	beforeEach(async () => {
		harness = await startPostgresHarness();
		config = {
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
		};
		database = createDatabase(config);
		closeDatabase = () => database.close();
		await migrate(database, { allowDown: true });
		identity = new IdentityService(database, config);
	});

	afterEach(async () => {
		if (closeDatabase) {
			await closeDatabase();
			closeDatabase = undefined;
		}
		if (harness) {
			await harness.stop();
			harness = undefined;
		}
	});

	it("issues setup codes only for setup-required profiles and redeems a leading-zero PIN", async () => {
		const issued = await identity.issueCredentialCode({ issuerLabel: "test", profileSlug: "member-1", purpose: "setup", reason: "test", ttlMinutes: 15 });
		expect(issued.code).toHaveLength(43);
		await identity.redeemCredential({ credentialCode: issued.code, pin: "0123", profileId: issued.profile.profileId, sourceAddress: "10.20.30.40" });
		const login = await identity.login({ pin: "0123", profileId: issued.profile.profileId, sourceAddress: "10.20.30.40" });
		expect(login.sessionToken).toHaveLength(43);
	});

	it("rejects slug-shaped login and setup mutations before any UUID query", async () => {
		const sourceAddress = "10.20.30.40";
		await expect(identity.login({ pin: "1357", profileId: "member-1", sourceAddress }))
			.rejects.toMatchObject({ code: "auth_failed", status: 401 });
		await expect(identity.redeemCredential({ credentialCode: "x".repeat(43), pin: "1357", profileId: "member-1", sourceAddress }))
			.rejects.toMatchObject({ code: "credential_code_failed", status: 401 });
		const throttles = await database.query<{ category: string; profile_id: string | null; scope: string }>(`
			select category, profile_id, scope
			from auth_throttles
			where subject_key = $1
			order by category
		`, [sourceSubjectKey(config, sourceAddress)]);
		expect(throttles.rows).toEqual([
			{ category: "credential", profile_id: null, scope: "source" },
			{ category: "pin", profile_id: null, scope: "source" },
		]);
	});

	it("rejects duplicate household PINs", async () => {
		const member1 = await identity.issueCredentialCode({ issuerLabel: "test", profileSlug: "member-1", purpose: "setup", reason: "test", ttlMinutes: 15 });
		await identity.redeemCredential({ credentialCode: member1.code, pin: "2468", profileId: member1.profile.profileId, sourceAddress: "10.20.30.40" });
		const member2 = await identity.issueCredentialCode({ issuerLabel: "test", profileSlug: "member-2", purpose: "setup", reason: "test", ttlMinutes: 15 });
		await expect(identity.redeemCredential({ credentialCode: member2.code, pin: "2468", profileId: member2.profile.profileId, sourceAddress: "10.20.30.40" })).rejects.toMatchObject({ code: "pin_not_allowed", status: 422 });
	});

	it("allows a one-time credential code to be redeemed exactly once under concurrency", async () => {
		const issued = await identity.issueCredentialCode({ issuerLabel: "test", profileSlug: "member-3", purpose: "setup", reason: "test", ttlMinutes: 15 });
		const attempts = await Promise.allSettled([
			identity.redeemCredential({ credentialCode: issued.code, pin: "1357", profileId: issued.profile.profileId, sourceAddress: "10.20.30.40" }),
			identity.redeemCredential({ credentialCode: issued.code, pin: "8642", profileId: issued.profile.profileId, sourceAddress: "10.20.30.41" }),
		]);
		expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
		expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
		const successfulPin = (await identity.login({ pin: "1357", profileId: issued.profile.profileId, sourceAddress: "10.20.30.42" }).then(() => "1357").catch(() => null))
			?? (await identity.login({ pin: "8642", profileId: issued.profile.profileId, sourceAddress: "10.20.30.42" }).then(() => "8642").catch(() => null));
		expect(["1357", "8642"]).toContain(successfulPin);
	});

	it("rejects superseded, expired, and replayed credential codes", async () => {
		const first = await identity.issueCredentialCode({ issuerLabel: "test", profileSlug: "member-1", purpose: "setup", reason: "first", ttlMinutes: 15 });
		const second = await identity.issueCredentialCode({ issuerLabel: "test", profileSlug: "member-1", purpose: "setup", reason: "second", ttlMinutes: 15 });
		await expect(identity.redeemCredential({ credentialCode: first.code, pin: "1357", profileId: first.profile.profileId, sourceAddress: "10.20.30.40" }))
			.rejects.toMatchObject({ code: "credential_code_failed", status: 401 });
		await identity.redeemCredential({ credentialCode: second.code, pin: "1357", profileId: second.profile.profileId, sourceAddress: "10.20.30.40" });
		await expect(identity.redeemCredential({ credentialCode: second.code, pin: "8642", profileId: second.profile.profileId, sourceAddress: "10.20.30.40" }))
			.rejects.toMatchObject({ code: "credential_code_failed", status: 401 });

		const expired = await identity.issueCredentialCode({ issuerLabel: "test", profileSlug: "member-2", purpose: "setup", reason: "expired", ttlMinutes: 15 });
		await database.query(
			"update credential_codes set issued_at = now() - interval '1 hour', expires_at = now() - interval '1 minute' where profile_id = $1 and consumed_at is null",
			[expired.profile.profileId],
		);
		await expect(identity.redeemCredential({ credentialCode: expired.code, pin: "2468", profileId: expired.profile.profileId, sourceAddress: "10.20.30.41" }))
			.rejects.toMatchObject({ code: "credential_code_failed", status: 401 });
	});

	it("recovery issuance revokes sessions and disables the old PIN until redemption", async () => {
		const setup = await identity.issueCredentialCode({ issuerLabel: "test", profileSlug: "member-1", purpose: "setup", reason: "test", ttlMinutes: 15 });
		await identity.redeemCredential({ credentialCode: setup.code, pin: "1357", profileId: setup.profile.profileId, sourceAddress: "10.20.30.40" });
		const login = await identity.login({ pin: "1357", profileId: setup.profile.profileId, sourceAddress: "10.20.30.40" });
		const recovery = await identity.issueCredentialCode({ issuerLabel: "test", profileSlug: "member-1", purpose: "recovery", reason: "test", ttlMinutes: 15 });
		expect(await identity.sessionFromToken(login.sessionToken)).toBeNull();
		await expect(identity.login({ pin: "1357", profileId: setup.profile.profileId, sourceAddress: "10.20.30.40" })).rejects.toMatchObject({ code: "auth_failed" });
		await identity.redeemCredential({ credentialCode: recovery.code, pin: "8642", profileId: setup.profile.profileId, sourceAddress: "10.20.30.40" });
		await expect(identity.login({ pin: "8642", profileId: setup.profile.profileId, sourceAddress: "10.20.30.40" })).resolves.toMatchObject({ sessionToken: expect.any(String) });
	});

	it("reauthentication rotates the session token and invalidates the old token", async () => {
		const issued = await identity.issueCredentialCode({ issuerLabel: "test", profileSlug: "member-2", purpose: "setup", reason: "test", ttlMinutes: 15 });
		await identity.redeemCredential({ credentialCode: issued.code, pin: "1357", profileId: issued.profile.profileId, sourceAddress: "10.20.30.40" });
		const login = await identity.login({ pin: "1357", profileId: issued.profile.profileId, sourceAddress: "10.20.30.40" });
		const active = await identity.sessionFromToken(login.sessionToken);
		expect(active).not.toBeNull();
		const rotated = await identity.reauthenticate({ pin: "1357", session: active!, sourceAddress: "10.20.30.40" });
		expect(rotated.sessionToken).not.toBe(login.sessionToken);
		expect(await identity.sessionFromToken(login.sessionToken)).toBeNull();
		expect(await identity.sessionFromToken(rotated.sessionToken)).not.toBeNull();
	});

	it("changes a PIN atomically, revokes sessions, and appends redacted audit evidence", async () => {
		const sourceAddress = "10.20.30.40";
		const issued = await identity.issueCredentialCode({ issuerLabel: "test", profileSlug: "member-1", purpose: "setup", reason: "test", ttlMinutes: 15 });
		await identity.redeemCredential({ credentialCode: issued.code, pin: "1357", profileId: issued.profile.profileId, sourceAddress });
		const login = await identity.login({ pin: "1357", profileId: issued.profile.profileId, sourceAddress });
		const session = await identity.sessionFromToken(login.sessionToken);
		await identity.changePin({ currentPin: "1357", newPin: "8642", session: session!, sourceAddress });

		expect(await identity.sessionFromToken(login.sessionToken)).toBeNull();
		await expect(identity.login({ pin: "1357", profileId: issued.profile.profileId, sourceAddress })).rejects.toMatchObject({ code: "auth_failed" });
		await expect(identity.login({ pin: "8642", profileId: issued.profile.profileId, sourceAddress })).resolves.toMatchObject({ sessionToken: expect.any(String) });
		const audit = await database.query<{ action: string; details_json: Record<string, unknown>; source_hash: string | null }>(
			"select action, details_json, source_hash from audit_events where action = 'pin.change' and profile_id = $1",
			[issued.profile.profileId],
		);
		expect(audit.rows).toEqual([{
			action: "pin.change",
			details_json: {},
			source_hash: sourceSubjectKey(config, sourceAddress),
		}]);
		expect(JSON.stringify(audit.rows)).not.toContain("1357");
		expect(JSON.stringify(audit.rows)).not.toContain("8642");
	});

	it("rejects a stale PIN change after recovery has changed credential state", async () => {
		const sourceAddress = "10.20.30.40";
		const issued = await identity.issueCredentialCode({ issuerLabel: "test", profileSlug: "member-2", purpose: "setup", reason: "test", ttlMinutes: 15 });
		await identity.redeemCredential({ credentialCode: issued.code, pin: "1357", profileId: issued.profile.profileId, sourceAddress });
		const login = await identity.login({ pin: "1357", profileId: issued.profile.profileId, sourceAddress });
		const session = await identity.sessionFromToken(login.sessionToken);
		await identity.issueCredentialCode({ issuerLabel: "test", profileSlug: "member-2", purpose: "recovery", reason: "test", ttlMinutes: 15 });

		await expect(identity.changePin({ currentPin: "1357", newPin: "8642", session: session!, sourceAddress }))
			.rejects.toMatchObject({ code: "credential_state_conflict", status: 409 });
		const profile = await database.query<{ credential_state: string }>("select credential_state from profiles where profile_id = $1", [issued.profile.profileId]);
		expect(profile.rows[0]?.credential_state).toBe("recovery-required");
		await expect(identity.login({ pin: "8642", profileId: issued.profile.profileId, sourceAddress })).rejects.toMatchObject({ code: "auth_failed" });
	});

	it("blocks PIN change while a persisted PIN throttle is active", async () => {
		const sourceAddress = "10.20.30.40";
		const issued = await identity.issueCredentialCode({ issuerLabel: "test", profileSlug: "member-3", purpose: "setup", reason: "test", ttlMinutes: 15 });
		await identity.redeemCredential({ credentialCode: issued.code, pin: "1357", profileId: issued.profile.profileId, sourceAddress });
		const login = await identity.login({ pin: "1357", profileId: issued.profile.profileId, sourceAddress });
		const session = await identity.sessionFromToken(login.sessionToken);
		await database.query(
			`insert into auth_throttles (
				scope, category, subject_key, profile_id, failure_count, lock_level, locked_until
			) values ('profile', 'pin', $1, $2, 5, 1, now() + interval '15 minutes')`,
			[issued.profile.profileId, issued.profile.profileId],
		);

		await expect(identity.changePin({ currentPin: "1357", newPin: "8642", session: session!, sourceAddress }))
			.rejects.toMatchObject({ code: "auth_throttled", status: 429 });
		await expect(identity.login({ pin: "1357", profileId: issued.profile.profileId, sourceAddress }))
			.rejects.toMatchObject({ code: "auth_throttled", status: 429 });
	});

	it("rejects recovery issuance before a profile has completed setup", async () => {
		await expect(identity.issueCredentialCode({ issuerLabel: "test", profileSlug: "member-3", purpose: "recovery", reason: "test", ttlMinutes: 15 }))
			.rejects.toMatchObject({ code: "credential_state_conflict", status: 409 });
	});

	it("starts a new throttle window at one failure", async () => {
		const issued = await identity.issueCredentialCode({ issuerLabel: "test", profileSlug: "member-1", purpose: "setup", reason: "test", ttlMinutes: 15 });
		await identity.redeemCredential({ credentialCode: issued.code, pin: "1357", profileId: issued.profile.profileId, sourceAddress: "10.20.30.40" });
		await database.query(
			`insert into auth_throttles (scope, category, subject_key, profile_id, failure_count, window_started_at, last_failure_at, lock_level)
			 values ('profile', 'pin', $1, $2, 9, now() - interval '1 hour', now() - interval '1 hour', 0)`,
			[issued.profile.profileId, issued.profile.profileId],
		);
		await expect(identity.login({ pin: "2468", profileId: issued.profile.profileId, sourceAddress: "10.20.30.41" })).rejects.toMatchObject({ code: "auth_failed" });
		const result = await database.query<{ failure_count: number }>("select failure_count from auth_throttles where scope = 'profile' and category = 'pin' and subject_key = $1", [issued.profile.profileId]);
		expect(result.rows[0]?.failure_count).toBe(1);
	});

	it("persists every concurrent PIN failure for profile and source throttles", async () => {
		const sourceAddress = "10.20.30.40";
		const issued = await identity.issueCredentialCode({ issuerLabel: "test", profileSlug: "member-1", purpose: "setup", reason: "test", ttlMinutes: 15 });
		await identity.redeemCredential({ credentialCode: issued.code, pin: "1357", profileId: issued.profile.profileId, sourceAddress });
		const attempts = await Promise.allSettled(Array.from({ length: 4 }, () =>
			identity.login({ pin: "2468", profileId: issued.profile.profileId, sourceAddress }),
		));
		expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(4);
		const sourceKey = sourceSubjectKey(config, sourceAddress);
		const result = await database.query<{ failure_count: number; scope: string }>(
			"select scope, failure_count from auth_throttles where category = 'pin' and (subject_key = $1 or subject_key = $2) order by scope",
			[issued.profile.profileId, sourceKey],
		);
		expect(result.rows).toEqual([
			{ failure_count: 4, scope: "profile" },
			{ failure_count: 4, scope: "source" },
		]);
	});

	it("escalates a persisted profile throttle after five failures", async () => {
		const sourceAddress = "10.20.30.40";
		const issued = await identity.issueCredentialCode({ issuerLabel: "test", profileSlug: "member-2", purpose: "setup", reason: "test", ttlMinutes: 15 });
		await identity.redeemCredential({ credentialCode: issued.code, pin: "1357", profileId: issued.profile.profileId, sourceAddress });
		for (let attempt = 0; attempt < 3; attempt += 1) {
			await expect(identity.login({ pin: "2468", profileId: issued.profile.profileId, sourceAddress }))
				.rejects.toMatchObject({ code: "auth_failed", status: 401 });
		}
		await expect(identity.login({ pin: "2468", profileId: issued.profile.profileId, sourceAddress }))
			.rejects.toMatchObject({ code: "auth_throttled", status: 429 });
		await database.query(
			"update auth_throttles set locked_until = now() - interval '1 second' where scope = 'profile' and category = 'pin' and subject_key = $1",
			[issued.profile.profileId],
		);
		await expect(identity.login({ pin: "2468", profileId: issued.profile.profileId, sourceAddress }))
			.rejects.toMatchObject({ code: "auth_failed", status: 401 });
		await database.query(
			"update auth_throttles set locked_until = now() - interval '1 second' where scope = 'profile' and category = 'pin' and subject_key = $1",
			[issued.profile.profileId],
		);
		await expect(identity.login({ pin: "2468", profileId: issued.profile.profileId, sourceAddress }))
			.rejects.toMatchObject({ code: "auth_failed", status: 401 });
		const throttle = await database.query<{ failure_count: number; lock_level: number; locked: boolean }>(
			"select failure_count, lock_level, locked_until > now() as locked from auth_throttles where scope = 'profile' and category = 'pin' and subject_key = $1",
			[issued.profile.profileId],
		);
		expect(throttle.rows).toEqual([{ failure_count: 5, lock_level: 1, locked: true }]);
		await expect(identity.login({ pin: "1357", profileId: issued.profile.profileId, sourceAddress }))
			.rejects.toMatchObject({ code: "auth_throttled", status: 429, headers: { "retry-after": expect.any(String) } });
	});

	it("successful PIN login does not clear credential-code throttles", async () => {
		const sourceAddress = "10.20.30.40";
		const issued = await identity.issueCredentialCode({ issuerLabel: "test", profileSlug: "member-2", purpose: "setup", reason: "test", ttlMinutes: 15 });
		await identity.redeemCredential({ credentialCode: issued.code, pin: "1357", profileId: issued.profile.profileId, sourceAddress });
		await expect(identity.redeemCredential({ credentialCode: "invalid", pin: "2468", profileId: issued.profile.profileId, sourceAddress })).rejects.toMatchObject({ code: "credential_code_failed" });
		await identity.login({ pin: "1357", profileId: issued.profile.profileId, sourceAddress });
		const sourceKey = sourceSubjectKey(config, sourceAddress);
		const result = await database.query<{ category: string; scope: string }>("select category, scope from auth_throttles where category = 'credential' and (subject_key = $1 or subject_key = $2) order by scope", [issued.profile.profileId, sourceKey]);
		expect(result.rows).toEqual([{ category: "credential", scope: "profile" }, { category: "credential", scope: "source" }]);
	});

	it("extends idle expiry on authenticated activity without exceeding absolute expiry", async () => {
		const issued = await identity.issueCredentialCode({ issuerLabel: "test", profileSlug: "member-3", purpose: "setup", reason: "test", ttlMinutes: 15 });
		await identity.redeemCredential({ credentialCode: issued.code, pin: "1357", profileId: issued.profile.profileId, sourceAddress: "10.20.30.40" });
		const login = await identity.login({ pin: "1357", profileId: issued.profile.profileId, sourceAddress: "10.20.30.40" });
		const before = new Date(Date.now() + 1000);
		await database.query("update sessions set idle_expires_at = $2 where token_digest = $1", [sessionDigest(login.sessionToken), before]);
		const active = await identity.sessionFromToken(login.sessionToken);
		expect(active).not.toBeNull();
		expect(active!.idleExpiresAt.getTime()).toBeGreaterThan(before.getTime());
		expect(active!.idleExpiresAt.getTime()).toBeLessThanOrEqual(active!.absoluteExpiresAt.getTime());
	});

	it("revokes a session that has reached absolute expiry", async () => {
		const issued = await identity.issueCredentialCode({ issuerLabel: "test", profileSlug: "member-3", purpose: "setup", reason: "test", ttlMinutes: 15 });
		await identity.redeemCredential({ credentialCode: issued.code, pin: "1357", profileId: issued.profile.profileId, sourceAddress: "10.20.30.40" });
		const login = await identity.login({ pin: "1357", profileId: issued.profile.profileId, sourceAddress: "10.20.30.40" });
		await database.query(
			`update sessions
			 set created_at = now() - interval '13 hours',
			     absolute_expires_at = now() - interval '1 second'
			 where token_digest = $1`,
			[sessionDigest(login.sessionToken)],
		);
		expect(await identity.sessionFromToken(login.sessionToken)).toBeNull();
		const session = await database.query<{ revocation_reason: string; revoked: boolean }>(
			"select revocation_reason, revoked_at is not null as revoked from sessions where token_digest = $1",
			[sessionDigest(login.sessionToken)],
		);
		expect(session.rows).toEqual([{ revocation_reason: "expiry", revoked: true }]);
	});
});