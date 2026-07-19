-- up
insert into profiles (profile_id, slug, display_name, credential_state)
values
	('00000000-0000-4000-8000-000000000001', 'member-1', 'Member 1', 'setup-required'),
	('00000000-0000-4000-8000-000000000002', 'member-2', 'Member 2', 'setup-required'),
	('00000000-0000-4000-8000-000000000003', 'member-3', 'Member 3', 'setup-required')
on conflict (profile_id) do update
set slug = excluded.slug,
	display_name = excluded.display_name;

-- down
delete from profiles where profile_id in (
	'00000000-0000-4000-8000-000000000001',
	'00000000-0000-4000-8000-000000000002',
	'00000000-0000-4000-8000-000000000003'
);