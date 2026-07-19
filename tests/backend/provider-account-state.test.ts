import { createHash, randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/modules/config";
import { createDatabase, type Database } from "../../src/modules/db/database";
import { migrate } from "../../src/modules/db/migrator";
import type { ActiveSession, ProfileSummary } from "../../src/modules/identity/types";
import { decryptProviderToken, PROVIDER_TOKEN_DECRYPTION_ERROR } from "../../src/modules/provider-accounts/custody";
import {
	ProviderAccountService,
	type AuthorizationSuccessResult,
} from "../../src/modules/provider-accounts/service";
import type {
	ProviderConnectorId,
	ProviderRuntimeConfig,
} from "../../src/modules/provider-accounts/types";
import { startPostgresHarness, type PostgresHarness } from "./helpers/postgres";
import { createProviderFixture, type ProviderFixture } from "./helpers/provider-config";

const PROFILES = {
	member1: {
		displayName: "Member 1",
		profileId: "00000000-0000-4000-8000-000000000001",
		slug: "member-1",
	},
	member2: {
		displayName: "Member 2",
		profileId: "00000000-0000-4000-8000-000000000002",
		slug: "member-2",
	},
} as const;

interface AuthorizationSecretsRow {
	browser_binding_digest: Buffer;
	consumed_at: Date | null;
	consumed_reason: string | null;
	exchange_claim_digest: Buffer | null;
	exchange_claim_expires_at: Date | null;
	oidc_nonce_ciphertext: Buffer | null;
	oidc_nonce_digest: Buffer | null;
	oidc_nonce_key_id: string | null;
	oidc_nonce_nonce: Buffer | null;
	oidc_nonce_tag: Buffer | null;
	pkce_ciphertext: Buffer | null;
	pkce_key_id: string | null;
	pkce_nonce: Buffer | null;
	pkce_tag: Buffer | null;
	state_digest: Buffer;
}

interface AccountSecretRow {
	access_ciphertext: Buffer;
	access_key_id: string;
	access_nonce: Buffer;
	access_tag: Buffer;
	account_id: string;
	grant_revision: number;
	masked_account: string | null;
	profile_id: string;
	refresh_ciphertext: Buffer | null;
	refresh_key_id: string | null;
	refresh_nonce: Buffer | null;
	refresh_tag: Buffer | null;
	state: string;
}

describe("provider account durable state", () => {
	let database: Database;
	let fixture: ProviderFixture;
	let harness: PostgresHarness;
	let runtime: ProviderRuntimeConfig;
	let service: ProviderAccountService;

	beforeEach(async () => {
		harness = await startPostgresHarness();
		const config: AppConfig = {
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
		await migrate(database, { allowDown: true });
		fixture = await createProviderFixture();
		const loaded = fixture.load();
		if (loaded.status !== "configured") throw new Error("expected configured provider runtime");
		runtime = loaded;
		service = new ProviderAccountService(database, runtime);
	});

	afterEach(async () => {
		await database?.close();
		await fixture?.cleanup();
		await harness?.stop();
	});

	async function createSession(
		profile = PROFILES.member1,
		overrides: { absoluteExpiresAt?: Date; idleExpiresAt?: Date; recentAuthAt?: Date } = {},
	): Promise<ActiveSession> {
		const now = new Date();
		const createdAt = new Date(now.getTime() - 1_000);
		const idleExpiresAt = overrides.idleExpiresAt ?? new Date(now.getTime() + 30 * 60_000);
		const absoluteExpiresAt = overrides.absoluteExpiresAt ?? new Date(now.getTime() + 12 * 60 * 60_000);
		const recentAuthAt = overrides.recentAuthAt ?? now;
		const sessionId = randomUUID();
		const tokenDigest = randomBytes(32);
		await database.query(`
			insert into sessions (
				session_id, profile_id, token_digest, created_at, last_seen_at,
				recent_auth_at, idle_expires_at, absolute_expires_at
			) values ($1, $2, $3, $4, $4, $5, $6, $7)
		`, [sessionId, profile.profileId, tokenDigest, createdAt, recentAuthAt, idleExpiresAt, absoluteExpiresAt]);
		const profileSummary: ProfileSummary = {
			checkedAt: now.toISOString(),
			credentialState: "setup-required",
			displayName: profile.displayName,
			profileId: profile.profileId,
			slug: profile.slug,
		};
		return {
			absoluteExpiresAt,
			createdAt,
			idleExpiresAt,
			lastSeenAt: createdAt,
			profile: profileSummary,
			recentAuthAt,
			revocationReason: null,
			revokedAt: null,
			sessionId,
			tokenDigest,
		};
	}

	function digestOpaque(value: string) {
		return createHash("sha256").update(Buffer.from(value, "base64url")).digest();
	}

	function successfulIdentity(
		connectorId: ProviderConnectorId,
		overrides: Partial<AuthorizationSuccessResult> = {},
	): AuthorizationSuccessResult {
		const registration = runtime.connector(connectorId)!.registration;
		return {
			accessExpiresAt: new Date(Date.now() + 60 * 60_000),
			accessToken: `access-token-${connectorId}`,
			accountLabel: connectorId === "google-gmail" ? "member@example.invalid" : "Amazon member",
			grantedScopes: registration.capabilityScopes["identity-only"],
			issuer: registration.issuer,
			outcome: "completed",
			refreshToken: `refresh-token-${connectorId}`,
			subject: `subject-${connectorId}`,
			...overrides,
		};
	}

	async function completeConnection(
		session: ActiveSession,
		connectorId: ProviderConnectorId,
		purpose: "connect" | "reconnect",
		identity = successfulIdentity(connectorId),
	) {
		const started = await service.startAuthorization(session, connectorId, purpose);
		const claim = await service.claimAuthorization({
			browserBinding: started.browserBinding,
			connectorId,
			state: started.state,
		});
		const view = await service.finalizeAuthorization(claim, identity);
		return { started, view };
	}

	it("stores only state/browser digests and encrypted PKCE with an S256-safe result", async () => {
		const session = await createSession();
		const started = await service.startAuthorization(session, "google-gmail", "connect");
		expect(started.state).toHaveLength(43);
		expect(started.browserBinding).toHaveLength(43);
		expect(started.state).not.toBe(started.browserBinding);
		expect(started.authorizationUrl).toEqual(expect.objectContaining({
			authorizationEndpoint: "https://openidconnect.googleapis.com/authorize",
			callbackUri: "https://k.example.invalid/oauth/callback/google-gmail",
			clientId: "google-client",
			nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			pkceChallenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			pkceMethod: "S256",
			scopes: ["openid", "email"],
		}));
		expect(JSON.stringify(started)).not.toContain("verifier");
		expect(JSON.stringify(started)).not.toContain("client-secret");

		const stored = await database.query<AuthorizationSecretsRow>(`
			select state_digest, browser_binding_digest, pkce_ciphertext, pkce_nonce,
				pkce_tag, pkce_key_id, oidc_nonce_digest, oidc_nonce_ciphertext,
				oidc_nonce_nonce, oidc_nonce_tag, oidc_nonce_key_id, exchange_claim_digest,
				exchange_claim_expires_at, consumed_at, consumed_reason
			from oauth_authorizations where authorization_id = $1
		`, [started.authorizationId]);
		const row = stored.rows[0]!;
		expect(row.state_digest.equals(digestOpaque(started.state))).toBe(true);
		expect(row.browser_binding_digest.equals(digestOpaque(started.browserBinding))).toBe(true);
		expect(row.state_digest.equals(row.browser_binding_digest)).toBe(false);
		expect(row.pkce_ciphertext).not.toBeNull();
		expect(row.pkce_nonce).toHaveLength(12);
		expect(row.pkce_tag).toHaveLength(16);
		expect(row.pkce_key_id).toBe("active-2026");
		expect(row.oidc_nonce_digest).toHaveLength(32);
		expect(row.oidc_nonce_ciphertext).not.toBeNull();
		expect(row.oidc_nonce_nonce).toHaveLength(12);
		expect(row.oidc_nonce_tag).toHaveLength(16);
		expect(row.oidc_nonce_key_id).toBe("active-2026");
		expect(row.exchange_claim_digest).toBeNull();

		const claim = await service.claimAuthorization({
			browserBinding: started.browserBinding,
			connectorId: "google-gmail",
			state: started.state,
		});
		const verifier = claim.usePkceVerifier((value) => value);
		const oidcNonce = claim.useOidcNonce((value) => value);
		expect(oidcNonce).toBe(started.authorizationUrl.nonce);
		expect(() => claim.useOidcNonce((value) => value))
			.toThrow("Provider authorization is invalid");
		expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
		expect(verifier).not.toBe(started.state);
		expect(verifier).not.toBe(started.browserBinding);
		expect(createHash("sha256").update(verifier, "ascii").digest("base64url"))
			.toBe(started.authorizationUrl.pkceChallenge);
		expect(() => claim.usePkceVerifier((value) => value))
			.toThrow("Provider authorization is invalid");
		expect(row.pkce_ciphertext!.equals(Buffer.from(verifier, "ascii"))).toBe(false);
		expect(row.oidc_nonce_ciphertext!.equals(Buffer.from(oidcNonce, "ascii"))).toBe(false);
		expect(inspect(claim)).not.toContain(verifier);
		expect(inspect(claim)).not.toContain(oidcNonce);
		await service.finalizeAuthorization(claim, { outcome: "failed", reasonCode: "PROVIDER_EXCHANGE_FAILED" });

		const amazon = await service.startAuthorization(session, "login-with-amazon", "connect");
		expect(amazon.authorizationUrl).not.toHaveProperty("nonce");
	});

	it("fails a claimed OIDC authorization when encrypted nonce and retained digest diverge", async () => {
		const session = await createSession();
		const started = await service.startAuthorization(session, "google-gmail", "connect");
		await database.query(`
			update oauth_authorizations
			set oidc_nonce_digest = $2
			where authorization_id = $1
		`, [started.authorizationId, randomBytes(32)]);
		await expect(service.claimAuthorization({
			browserBinding: started.browserBinding,
			connectorId: "google-gmail",
			state: started.state,
		})).rejects.toMatchObject({ code: "provider_authorization_invalid", status: 400 });
		const row = await database.query<{ consumed_reason: string; oidc_nonce_ciphertext: Buffer | null }>(`
			select consumed_reason, oidc_nonce_ciphertext
			from oauth_authorizations where authorization_id = $1
		`, [started.authorizationId]);
		expect(row.rows[0]).toEqual({ consumed_reason: "failed", oidc_nonce_ciphertext: null });
	});

	it("enforces purpose consistency plus current, profile-bound, recently authenticated sessions", async () => {
		const session = await createSession();
		await expect(service.startAuthorization(session, "google-gmail", "reconnect"))
			.rejects.toMatchObject({ code: "provider_account_state_conflict", status: 409 });
		await completeConnection(session, "google-gmail", "connect");
		await expect(service.startAuthorization(session, "google-gmail", "connect"))
			.rejects.toMatchObject({ code: "provider_account_state_conflict", status: 409 });
		await expect(service.startAuthorization(session, "google-gmail", "reconnect"))
			.resolves.toMatchObject({ authorizationId: expect.any(String) });

		const stale = await createSession(PROFILES.member2, { recentAuthAt: new Date(Date.now() - 10 * 60_000 - 1_000) });
		await expect(service.startAuthorization(stale, "login-with-amazon", "connect"))
			.rejects.toMatchObject({ code: "recent_authentication_required", status: 403 });

		const revoked = await createSession(PROFILES.member2);
		await database.query(
			"update sessions set revoked_at = now(), revocation_reason = 'logout' where session_id = $1",
			[revoked.sessionId],
		);
		await expect(service.startAuthorization(revoked, "login-with-amazon", "connect"))
			.rejects.toMatchObject({ code: "unauthorized", status: 401 });

		const expired = await createSession(PROFILES.member2);
		await database.query(
			`update sessions
			 set created_at = now() - interval '2 minutes',
			     idle_expires_at = now() - interval '1 second'
			 where session_id = $1`,
			[expired.sessionId],
		);
		await expect(service.startAuthorization(expired, "login-with-amazon", "connect"))
			.rejects.toMatchObject({ code: "unauthorized", status: 401 });

		const otherProfileView = { ...session, profile: stale.profile };
		await expect(service.startAuthorization(otherProfileView, "login-with-amazon", "connect"))
			.rejects.toMatchObject({ code: "unauthorized", status: 401 });
	});

	it("supersedes prior secret material and leaves exactly one open row under concurrent starts", async () => {
		const session = await createSession();
		const first = await service.startAuthorization(session, "google-gmail", "connect");
		const second = await service.startAuthorization(session, "google-gmail", "connect");
		const firstRow = await database.query<AuthorizationSecretsRow>(`
			select state_digest, browser_binding_digest, pkce_ciphertext, pkce_nonce,
				pkce_tag, pkce_key_id, oidc_nonce_digest, oidc_nonce_ciphertext,
				oidc_nonce_nonce, oidc_nonce_tag, oidc_nonce_key_id, exchange_claim_digest,
				exchange_claim_expires_at, consumed_at, consumed_reason
			from oauth_authorizations where authorization_id = $1
		`, [first.authorizationId]);
		expect(firstRow.rows[0]).toEqual(expect.objectContaining({
			consumed_at: expect.any(Date),
			consumed_reason: "superseded",
			exchange_claim_digest: null,
			oidc_nonce_digest: null,
			oidc_nonce_ciphertext: null,
			oidc_nonce_key_id: null,
			oidc_nonce_nonce: null,
			oidc_nonce_tag: null,
			pkce_ciphertext: null,
			pkce_key_id: null,
			pkce_nonce: null,
			pkce_tag: null,
		}));
		expect(second.authorizationId).not.toBe(first.authorizationId);

		const concurrent = await Promise.all([
			service.startAuthorization(session, "login-with-amazon", "connect"),
			service.startAuthorization(session, "login-with-amazon", "connect"),
		]);
		expect(concurrent[0].authorizationId).not.toBe(concurrent[1].authorizationId);
		const rows = await database.query<{ consumed_reason: string | null; open: boolean }>(`
			select consumed_at is null as open, consumed_reason
			from oauth_authorizations
			where profile_id = $1 and connector_id = 'login-with-amazon'
		`, [session.profile.profileId]);
		expect(rows.rows.filter((row) => row.open)).toHaveLength(1);
		expect(rows.rows.filter((row) => row.consumed_reason === "superseded")).toHaveLength(1);
	});

	it("returns one generic error for wrong state, browser, connector, expiry, and replay", async () => {
		const session = await createSession();
		const wrongStateStart = await service.startAuthorization(session, "google-gmail", "connect");
		const wrongState = randomBytes(32).toString("base64url");
		const wrongStateError = await service.claimAuthorization({
			browserBinding: wrongStateStart.browserBinding,
			connectorId: "google-gmail",
			state: wrongState,
		}).catch((error: unknown) => error);
		expect(wrongStateError).toMatchObject({ code: "provider_authorization_invalid", status: 400 });
		expect(inspect(wrongStateError)).not.toContain(wrongState);
		const stillOpen = await database.query<{ open: boolean }>(
			"select consumed_at is null as open from oauth_authorizations where authorization_id = $1",
			[wrongStateStart.authorizationId],
		);
		expect(stillOpen.rows[0]?.open).toBe(true);

		const wrongBrowserError = await service.claimAuthorization({
			browserBinding: randomBytes(32).toString("base64url"),
			connectorId: "google-gmail",
			state: wrongStateStart.state,
		}).catch((error: unknown) => error);
		expect(wrongBrowserError).toMatchObject({
			code: "provider_authorization_invalid",
			message: "Provider authorization is invalid",
			status: 400,
		});
		await expect(service.claimAuthorization({
			browserBinding: wrongStateStart.browserBinding,
			connectorId: "google-gmail",
			state: wrongStateStart.state,
		})).rejects.toMatchObject({ code: "provider_authorization_invalid", status: 400 });

		const wrongConnectorStart = await service.startAuthorization(session, "login-with-amazon", "connect");
		await expect(service.consumeAuthorization({
			browserBinding: wrongConnectorStart.browserBinding,
			connectorId: "google-gmail",
			outcome: "denied",
			state: wrongConnectorStart.state,
		})).rejects.toMatchObject({ code: "provider_authorization_invalid", status: 400 });
		const mixed = await database.query<{ consumed_reason: string }>(
			"select consumed_reason from oauth_authorizations where authorization_id = $1",
			[wrongConnectorStart.authorizationId],
		);
		expect(mixed.rows[0]?.consumed_reason).toBe("invalid");

		const expiredStart = await service.startAuthorization(session, "login-with-amazon", "connect");
		await database.query(`
			update oauth_authorizations
			set created_at = now() - interval '10 minutes', expires_at = now() - interval '1 second'
			where authorization_id = $1
		`, [expiredStart.authorizationId]);
		await expect(service.claimAuthorization({
			browserBinding: expiredStart.browserBinding,
			connectorId: "login-with-amazon",
			state: expiredStart.state,
		})).rejects.toMatchObject({ code: "provider_authorization_invalid", status: 400 });
		const expired = await database.query<AuthorizationSecretsRow>(`
			select state_digest, browser_binding_digest, pkce_ciphertext, pkce_nonce,
				pkce_tag, pkce_key_id, oidc_nonce_digest, oidc_nonce_ciphertext,
				oidc_nonce_nonce, oidc_nonce_tag, oidc_nonce_key_id, exchange_claim_digest,
				exchange_claim_expires_at, consumed_at, consumed_reason
			from oauth_authorizations where authorization_id = $1
		`, [expiredStart.authorizationId]);
		expect(expired.rows[0]).toEqual(expect.objectContaining({
			consumed_reason: "expired",
			pkce_ciphertext: null,
		}));

		const revokedStart = await service.startAuthorization(session, "login-with-amazon", "connect");
		await database.query(
			"update sessions set revoked_at = now(), revocation_reason = 'logout' where session_id = $1",
			[session.sessionId],
		);
		await expect(service.claimAuthorization({
			browserBinding: revokedStart.browserBinding,
			connectorId: "login-with-amazon",
			state: revokedStart.state,
		})).rejects.toMatchObject({ code: "provider_authorization_invalid", status: 400 });
		const revokedAuthorization = await database.query<{ consumed_reason: string }>(
			"select consumed_reason from oauth_authorizations where authorization_id = $1",
			[revokedStart.authorizationId],
		);
		expect(revokedAuthorization.rows[0]?.consumed_reason).toBe("invalid");
	});

	it("grants one exchange claim under concurrency and fails a stale claim closed", async () => {
		const session = await createSession();
		const started = await service.startAuthorization(session, "google-gmail", "connect");
		const attempts = await Promise.allSettled([
			service.claimAuthorization({ browserBinding: started.browserBinding, connectorId: "google-gmail", state: started.state }),
			service.claimAuthorization({ browserBinding: started.browserBinding, connectorId: "google-gmail", state: started.state }),
		]);
		expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
		expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
		const claimedRow = await database.query<AuthorizationSecretsRow>(`
			select state_digest, browser_binding_digest, pkce_ciphertext, pkce_nonce,
				pkce_tag, pkce_key_id, oidc_nonce_digest, oidc_nonce_ciphertext,
				oidc_nonce_nonce, oidc_nonce_tag, oidc_nonce_key_id, exchange_claim_digest,
				exchange_claim_expires_at, consumed_at, consumed_reason
			from oauth_authorizations where authorization_id = $1
		`, [started.authorizationId]);
		expect(claimedRow.rows[0]?.exchange_claim_digest).toHaveLength(32);
		expect(claimedRow.rows[0]?.consumed_at).toBeNull();
		const claim = attempts.find((attempt) => attempt.status === "fulfilled")!;
		if (claim.status !== "fulfilled") throw new Error("expected a successful claim");
		await service.finalizeAuthorization(claim.value, { outcome: "denied", reasonCode: "PROVIDER_DENIED" });
		await expect(service.finalizeAuthorization(claim.value, { outcome: "denied" }))
			.rejects.toMatchObject({ code: "provider_authorization_invalid", status: 400 });

		const staleStart = await service.startAuthorization(session, "google-gmail", "connect");
		const staleClaim = await service.claimAuthorization({
			browserBinding: staleStart.browserBinding,
			connectorId: "google-gmail",
			state: staleStart.state,
		});
		await database.query(`
			update oauth_authorizations
			set created_at = now() - interval '5 minutes',
				expires_at = now() + interval '5 minutes',
				exchange_claimed_at = now() - interval '2 minutes',
				exchange_claim_expires_at = now() - interval '1 second'
			where authorization_id = $1
		`, [staleStart.authorizationId]);
		await expect(service.claimAuthorization({
			browserBinding: staleStart.browserBinding,
			connectorId: "google-gmail",
			state: staleStart.state,
		})).rejects.toMatchObject({ code: "provider_authorization_invalid", status: 400 });
		const staleRow = await database.query<AuthorizationSecretsRow>(`
			select state_digest, browser_binding_digest, pkce_ciphertext, pkce_nonce,
				pkce_tag, pkce_key_id, oidc_nonce_digest, oidc_nonce_ciphertext,
				oidc_nonce_nonce, oidc_nonce_tag, oidc_nonce_key_id, exchange_claim_digest,
				exchange_claim_expires_at, consumed_at, consumed_reason
			from oauth_authorizations where authorization_id = $1
		`, [staleStart.authorizationId]);
		expect(staleRow.rows[0]).toEqual(expect.objectContaining({
			consumed_reason: "failed",
			exchange_claim_digest: null,
			pkce_ciphertext: null,
		}));
		await expect(service.finalizeAuthorization(staleClaim, { outcome: "failed" }))
			.rejects.toMatchObject({ code: "provider_authorization_invalid", status: 400 });
	});

	it("issues 60-second completion receipts that are generic and one-use", async () => {
		const receipt = await service.issueCompletionReceipt({
			authorizationId: null,
			connectorId: "google-gmail",
			outcome: "connected",
			profileId: PROFILES.member1.profileId,
		});
		expect(receipt).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const stored = await database.query<{ bounded: boolean; digest: Buffer }>(`
			select receipt_digest as digest,
				expires_at <= created_at + interval '60 seconds' as bounded
			from oauth_completion_receipts
		`);
		expect(stored.rows[0]?.bounded).toBe(true);
		expect(stored.rows[0]?.digest.equals(digestOpaque(receipt))).toBe(true);
		expect(await service.consumeCompletionReceipt(receipt)).toEqual({ outcome: "connected", valid: true });
		const generic = { outcome: "invalid", valid: false };
		expect(await service.consumeCompletionReceipt(receipt)).toEqual(generic);
		expect(await service.consumeCompletionReceipt(randomBytes(32).toString("base64url"))).toEqual(generic);
		expect(await service.consumeCompletionReceipt("malformed")).toEqual(generic);

		const expiredReceipt = await service.issueCompletionReceipt({
			authorizationId: null,
			connectorId: null,
			outcome: "denied",
			profileId: null,
		});
		await database.query(`
			update oauth_completion_receipts
			set created_at = now() - interval '61 seconds', expires_at = now() - interval '1 second'
			where receipt_digest = $1
		`, [digestOpaque(expiredReceipt)]);
		expect(await service.consumeCompletionReceipt(expiredReceipt)).toEqual(generic);
	});

	it("deletes expired receipts before consumed authorizations after seven days", async () => {
		const session = await createSession();
		const oldAuthorization = await service.startAuthorization(session, "google-gmail", "connect");
		await service.consumeAuthorization({
			browserBinding: oldAuthorization.browserBinding,
			connectorId: "google-gmail",
			outcome: "denied",
			state: oldAuthorization.state,
		});
		await service.issueCompletionReceipt({
			authorizationId: oldAuthorization.authorizationId,
			connectorId: "google-gmail",
			outcome: "denied",
			profileId: session.profile.profileId,
		});

		const recentAuthorization = await service.startAuthorization(session, "google-gmail", "connect");
		await service.consumeAuthorization({
			browserBinding: recentAuthorization.browserBinding,
			connectorId: "google-gmail",
			outcome: "denied",
			state: recentAuthorization.state,
		});
		await service.issueCompletionReceipt({
			authorizationId: recentAuthorization.authorizationId,
			connectorId: "google-gmail",
			outcome: "denied",
			profileId: session.profile.profileId,
		});

		await database.query(`
			update oauth_authorizations
			set consumed_at = now() - interval '8 days'
			where authorization_id = $1
		`, [oldAuthorization.authorizationId]);
		await database.query(`
			update oauth_completion_receipts
			set created_at = now() - interval '8 days',
			    expires_at = now() - interval '8 days' + interval '30 seconds'
			where authorization_id = $1
		`, [oldAuthorization.authorizationId]);

		await expect(service.cleanupRetention()).resolves.toEqual({
			authorizationsDeleted: 1,
			receiptsDeleted: 1,
		});
		const counts = await database.query<{ old_authorizations: string; old_receipts: string; recent_authorizations: string; recent_receipts: string }>(`
			select
				(select count(*)::text from oauth_authorizations where authorization_id = $1) as old_authorizations,
				(select count(*)::text from oauth_completion_receipts where authorization_id = $1) as old_receipts,
				(select count(*)::text from oauth_authorizations where authorization_id = $2) as recent_authorizations,
				(select count(*)::text from oauth_completion_receipts where authorization_id = $2) as recent_receipts
		`, [oldAuthorization.authorizationId, recentAuthorization.authorizationId]);
		expect(counts.rows[0]).toEqual({
			old_authorizations: "0",
			old_receipts: "0",
			recent_authorizations: "1",
			recent_receipts: "1",
		});
	});

	it("inserts an encrypted account, preserves it on reconnect failure, and replaces it at the next revision", async () => {
		const session = await createSession();
		const accessV1 = "access-token-v1-do-not-store-plain";
		const refreshV1 = "refresh-token-v1-do-not-store-plain";
		const connected = await completeConnection(session, "google-gmail", "connect", successfulIdentity("google-gmail", {
			accessToken: accessV1,
			refreshToken: refreshV1,
			subject: "stable-google-subject",
		}));
		expect(connected.view).toEqual(expect.objectContaining({
			capabilities: ["identity-only"],
			connectorId: "google-gmail",
			maskedAccount: "m*****@example.invalid",
			revision: 1,
			state: "connected",
		}));
		const pendingAfterConnect = await service.listAccountRows(session.profile.profileId);
		expect(pendingAfterConnect).toEqual([expect.objectContaining({
			authorizationPending: false,
			connectorId: "google-gmail",
			revision: 1,
		})]);

		const first = await database.query<AccountSecretRow>(`
			select account_id, profile_id, state, grant_revision, masked_account,
				access_ciphertext, access_nonce, access_tag, access_key_id,
				refresh_ciphertext, refresh_nonce, refresh_tag, refresh_key_id
			from provider_accounts where account_id = $1
		`, [connected.view!.accountId]);
		const firstRow = first.rows[0]!;
		expect(firstRow.access_ciphertext.includes(Buffer.from(accessV1))).toBe(false);
		expect(firstRow.refresh_ciphertext?.includes(Buffer.from(refreshV1))).toBe(false);
		expect(decryptProviderToken({
			ciphertext: firstRow.access_ciphertext,
			keyId: firstRow.access_key_id,
			nonce: firstRow.access_nonce,
			tag: firstRow.access_tag,
		}, {
			accountId: firstRow.account_id,
			connectorId: "google-gmail",
			kind: "access",
			profileId: firstRow.profile_id,
			revision: 1,
		}, runtime.keyring).toString("utf8")).toBe(accessV1);

		const failedStart = await service.startAuthorization(session, "google-gmail", "reconnect");
		const pendingReconnect = await service.listAccountRows(session.profile.profileId);
		expect(pendingReconnect[0]).toEqual(expect.objectContaining({
			authorizationPending: true,
			accountId: firstRow.account_id,
			revision: 1,
			state: "connected",
		}));
		const failedClaim = await service.claimAuthorization({
			browserBinding: failedStart.browserBinding,
			connectorId: "google-gmail",
			state: failedStart.state,
		});
		await service.finalizeAuthorization(failedClaim, { outcome: "failed", reasonCode: "PROVIDER_EXCHANGE_FAILED" });
		const afterFailure = await database.query<AccountSecretRow>(`
			select account_id, profile_id, state, grant_revision, masked_account,
				access_ciphertext, access_nonce, access_tag, access_key_id,
				refresh_ciphertext, refresh_nonce, refresh_tag, refresh_key_id
			from provider_accounts where account_id = $1
		`, [firstRow.account_id]);
		expect(afterFailure.rows[0]?.grant_revision).toBe(1);
		expect(afterFailure.rows[0]?.access_ciphertext.equals(firstRow.access_ciphertext)).toBe(true);
		expect(afterFailure.rows[0]?.access_nonce.equals(firstRow.access_nonce)).toBe(true);

		const accessV2 = "access-token-v2-do-not-store-plain";
		const reconnected = await completeConnection(session, "google-gmail", "reconnect", successfulIdentity("google-gmail", {
			accessToken: accessV2,
			accountLabel: "updated@example.invalid",
			refreshToken: null,
			subject: "stable-google-subject",
		}));
		expect(reconnected.view).toEqual(expect.objectContaining({
			accountId: firstRow.account_id,
			maskedAccount: "u******@example.invalid",
			revision: 2,
		}));
		const second = await database.query<AccountSecretRow>(`
			select account_id, profile_id, state, grant_revision, masked_account,
				access_ciphertext, access_nonce, access_tag, access_key_id,
				refresh_ciphertext, refresh_nonce, refresh_tag, refresh_key_id
			from provider_accounts where account_id = $1
		`, [firstRow.account_id]);
		expect(second.rows[0]?.grant_revision).toBe(2);
		expect(second.rows[0]?.access_ciphertext.equals(firstRow.access_ciphertext)).toBe(false);
		expect(second.rows[0]?.refresh_ciphertext).toBeNull();
		expect(() => decryptProviderToken({
			ciphertext: firstRow.access_ciphertext,
			keyId: firstRow.access_key_id,
			nonce: firstRow.access_nonce,
			tag: firstRow.access_tag,
		}, {
			accountId: firstRow.account_id,
			connectorId: "google-gmail",
			kind: "access",
			profileId: firstRow.profile_id,
			revision: 2,
		}, runtime.keyring)).toThrow(PROVIDER_TOKEN_DECRYPTION_ERROR);
	});

	it("rejects duplicate external subjects across profiles without revealing the conflict", async () => {
		const member1 = await createSession(PROFILES.member1);
		const member2 = await createSession(PROFILES.member2);
		const subject = "shared-provider-subject-must-not-leak";
		await completeConnection(member1, "login-with-amazon", "connect", successfulIdentity("login-with-amazon", { subject }));
		const started = await service.startAuthorization(member2, "login-with-amazon", "connect");
		const claim = await service.claimAuthorization({
			browserBinding: started.browserBinding,
			connectorId: "login-with-amazon",
			state: started.state,
		});
		const error = await service.finalizeAuthorization(claim, successfulIdentity("login-with-amazon", { subject }))
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({
			code: "provider_account_update_failed",
			message: "Provider account update failed",
			status: 409,
		});
		expect(inspect(error)).not.toContain(subject);
		const accounts = await database.query<{ count: string }>(
			"select count(*)::text as count from provider_accounts where connector_id = 'login-with-amazon'",
		);
		expect(accounts.rows[0]?.count).toBe("1");
		const authorization = await database.query<{ consumed_reason: string }>(
			"select consumed_reason from oauth_authorizations where authorization_id = $1",
			[started.authorizationId],
		);
		expect(authorization.rows[0]?.consumed_reason).toBe("failed");
	});

	it("writes redacted append-only audit rows for authorization and account state", async () => {
		const session = await createSession();
		const accessToken = "audit-access-token-must-not-leak";
		const refreshToken = "audit-refresh-token-must-not-leak";
		const subject = "audit-subject-must-not-leak";
		const accountLabel = "audit-member@example.invalid";
		const completed = await completeConnection(session, "google-gmail", "connect", successfulIdentity("google-gmail", {
			accessToken,
			accountLabel,
			refreshToken,
			subject,
		}));
		const audit = await database.query<{
			action: string;
			details_json: Record<string, unknown>;
			target_kind: string;
		}>(`
			select action, target_kind, details_json
			from audit_events
			where target_id in ($1, $2)
			order by created_at
		`, [completed.started.authorizationId, completed.view!.accountId]);
		expect(audit.rows.map((row) => [row.action, row.target_kind])).toEqual([
			["provider-authorization.start", "oauth-authorization"],
			["provider-authorization.claim", "oauth-authorization"],
			["provider-authorization.consume", "oauth-authorization"],
			["provider-account.connect", "provider-account"],
		]);
		const serialized = JSON.stringify(audit.rows);
		for (const secret of [
			completed.started.state,
			completed.started.browserBinding,
			completed.started.authorizationUrl.nonce!,
			accessToken,
			refreshToken,
			subject,
			accountLabel,
		]) {
			expect(serialized).not.toContain(secret);
		}
		await expect(database.query("update audit_events set actor_label = 'tampered' where target_id = $1", [completed.view!.accountId]))
			.rejects.toMatchObject({ code: "55000" });
		await expect(database.query("delete from audit_events where target_id = $1", [completed.view!.accountId]))
			.rejects.toMatchObject({ code: "55000" });
	});
});