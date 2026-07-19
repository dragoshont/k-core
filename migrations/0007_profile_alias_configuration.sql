-- up
create table profile_alias_migration_backup (
	profile_id uuid primary key,
	slug text not null,
	display_name text not null,
	captured_at timestamptz not null default now(),
	constraint profile_alias_migration_backup_fixed_identity check (profile_id in (
		'00000000-0000-4000-8000-000000000001',
		'00000000-0000-4000-8000-000000000002',
		'00000000-0000-4000-8000-000000000003'
	))
);

insert into profile_alias_migration_backup (profile_id, slug, display_name)
select profile_id, slug, display_name from profiles;

do $$
begin
	if (select count(*) from profile_alias_migration_backup) <> 3 then
		raise exception 'profile configuration mismatch' using errcode = '55000';
	end if;
end
$$;

alter table profiles drop constraint if exists profiles_slug_check;
alter table profiles drop constraint if exists profiles_display_name_check;
alter table profiles drop constraint if exists profiles_slug_key;
alter table profiles drop constraint if exists profiles_display_name_key;
alter table profiles drop constraint if exists profiles_slug_unique;
alter table profiles drop constraint if exists profiles_display_name_unique;
alter table profiles drop constraint if exists profiles_fixed_identity;
alter table profiles drop constraint if exists profiles_slug_format;
alter table profiles drop constraint if exists profiles_display_name_format;

alter table profiles
	add constraint profiles_slug_unique unique (slug) deferrable initially immediate,
	add constraint profiles_display_name_unique unique (display_name) deferrable initially immediate,
	add constraint profiles_fixed_identity check (profile_id in (
		'00000000-0000-4000-8000-000000000001',
		'00000000-0000-4000-8000-000000000002',
		'00000000-0000-4000-8000-000000000003'
	)),
	add constraint profiles_slug_format check (
		char_length(slug) between 1 and 64
		and slug ~ '^[a-z][a-z0-9-]{0,63}$'
	),
	add constraint profiles_display_name_format check (
		char_length(display_name) between 1 and 120
		and display_name = btrim(display_name)
		and display_name !~ '[[:cntrl:]]'
	);

create function guard_profile_alias_mutation() returns trigger
language plpgsql
as $$
begin
	if (new.slug, new.display_name) is distinct from (old.slug, old.display_name)
		and coalesce(current_setting('k.profile_alias_migration', true), '') <> 'on' then
		raise exception 'profile aliases may be changed only by the migrator' using errcode = '55000';
	end if;
	return new;
end;
$$;

create trigger profiles_aliases_migrator_only
before update of slug, display_name on profiles
for each row execute function guard_profile_alias_mutation();

-- down
select set_config('k.profile_alias_migration', 'on', true);
set constraints profiles_slug_unique, profiles_display_name_unique deferred;

update profiles as profile
set slug = backup.slug,
	display_name = backup.display_name,
	updated_at = case
		when (profile.slug, profile.display_name) is distinct from (backup.slug, backup.display_name) then now()
		else profile.updated_at
	end
from profile_alias_migration_backup as backup
where profile.profile_id = backup.profile_id;

do $$
begin
	if exists (
		select 1
		from profile_alias_migration_backup as backup
		full join profiles as profile using (profile_id)
		where profile.profile_id is null
			or backup.profile_id is null
			or (profile.slug, profile.display_name) is distinct from (backup.slug, backup.display_name)
	) then
		raise exception 'profile configuration mismatch' using errcode = '55000';
	end if;
end
$$;

set constraints profiles_slug_unique, profiles_display_name_unique immediate;
drop trigger if exists profiles_aliases_migrator_only on profiles;
drop function if exists guard_profile_alias_mutation();
drop table if exists profile_alias_migration_backup;