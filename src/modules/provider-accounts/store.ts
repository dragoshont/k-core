import type { PoolClient, QueryResultRow } from "pg";
import type { SqlExecutor } from "../db/database";
import type {
	ProviderCapability,
	ProviderConnectorId,
	ProviderEncryptedValue,
} from "./types";

export type OAuthAuthorizationPurpose = "connect" | "reconnect";
export type OAuthAuthorizationConsumedReason =
	| "completed"
	| "denied"
	| "expired"
	| "failed"
	| "invalid"
	| "superseded";
export type OAuthCompletionOutcome = "connected" | "denied" | "expired" | "invalid";
export type ProviderAccountState = "connected" | "error" | "expired-or-revoked";

export interface OAuthAuthorizationRow extends QueryResultRow {
	account_id: string | null;
	authorization_id: string;
	browser_binding_digest: Buffer;
	callback_uri: string;
	capability_id: string;
	connector_id: ProviderConnectorId;
	consumed_at: Date | null;
	consumed_reason: OAuthAuthorizationConsumedReason | null;
	created_at: Date;
	exchange_claim_digest: Buffer | null;
	exchange_claim_expires_at: Date | null;
	exchange_claimed_at: Date | null;
	expires_at: Date;
	issuer: string;
	oidc_nonce_ciphertext: Buffer | null;
	oidc_nonce_digest: Buffer | null;
	oidc_nonce_key_id: string | null;
	oidc_nonce_nonce: Buffer | null;
	oidc_nonce_tag: Buffer | null;
	pkce_ciphertext: Buffer | null;
	pkce_key_id: string | null;
	pkce_nonce: Buffer | null;
	pkce_tag: Buffer | null;
	plugin_digest: string;
	plugin_id: string;
	profile_id: string;
	purpose: OAuthAuthorizationPurpose;
	requested_capabilities: ProviderCapability[];
	requested_scopes: string[];
	session_id: string;
	state_digest: Buffer;
}

export interface ProviderAccountRow extends QueryResultRow {
	access_ciphertext: Buffer;
	access_expires_at: Date;
	access_key_id: string;
	access_nonce: Buffer;
	access_tag: Buffer;
	account_id: string;
	block_new_use_at: Date | null;
	capabilities: ProviderCapability[];
	connected_at: Date;
	connector_id: ProviderConnectorId;
	created_at: Date;
	grant_revision: number;
	granted_scopes: string[];
	issuer: string;
	last_validated_at: Date;
	masked_account: string | null;
	profile_id: string;
	refresh_ciphertext: Buffer | null;
	refresh_key_id: string | null;
	refresh_nonce: Buffer | null;
	refresh_tag: Buffer | null;
	state: ProviderAccountState;
	subject_hash: Buffer;
	updated_at: Date;
}

export interface OAuthCompletionReceiptRow extends QueryResultRow {
	authorization_id: string | null;
	connector_id: ProviderConnectorId | null;
	consumed_at: Date | null;
	created_at: Date;
	expires_at: Date;
	outcome: OAuthCompletionOutcome;
	profile_id: string | null;
	receipt_digest: Buffer;
	receipt_id: string;
}

export interface ProviderAccountListRow extends QueryResultRow {
	account_id: string | null;
	authorization_pending: boolean;
	capabilities: ProviderCapability[] | null;
	connected_at: Date | null;
	connector_id: ProviderConnectorId;
	grant_revision: number | null;
	granted_scopes: string[] | null;
	last_validated_at: Date | null;
	masked_account: string | null;
	state: ProviderAccountState | null;
}

const AUTHORIZATION_COLUMNS = `
	authorization_id, profile_id, session_id, account_id, connector_id, purpose,
	issuer, callback_uri, plugin_id, capability_id, plugin_digest,
	requested_capabilities, requested_scopes, state_digest, browser_binding_digest,
	pkce_ciphertext, pkce_nonce, pkce_tag, pkce_key_id, oidc_nonce_digest,
	oidc_nonce_ciphertext, oidc_nonce_nonce, oidc_nonce_tag, oidc_nonce_key_id,
	exchange_claim_digest, exchange_claimed_at, exchange_claim_expires_at,
	consumed_reason, created_at, expires_at, consumed_at
`;

const ACCOUNT_COLUMNS = `
	account_id, profile_id, connector_id, issuer, subject_hash, masked_account,
	granted_scopes, capabilities, state, grant_revision, access_ciphertext,
	access_nonce, access_tag, access_key_id, access_expires_at, refresh_ciphertext,
	refresh_nonce, refresh_tag, refresh_key_id, block_new_use_at, connected_at,
	last_validated_at, created_at, updated_at
`;

