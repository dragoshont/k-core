import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { addMinutes, addHours } from "../time";
import { appendAuditEvent } from "../common/audit";
import { constantTimeBufferEqual, hmacSha256Buffer, randomBase64Url, sha256Buffer } from "../common/crypto";
import type { AppConfig } from "../config";
import { isProfileId } from "../config/profile-config";
import type { Database } from "../db/database";
import { withTransaction } from "../db/database";
import { ProblemError } from "../http/problems";
import { assertAllowedPin, validatePinFormat } from "./pin-policy";
import {
	consumeOpenCredentialCodes,
	createSession,
	insertCredentialCode,
	listProfiles,
	lockPinFingerprint,
	lockThrottle,
	readActiveSessionByDigest,
	readOpenCredentialCodeForProfileForUpdate,
	readProfileByFingerprint,
	readProfileById,
	readProfileByIdForUpdate,
	readProfileBySlugForUpdate,
	readThrottle,
	resetThrottles,
	revokeProfileSessions,
	revokeSessionByDigest,
	sessionDigest,
	sourceSubjectKey,
	touchSession,
	updateProfileForRecoveryIssue,
	writeThrottleFailure,
	setProfilePin,
} from "./store";
import type { ActiveSession, ProfileSummary, SessionView } from "./types";

const SESSION_IDLE_MINUTES = 30;
const SESSION_ABSOLUTE_HOURS = 12;
const RECENT_AUTH_MINUTES = 10;

function profileToView(profile: ProfileSummary) {
	return profile;
}

function throttleLockDate(level: number, now: Date) {
	if (level === 1) {
		return addMinutes(now, 15);
	}
	if (level === 2) {
		return addHours(now, 1);
	}
	if (level >= 3) {
		return addHours(now, 24);
	}
	return null;
}

async function verifyPin(config: AppConfig, verifier: string, pin: string) {
	return argon2.verify(verifier, `${pin}${config.pinPepper}`);
}

async function hashPin(config: AppConfig, pin: string) {
	return argon2.hash(`${pin}${config.pinPepper}`, { memoryCost: 65536, parallelism: 1, timeCost: 3, type: argon2.argon2id });
}

function credentialDigest(code: string) {
	const raw = Buffer.from(code, "base64url");
	if (raw.length !== 32 || raw.toString("base64url") !== code) {
		return null;
	}
	return sha256Buffer(raw);
}

function pinFingerprint(config: AppConfig, pin: string) {
	return hmacSha256Buffer(config.pinReuseSecret, pin);
}

function nowIso(now: Date) {
	return now.toISOString();
}

function createSessionView(profile: ProfileSummary, csrfToken: string, createdAt: Date, idleExpiresAt: Date, absoluteExpiresAt: Date, recentAuthAt: Date): SessionView {
	return {
		absoluteExpiresAt: absoluteExpiresAt.toISOString(),
		createdAt: createdAt.toISOString(),
		csrfToken,
		idleExpiresAt: idleExpiresAt.toISOString(),
		profile: profileToView(profile),
		recentAuthenticationAt: recentAuthAt.toISOString(),
	};
	}

async function registerFailure(
	database: Database,
	config: AppConfig,
	input: { category: "credential" | "pin"; profileId?: string; sourceKey?: string },
) {
	const now = new Date();
	return withTransaction(database.pool, async (client) => {
		if (input.profileId) {
			await lockThrottle(client, "profile", input.category, input.profileId);
			const current = await readThrottle(client, "profile", input.category, input.profileId);
			const withinWindow = current && now.getTime() - current.window_started_at.getTime() <= 15 * 60 * 1000;
			const failureCount = withinWindow ? current.failure_count + 1 : 1;
			const lockLevel = failureCount >= 5 ? Math.min((current?.lock_level ?? 0) + 1, 3) : current?.lock_level ?? 0;
			await writeThrottleFailure(client, {
				category: input.category,
				failureCount,
				lockedUntil: failureCount >= 5 ? throttleLockDate(lockLevel, now) : failureCount >= 3 ? addMinutes(now, 1) : null,
				lockLevel,
				profileId: input.profileId,
				scope: "profile",
				subjectKey: input.profileId,
				windowStartedAt: withinWindow ? current!.window_started_at : now,
			});
		}

		if (input.sourceKey) {
			await lockThrottle(client, "source", input.category, input.sourceKey);
			const current = await readThrottle(client, "source", input.category, input.sourceKey);
			const withinWindow = current && now.getTime() - current.window_started_at.getTime() <= 60 * 60 * 1000;
			const failureCount = withinWindow ? current.failure_count + 1 : 1;
			const lockedUntil = failureCount >= 10 ? addHours(now, 1) : null;
			await writeThrottleFailure(client, {
				category: input.category,
				failureCount,
				lockedUntil,
				lockLevel: lockedUntil ? 1 : 0,
				profileId: null,
				scope: "source",
				subjectKey: input.sourceKey,
				windowStartedAt: withinWindow ? current!.window_started_at : now,
			});
		}
	});
}

