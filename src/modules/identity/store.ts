import type { PoolClient, QueryResultRow } from "pg";
import { randomUUID } from "node:crypto";
import { hmacSha256Buffer, sha256Buffer } from "../common/crypto";
import type { AppConfig } from "../config";
import type { SqlExecutor } from "../db/database";
import type { ActiveSession, CredentialState, ProfileSummary } from "./types";

interface ProfileRow extends QueryResultRow {
	credential_revision: number;
	credential_state: CredentialState;
	display_name: ProfileSummary["displayName"];
	pin_fingerprint: Buffer | null;
	pin_updated_at: Date | null;
	pin_verifier: string | null;
	profile_id: string;
	slug: ProfileSummary["slug"];
	updated_at: Date;
}

interface SessionRow extends QueryResultRow {
	absolute_expires_at: Date;
	created_at: Date;
	idle_expires_at: Date;
	last_seen_at: Date;
	recent_auth_at: Date;
	revocation_reason: string | null;
	revoked_at: Date | null;
	session_id: string;
	token_digest: Buffer;
}

function mapProfile(row: ProfileRow): ProfileSummary {
	return {
		checkedAt: row.updated_at.toISOString(),
		credentialState: row.credential_state,
		displayName: row.display_name,
		profileId: row.profile_id,
		slug: row.slug,
	};
}

export async function listProfiles(executor: SqlExecutor) {
	const result = await executor.query<ProfileRow>(`
		select profile_id, slug, display_name, credential_state, credential_revision, pin_verifier, pin_fingerprint, pin_updated_at, updated_at
		from profiles
		order by profile_id asc
	`);
	return result.rows.map(mapProfile);
}

export async function readProfileById(executor: SqlExecutor, profileId: string) {
	const result = await executor.query<ProfileRow>(`
		select profile_id, slug, display_name, credential_state, credential_revision, pin_verifier, pin_fingerprint, pin_updated_at, updated_at
		from profiles
		where profile_id = $1
	`, [profileId]);
	return result.rows[0] ?? null;
}

export async function readProfileByIdForUpdate(client: PoolClient, profileId: string) {
	const result = await client.query<ProfileRow>(`
		select profile_id, slug, display_name, credential_state, credential_revision, pin_verifier, pin_fingerprint, pin_updated_at, updated_at
		from profiles
		where profile_id = $1
		for update
	`, [profileId]);
	return result.rows[0] ?? null;
}

export async function readProfileBySlug(executor: SqlExecutor, slug: string) {
	const result = await executor.query<ProfileRow>(`
		select profile_id, slug, display_name, credential_state, credential_revision, pin_verifier, pin_fingerprint, pin_updated_at, updated_at
		from profiles
		where slug = $1
	`, [slug]);
	return result.rows[0] ?? null;
}

export async function readProfileBySlugForUpdate(client: PoolClient, slug: string) {
	const result = await client.query<ProfileRow>(`
		select profile_id, slug, display_name, credential_state, credential_revision, pin_verifier, pin_fingerprint, pin_updated_at, updated_at
		from profiles
		where slug = $1
		for update
	`, [slug]);
	return result.rows[0] ?? null;
}

export async function readProfileByFingerprint(executor: SqlExecutor, fingerprint: Buffer) {
	const result = await executor.query<ProfileRow>(`
		select profile_id, slug, display_name, credential_state, credential_revision, pin_verifier, pin_fingerprint, pin_updated_at, updated_at
		from profiles
		where pin_fingerprint = $1
	`, [fingerprint]);
	return result.rows[0] ?? null;
}

export async function lockPinFingerprint(client: PoolClient, fingerprint: Buffer) {
	await client.query(
		"select pg_advisory_xact_lock(hashtextextended($1, 0))",
		[`k:pin-fingerprint:${fingerprint.toString("hex")}`],
	);
}

export async function readCredentialCode(executor: SqlExecutor, digest: Buffer) {
	const result = await executor.query<{
		consumed_at: Date | null;
		credential_code_id: string;
		credential_revision: number;
		expires_at: Date;
		profile_id: string;
		purpose: "setup" | "recovery";
	}>(`
		select credential_code_id, profile_id, purpose, credential_revision, expires_at, consumed_at
		from credential_codes
		where digest = $1
	`, [digest]);
	return result.rows[0] ?? null;
}

export async function readOpenCredentialCodeForProfileForUpdate(client: PoolClient, profileId: string) {
	const result = await client.query<{
		consumed_at: Date | null;
		credential_code_id: string;
		credential_revision: number;
		digest: Buffer;
		expires_at: Date;
		profile_id: string;
		purpose: "setup" | "recovery";
	}>(`
		select credential_code_id, profile_id, purpose, credential_revision, digest, expires_at, consumed_at
		from credential_codes
		where profile_id = $1 and consumed_at is null
		for update
	`, [profileId]);
	return result.rows[0] ?? null;
}

