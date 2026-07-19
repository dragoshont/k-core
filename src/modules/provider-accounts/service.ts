import { inspect } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { appendAuditEvent } from "../common/audit";
import {
	constantTimeBufferEqual,
	randomBase64Url,
	sha256Buffer,
} from "../common/crypto";
import type { Database } from "../db/database";
import { ProblemError } from "../http/problems";
import { readActiveSessionByIdForUpdate } from "../identity/store";
import type { ActiveSession } from "../identity/types";
import { addMinutes } from "../time";
import {
	decryptProviderToken,
	encryptProviderToken,
	providerSubjectHmac,
} from "./custody";
import {
	claimAuthorizationRow,
	consumeAuthorizationRow,
	consumeCompletionReceiptRow,
	deleteExpiredCompletionReceipts,
	deleteRetainedAuthorizations,
	insertAuthorization,
	insertCompletionReceipt,
	insertProviderAccount,
	listProviderAccountRows,
	lockProviderConnector,
	lockProviderSubject,
	readAuthorizationLockKeyByStateDigest,
	readAuthorizationByIdForUpdate,
	readAuthorizationByStateDigestForUpdate,
	readCompletionReceiptForUpdate,
	readOpenAuthorizationForUpdate,
	readProviderAccountBySubject,
	readProviderAccountForUpdate,
	replaceProviderAccount,
	type OAuthAuthorizationPurpose,
	type OAuthAuthorizationRow,
	type OAuthCompletionOutcome,
	type ProviderAccountRow,
} from "./store";
import type {
	ProviderConnectorId,
	ProviderEncryptedValue,
} from "./types";
import { ProviderRuntimeConfig } from "./types";

const AUTHORIZATION_MINUTES = 10;
const AUTHORIZATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_AUTH_MINUTES = 10;
const RECEIPT_SECONDS = 60;
const GENERIC_AUTHORIZATION_ERROR = "Provider authorization is invalid";
const GENERIC_ACCOUNT_ERROR = "Provider account update failed";
const AUTHORIZATION_REASON_CODES = [
	"PROVIDER_DENIED",
	"PROVIDER_EXCHANGE_FAILED",
	"PROVIDER_RESPONSE_INVALID",
] as const;
const FAILURE_OUTCOMES = new Set<AuthorizationFailureOutcome>([
	"denied", "expired", "failed", "invalid",
]);
const COMPLETION_OUTCOMES = new Set<OAuthCompletionOutcome>([
	"connected", "denied", "expired", "invalid",
]);

export type AuthorizationReasonCode = typeof AUTHORIZATION_REASON_CODES[number];

export interface StartAuthorizationResult {
	authorizationId: string;
	authorizationUrl: {
		authorizationEndpoint: string;
		callbackUri: string;
		clientId: string;
		nonce?: string;
		pkceChallenge: string;
		pkceMethod: "S256";
		scopes: readonly string[];
	};
	browserBinding: string;
	state: string;
}

export interface ProviderAccountView {
	accountId: string;
	capabilities: readonly ["identity-only"];
	connectedAt: string;
	connectorId: ProviderConnectorId;
	grantedScopes: readonly string[];
	lastValidatedAt: string;
	maskedAccount: string | null;
	revision: number;
	state: "connected" | "error" | "expired-or-revoked";
}

export interface ProviderAccountListView {
	accountId: string | null;
	authorizationPending: boolean;
	capabilities: readonly ["identity-only"] | readonly [];
	connectedAt: string | null;
	connectorId: ProviderConnectorId;
	grantedScopes: readonly string[];
	lastValidatedAt: string | null;
	maskedAccount: string | null;
	revision: number;
	state: "connected" | "connecting" | "error" | "expired-or-revoked";
}

export type AuthorizationFailureOutcome = "denied" | "expired" | "failed" | "invalid";

export interface AuthorizationSuccessResult {
	accessExpiresAt: Date;
	accessToken: Buffer | string;
	accountLabel: string | null;
	grantedScopes: readonly string[];
	issuer: string;
	outcome: "completed";
	refreshToken?: Buffer | string | null;
	subject: string;
}

function authorizationError() {
	return new ProblemError(400, "provider_authorization_invalid", GENERIC_AUTHORIZATION_ERROR);
}

