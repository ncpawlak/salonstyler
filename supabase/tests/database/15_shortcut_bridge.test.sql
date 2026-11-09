-- iOS Shortcut bridge, part 2 (#6): version + health tracking, auto-reply and station card phone.
begin;
select plan(16);

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
                    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
$$;

create function pg_temp.as_service_role() returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
$$;

create function pg_temp.logout() returns void language sql as $$
  reset role;
  select set_config('request.jwt.claims', '', true);
$$;

insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-4000-f150-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@bridge15.test'),
  ('00000000-0000-4000-f150-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stylist@bridge15.test');

select pg_temp.login('00000000-0000-4000-f150-00000000000a');
select public.create_salon('Bridge Studio', 'bridge-studio-15', 'America/Chicago');
select pg_temp.logout();

create temp table ids as select (select id from public.salons where slug = 'bridge-studio-15') as a;
grant select on ids to authenticated, service_role;
create temp table t (name text primary key, val text);
grant select, insert on t to authenticated, service_role;

insert into public.salon_members (salon_id, user_id, role)
  select a, '00000000-0000-4000-f150-00000000000b', 'stylist' from ids;

-- Schema ----------------------------------------------------------------------
select col_default_is('public', 'inbox_bridges', 'auto_reply', 'false', 'auto-reply is off by default');
select has_column('public', 'inbox_bridges', 'phone', 'inbox_bridges.phone exists');
select has_column('public', 'inbox_bridges', 'last_bridge_version', 'inbox_bridges.last_bridge_version exists');
select has_column('public', 'inbox_bridges', 'last_test_at', 'inbox_bridges.last_test_at exists');

-- Owner settings ----------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-f150-00000000000a');
insert into t (name, val) select 'token', public.rotate_inbox_bridge_token((select a from ids));
update public.inbox_bridges set auto_reply = true, phone = '+1 (555) 010-0199'
 where salon_id = (select a from ids);
select is(
  (select (auto_reply, phone)::text from public.inbox_bridges),
  (true, '+1 (555) 010-0199')::text,
  'owner can turn on auto-reply and set the station phone');
select throws_ok(
  $$ update public.inbox_bridges set phone = '12' $$,
  '23514', null, 'the station phone must look like a number');
select throws_ok(
  $$ update public.inbox_bridges set last_bridge_version = '9', last_test_at = now() $$,
  '42501', null, 'members cannot write the health columns');
select throws_ok(
  $$ select * from public.inbox_bridge_for_token('x', 60, '2') $$,
  '42501', null, 'members cannot resolve tokens');
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-f150-00000000000b');
update public.inbox_bridges set auto_reply = false;
select pg_temp.logout();
select is(
  (select auto_reply from public.inbox_bridges where salon_id = (select a from ids)),
  true, 'stylists cannot change auto-reply');

-- Token lookup records the Shortcut version ---------------------------------------
select pg_temp.as_service_role();
select is(
  (select (salon_id, keyword, rate_limited, auto_reply, salon_name)::text
     from public.inbox_bridge_for_token((select val from t where name = 'token'), 60, '2')),
  ((select a from ids), 'Chairside', false, true, 'Bridge Studio')::text,
  'the lookup returns the reply settings and salon name');
select is(
  (select last_bridge_version from public.inbox_bridges where salon_id = (select a from ids)),
  '2', 'the reported Shortcut version is recorded');
select isnt(
  (select last_received_at from public.inbox_bridges where salon_id = (select a from ids)),
  null, 'last fired is recorded');
select lives_ok(
  $$ select * from public.inbox_bridge_for_token((select val from t where name = 'token')) $$,
  'older callers without a version still work');
select is(
  (select last_bridge_version from public.inbox_bridges where salon_id = (select a from ids)),
  '2', 'a request without a version keeps the last known one');
update public.inbox_bridges set last_test_at = now() where salon_id = (select a from ids);
select isnt(
  (select last_test_at from public.inbox_bridges where salon_id = (select a from ids)),
  null, 'the service role records bridge tests');
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-f150-00000000000a');
select is(
  (select (last_bridge_version is not null and last_test_at is not null) from public.inbox_bridges),
  true, 'the owner sees the bridge health');
select pg_temp.logout();

select * from finish();
rollback;