export async function insertCredentialCode(
	client: PoolClient,
	input: {
		credentialRevision: number;
		digest: Buffer;
		expiresAt: Date;
		issuerLabel: string;
		profileId: string;
		purpose: "setup" | "recovery";
		reason: string;
	},
) {
	await client.query(
		`insert into credential_codes (credential_code_id, profile_id, purpose, credential_revision, digest, issuer_label, reason, expires_at)
		 values ($1, $2, $3, $4, $5, $6, $7, $8)`,
		[randomUUID(), input.profileId, input.purpose, input.credentialRevision, input.digest, input.issuerLabel, input.reason, input.expiresAt],
	);
	}

export async function consumeOpenCredentialCodes(client: PoolClient, profileId: string, consumedReason: string) {
	await client.query(
		`update credential_codes
		 set consumed_at = now(), consumed_reason = $2
		 where profile_id = $1 and consumed_at is null`,
		[profileId, consumedReason],
	);
}

export async function updateProfileForRecoveryIssue(client: PoolClient, profileId: string) {
	const result = await client.query(
		`update profiles
		 set credential_state = 'recovery-required',
		     credential_revision = credential_revision + 1,
		     updated_at = now()
		 where profile_id = $1`,
		[profileId],
	);
	return result.rowCount === 1;
}

export async function setProfilePin(
	client: PoolClient,
	input: {
		profileId: string;
		state: CredentialState;
		verifier: string;
		fingerprint: Buffer;
	},
) {
	const result = await client.query(
		`update profiles
		 set pin_verifier = $2,
		     pin_fingerprint = $3,
		     pin_updated_at = now(),
		     credential_state = 'ready',
		     credential_revision = credential_revision + 1,
		     updated_at = now()
		 where profile_id = $1 and credential_state = $4`,
		[input.profileId, input.verifier, input.fingerprint, input.state],
	);
	return result.rowCount === 1;
	}

export function sourceSubjectKey(config: AppConfig, sourceValue: string) {
	return hmacSha256Buffer(config.sourceHashSecret, sourceValue).toString("hex");
}

export async function readThrottle(executor: SqlExecutor, scope: "profile" | "source", category: "pin" | "credential", subjectKey: string) {
	const result = await executor.query<{
		failure_count: number;
		last_failure_at: Date;
		lock_level: number;
		locked_until: Date | null;
		window_started_at: Date;
	}>(`
		select failure_count, window_started_at, last_failure_at, lock_level, locked_until
		from auth_throttles
		where scope = $1 and category = $2 and subject_key = $3
	`, [scope, category, subjectKey]);
	return result.rows[0] ?? null;
}

export async function lockThrottle(client: PoolClient, scope: "profile" | "source", category: "pin" | "credential", subjectKey: string) {
	await client.query(
		"select pg_advisory_xact_lock(hashtextextended($1, 0))",
		[`k:auth-throttle:${scope}:${category}:${subjectKey}`],
	);
}

export async function writeThrottleFailure(
	client: PoolClient,
	input: {
		category: "pin" | "credential";
		failureCount: number;
		lockedUntil: Date | null;
		lockLevel: number;
		profileId: string | null;
		scope: "profile" | "source";
		subjectKey: string;
		windowStartedAt: Date;
	},
) {
	await client.query(
		`insert into auth_throttles (scope, category, subject_key, profile_id, failure_count, window_started_at, last_failure_at, lock_level, locked_until)
		 values ($1, $2, $3, $4, $5, $6, now(), $7, $8)
		 on conflict (scope, category, subject_key)
		 do update set
		   failure_count = excluded.failure_count,
		   last_failure_at = now(),
		   window_started_at = excluded.window_started_at,
		   lock_level = excluded.lock_level,
		   locked_until = excluded.locked_until`,
		[input.scope, input.category, input.subjectKey, input.profileId, input.failureCount, input.windowStartedAt, input.lockLevel, input.lockedUntil],
	);
}

export async function resetThrottles(client: PoolClient, category: "pin" | "credential", profileId: string, sourceKey?: string) {
	await client.query("delete from auth_throttles where scope = 'profile' and category = $1 and subject_key = $2", [category, profileId]);
	if (sourceKey) {
		await client.query("delete from auth_throttles where scope = 'source' and category = $1 and subject_key = $2", [category, sourceKey]);
	}
}

export async function revokeProfileSessions(client: PoolClient, profileId: string, reason: SessionRevocationReason) {
	await client.query(
		`update sessions
		 set revoked_at = now(), revocation_reason = $2
		 where profile_id = $1 and revoked_at is null`,
		[profileId, reason],
	);
}