export async function lockProviderConnector(
	client: PoolClient,
	profileId: string,
	connectorId: ProviderConnectorId,
) {
	await client.query(
		"select pg_advisory_xact_lock(hashtextextended($1, 0))",
		[`k:provider-connector:${profileId}:${connectorId}`],
	);
}

export async function lockProviderSubject(
	client: PoolClient,
	connectorId: ProviderConnectorId,
	subjectHash: Buffer,
) {
	await client.query(
		"select pg_advisory_xact_lock(hashtextextended($1, 0))",
		[`k:provider-subject:${connectorId}:${subjectHash.toString("hex")}`],
	);
}

export async function readAuthorizationLockKeyByStateDigest(
	executor: SqlExecutor,
	stateDigest: Buffer,
) {
	const result = await executor.query<{
		connector_id: ProviderConnectorId;
		profile_id: string;
	}>(`
		select profile_id, connector_id
		from oauth_authorizations
		where state_digest = $1
	`, [stateDigest]);
	return result.rows[0] ?? null;
}

export async function readAuthorizationByStateDigestForUpdate(
	client: PoolClient,
	stateDigest: Buffer,
) {
	const result = await client.query<OAuthAuthorizationRow>(`
		select ${AUTHORIZATION_COLUMNS}
		from oauth_authorizations
		where state_digest = $1
		for update
	`, [stateDigest]);
	return result.rows[0] ?? null;
}

export async function readAuthorizationByIdForUpdate(
	client: PoolClient,
	authorizationId: string,
) {
	const result = await client.query<OAuthAuthorizationRow>(`
		select ${AUTHORIZATION_COLUMNS}
		from oauth_authorizations
		where authorization_id = $1
		for update
	`, [authorizationId]);
	return result.rows[0] ?? null;
}

export async function readOpenAuthorizationForUpdate(
	client: PoolClient,
	profileId: string,
	connectorId: ProviderConnectorId,
) {
	const result = await client.query<OAuthAuthorizationRow>(`
		select ${AUTHORIZATION_COLUMNS}
		from oauth_authorizations
		where profile_id = $1 and connector_id = $2 and consumed_at is null
		for update
	`, [profileId, connectorId]);
	return result.rows[0] ?? null;
}

export async function insertAuthorization(
	client: PoolClient,
	input: {
		accountId: string | null;
		authorizationId: string;
		browserBindingDigest: Buffer;
		callbackUri: string;
		capabilityId: string;
		connectorId: ProviderConnectorId;
		createdAt: Date;
		expiresAt: Date;
		issuer: string;
		oidcNonceDigest: Buffer | null;
		oidcNonce: ProviderEncryptedValue | null;
		pkce: ProviderEncryptedValue;
		pluginDigest: string;
		pluginId: string;
		profileId: string;
		purpose: OAuthAuthorizationPurpose;
		requestedCapabilities: ProviderCapability[];
		requestedScopes: readonly string[];
		sessionId: string;
		stateDigest: Buffer;
	},
) {
	await client.query(`
		insert into oauth_authorizations (
			authorization_id, profile_id, session_id, account_id, connector_id,
			purpose, issuer, callback_uri, plugin_id, capability_id, plugin_digest,
			requested_capabilities, requested_scopes, state_digest,
			browser_binding_digest, pkce_ciphertext, pkce_nonce, pkce_tag,
			pkce_key_id, oidc_nonce_digest, oidc_nonce_ciphertext,
			oidc_nonce_nonce, oidc_nonce_tag, oidc_nonce_key_id, created_at, expires_at
		) values (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
			$12::jsonb, $13::jsonb, $14, $15, $16, $17, $18, $19, $20,
			$21, $22, $23, $24, $25, $26
		)
	`, [
		input.authorizationId,
		input.profileId,
		input.sessionId,
		input.accountId,
		input.connectorId,
		input.purpose,
		input.issuer,
		input.callbackUri,
		input.pluginId,
		input.capabilityId,
		input.pluginDigest,
		JSON.stringify(input.requestedCapabilities),
		JSON.stringify(input.requestedScopes),
		input.stateDigest,
		input.browserBindingDigest,
		input.pkce.ciphertext,
		input.pkce.nonce,
		input.pkce.tag,
		input.pkce.keyId,
		input.oidcNonceDigest,
		input.oidcNonce?.ciphertext ?? null,
		input.oidcNonce?.nonce ?? null,
		input.oidcNonce?.tag ?? null,
		input.oidcNonce?.keyId ?? null,
		input.createdAt,
		input.expiresAt,
	]);
}

