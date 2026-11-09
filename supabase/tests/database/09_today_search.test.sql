-- Today screen + global search (#38): search_salon RPC and Realtime publication.
begin;
select plan(17);

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
  ('00000000-0000-4000-e000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-a@search.test'),
  ('00000000-0000-4000-e000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-b@search.test');

select pg_temp.login('00000000-0000-4000-e000-00000000000a');
select public.create_salon('Search A', 'search-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-e000-00000000000b');
select public.create_salon('Search B', 'search-b', 'America/Chicago');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'search-a') as a,
         (select id from public.salons where slug = 'search-b') as b;
grant select on ids to authenticated;

insert into public.clients (salon_id, name, phone)
select a, n, p from ids, (values
  ('Karina Lopez', '(555) 010-4477'),
  ('Maya Chen', '555.020.9911'),
  ('Kara Smith', null),
  ('50% Off Guy', null)
) v(n, p);
insert into public.clients (salon_id, name, phone)
select b, 'Karina Other Salon', '555-010-4477' from ids;

select pg_temp.login('00000000-0000-4000-e000-00000000000a');
select public.book_appointment(
  (select a from ids),
  (select id from public.clients where name = 'Karina Lopez'),
  jsonb_build_array(jsonb_build_object(
    'kind', 'busy', 'start', now() + interval '2 hours', 'end', now() + interval '3 hours')),
  '[{"serviceId":"00000000-0000-4000-e000-0000000000f1","name":"Balayage","colorTag":"amber"}]',
  'requested');

-- Schema ---------------------------------------------------------------------------------------
select isnt_empty(
  $$ select 1 from pg_extension where extname = 'pg_trgm' $$, 'pg_trgm is installed');
select has_function('public', 'search_salon', array['uuid', 'text', 'integer'], 'search_salon exists');
select ok(
  exists (select 1 from pg_publication_tables
           where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'appointments'),
  'appointments are published to Realtime');
select ok(
  exists (select 1 from pg_publication_tables
           where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'clients'),
  'clients are published to Realtime');

-- Clients ----------------------------------------------------------------------------------------
select is(
  (select title from public.search_salon((select a from ids), 'kar') where kind = 'client'
    order by score desc, title limit 1),
  'Kara Smith', 'partial name matches (prefix)');
select is(
  (select count(*)::integer from public.search_salon((select a from ids), 'kar') where kind = 'client'),
  2, 'partial name finds both Karina and Kara');
select is(
  (select title from public.search_salon((select a from ids), 'lopez') where kind = 'client'),
  'Karina Lopez', 'matches a later word of the name');
select is(
  (select title from public.search_salon((select a from ids), 'karnia') where kind = 'client'
    order by score desc limit 1),
  'Karina Lopez', 'tolerates a typo');
select is(
  (select title from public.search_salon((select a from ids), '0104') where kind = 'client'),
  'Karina Lopez', 'phone digits match regardless of formatting');
select is(
  (select title from public.search_salon((select a from ids), '020-99') where kind = 'client'),
  'Maya Chen', 'formatted phone fragment matches');
select is(
  (select array_agg(title) from public.search_salon((select a from ids), '%') where kind = 'client'),
  array['50% Off Guy'], 'LIKE wildcards are literal');
select is_empty(
  $$ select 1 from public.search_salon((select a from ids), '   ') $$, 'blank query returns nothing');

-- Appointments & services ----------------------------------------------------------------------
select is(
  (select status::text from public.search_salon((select a from ids), 'karina') where kind = 'appointment'),
  'requested', 'appointments match by client name, with status');
select is(
  (select title from public.search_salon((select a from ids), 'balay') where kind = 'appointment'),
  'Karina Lopez', 'appointments match by service name');
select ok(
  exists (select 1 from public.search_salon((select a from ids), 'balay') where kind = 'service'),
  'services match by name (starter menu)');

-- Isolation --------------------------------------------------------------------------------------
select is_empty(
  $$ select 1 from public.search_salon((select b from ids), 'karina') $$,
  'cannot search another salon');
select pg_temp.logout();

set local role anon;
select throws_ok(
  $$ select * from public.search_salon((select a from ids), 'karina') $$,
  '42501', null, 'anon cannot search');
reset role;

select * from finish();
rollback;