export type SessionRevocationReason = "logout" | "credential reset" | "pin change" | "recovery issue" | "expiry" | "rotation";

export async function createSession(
	client: PoolClient,
	input: {
		absoluteExpiresAt: Date;
		idleExpiresAt: Date;
		profileId: string;
		recentAuthAt: Date;
		tokenDigest: Buffer;
	},
) {
	const sessionId = randomUUID();
	await client.query(
		`insert into sessions (session_id, profile_id, token_digest, idle_expires_at, absolute_expires_at, recent_auth_at)
		 values ($1, $2, $3, $4, $5, $6)`,
		[sessionId, input.profileId, input.tokenDigest, input.idleExpiresAt, input.absoluteExpiresAt, input.recentAuthAt],
	);
	return sessionId;
}

export async function readActiveSessionByDigest(executor: SqlExecutor, digest: Buffer) {
	const result = await executor.query<SessionRow & ProfileRow>(`
		select
			s.session_id,
			s.token_digest,
			s.created_at,
			s.last_seen_at,
			s.recent_auth_at,
			s.idle_expires_at,
			s.absolute_expires_at,
			s.revoked_at,
			s.revocation_reason,
			p.profile_id,
			p.slug,
			p.display_name,
			p.credential_state,
			p.credential_revision,
			p.pin_verifier,
			p.pin_fingerprint,
			p.pin_updated_at,
			p.updated_at
		from sessions s
		join profiles p on p.profile_id = s.profile_id
		where s.token_digest = $1 and s.revoked_at is null
	`, [digest]);
	const row = result.rows[0];
	if (!row) {
		return null;
	}
	return {
		absoluteExpiresAt: row.absolute_expires_at,
		createdAt: row.created_at,
		idleExpiresAt: row.idle_expires_at,
		lastSeenAt: row.last_seen_at,
		profile: mapProfile(row),
		recentAuthAt: row.recent_auth_at,
		revocationReason: row.revocation_reason,
		revokedAt: row.revoked_at,
		sessionId: row.session_id,
		tokenDigest: row.token_digest,
	} satisfies ActiveSession;
	}

export async function readActiveSessionByIdForUpdate(
	client: PoolClient,
	input: { activeAt: Date; profileId: string; sessionId: string },
) {
	const result = await client.query<SessionRow & ProfileRow>(`
		select
			s.session_id,
			s.token_digest,
			s.created_at,
			s.last_seen_at,
			s.recent_auth_at,
			s.idle_expires_at,
			s.absolute_expires_at,
			s.revoked_at,
			s.revocation_reason,
			p.profile_id,
			p.slug,
			p.display_name,
			p.credential_state,
			p.credential_revision,
			p.pin_verifier,
			p.pin_fingerprint,
			p.pin_updated_at,
			p.updated_at
		from sessions s
		join profiles p on p.profile_id = s.profile_id
		where s.session_id = $1
			and s.profile_id = $2
			and s.revoked_at is null
			and s.idle_expires_at > $3
			and s.absolute_expires_at > $3
		for update of s
	`, [input.sessionId, input.profileId, input.activeAt]);
	const row = result.rows[0];
	if (!row) return null;
	return {
		absoluteExpiresAt: row.absolute_expires_at,
		createdAt: row.created_at,
		idleExpiresAt: row.idle_expires_at,
		lastSeenAt: row.last_seen_at,
		profile: mapProfile(row),
		recentAuthAt: row.recent_auth_at,
		revocationReason: row.revocation_reason,
		revokedAt: row.revoked_at,
		sessionId: row.session_id,
		tokenDigest: row.token_digest,
	} satisfies ActiveSession;
}

export async function touchSession(
	client: PoolClient,
	input: { absoluteExpiresAt?: Date; digest: Buffer; idleExpiresAt: Date; recentAuthAt?: Date; tokenDigest?: Buffer },
) {
	await client.query(
		`update sessions
		 set last_seen_at = now(),
		     idle_expires_at = $2,
		     absolute_expires_at = coalesce($3, absolute_expires_at),
		     recent_auth_at = coalesce($4, recent_auth_at),
		     token_digest = coalesce($5, token_digest)
		 where token_digest = $1 and revoked_at is null`,
		[input.digest, input.idleExpiresAt, input.absoluteExpiresAt ?? null, input.recentAuthAt ?? null, input.tokenDigest ?? null],
	);
	}

export async function revokeSessionByDigest(client: PoolClient, digest: Buffer, reason: SessionRevocationReason) {
	await client.query(
		`update sessions
		 set revoked_at = now(), revocation_reason = $2
		 where token_digest = $1 and revoked_at is null`,
		[digest, reason],
	);
	}

export function sessionDigest(rawToken: string) {
	return sha256Buffer(Buffer.from(rawToken, "base64url"));
}