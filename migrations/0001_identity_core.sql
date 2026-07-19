-- up
create table profiles (
	profile_id uuid primary key,
	slug text not null,
	display_name text not null,
	credential_state text not null check (credential_state in ('setup-required', 'ready', 'recovery-required')),
	credential_revision integer not null default 0 check (credential_revision >= 0),
	pin_verifier text null,
	pin_fingerprint bytea null check (pin_fingerprint is null or octet_length(pin_fingerprint) = 32),
	pin_updated_at timestamptz null,
	kindle_address text null,
	destination_revision integer not null default 0 check (destination_revision >= 0),
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint profiles_slug_unique unique (slug) deferrable initially immediate,
	constraint profiles_display_name_unique unique (display_name) deferrable initially immediate,
	constraint profiles_fixed_identity check (profile_id in (
		'00000000-0000-4000-8000-000000000001',
		'00000000-0000-4000-8000-000000000002',
		'00000000-0000-4000-8000-000000000003'
	)),
	constraint profiles_slug_format check (
		char_length(slug) between 1 and 64
		and slug ~ '^[a-z][a-z0-9-]{0,63}$'
	),
	constraint profiles_display_name_format check (
		char_length(display_name) between 1 and 120
		and display_name = btrim(display_name)
		and display_name !~ '[[:cntrl:]]'
	)
);

create unique index profiles_pin_fingerprint_unique on profiles (pin_fingerprint) where pin_fingerprint is not null;

create table credential_codes (
	credential_code_id uuid primary key,
	profile_id uuid not null references profiles (profile_id) on delete restrict,
	purpose text not null check (purpose in ('setup', 'recovery')),
	credential_revision integer not null check (credential_revision >= 0),
	digest bytea not null unique check (octet_length(digest) = 32),
	issuer_label text not null,
	reason text not null,
	issued_at timestamptz not null default now(),
	expires_at timestamptz not null,
	consumed_at timestamptz null,
	consumed_reason text null check (consumed_reason in ('credential redeemed', 'superseded by recovery issue', 'superseded by new setup code')),
	check (expires_at > issued_at and expires_at <= issued_at + interval '24 hours'),
	check (
		(consumed_at is null and consumed_reason is null)
		or (consumed_at is not null and consumed_reason is not null)
	)
);

create unique index credential_codes_one_open_per_profile on credential_codes (profile_id) where consumed_at is null;

create table auth_throttles (
	scope text not null check (scope in ('profile', 'source')),
	category text not null check (category in ('pin', 'credential')),
	subject_key text not null,
	profile_id uuid null references profiles (profile_id) on delete cascade,
	failure_count integer not null default 0 check (failure_count >= 0),
	window_started_at timestamptz not null default now(),
	last_failure_at timestamptz not null default now(),
	lock_level integer not null default 0 check (lock_level between 0 and 3),
	locked_until timestamptz null,
	primary key (scope, category, subject_key),
	check (
		(scope = 'profile' and profile_id is not null and subject_key = profile_id::text)
		or (scope = 'source' and profile_id is null and char_length(subject_key) = 64)
	)
);

create table sessions (
	session_id uuid primary key,
	profile_id uuid not null references profiles (profile_id) on delete cascade,
	token_digest bytea not null unique check (octet_length(token_digest) = 32),
	created_at timestamptz not null default now(),
	last_seen_at timestamptz not null default now(),
	recent_auth_at timestamptz not null default now(),
	idle_expires_at timestamptz not null,
	absolute_expires_at timestamptz not null,
	revoked_at timestamptz null,
	revocation_reason text null check (revocation_reason in ('logout', 'credential reset', 'pin change', 'recovery issue', 'expiry', 'rotation')),
	check (idle_expires_at > created_at and absolute_expires_at > created_at),
	check (
		(revoked_at is null and revocation_reason is null)
		or (revoked_at is not null and revocation_reason is not null)
	)
);

create index sessions_profile_active_idx on sessions (profile_id, last_seen_at desc) where revoked_at is null;
create index sessions_expiry_idx on sessions (idle_expires_at, absolute_expires_at) where revoked_at is null;

create table audit_events (
	audit_event_id uuid primary key,
	actor_kind text not null check (actor_kind in ('operator-cli', 'profile', 'system')),
	profile_id uuid null references profiles (profile_id) on delete set null,
	actor_label text not null,
	action text not null,
	target_kind text not null check (target_kind in ('profile', 'session', 'credential-code', 'provider-cache', 'throttle')),
	target_id text not null,
	outcome text not null check (outcome in ('succeeded', 'failed')),
	correlation_id uuid not null,
	request_id uuid null,
	source_hash text null check (source_hash is null or char_length(source_hash) = 64),
	details_json jsonb not null default '{}'::jsonb,
	created_at timestamptz not null default now()
);

create index audit_events_target_time_idx on audit_events (target_kind, target_id, created_at desc);
create index audit_events_actor_time_idx on audit_events (actor_kind, actor_label, created_at desc);
create index audit_events_correlation_idx on audit_events (correlation_id);
create index audit_events_action_time_idx on audit_events (action, created_at desc);

create function reject_audit_event_mutation() returns trigger
language plpgsql
as $$
begin
	raise exception 'audit events are append-only' using errcode = '55000';
end;
$$;

create trigger audit_events_rows_append_only
before update or delete on audit_events
for each row execute function reject_audit_event_mutation();

create trigger audit_events_truncate_append_only
before truncate on audit_events
for each statement execute function reject_audit_event_mutation();

-- down
drop table if exists audit_events;
drop function if exists reject_audit_event_mutation();
drop table if exists sessions;
drop table if exists auth_throttles;
drop table if exists credential_codes;
drop table if exists profiles;