async function assertNotThrottled(database: Database, input: { category: "credential" | "pin"; profileId?: string; sourceKey?: string }) {
	const now = new Date();
	for (const key of [input.profileId ? ["profile", input.profileId] as const : null, input.sourceKey ? ["source", input.sourceKey] as const : null]) {
		if (!key) {
			continue;
		}

		const throttle = await readThrottle(database, key[0], input.category, key[1]);
		if (throttle?.locked_until && throttle.locked_until > now) {
			throw new ProblemError(429, "auth_throttled", "Too many attempts", "Wait before trying again.", {
				headers: { "retry-after": String(Math.max(1, Math.ceil((throttle.locked_until.getTime() - now.getTime()) / 1000))) },
				retryAt: throttle.locked_until.toISOString(),
			});
		}
	}
}

export class IdentityService {
	constructor(private readonly database: Database, private readonly config: AppConfig) {}

	async listProfiles() {
		return listProfiles(this.database);
	}

	async issueCredentialCode(input: { issuerLabel: string; profileSlug: string; purpose: "setup" | "recovery"; reason: string; ttlMinutes: number }) {
		const code = randomBase64Url(32);
		const digest = credentialDigest(code)!;
		const correlationId = randomUUID();
		let issuedProfile: ProfileSummary | null = null;

		await withTransaction(this.database.pool, async (client) => {
			const profile = await readProfileBySlugForUpdate(client, input.profileSlug);
			if (!profile) {
				throw new ProblemError(404, "profile_not_found", "Profile not found");
			}
			if (input.purpose === "setup" && profile.credential_state !== "setup-required") {
				throw new ProblemError(409, "credential_state_conflict", "Credential state changed", "Setup codes can be issued only for setup-required profiles.");
			}
			if (input.purpose === "recovery" && profile.credential_state === "setup-required") {
				throw new ProblemError(409, "credential_state_conflict", "Credential state changed", "Recovery codes require a configured profile.");
			}
			if (input.purpose === "recovery") {
				if (!(await updateProfileForRecoveryIssue(client, profile.profile_id))) {
					throw new ProblemError(409, "credential_state_conflict", "Credential state changed");
				}
				await revokeProfileSessions(client, profile.profile_id, "recovery issue");
			}
			await consumeOpenCredentialCodes(client, profile.profile_id, input.purpose === "recovery" ? "superseded by recovery issue" : "superseded by new setup code");
			await insertCredentialCode(client, {
				credentialRevision: input.purpose === "recovery" ? profile.credential_revision + 1 : profile.credential_revision,
				digest,
				expiresAt: addMinutes(new Date(), Math.min(input.ttlMinutes, 24 * 60)),
				issuerLabel: input.issuerLabel,
				profileId: profile.profile_id,
				purpose: input.purpose,
				reason: input.reason,
			});
			await appendAuditEvent(client, {
				action: `credential-code.issue.${input.purpose}`,
				actorKind: "operator-cli",
				actorLabel: input.issuerLabel,
				correlationId,
				detailsJson: { purpose: input.purpose, ttlMinutes: input.ttlMinutes },
				outcome: "succeeded",
				profileId: profile.profile_id,
				requestId: null,
				sourceHash: null,
				targetId: profile.profile_id,
				targetKind: "profile",
			});
			issuedProfile = profileToView({
				checkedAt: profile.updated_at.toISOString(),
				credentialState: input.purpose === "recovery" ? "recovery-required" : profile.credential_state,
				displayName: profile.display_name,
				profileId: profile.profile_id,
				slug: profile.slug,
			});
		});

		return { code, profile: issuedProfile!, purpose: input.purpose };
	}

