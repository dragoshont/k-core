-- up
alter table audit_events drop constraint audit_events_target_kind_check;
alter table audit_events add constraint audit_events_target_kind_check check (
	target_kind in (
		'profile', 'session', 'credential-code', 'provider-cache', 'throttle',
		'plugin', 'preflight', 'operation', 'artifact', 'delivery-attempt',
		'provider-account', 'oauth-authorization', 'oauth-completion', 'metadata-contribution'
	)
);

alter table plugin_cache drop constraint plugin_cache_resource_kind_check;
alter table plugin_cache add constraint plugin_cache_resource_kind_check check (
	resource_kind in ('search', 'detail', 'metadata')
);

create table provider_accounts (
	account_id uuid primary key,
	profile_id uuid not null references profiles (profile_id) on delete restrict,
	connector_id text not null check (connector_id in ('google-gmail', 'login-with-amazon')),
	issuer text not null check (char_length(issuer) between 9 and 512 and issuer like 'https://%'),
	subject_hash bytea not null check (octet_length(subject_hash) = 32),
	masked_account text null check (masked_account is null or char_length(masked_account) <= 254),
	granted_scopes jsonb not null check (
		jsonb_typeof(granted_scopes) = 'array'
		and jsonb_array_length(granted_scopes) between 1 and 8
	),
	capabilities jsonb not null check (capabilities = '["identity-only"]'::jsonb),
	state text not null check (state in ('connected', 'expired-or-revoked', 'error')),
	grant_revision integer not null default 1 check (grant_revision >= 1),
	access_ciphertext bytea not null check (octet_length(access_ciphertext) > 0),
	access_nonce bytea not null check (octet_length(access_nonce) = 12),
	access_tag bytea not null check (octet_length(access_tag) = 16),
	access_key_id text not null check (access_key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
	access_expires_at timestamptz not null,
	refresh_ciphertext bytea null,
	refresh_nonce bytea null,
	refresh_tag bytea null,
	refresh_key_id text null check (refresh_key_id is null or refresh_key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
	block_new_use_at timestamptz null,
	connected_at timestamptz not null default now(),
	last_validated_at timestamptz not null default now(),
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	unique (profile_id, connector_id),
	unique (connector_id, subject_hash),
	check (
		(refresh_ciphertext is null and refresh_nonce is null and refresh_tag is null and refresh_key_id is null)
		or (refresh_ciphertext is not null and octet_length(refresh_ciphertext) > 0
			and refresh_nonce is not null and octet_length(refresh_nonce) = 12
			and refresh_tag is not null and octet_length(refresh_tag) = 16
			and refresh_key_id is not null)
	),
	check (access_expires_at > connected_at)
);

create table oauth_authorizations (
	authorization_id uuid primary key,
	profile_id uuid not null references profiles (profile_id) on delete restrict,
	session_id uuid not null references sessions (session_id) on delete restrict,
	account_id uuid null references provider_accounts (account_id) on delete restrict,
	connector_id text not null check (connector_id in ('google-gmail', 'login-with-amazon')),
	purpose text not null check (purpose in ('connect', 'reconnect')),
	issuer text not null check (char_length(issuer) between 9 and 512 and issuer like 'https://%'),
	callback_uri text not null check (char_length(callback_uri) between 9 and 1024 and callback_uri like 'https://%'),
	plugin_id text not null check (plugin_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
	capability_id text not null check (capability_id ~ '^[a-z0-9][a-z0-9-]{0,63}/[a-z0-9][a-z0-9-]{0,63}$'),
	plugin_digest text not null check (plugin_digest ~ '^[a-f0-9]{64}$'),
	requested_capabilities jsonb not null check (requested_capabilities = '["identity-only"]'::jsonb),
	requested_scopes jsonb not null check (
		jsonb_typeof(requested_scopes) = 'array'
		and jsonb_array_length(requested_scopes) between 1 and 8
	),
	state_digest bytea not null unique check (octet_length(state_digest) = 32),
	browser_binding_digest bytea not null check (octet_length(browser_binding_digest) = 32),
	pkce_ciphertext bytea null,
	pkce_nonce bytea null,
	pkce_tag bytea null,
	pkce_key_id text null check (pkce_key_id is null or pkce_key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
	oidc_nonce_digest bytea null check (oidc_nonce_digest is null or octet_length(oidc_nonce_digest) = 32),
	oidc_nonce_ciphertext bytea null,
	oidc_nonce_nonce bytea null,
	oidc_nonce_tag bytea null,
	oidc_nonce_key_id text null check (oidc_nonce_key_id is null or oidc_nonce_key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
	exchange_claim_digest bytea null check (exchange_claim_digest is null or octet_length(exchange_claim_digest) = 32),
	exchange_claimed_at timestamptz null,
	exchange_claim_expires_at timestamptz null,
	consumed_reason text null check (consumed_reason in ('completed', 'denied', 'invalid', 'expired', 'superseded', 'failed')),
	created_at timestamptz not null default now(),
	expires_at timestamptz not null,
	consumed_at timestamptz null,
	check (expires_at > created_at and expires_at <= created_at + interval '10 minutes'),
	check (
		(exchange_claim_digest is null and exchange_claimed_at is null and exchange_claim_expires_at is null)
		or (consumed_at is null and exchange_claim_digest is not null
			and exchange_claimed_at is not null and exchange_claimed_at >= created_at
			and exchange_claim_expires_at is not null and exchange_claim_expires_at > exchange_claimed_at
			and exchange_claim_expires_at <= exchange_claimed_at + interval '2 minutes'
			and exchange_claim_expires_at <= expires_at)
	),
	check (
		(purpose = 'connect' and account_id is null)
		or (purpose = 'reconnect' and account_id is not null)
	),
	check (
		(oidc_nonce_digest is null and oidc_nonce_ciphertext is null
			and oidc_nonce_nonce is null and oidc_nonce_tag is null
			and oidc_nonce_key_id is null)
		or (oidc_nonce_digest is not null and oidc_nonce_ciphertext is not null
			and octet_length(oidc_nonce_ciphertext) > 0
			and oidc_nonce_nonce is not null and octet_length(oidc_nonce_nonce) = 12
			and oidc_nonce_tag is not null and octet_length(oidc_nonce_tag) = 16
			and oidc_nonce_key_id is not null)
	),
	check (
		consumed_at is not null
		or (connector_id = 'google-gmail' and oidc_nonce_ciphertext is not null)
		or (connector_id = 'login-with-amazon' and oidc_nonce_ciphertext is null)
	),
	check (
		(consumed_at is null and consumed_reason is null
			and pkce_ciphertext is not null and octet_length(pkce_ciphertext) > 0
			and pkce_nonce is not null and octet_length(pkce_nonce) = 12
			and pkce_tag is not null and octet_length(pkce_tag) = 16
			and pkce_key_id is not null)
		or (consumed_at is not null and consumed_reason is not null
			and pkce_ciphertext is null and pkce_nonce is null
			and pkce_tag is null and pkce_key_id is null
			and oidc_nonce_digest is null and oidc_nonce_ciphertext is null
			and oidc_nonce_nonce is null and oidc_nonce_tag is null
			and oidc_nonce_key_id is null)
	)
);

create unique index oauth_authorizations_one_open_per_connector
	on oauth_authorizations (profile_id, connector_id)
	where consumed_at is null;
create index oauth_authorizations_state_lookup
	on oauth_authorizations (state_digest);
create index oauth_authorizations_retention
	on oauth_authorizations (consumed_at)
	where consumed_at is not null;

create table oauth_completion_receipts (
	receipt_id uuid primary key,
	receipt_digest bytea not null unique check (octet_length(receipt_digest) = 32),
	authorization_id uuid null references oauth_authorizations (authorization_id) on delete restrict,
	profile_id uuid null references profiles (profile_id) on delete restrict,
	connector_id text null check (connector_id is null or connector_id in ('google-gmail', 'login-with-amazon')),
	outcome text not null check (outcome in ('connected', 'denied', 'expired', 'invalid')),
	created_at timestamptz not null default now(),
	expires_at timestamptz not null,
	consumed_at timestamptz null,
	check (expires_at > created_at and expires_at <= created_at + interval '60 seconds')
);

create index oauth_completion_receipts_expiry
	on oauth_completion_receipts (expires_at)
	where consumed_at is null;

-- down
do $$
begin
	if exists (select 1 from provider_accounts limit 1)
		or exists (select 1 from oauth_authorizations limit 1)
		or exists (select 1 from oauth_completion_receipts limit 1)
		or exists (select 1 from plugin_cache where resource_kind = 'metadata' limit 1) then
		raise exception 'cannot roll back provider accounts after durable writes exist'
			using errcode = '55000';
	end if;
end
$$;

drop table if exists oauth_completion_receipts;
drop table if exists oauth_authorizations;
drop table if exists provider_accounts;

alter table plugin_cache drop constraint plugin_cache_resource_kind_check;
alter table plugin_cache add constraint plugin_cache_resource_kind_check check (
	resource_kind in ('search', 'detail')
);

alter table audit_events drop constraint audit_events_target_kind_check;
alter table audit_events add constraint audit_events_target_kind_check check (
	target_kind in (
		'profile', 'session', 'credential-code', 'provider-cache', 'throttle',
		'plugin', 'preflight', 'operation', 'artifact', 'delivery-attempt'
	)
);