function accountError() {
	return new ProblemError(409, "provider_account_update_failed", GENERIC_ACCOUNT_ERROR);
}

function opaqueDigest(value: unknown) {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
	const raw = Buffer.from(value, "base64url");
	if (raw.byteLength !== 32 || raw.toString("base64url") !== value) return null;
	try {
		return sha256Buffer(raw);
	} finally {
		raw.fill(0);
	}
}

function validateReasonCode(reasonCode: unknown) {
	if (reasonCode !== undefined
		&& !AUTHORIZATION_REASON_CODES.includes(reasonCode as AuthorizationReasonCode)) {
		throw authorizationError();
	}
	return reasonCode as AuthorizationReasonCode | undefined ?? null;
}

function sameStringSet(left: unknown, right: readonly string[]) {
	return Array.isArray(left)
		&& left.every((value): value is string => typeof value === "string")
		&& left.length === right.length
		&& new Set(left).size === left.length
		&& left.every((value) => right.includes(value));
}

function maskAccountLabel(value: unknown) {
	if (value === null) return null;
	if (typeof value !== "string") throw accountError();
	const normalized = value.trim();
	if (!normalized || normalized.length > 254 || /[\r\n\0]/.test(normalized)) {
		throw accountError();
	}
	const at = normalized.lastIndexOf("@");
	if (at > 0 && at < normalized.length - 1) {
		const local = normalized.slice(0, at);
		const domain = normalized.slice(at + 1);
		const maskedLocal = local.length === 1
			? "*"
			: `${local.slice(0, 1)}${"*".repeat(Math.min(8, local.length - 1))}`;
		return `${maskedLocal}@${domain}`;
	}
	return normalized.length === 1
		? "*"
		: `${normalized.slice(0, 1)}${"*".repeat(Math.min(8, normalized.length - 1))}`;
}

function validSecret(value: unknown) {
	if (value === null || value === undefined) return true;
	if (!Buffer.isBuffer(value) && typeof value !== "string") return false;
	const length = Buffer.isBuffer(value) ? value.byteLength : Buffer.byteLength(value, "utf8");
	return length >= 1 && length <= 64 * 1024;
}

function accountView(row: ProviderAccountRow): ProviderAccountView {
	return {
		accountId: row.account_id,
		capabilities: ["identity-only"],
		connectedAt: row.connected_at.toISOString(),
		connectorId: row.connector_id,
		grantedScopes: row.granted_scopes,
		lastValidatedAt: row.last_validated_at.toISOString(),
		maskedAccount: row.masked_account,
		revision: row.grant_revision,
		state: row.state,
	};
}

async function activeSession(
	client: PoolClient,
	row: Pick<OAuthAuthorizationRow, "profile_id" | "session_id">,
	now: Date,
) {
	return readActiveSessionByIdForUpdate(client, {
		activeAt: now,
		profileId: row.profile_id,
		sessionId: row.session_id,
	});
}

async function auditAuthorization(
	client: PoolClient,
	row: Pick<OAuthAuthorizationRow, "authorization_id" | "connector_id" | "profile_id" | "purpose">,
	action: string,
	details: Record<string, unknown>,
	outcome: "failed" | "succeeded",
) {
	await appendAuditEvent(client, {
		action,
		actorKind: "system",
		actorLabel: "provider-accounts",
		correlationId: randomUUID(),
		detailsJson: {
			connectorId: row.connector_id,
			purpose: row.purpose,
			...details,
		},
		outcome,
		profileId: row.profile_id,
		requestId: null,
		sourceHash: null,
		targetId: row.authorization_id,
		targetKind: "oauth-authorization",
	});
}

export class ProviderAuthorizationClaim {
	readonly accountId: string | null;
	readonly authorizationId: string;
	readonly callbackUri: string;
	readonly capabilityId: string;
	readonly connectorId: ProviderConnectorId;
	readonly issuer: string;
	readonly pluginDigest: string;
	readonly pluginId: string;
	readonly profileId: string;
	readonly purpose: OAuthAuthorizationPurpose;
	readonly requestedScopes: readonly string[];
	readonly sessionId: string;
	#claim: Buffer;
	#oidcNonce: Buffer | null;
	#pkceVerifier: Buffer;