	async redeemCredential(input: { credentialCode: string; pin: string; profileId: string; sourceAddress: string }) {
		const pinCheck = assertAllowedPin(input.pin);
		if (!pinCheck.ok) {
			throw new ProblemError(422, "pin_not_allowed", "PIN not allowed", pinCheck.reason);
		}

		const sourceKey = sourceSubjectKey(this.config, input.sourceAddress);
		if (!isProfileId(input.profileId)) {
			await assertNotThrottled(this.database, { category: "credential", sourceKey });
			await registerFailure(this.database, this.config, { category: "credential", sourceKey });
			throw new ProblemError(401, "credential_code_failed", "Credential code failed", "The code or profile was not accepted.");
		}
		await assertNotThrottled(this.database, { category: "credential", profileId: input.profileId, sourceKey });

		const digest = /^[A-Za-z0-9_-]{43}$/.test(input.credentialCode) ? credentialDigest(input.credentialCode) : null;
		if (!digest) {
			await registerFailure(this.database, this.config, { category: "credential", profileId: input.profileId, sourceKey });
			throw new ProblemError(401, "credential_code_failed", "Credential code failed", "The code or profile was not accepted.");
		}

		const fingerprint = pinFingerprint(this.config, input.pin);
		const verifier = await hashPin(this.config, input.pin);
		const correlationId = randomUUID();
		try {
			await withTransaction(this.database.pool, async (client) => {
				const profile = await readProfileByIdForUpdate(client, input.profileId);
				const credential = await readOpenCredentialCodeForProfileForUpdate(client, input.profileId);
				const digestMatches = constantTimeBufferEqual(digest, credential?.digest ?? Buffer.alloc(32));
				if (!profile || !credential || !digestMatches || credential.profile_id !== input.profileId || credential.consumed_at || credential.expires_at <= new Date()) {
					throw new ProblemError(401, "credential_code_failed", "Credential code failed", "The code or profile was not accepted.");
				}
				if ((credential.purpose === "setup" && profile.credential_state !== "setup-required")
					|| (credential.purpose === "recovery" && profile.credential_state !== "recovery-required")
					|| credential.credential_revision !== profile.credential_revision) {
					throw new ProblemError(409, "credential_state_conflict", "Credential state changed", "Ask the operator for a fresh code.");
				}

				await lockPinFingerprint(client, fingerprint);
				const duplicate = await readProfileByFingerprint(client, fingerprint);
				if (duplicate && duplicate.profile_id !== input.profileId) {
					throw new ProblemError(422, "pin_not_allowed", "PIN not allowed", "Choose a PIN that is not used by another household profile.");
				}

				if (!(await setProfilePin(client, {
					fingerprint,
					profileId: input.profileId,
					state: profile.credential_state,
					verifier,
				}))) {
					throw new ProblemError(409, "credential_state_conflict", "Credential state changed");
				}
				await consumeOpenCredentialCodes(client, input.profileId, "credential redeemed");
				await revokeProfileSessions(client, input.profileId, "credential reset");
				await resetThrottles(client, "credential", input.profileId, sourceKey);
				await appendAuditEvent(client, {
					action: "credential-code.redeem",
					actorKind: "system",
					actorLabel: "identity",
					correlationId,
					detailsJson: { purpose: credential.purpose },
					outcome: "succeeded",
					profileId: input.profileId,
					requestId: null,
					sourceHash: sourceKey,
					targetId: input.profileId,
					targetKind: "profile",
				});
			});
		} catch (error) {
			if (error instanceof ProblemError && error.code === "credential_code_failed") {
				await registerFailure(this.database, this.config, { category: "credential", profileId: input.profileId, sourceKey });
			}
			throw error;
		}
	}