export async function consumeAuthorizationRow(
	client: PoolClient,
	authorizationId: string,
	reason: OAuthAuthorizationConsumedReason,
) {
	const result = await client.query(`
		update oauth_authorizations
		set consumed_at = now(),
			consumed_reason = $2,
			pkce_ciphertext = null,
			pkce_nonce = null,
			pkce_tag = null,
			pkce_key_id = null,
			oidc_nonce_digest = null,
			oidc_nonce_ciphertext = null,
			oidc_nonce_nonce = null,
			oidc_nonce_tag = null,
			oidc_nonce_key_id = null,
			exchange_claim_digest = null,
			exchange_claimed_at = null,
			exchange_claim_expires_at = null
		where authorization_id = $1 and consumed_at is null
	`, [authorizationId, reason]);
	return result.rowCount === 1;
}

export async function claimAuthorizationRow(
	client: PoolClient,
	authorizationId: string,
	claimDigest: Buffer,
	claimedAt: Date,
	claimExpiresAt: Date,
) {
	const result = await client.query<OAuthAuthorizationRow>(`
		update oauth_authorizations
		set exchange_claim_digest = $2,
			exchange_claimed_at = $3,
			exchange_claim_expires_at = $4
		where authorization_id = $1
			and consumed_at is null
			and expires_at > $3
			and exchange_claim_digest is null
		returning ${AUTHORIZATION_COLUMNS}
	`, [authorizationId, claimDigest, claimedAt, claimExpiresAt]);
	return result.rows[0] ?? null;
}

export async function readProviderAccountForUpdate(
	client: PoolClient,
	profileId: string,
	connectorId: ProviderConnectorId,
) {
	const result = await client.query<ProviderAccountRow>(`
		select ${ACCOUNT_COLUMNS}
		from provider_accounts
		where profile_id = $1 and connector_id = $2
		for update
	`, [profileId, connectorId]);
	return result.rows[0] ?? null;
}

export async function readProviderAccountBySubject(
	executor: SqlExecutor,
	connectorId: ProviderConnectorId,
	subjectHash: Buffer,
) {
	const result = await executor.query<{ account_id: string; profile_id: string }>(`
		select account_id, profile_id
		from provider_accounts
		where connector_id = $1 and subject_hash = $2
	`, [connectorId, subjectHash]);
	return result.rows[0] ?? null;
}

export async function insertProviderAccount(
	client: PoolClient,
	input: {
		accessExpiresAt: Date;
		accessToken: ProviderEncryptedValue;
		accountId: string;
		capabilities: ProviderCapability[];
		connectorId: ProviderConnectorId;
		grantedScopes: readonly string[];
		issuer: string;
		maskedAccount: string | null;
		profileId: string;
		refreshToken: ProviderEncryptedValue | null;
		subjectHash: Buffer;
	},
) {
	const result = await client.query<ProviderAccountRow>(`
		insert into provider_accounts (
			account_id, profile_id, connector_id, issuer, subject_hash,
			masked_account, granted_scopes, capabilities, state, grant_revision,
			access_ciphertext, access_nonce, access_tag, access_key_id,
			access_expires_at, refresh_ciphertext, refresh_nonce, refresh_tag,
			refresh_key_id
		) values (
			$1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 'connected', 1,
			$9, $10, $11, $12, $13, $14, $15, $16, $17
		)
		returning ${ACCOUNT_COLUMNS}
	`, [
		input.accountId,
		input.profileId,
		input.connectorId,
		input.issuer,
		input.subjectHash,
		input.maskedAccount,
		JSON.stringify(input.grantedScopes),
		JSON.stringify(input.capabilities),
		input.accessToken.ciphertext,
		input.accessToken.nonce,
		input.accessToken.tag,
		input.accessToken.keyId,
		input.accessExpiresAt,
		input.refreshToken?.ciphertext ?? null,
		input.refreshToken?.nonce ?? null,
		input.refreshToken?.tag ?? null,
		input.refreshToken?.keyId ?? null,
	]);
	return result.rows[0]!;
}

