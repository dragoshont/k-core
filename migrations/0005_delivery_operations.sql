-- up
alter table audit_events drop constraint audit_events_target_kind_check;
alter table audit_events add constraint audit_events_target_kind_check check (
	target_kind in ('profile', 'session', 'credential-code', 'provider-cache', 'throttle', 'plugin', 'preflight', 'operation', 'artifact', 'delivery-attempt')
);

create table delivery_preflights (
	preflight_id uuid primary key,
	profile_id uuid not null references profiles (profile_id) on delete cascade,
	plugin_id text not null check (plugin_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
	item_id text not null check (item_id ~ '^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$'),
	option_id text not null check (option_id ~ '^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$'),
	plugin_digest text not null check (char_length(plugin_digest) = 64),
	destination_revision integer not null check (destination_revision >= 0),
	item_json jsonb not null,
	ready boolean not null,
	blockers_json jsonb not null default '[]'::jsonb,
	warnings_json jsonb not null default '[]'::jsonb,
	created_at timestamptz not null default now(),
	expires_at timestamptz not null,
	consumed_at timestamptz null,
	check (expires_at > created_at and expires_at <= created_at + interval '15 minutes')
);

create table operations (
	operation_id uuid primary key,
	profile_id uuid not null references profiles (profile_id) on delete cascade,
	preflight_id uuid not null unique references delivery_preflights (preflight_id) on delete restrict,
	idempotency_key uuid not null,
	status text not null check (status in ('queued', 'waiting', 'running', 'blocked', 'canceling', 'canceled', 'succeeded', 'failed', 'partial', 'expired', 'unknown')),
	attempt integer not null default 1 check (attempt >= 1),
	cancel_requested_at timestamptz null,
	lease_owner text null,
	lease_expires_at timestamptz null,
	target_json jsonb not null,
	delivery_evidence text not null default 'not-submitted' check (delivery_evidence in ('not-submitted', 'mail-server-accepted', 'bounced', 'rejected', 'unknown', 'user-confirmed-received')),
	correlation_id uuid not null,
	created_at timestamptz not null default now(),
	started_at timestamptz null,
	updated_at timestamptz not null default now(),
	completed_at timestamptz null,
	unique (profile_id, idempotency_key)
);

create table operation_stages (
	operation_id uuid not null references operations (operation_id) on delete cascade,
	stage_index integer not null check (stage_index between 0 and 7),
	name text not null check (name in ('preflight', 'acquire', 'validate', 'metadata', 'convert', 'validate-output', 'deliver', 'cleanup')),
	status text not null check (status in ('not-started', 'queued', 'waiting', 'running', 'blocked', 'canceled', 'succeeded', 'failed', 'unknown')),
	message text null,
	error_json jsonb null,
	started_at timestamptz null,
	completed_at timestamptz null,
	updated_at timestamptz not null default now(),
	primary key (operation_id, stage_index),
	unique (operation_id, name)
);

create table artifacts (
	artifact_id uuid primary key,
	operation_id uuid not null unique references operations (operation_id) on delete restrict,
	storage_path text not null unique,
	media_type text not null check (media_type = 'application/epub+zip'),
	size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 26214400),
	sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
	validated_at timestamptz not null,
	retain_until timestamptz not null default (now() + interval '24 hours'),
	deleted_at timestamptz null,
	created_at timestamptz not null default now()
);

create table delivery_attempts (
	delivery_attempt_id uuid primary key,
	operation_id uuid not null unique references operations (operation_id) on delete restrict,
	message_id text not null unique,
	destination_hash text not null check (char_length(destination_hash) = 64),
	status text not null check (status in ('sending', 'accepted', 'rejected', 'unknown')),
	smtp_response text null,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create index operations_profile_time_idx on operations (profile_id, updated_at desc);
create index operations_claim_idx on operations (status, lease_expires_at, created_at);

-- down
do $$
begin
	if exists (select 1 from operations limit 1) then
		raise exception 'cannot roll back delivery operations after durable writes exist'
			using errcode = '55000';
	end if;
end
$$;

drop table if exists delivery_attempts;
drop table if exists artifacts;
drop table if exists operation_stages;
drop table if exists operations;
drop table if exists delivery_preflights;
alter table audit_events drop constraint audit_events_target_kind_check;
alter table audit_events add constraint audit_events_target_kind_check check (
	target_kind in ('profile', 'session', 'credential-code', 'provider-cache', 'throttle')
);