	async login(input: { pin: string; profileId: string; sourceAddress: string }) {
		if (!validatePinFormat(input.pin)) {
			throw new ProblemError(401, "auth_failed", "PIN not accepted", "The profile or PIN was not accepted.");
		}

		const sourceKey = sourceSubjectKey(this.config, input.sourceAddress);
		if (!isProfileId(input.profileId)) {
			await assertNotThrottled(this.database, { category: "pin", sourceKey });
			await registerFailure(this.database, this.config, { category: "pin", sourceKey });
			throw new ProblemError(401, "auth_failed", "PIN not accepted", "The profile or PIN was not accepted.");
		}
		await assertNotThrottled(this.database, { category: "pin", profileId: input.profileId, sourceKey });
		const profile = await readProfileById(this.database, input.profileId);
		if (!profile || profile.credential_state !== "ready" || !profile.pin_verifier) {
			await registerFailure(this.database, this.config, { category: "pin", profileId: input.profileId, sourceKey });
			throw new ProblemError(401, "auth_failed", "PIN not accepted", "The profile or PIN was not accepted.");
		}

		const ok = await verifyPin(this.config, profile.pin_verifier, input.pin);
		if (!ok) {
			await registerFailure(this.database, this.config, { category: "pin", profileId: input.profileId, sourceKey });
			throw new ProblemError(401, "auth_failed", "PIN not accepted", "The profile or PIN was not accepted.");
		}

		const now = new Date();
		const sessionToken = randomBase64Url(32);
		const csrfToken = randomBase64Url(32);
		const digest = sessionDigest(sessionToken);
		const idleExpiresAt = addMinutes(now, SESSION_IDLE_MINUTES);
		const absoluteExpiresAt = addHours(now, SESSION_ABSOLUTE_HOURS);

		await withTransaction(this.database.pool, async (client) => {
			await resetThrottles(client, "pin", input.profileId, sourceKey);
			await createSession(client, {
				absoluteExpiresAt,
				idleExpiresAt,
				profileId: input.profileId,
				recentAuthAt: now,
				tokenDigest: digest,
			});
		});

		return {
			csrfToken,
			sessionToken,
			view: createSessionView(profileToView({ checkedAt: profile.updated_at.toISOString(), credentialState: profile.credential_state, displayName: profile.display_name, profileId: profile.profile_id, slug: profile.slug }), csrfToken, now, idleExpiresAt, absoluteExpiresAt, now),
		};
	}

	async sessionFromToken(token: string | undefined) {
		if (!token) {
			return null;
		}

		const session = await readActiveSessionByDigest(this.database, sessionDigest(token));
		if (!session) {
			return null;
		}

		const now = new Date();
		if (session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) {
			await withTransaction(this.database.pool, async (client) => {
				await revokeSessionByDigest(client, session.tokenDigest, "expiry");
			});
			return null;
		}

		const idleExpiresAt = new Date(Math.min(addMinutes(now, SESSION_IDLE_MINUTES).getTime(), session.absoluteExpiresAt.getTime()));
		if (idleExpiresAt > session.idleExpiresAt) {
			await withTransaction(this.database.pool, async (client) => {
				await touchSession(client, { digest: session.tokenDigest, idleExpiresAt });
			});
			session.idleExpiresAt = idleExpiresAt;
			session.lastSeenAt = now;
		}

		return session;
	}

	async readSession(token: string | undefined, csrfToken: string | undefined) {
		const session = await this.sessionFromToken(token);
		if (!session || !csrfToken) {
			return null;
		}
		return createSessionView(session.profile, csrfToken, session.createdAt, session.idleExpiresAt, session.absoluteExpiresAt, session.recentAuthAt);
	}

