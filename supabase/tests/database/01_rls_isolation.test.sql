-- RLS isolation: a member of salon A can never see or touch salon B.
begin;
select plan(33);

-- Test helpers -------------------------------------------------------------
create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
                    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
$$;

create function pg_temp.logout() returns void language sql as $$
  reset role;
  select set_config('request.jwt.claims', '', true);
$$;

insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-4000-a000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'alice@a.test'),
  ('00000000-0000-4000-a000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bob@b.test'),
  ('00000000-0000-4000-a000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stylist@a.test');

-- Alice creates salon A, Bob creates salon B (first-run flow) --------------
select pg_temp.login('00000000-0000-4000-a000-00000000000a');
select lives_ok(
  $$ select public.create_salon('Salon A', 'salon-a', 'America/Chicago') $$,
  'owner A can create a salon'
);
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-a000-00000000000b');
select lives_ok(
  $$ select public.create_salon('Salon B', 'Salon-B ', 'America/New_York') $$,
  'owner B can create a salon (slug is normalized)'
);
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'salon-a') as a,
         (select id from public.salons where slug = 'salon-b') as b;
grant select on ids to authenticated;

-- create_salon side effects -------------------------------------------------
select is(
  (select role::text from public.salon_members m, ids
   where m.salon_id = ids.a and m.user_id = '00000000-0000-4000-a000-00000000000a'),
  'owner', 'creator becomes owner');
select is(
  (select autonomy from public.settings s, ids where s.salon_id = ids.a),
  'draft', 'default settings row created (autonomy = draft)');
select is(
  (select count(*)::int from public.audit_log l, ids where l.salon_id = ids.a and l.action = 'salon.created'),
  1, 'salon creation is audited');

-- Seed rows in both salons as superuser -------------------------------------
insert into public.push_tokens (salon_id, user_id, token, platform)
  select a, '00000000-0000-4000-a000-00000000000a'::uuid, 'tok-a', 'ios'::public.push_platform from ids
  union all
  select b, '00000000-0000-4000-a000-00000000000b'::uuid, 'tok-b', 'ios'::public.push_platform from ids;
insert into public.salon_members (salon_id, user_id, role)
  select a, '00000000-0000-4000-a000-0000000000a2', 'stylist' from ids;

-- Alice (owner of A) ---------------------------------------------------------
select pg_temp.login('00000000-0000-4000-a000-00000000000a');

select results_eq('select slug from public.salons', array['salon-a'], 'A sees only salon A');
select is((select count(*)::int from public.salons, ids where id = ids.b), 0, 'A cannot read salon B by id');
select is((select count(*)::int from public.salon_members, ids where salon_id = ids.b), 0, 'A cannot read B members');
select is((select count(*)::int from public.salon_members), 2, 'A sees both A members');
select is((select count(*)::int from public.settings, ids where salon_id = ids.b), 0, 'A cannot read B settings');
select is((select count(*)::int from public.audit_log, ids where salon_id = ids.b), 0, 'A cannot read B audit log');
select is((select count(*)::int from public.push_tokens, ids where salon_id = ids.b), 0, 'A cannot read B push tokens');

-- writes into B are silently filtered (update/delete) or rejected (insert)
update public.salons set name = 'pwned' from ids where salons.id = ids.b;
update public.settings set autonomy = 'auto' from ids where settings.salon_id = ids.b;
delete from public.salon_members using ids where salon_members.salon_id = ids.b;
delete from public.salons using ids where salons.id = ids.b;

select throws_ok(
  $$ insert into public.salon_members (salon_id, user_id, role)
     select b, '00000000-0000-4000-a000-00000000000a', 'owner' from ids $$,
  '42501', null, 'A cannot add themself to salon B');
select throws_ok(
  $$ insert into public.audit_log (salon_id, action) select b, 'x' from ids $$,
  '42501', null, 'A cannot write to B audit log');
select throws_ok(
  $$ insert into public.push_tokens (salon_id, token, platform) select b, 'evil', 'ios' from ids $$,
  '42501', null, 'A cannot register a push token in salon B');
select throws_ok(
  $$ insert into public.salons (name, slug, timezone) values ('Direct', 'direct-insert', 'UTC') $$,
  '42501', null, 'salons can only be created through create_salon()');

-- owner powers inside A
select lives_ok(
  $$ update public.settings set autonomy = 'auto' from ids where settings.salon_id = ids.a $$,
  'owner A can update A settings');
select lives_ok(
  $$ insert into public.audit_log (salon_id, action) select a, 'test.event' from ids $$,
  'owner A can append to A audit log');
select throws_ok(
  $$ insert into public.audit_log (salon_id, action, actor_user_id)
     select a, 'spoof', '00000000-0000-4000-a000-00000000000b' from ids $$,
  '42501', null, 'audit entries cannot spoof another actor');
select throws_ok(
  $$ delete from public.salon_members using ids
     where salon_members.salon_id = ids.a and user_id = '00000000-0000-4000-a000-00000000000a' $$,
  'P0001', 'A salon must have at least one owner', 'last owner cannot leave');
select is(public.is_salon_slug_available('salon-b'), false, 'taken slug is unavailable');
select is(public.is_salon_slug_available('fresh-slug'), true, 'free slug is available');
select is(public.is_salon_slug_available('api'), false, 'reserved slug is unavailable');
select pg_temp.logout();

-- B data untouched by A's attempts
select is((select name from public.salons, ids where id = ids.b), 'Salon B', 'B name unchanged');
select is((select autonomy from public.settings, ids where salon_id = ids.b), 'draft', 'B settings unchanged');
select is((select count(*)::int from public.salon_members, ids where salon_id = ids.b), 1, 'B members unchanged');

-- Stylist in A: reads A, cannot administer ----------------------------------
select pg_temp.login('00000000-0000-4000-a000-0000000000a2');
select results_eq('select slug from public.salons', array['salon-a'], 'stylist sees only salon A');
select is((select count(*)::int from public.push_tokens), 0, 'stylist does not see owner push tokens');
update public.settings set autonomy = 'draft' from ids where settings.salon_id = ids.a;
select pg_temp.logout();
select is((select autonomy from public.settings, ids where salon_id = ids.a), 'auto', 'stylist cannot update settings');

-- Anonymous ------------------------------------------------------------------
set local role anon;
select throws_ok('select * from public.salons', '42501', null, 'anon cannot read salons');
select throws_ok(
  $$ select public.create_salon('Anon', 'anon-salon', 'UTC') $$,
  '42501', null, 'anon cannot create a salon');
reset role;

-- Validation -----------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-a000-00000000000a');
select throws_ok(
  $$ select public.create_salon('Bad TZ', 'bad-tz', 'Mars/Olympus') $$,
  '23514', null, 'invalid timezone rejected');
select throws_ok(
  $$ select public.create_salon('Dup', 'salon-b', 'UTC') $$,
  '23505', null, 'duplicate slug rejected');
select pg_temp.logout();

select * from finish();
rollback;