export async function replaceProviderAccount(
	client: PoolClient,
	input: {
		accessExpiresAt: Date;
		accessToken: ProviderEncryptedValue;
		accountId: string;
		expectedRevision: number;
		grantedScopes: readonly string[];
		issuer: string;
		maskedAccount: string | null;
		refreshToken: ProviderEncryptedValue | null;
		subjectHash: Buffer;
	},
) {
	const result = await client.query<ProviderAccountRow>(`
		update provider_accounts
		set issuer = $3,
			subject_hash = $4,
			masked_account = $5,
			granted_scopes = $6::jsonb,
			capabilities = '["identity-only"]'::jsonb,
			state = 'connected',
			grant_revision = grant_revision + 1,
			access_ciphertext = $7,
			access_nonce = $8,
			access_tag = $9,
			access_key_id = $10,
			access_expires_at = $11,
			refresh_ciphertext = $12,
			refresh_nonce = $13,
			refresh_tag = $14,
			refresh_key_id = $15,
			block_new_use_at = null,
			last_validated_at = now(),
			updated_at = now()
		where account_id = $1 and grant_revision = $2
		returning ${ACCOUNT_COLUMNS}
	`, [
		input.accountId,
		input.expectedRevision,
		input.issuer,
		input.subjectHash,
		input.maskedAccount,
		JSON.stringify(input.grantedScopes),
		input.accessToken.ciphertext,
		input.accessToken.nonce,
		input.accessToken.tag,
		input.accessToken.keyId,
		input.accessExpiresAt,
		input.refreshToken?.ciphertext ?? null,
		input.refreshToken?.nonce ?? null,
		input.refreshToken?.tag ?? null,
		input.refreshToken?.keyId ?? null,
	]);
	return result.rows[0] ?? null;
}

export async function listProviderAccountRows(
	executor: SqlExecutor,
	profileId: string,
) {
	const result = await executor.query<ProviderAccountListRow>(`
		select
			coalesce(pa.connector_id, oa.connector_id) as connector_id,
			pa.account_id,
			pa.masked_account,
			pa.granted_scopes,
			pa.capabilities,
			pa.state,
			pa.grant_revision,
			pa.connected_at,
			pa.last_validated_at,
			(oa.authorization_id is not null) as authorization_pending
		from provider_accounts pa
		full outer join (
			select authorization_id, profile_id, connector_id
			from oauth_authorizations
			where consumed_at is null and expires_at > now()
		) oa
			on oa.profile_id = pa.profile_id
			and oa.connector_id = pa.connector_id
		where coalesce(pa.profile_id, oa.profile_id) = $1
		order by connector_id
	`, [profileId]);
	return result.rows;
}

export async function insertCompletionReceipt(
	client: PoolClient,
	input: {
		authorizationId: string | null;
		connectorId: ProviderConnectorId | null;
		createdAt: Date;
		expiresAt: Date;
		outcome: OAuthCompletionOutcome;
		profileId: string | null;
		receiptDigest: Buffer;
		receiptId: string;
	},
) {
	await client.query(`
		insert into oauth_completion_receipts (
			receipt_id, receipt_digest, authorization_id, profile_id,
			connector_id, outcome, created_at, expires_at
		) values ($1, $2, $3, $4, $5, $6, $7, $8)
	`, [
		input.receiptId,
		input.receiptDigest,
		input.authorizationId,
		input.profileId,
		input.connectorId,
		input.outcome,
		input.createdAt,
		input.expiresAt,
	]);
}

export async function readCompletionReceiptForUpdate(
	client: PoolClient,
	receiptDigest: Buffer,
) {
	const result = await client.query<OAuthCompletionReceiptRow>(`
		select
			receipt_id, receipt_digest, authorization_id, profile_id, connector_id,
			outcome, created_at, expires_at, consumed_at
		from oauth_completion_receipts
		where receipt_digest = $1
		for update
	`, [receiptDigest]);
	return result.rows[0] ?? null;
}

export async function consumeCompletionReceiptRow(
	client: PoolClient,
	receiptId: string,
) {
	const result = await client.query(`
		update oauth_completion_receipts
		set consumed_at = now()
		where receipt_id = $1 and consumed_at is null
	`, [receiptId]);
	return result.rowCount === 1;
}

export async function deleteExpiredCompletionReceipts(
	client: PoolClient,
	expiredAt: Date,
) {
	const result = await client.query(`
		delete from oauth_completion_receipts
		where expires_at <= $1
	`, [expiredAt]);
	return result.rowCount ?? 0;
}

export async function deleteRetainedAuthorizations(
	client: PoolClient,
	consumedBefore: Date,
) {
	const result = await client.query(`
		delete from oauth_authorizations
		where consumed_at is not null and consumed_at <= $1
	`, [consumedBefore]);
	return result.rowCount ?? 0;
}