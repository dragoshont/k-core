-- up
create table plugin_cache (
	plugin_id text not null check (plugin_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
	resource_kind text not null check (resource_kind in ('search', 'detail')),
	cache_key text not null check (char_length(cache_key) = 64),
	normalized_json jsonb not null,
	fetched_at timestamptz not null,
	fresh_until timestamptz not null,
	stale_until timestamptz not null,
	last_accessed_at timestamptz not null,
	primary key (plugin_id, resource_kind, cache_key),
	check (fresh_until > fetched_at),
	check (stale_until >= fresh_until)
);

create index plugin_cache_cleanup_idx on plugin_cache (stale_until);

-- down
drop table if exists plugin_cache;