	async reauthenticate(input: { pin: string; session: ActiveSession; sourceAddress: string }) {
		if (!validatePinFormat(input.pin)) {
			throw new ProblemError(401, "auth_failed", "PIN not accepted", "The profile or PIN was not accepted.");
		}
		const sourceKey = sourceSubjectKey(this.config, input.sourceAddress);
		await assertNotThrottled(this.database, { category: "pin", profileId: input.session.profile.profileId, sourceKey });
		const profile = await readProfileById(this.database, input.session.profile.profileId);
		if (!profile?.pin_verifier || !(await verifyPin(this.config, profile.pin_verifier, input.pin))) {
			await registerFailure(this.database, this.config, { category: "pin", profileId: input.session.profile.profileId, sourceKey });
			throw new ProblemError(401, "auth_failed", "PIN not accepted", "The profile or PIN was not accepted.");
		}

		const now = new Date();
		const rotatedSessionToken = randomBase64Url(32);
		const rotatedDigest = sessionDigest(rotatedSessionToken);
		const idleExpiresAt = addMinutes(now, SESSION_IDLE_MINUTES);
		await withTransaction(this.database.pool, async (client) => {
			await resetThrottles(client, "pin", input.session.profile.profileId, sourceKey);
			await touchSession(client, {
				digest: input.session.tokenDigest,
				idleExpiresAt,
				recentAuthAt: now,
				tokenDigest: rotatedDigest,
			});
		});

		return {
			recentAuthAt: now,
			sessionToken: rotatedSessionToken,
		};
	}

	async changePin(input: { currentPin: string; newPin: string; session: ActiveSession; sourceAddress: string }) {
		const pinCheck = assertAllowedPin(input.newPin, input.currentPin);
		if (!pinCheck.ok) {
			throw new ProblemError(422, "pin_not_allowed", "PIN not allowed", pinCheck.reason);
		}

		const sourceKey = sourceSubjectKey(this.config, input.sourceAddress);
		await assertNotThrottled(this.database, { category: "pin", profileId: input.session.profile.profileId, sourceKey });
		const profile = await readProfileById(this.database, input.session.profile.profileId);
		if (!profile?.pin_verifier || !(await verifyPin(this.config, profile.pin_verifier, input.currentPin))) {
			await registerFailure(this.database, this.config, {
				category: "pin",
				profileId: input.session.profile.profileId,
				sourceKey,
			});
			throw new ProblemError(401, "auth_failed", "PIN not accepted", "The profile or PIN was not accepted.");
		}

		const fingerprint = pinFingerprint(this.config, input.newPin);
		const verifier = await hashPin(this.config, input.newPin);
		const correlationId = randomUUID();
		await withTransaction(this.database.pool, async (client) => {
			const current = await readProfileByIdForUpdate(client, input.session.profile.profileId);
			if (!current
				|| current.credential_state !== "ready"
				|| current.credential_revision !== profile.credential_revision
				|| current.pin_verifier !== profile.pin_verifier) {
				throw new ProblemError(409, "credential_state_conflict", "Credential state changed", "Authenticate again before changing the PIN.");
			}
			await lockPinFingerprint(client, fingerprint);
			const duplicate = await readProfileByFingerprint(client, fingerprint);
			if (duplicate && duplicate.profile_id !== input.session.profile.profileId) {
				throw new ProblemError(422, "pin_not_allowed", "PIN not allowed", "Choose a PIN that is not used by another household profile.");
			}
			if (!(await setProfilePin(client, {
				fingerprint,
				profileId: input.session.profile.profileId,
				state: "ready",
				verifier,
			}))) {
				throw new ProblemError(409, "credential_state_conflict", "Credential state changed");
			}
			await revokeProfileSessions(client, input.session.profile.profileId, "pin change");
			await resetThrottles(client, "pin", input.session.profile.profileId, sourceKey);
			await appendAuditEvent(client, {
				action: "pin.change",
				actorKind: "profile",
				actorLabel: current.slug,
				correlationId,
				detailsJson: {},
				outcome: "succeeded",
				profileId: current.profile_id,
				requestId: null,
				sourceHash: sourceKey,
				targetId: current.profile_id,
				targetKind: "profile",
			});
		});
	}

	async logout(session: ActiveSession) {
		await withTransaction(this.database.pool, async (client) => {
			await revokeSessionByDigest(client, session.tokenDigest, "logout");
		});
	}

	requiresRecentAuth(session: ActiveSession) {
		return Date.now() - session.recentAuthAt.getTime() > RECENT_AUTH_MINUTES * 60 * 1000;
	}
}