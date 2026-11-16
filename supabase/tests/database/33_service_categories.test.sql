-- Service categories (#86): kept in sync with services.category, owner-only add / rename (merge) /
-- remove (move services) / reorder, read isolation, and data-export registration.
begin;
select plan(27);

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
                    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
$$;

create function pg_temp.logout() returns void language sql as $$
  reset role;
  select set_config('request.jwt.claims', '', true);
$$;

select ok(to_regclass('public.service_categories') is not null, 'service_categories exists');

insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-4000-b330-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'alice@cat.test'),
  ('00000000-0000-4000-b330-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bob@cat.test'),
  ('00000000-0000-4000-b330-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stylist@cat.test');

select pg_temp.login('00000000-0000-4000-b330-00000000000a');
select public.create_salon('Cat A', 'cat-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-b330-00000000000b');
select public.create_salon('Cat B', 'cat-b', 'America/New_York');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'cat-a') as a,
         (select id from public.salons where slug = 'cat-b') as b;
grant select on ids to authenticated;

insert into public.salon_members (salon_id, user_id, role)
  select a, '00000000-0000-4000-b330-0000000000a2', 'stylist' from ids;

create function pg_temp.cats(p_salon uuid) returns text[] language sql as $$
  select coalesce(array_agg(name order by position), '{}')
    from public.service_categories where salon_id = p_salon;
$$;
grant execute on function pg_temp.cats(uuid) to authenticated;

-- Sync with services --------------------------------------------------------
select is(pg_temp.cats((select a from ids)),
          array['Cuts', 'Styling', 'Color', 'Treatments', 'Other'],
          'the starter menu files its categories in menu order');

update public.services set category = 'Bridal'
 where salon_id = (select a from ids) and name = 'Bridal trial';
select is((pg_temp.cats((select a from ids)))[6], 'Bridal',
          'a service in a new category appends it');

-- Owner RPCs -----------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-b330-00000000000a');

select lives_ok($$ select public.add_service_category((select a from ids), '  Extensions ') $$,
                'owner adds a category');
select is((pg_temp.cats((select a from ids)))[7], 'Extensions', 'added name is trimmed and appended');
select lives_ok($$ select public.add_service_category((select a from ids), 'Extensions') $$,
                'adding an existing category is a no-op');
select is(array_length(pg_temp.cats((select a from ids)), 1), 7, 'no duplicate category');
select throws_ok($$ select public.add_service_category((select a from ids), '   ') $$,
                 '22023', null, 'blank names are rejected');

select lives_ok($$ select public.rename_service_category((select a from ids), 'Styling', 'Style') $$,
                'owner renames a category');
select is((pg_temp.cats((select a from ids)))[2], 'Style', 'rename keeps the position');
select is((select count(*)::int from public.services s, ids
            where s.salon_id = ids.a and s.category = 'Styling'), 0,
          'rename moves every service');
select ok((select count(*) from public.services s, ids
            where s.salon_id = ids.a and s.category = 'Style') > 0, 'services carry the new name');

select lives_ok($$ select public.rename_service_category((select a from ids), 'Bridal', 'Style') $$,
                'renaming onto an existing category merges');
select ok(not ('Bridal' = any (pg_temp.cats((select a from ids)))), 'merged category is gone');
select is((select category from public.services s, ids
            where s.salon_id = ids.a and s.name = 'Bridal trial'), 'Style',
          'merged services moved');

select throws_ok($$ select public.delete_service_category((select a from ids), 'Treatments') $$,
                 '23503', null, 'removing a category with services needs a destination');
select throws_ok($$ select public.delete_service_category((select a from ids), 'Treatments', 'Treatments') $$,
                 '22023', null, 'cannot move services into the category being removed');
select lives_ok($$ select public.delete_service_category((select a from ids), 'Treatments', 'Color') $$,
                'remove with a destination merges');
select is((select count(*)::int from public.services s, ids
            where s.salon_id = ids.a and s.category = 'Treatments'), 0, 'its services moved');
select lives_ok($$ select public.delete_service_category((select a from ids), 'Extensions') $$,
                'an empty category is removed directly');

select lives_ok($$ select public.reorder_service_categories((select a from ids), array['Color', 'Cuts']) $$,
                'owner reorders');
select is(pg_temp.cats((select a from ids)), array['Color', 'Cuts', 'Style', 'Other'],
          'listed names first, the rest keep their order');

select is((select count(*)::int from public.service_categories s, ids where s.salon_id = ids.b), 0,
          'cannot read another salon''s categories');
select throws_ok($$ insert into public.service_categories (salon_id, name, position)
                    select a, 'Sneaky', 99 from ids $$,
                 '42501', null, 'direct writes are not allowed');
select throws_ok($$ select public.add_service_category((select b from ids), 'Nope') $$,
                 '42501', null, 'cannot edit another salon''s categories');
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-b330-0000000000a2');
select ok((select count(*) from public.service_categories s, ids where s.salon_id = ids.a) = 4,
          'stylists can read their salon''s categories');
select throws_ok($$ select public.rename_service_category((select a from ids), 'Color', 'Colour') $$,
                 '42501', null, 'stylists cannot edit categories');
select pg_temp.logout();

select * from finish();
rollback;