	constructor(row: OAuthAuthorizationRow, claim: Buffer, pkceVerifier: Buffer, oidcNonce: Buffer | null) {
		this.accountId = row.account_id;
		this.authorizationId = row.authorization_id;
		this.callbackUri = row.callback_uri;
		this.capabilityId = row.capability_id;
		this.connectorId = row.connector_id;
		this.issuer = row.issuer;
		this.pluginDigest = row.plugin_digest;
		this.pluginId = row.plugin_id;
		this.profileId = row.profile_id;
		this.purpose = row.purpose;
		this.requestedScopes = Object.freeze([...row.requested_scopes]);
		this.sessionId = row.session_id;
		this.#claim = Buffer.from(claim);
		this.#oidcNonce = oidcNonce ? Buffer.from(oidcNonce) : null;
		this.#pkceVerifier = Buffer.from(pkceVerifier);
	}

	useOidcNonce<T>(use: (nonce: string) => T) {
		if (!this.#oidcNonce || this.#oidcNonce.byteLength === 0) throw authorizationError();
		const nonce = this.#oidcNonce.toString("ascii");
		try {
			return use(nonce);
		} finally {
			this.#oidcNonce.fill(0);
			this.#oidcNonce = null;
		}
	}

	usePkceVerifier<T>(use: (verifier: string) => T) {
		if (this.#pkceVerifier.byteLength === 0) throw authorizationError();
		const verifier = this.#pkceVerifier.toString("ascii");
		try {
			return use(verifier);
		} finally {
			this.#pkceVerifier.fill(0);
			this.#pkceVerifier = Buffer.alloc(0);
		}
	}

	matchesClaimDigest(digest: Buffer) {
		return this.#claim.byteLength > 0
			&& constantTimeBufferEqual(sha256Buffer(this.#claim), digest);
	}

	dispose() {
		this.#claim.fill(0);
		this.#claim = Buffer.alloc(0);
		this.#oidcNonce?.fill(0);
		this.#oidcNonce = null;
		this.#pkceVerifier.fill(0);
		this.#pkceVerifier = Buffer.alloc(0);
	}

	toJSON() {
		return {
			authorizationId: this.authorizationId,
			connectorId: this.connectorId,
			profileId: this.profileId,
			purpose: this.purpose,
		};
	}

	toString() {
		return "[ProviderAuthorizationClaim]";
	}

	[inspect.custom]() {
		return this.toJSON();
	}
}

export class ProviderAccountService {
	constructor(
		private readonly database: Database,
		private readonly config: ProviderRuntimeConfig,
	) {}

	private registration(connectorId: ProviderConnectorId) {
		const connector = this.config.connector(connectorId);
		if (!connector) {
			throw new ProblemError(409, "integration_not_ready", "Integration is not ready");
		}
		return connector.registration;
	}

	async cleanupRetention(now = new Date()) {
		if (!Number.isFinite(now.getTime())) throw authorizationError();
		const consumedBefore = new Date(now.getTime() - AUTHORIZATION_RETENTION_MS);
		return this.database.withTransaction(async (client) => {
			const receiptsDeleted = await deleteExpiredCompletionReceipts(client, now);
			const authorizationsDeleted = await deleteRetainedAuthorizations(client, consumedBefore);
			return { authorizationsDeleted, receiptsDeleted };
		});
	}

	async startAuthorization(
		input: ActiveSession,
		connectorId: ProviderConnectorId,
		purpose: OAuthAuthorizationPurpose,
	): Promise<StartAuthorizationResult> {
		await this.cleanupRetention();
		if (purpose !== "connect" && purpose !== "reconnect") {
			throw new ProblemError(422, "validation_failed", "Validation failed");
		}
		const registration = this.registration(connectorId);
		const authorizationId = randomUUID();
		const stateRaw = randomBytes(32);
		const browserRaw = randomBytes(32);
		const verifierRaw = randomBytes(32);
		const nonceRaw = registration.oidc ? randomBytes(32) : null;
		const secrets = { nonce: null as Buffer | null, verifier: null as Buffer | null };

		try {
			const state = stateRaw.toString("base64url");
			const browserBinding = browserRaw.toString("base64url");
			const verifier = secrets.verifier = Buffer.from(verifierRaw.toString("base64url"), "ascii");
			const oidcNonce = nonceRaw?.toString("base64url");
			const nonce = oidcNonce ? secrets.nonce = Buffer.from(oidcNonce, "ascii") : null;
			const pkceChallenge = sha256Buffer(verifier).toString("base64url");
			const encryptedPkce = encryptProviderToken(verifier, {
				authorizationId,
				connectorId,
				kind: "pkce",
				profileId: input.profile.profileId,
			}, this.config.keyring);
			const encryptedOidcNonce = nonce ? encryptProviderToken(nonce, {
				authorizationId,
				connectorId,
				kind: "oidc-nonce",
				profileId: input.profile.profileId,
			}, this.config.keyring) : null;
			await this.database.withTransaction(async (client) => {
				await lockProviderConnector(client, input.profile.profileId, connectorId);
				const prior = await readOpenAuthorizationForUpdate(client, input.profile.profileId, connectorId);
				const now = new Date();
				const session = await readActiveSessionByIdForUpdate(client, {
					activeAt: now,
					profileId: input.profile.profileId,
					sessionId: input.sessionId,
				});
				if (!session) throw new ProblemError(401, "unauthorized", "Authentication is required");
				if (session.recentAuthAt > now
					|| now.getTime() - session.recentAuthAt.getTime() > RECENT_AUTH_MINUTES * 60 * 1000) {
					throw new ProblemError(403, "recent_authentication_required", "Recent authentication required");
				}

				const account = await readProviderAccountForUpdate(client, session.profile.profileId, connectorId);
				if ((purpose === "connect" && account) || (purpose === "reconnect" && !account)) {
					throw new ProblemError(409, "provider_account_state_conflict", "Provider account state changed");
				}

				if (prior) {
					await consumeAuthorizationRow(client, prior.authorization_id, "superseded");
					await auditAuthorization(client, prior, "provider-authorization.consume", { reason: "superseded" }, "succeeded");
				}

				const createdAt = new Date();
				await insertAuthorization(client, {
					accountId: account?.account_id ?? null,
					authorizationId,
					browserBindingDigest: sha256Buffer(browserRaw),
					callbackUri: registration.callbackUri,
					capabilityId: registration.capabilityId,
					connectorId,
					createdAt,
					expiresAt: addMinutes(createdAt, AUTHORIZATION_MINUTES),
					issuer: registration.issuer,
					oidcNonceDigest: nonceRaw ? sha256Buffer(nonceRaw) : null,
					oidcNonce: encryptedOidcNonce,
					pkce: encryptedPkce,
					pluginDigest: registration.pluginDigest,
					pluginId: registration.pluginId,
					profileId: session.profile.profileId,
					purpose,
					requestedCapabilities: ["identity-only"],
					requestedScopes: registration.capabilityScopes["identity-only"],
					sessionId: session.sessionId,
					stateDigest: sha256Buffer(stateRaw),
				});
				await appendAuditEvent(client, {
					action: "provider-authorization.start",
					actorKind: "profile",
					actorLabel: session.profile.slug,
					correlationId: randomUUID(),
					detailsJson: { capability: "identity-only", connectorId, purpose },
					outcome: "succeeded",
					profileId: session.profile.profileId,
					requestId: null,
					sourceHash: null,
					targetId: authorizationId,
					targetKind: "oauth-authorization",
				});
			});
			return {
				authorizationId,
				authorizationUrl: {
					authorizationEndpoint: registration.authorizationEndpoint,
					callbackUri: registration.callbackUri,
					clientId: registration.clientId,
					...(oidcNonce ? { nonce: oidcNonce } : {}),
					pkceChallenge,
					pkceMethod: "S256",
					scopes: registration.capabilityScopes["identity-only"],
				},
				browserBinding,
				state,
			};
		} finally {
			stateRaw.fill(0);
			browserRaw.fill(0);
			verifierRaw.fill(0);
			secrets.verifier?.fill(0);
			secrets.nonce?.fill(0);
			nonceRaw?.fill(0);
		}
	}

	async consumeAuthorization(input: {
		browserBinding: string;
		connectorId: ProviderConnectorId;
		outcome: AuthorizationFailureOutcome;
		reasonCode?: AuthorizationReasonCode;
		state: string;
	}) {
		const reasonCode = validateReasonCode(input.reasonCode);
		const stateDigest = opaqueDigest(input.state);
		const browserDigest = opaqueDigest(input.browserBinding);
		if (!stateDigest || !browserDigest || !FAILURE_OUTCOMES.has(input.outcome)) {
			throw authorizationError();
		}
		const candidate = await readAuthorizationLockKeyByStateDigest(this.database, stateDigest);
		if (!candidate) throw authorizationError();
		let consumed = false;
		let validBinding = false;
		await this.database.withTransaction(async (client) => {
			await lockProviderConnector(client, candidate.profile_id, candidate.connector_id);
			const row = await readAuthorizationByStateDigestForUpdate(client, stateDigest);
			if (!row || row.consumed_at) return;
			const now = new Date();
			const browserMatches = constantTimeBufferEqual(browserDigest, row.browser_binding_digest);
			const connectorMatches = row.connector_id === input.connectorId;
			const session = connectorMatches && browserMatches ? await activeSession(client, row, now) : null;
			const reason = row.expires_at <= now
				? "expired"
				: (!connectorMatches || !browserMatches || !session ? "invalid" : input.outcome);
			validBinding = row.expires_at > now && connectorMatches && browserMatches && session !== null;
			consumed = await consumeAuthorizationRow(client, row.authorization_id, reason);
			if (consumed) {
				await auditAuthorization(client, row, "provider-authorization.consume", { reason, reasonCode }, "failed");
			}
		});
		if (!consumed || !validBinding) throw authorizationError();
	}

	async claimAuthorization(input: {
		browserBinding: string;
		connectorId: ProviderConnectorId;
		state: string;
	}) {
		const registration = this.registration(input.connectorId);
		const stateDigest = opaqueDigest(input.state);
		const browserDigest = opaqueDigest(input.browserBinding);
		if (!stateDigest || !browserDigest) throw authorizationError();
		const candidate = await readAuthorizationLockKeyByStateDigest(this.database, stateDigest);
		if (!candidate) throw authorizationError();
		const claim = randomBytes(32);
		let claimed: OAuthAuthorizationRow | null = null;
		const decrypted = { nonce: null as Buffer | null, verifier: null as Buffer | null };
		let invalid = false;

		try {
			await this.database.withTransaction(async (client) => {
				await lockProviderConnector(client, candidate.profile_id, candidate.connector_id);
				const row = await readAuthorizationByStateDigestForUpdate(client, stateDigest);
				if (!row || row.consumed_at) {
					invalid = true;
					return;
				}
				const now = new Date();
				const registrationMatches = row.connector_id === input.connectorId
					&& row.issuer === registration.issuer
					&& row.callback_uri === registration.callbackUri
					&& row.plugin_id === registration.pluginId
					&& row.capability_id === registration.capabilityId
					&& row.plugin_digest === registration.pluginDigest
					&& sameStringSet(row.requested_scopes, registration.capabilityScopes["identity-only"]);
				const browserMatches = constantTimeBufferEqual(browserDigest, row.browser_binding_digest);
				const session = registrationMatches && browserMatches ? await activeSession(client, row, now) : null;
				if (row.expires_at <= now || !registrationMatches || !browserMatches || !session) {
					const reason = row.expires_at <= now ? "expired" : "invalid";
					await consumeAuthorizationRow(client, row.authorization_id, reason);
					await auditAuthorization(client, row, "provider-authorization.consume", { reason }, "failed");
					invalid = true;
					return;
				}
				if (row.exchange_claim_digest) {
					if (row.exchange_claim_expires_at && row.exchange_claim_expires_at <= now) {
						await consumeAuthorizationRow(client, row.authorization_id, "failed");
						await auditAuthorization(client, row, "provider-authorization.consume", { reason: "failed" }, "failed");
					}
					invalid = true;
					return;
				}

				const claimedAt = new Date();
				const claimExpiresAt = new Date(Math.min(
					row.expires_at.getTime(),
					addMinutes(claimedAt, 2).getTime(),
				));
				const updated = await claimAuthorizationRow(
					client,
					row.authorization_id,
					sha256Buffer(claim),
					claimedAt,
					claimExpiresAt,
				);
				if (!updated || !updated.pkce_ciphertext || !updated.pkce_nonce || !updated.pkce_tag || !updated.pkce_key_id) {
					invalid = true;
					return;
				}
				const hasOidcNonce = updated.oidc_nonce_digest !== null
					&& updated.oidc_nonce_ciphertext !== null
					&& updated.oidc_nonce_nonce !== null
					&& updated.oidc_nonce_tag !== null
					&& updated.oidc_nonce_key_id !== null;
				if (registration.oidc !== hasOidcNonce) {
					await consumeAuthorizationRow(client, row.authorization_id, "failed");
					await auditAuthorization(client, row, "provider-authorization.consume", { reason: "failed" }, "failed");
					invalid = true;
					return;
				}
				try {
					decrypted.verifier = decryptProviderToken({
						ciphertext: updated.pkce_ciphertext,
						keyId: updated.pkce_key_id,
						nonce: updated.pkce_nonce,
						tag: updated.pkce_tag,
					}, {
						authorizationId: updated.authorization_id,
						connectorId: updated.connector_id,
						kind: "pkce",
						profileId: updated.profile_id,
					}, this.config.keyring);
					if (hasOidcNonce) {
						decrypted.nonce = decryptProviderToken({
							ciphertext: updated.oidc_nonce_ciphertext!,
							keyId: updated.oidc_nonce_key_id!,
							nonce: updated.oidc_nonce_nonce!,
							tag: updated.oidc_nonce_tag!,
						}, {
							authorizationId: updated.authorization_id,
							connectorId: updated.connector_id,
							kind: "oidc-nonce",
							profileId: updated.profile_id,
						}, this.config.keyring);
						const encodedNonce = decrypted.nonce.toString("ascii");
						const nonceBytes = Buffer.from(encodedNonce, "base64url");
						try {
							if (nonceBytes.byteLength !== 32
								|| nonceBytes.toString("base64url") !== encodedNonce
								|| !constantTimeBufferEqual(sha256Buffer(nonceBytes), updated.oidc_nonce_digest!)) {
								throw authorizationError();
							}
						} finally {
							nonceBytes.fill(0);
						}
					}
					claimed = updated;
					await auditAuthorization(client, row, "provider-authorization.claim", {}, "succeeded");
				} catch {
					await consumeAuthorizationRow(client, row.authorization_id, "failed");
					await auditAuthorization(client, row, "provider-authorization.consume", { reason: "failed" }, "failed");
					invalid = true;
				}
			});
			if (invalid || !claimed || !decrypted.verifier) throw authorizationError();
			return new ProviderAuthorizationClaim(claimed, claim, decrypted.verifier, decrypted.nonce);
		} finally {
			claim.fill(0);
			decrypted.nonce?.fill(0);
			decrypted.verifier?.fill(0);
		}
	}

	async finalizeAuthorization(
		claim: ProviderAuthorizationClaim,
		result: AuthorizationSuccessResult | { outcome: AuthorizationFailureOutcome; reasonCode?: AuthorizationReasonCode },
	) {
		let view: ProviderAccountView | null = null;
		let finalized = false;
		let authorizationRejected = false;
		try {
			if (typeof result !== "object"
				|| result === null
				|| (result.outcome !== "completed" && !FAILURE_OUTCOMES.has(result.outcome))) {
				throw authorizationError();
			}
			const reasonCode = result.outcome === "completed" ? null : validateReasonCode(result.reasonCode);
			await this.database.withTransaction(async (client) => {
				await lockProviderConnector(client, claim.profileId, claim.connectorId);
				const row = await readAuthorizationByIdForUpdate(client, claim.authorizationId);
				const now = new Date();
				const claimMatches = row?.exchange_claim_digest
					? claim.matchesClaimDigest(row.exchange_claim_digest)
					: false;
				if (!row
					|| row.consumed_at
					|| !claimMatches
					|| row.authorization_id !== claim.authorizationId
					|| row.profile_id !== claim.profileId
					|| row.session_id !== claim.sessionId
					|| row.connector_id !== claim.connectorId) {
					return;
				}
				if (!row.exchange_claim_expires_at || row.exchange_claim_expires_at <= now) {
					await consumeAuthorizationRow(client, row.authorization_id, "failed");
					await auditAuthorization(client, row, "provider-authorization.consume", { reason: "failed" }, "failed");
					authorizationRejected = true;
					return;
				}

				const session = await activeSession(client, row, now);
				if (!session) {
					await consumeAuthorizationRow(client, row.authorization_id, "invalid");
					await auditAuthorization(client, row, "provider-authorization.consume", { reason: "invalid" }, "failed");
					authorizationRejected = true;
					return;
				}

				if (result.outcome !== "completed") {
					await consumeAuthorizationRow(client, row.authorization_id, result.outcome);
					await auditAuthorization(client, row, "provider-authorization.consume", { reason: result.outcome, reasonCode }, "failed");
					finalized = true;
					return;
				}

				let maskedAccount: string | null = null;
				let accountLabelValid = true;
				try {
					maskedAccount = maskAccountLabel(result.accountLabel);
				} catch {
					accountLabelValid = false;
				}
				if (typeof result.issuer !== "string"
					|| result.issuer !== row.issuer
					|| typeof result.subject !== "string"
					|| !result.subject
					|| result.subject.includes("\0")
					|| Buffer.byteLength(result.subject, "utf8") > 2048
					|| !(result.accessExpiresAt instanceof Date)
					|| !Number.isFinite(result.accessExpiresAt.getTime())
					|| result.accessExpiresAt <= now
					|| !sameStringSet(result.grantedScopes, row.requested_scopes)
					|| !validSecret(result.accessToken)
					|| !validSecret(result.refreshToken)
					|| !accountLabelValid) {
					await consumeAuthorizationRow(client, row.authorization_id, "failed");
					await auditAuthorization(client, row, "provider-authorization.consume", { reason: "failed" }, "failed");
					finalized = true;
					return;
				}

				const existing = await readProviderAccountForUpdate(client, row.profile_id, row.connector_id);
				if ((row.purpose === "connect" && existing)
					|| (row.purpose === "reconnect" && (!existing || existing.account_id !== row.account_id))) {
					await consumeAuthorizationRow(client, row.authorization_id, "failed");
					await auditAuthorization(client, row, "provider-authorization.consume", { reason: "failed" }, "failed");
					finalized = true;
					return;
				}

				const subjectHash = providerSubjectHmac(result.issuer, result.subject, this.config.subjectHashKey);
				await lockProviderSubject(client, row.connector_id, subjectHash);
				const duplicate = await readProviderAccountBySubject(client, row.connector_id, subjectHash);
				if (duplicate && duplicate.profile_id !== row.profile_id) {
					await consumeAuthorizationRow(client, row.authorization_id, "failed");
					await auditAuthorization(client, row, "provider-authorization.consume", { reason: "failed" }, "failed");
					finalized = true;
					return;
				}

				const accountId = existing?.account_id ?? randomUUID();
				const revision = existing ? existing.grant_revision + 1 : 1;
				const accessToken = encryptProviderToken(result.accessToken, {
					accountId,
					connectorId: row.connector_id,
					kind: "access",
					profileId: row.profile_id,
					revision,
				}, this.config.keyring);
				let refreshToken: ProviderEncryptedValue | null = null;
				if (result.refreshToken !== undefined && result.refreshToken !== null) {
					refreshToken = encryptProviderToken(result.refreshToken, {
						accountId,
						connectorId: row.connector_id,
						kind: "refresh",
						profileId: row.profile_id,
						revision,
					}, this.config.keyring);
				}
				const saved = existing
					? await replaceProviderAccount(client, {
						accessExpiresAt: result.accessExpiresAt,
						accessToken,
						accountId,
						expectedRevision: existing.grant_revision,
						grantedScopes: result.grantedScopes,
						issuer: result.issuer,
						maskedAccount,
						refreshToken,
						subjectHash,
					})
					: await insertProviderAccount(client, {
						accessExpiresAt: result.accessExpiresAt,
						accessToken,
						accountId,
						capabilities: ["identity-only"],
						connectorId: row.connector_id,
						grantedScopes: result.grantedScopes,
						issuer: result.issuer,
						maskedAccount,
						profileId: row.profile_id,
						refreshToken,
						subjectHash,
					});
				if (!saved) throw accountError();
				await consumeAuthorizationRow(client, row.authorization_id, "completed");
				await auditAuthorization(client, row, "provider-authorization.consume", { reason: "completed" }, "succeeded");
				await appendAuditEvent(client, {
					action: existing ? "provider-account.reconnect" : "provider-account.connect",
					actorKind: "system",
					actorLabel: "provider-accounts",
					correlationId: randomUUID(),
					detailsJson: { capability: "identity-only", connectorId: row.connector_id, revision },
					outcome: "succeeded",
					profileId: row.profile_id,
					requestId: null,
					sourceHash: null,
					targetId: saved.account_id,
					targetKind: "provider-account",
				});
				view = accountView(saved);
				finalized = true;
			});
		} finally {
			claim.dispose();
		}
		if (authorizationRejected || !finalized) throw authorizationError();
		if (result.outcome === "completed" && !view) throw accountError();
		return view;
	}

	async issueCompletionReceipt(input: {
		authorizationId: string | null;
		connectorId: ProviderConnectorId | null;
		outcome: OAuthCompletionOutcome;
		profileId: string | null;
	}) {
		await this.cleanupRetention();
		if (!COMPLETION_OUTCOMES.has(input.outcome)) throw authorizationError();
		const receipt = randomBase64Url(32);
		const digest = opaqueDigest(receipt)!;
		const receiptId = randomUUID();
		await this.database.withTransaction(async (client) => {
			const createdAt = new Date();
			await insertCompletionReceipt(client, {
				authorizationId: input.authorizationId,
				connectorId: input.connectorId,
				createdAt,
				expiresAt: new Date(createdAt.getTime() + RECEIPT_SECONDS * 1000),
				outcome: input.outcome,
				profileId: input.profileId,
				receiptDigest: digest,
				receiptId,
			});
			await appendAuditEvent(client, {
				action: "oauth-completion.issue",
				actorKind: "system",
				actorLabel: "provider-accounts",
				correlationId: randomUUID(),
				detailsJson: { connectorId: input.connectorId, outcome: input.outcome },
				outcome: "succeeded",
				profileId: input.profileId,
				requestId: null,
				sourceHash: null,
				targetId: receiptId,
				targetKind: "oauth-completion",
			});
		});
		return receipt;
	}

	async consumeCompletionReceipt(receipt: string): Promise<
		| { outcome: OAuthCompletionOutcome; valid: true }
		| { outcome: "invalid"; valid: false }
	> {
		const digest = opaqueDigest(receipt);
		if (!digest) return { outcome: "invalid" as const, valid: false as const };
		let outcome: OAuthCompletionOutcome | null = null;
		await this.database.withTransaction(async (client) => {
			const row = await readCompletionReceiptForUpdate(client, digest);
			if (!row || row.consumed_at || row.expires_at <= new Date()) {
				if (row && !row.consumed_at) await consumeCompletionReceiptRow(client, row.receipt_id);
				return;
			}
			if (!(await consumeCompletionReceiptRow(client, row.receipt_id))) return;
			outcome = row.outcome;
			await appendAuditEvent(client, {
				action: "oauth-completion.consume",
				actorKind: "system",
				actorLabel: "provider-accounts",
				correlationId: randomUUID(),
				detailsJson: { connectorId: row.connector_id, outcome: row.outcome },
				outcome: "succeeded",
				profileId: row.profile_id,
				requestId: null,
				sourceHash: null,
				targetId: row.receipt_id,
				targetKind: "oauth-completion",
			});
		});
		return outcome
			? { outcome, valid: true as const }
			: { outcome: "invalid" as const, valid: false as const };
	}

	async listAccountRows(profileId: string): Promise<ProviderAccountListView[]> {
		const rows = await listProviderAccountRows(this.database, profileId);
		return rows.map((row) => ({
			accountId: row.account_id,
			authorizationPending: row.authorization_pending,
			capabilities: row.capabilities ? ["identity-only"] as const : [] as const,
			connectedAt: row.connected_at?.toISOString() ?? null,
			connectorId: row.connector_id,
			grantedScopes: row.granted_scopes ?? [],
			lastValidatedAt: row.last_validated_at?.toISOString() ?? null,
			maskedAccount: row.masked_account,
			revision: row.grant_revision ?? 0,
			state: row.state ?? "connecting",
		}));
	}
}