-- up
create table provider_cache (
	provider_id text not null check (provider_id = 'open-library'),
	resource_kind text not null check (resource_kind in ('search', 'detail')),
	cache_key text not null check (char_length(cache_key) = 64),
	http_status integer not null check (http_status between 200 and 599),
	normalized_json jsonb not null,
	etag text null,
	last_modified text null,
	fetched_at timestamptz not null,
	fresh_until timestamptz not null,
	stale_until timestamptz not null,
	last_accessed_at timestamptz not null,
	primary key (provider_id, resource_kind, cache_key),
	check (fresh_until > fetched_at),
	check (stale_until >= fresh_until)
);

create index provider_cache_cleanup_idx on provider_cache (resource_kind, stale_until);

-- down
drop table if exists provider_cache;