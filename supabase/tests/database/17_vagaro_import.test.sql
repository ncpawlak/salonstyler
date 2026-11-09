-- Import from Vagaro (#15): idempotent client + appointment import RPCs.
begin;
select plan(32);

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
  ('00000000-0000-4000-c170-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-a@import.test'),
  ('00000000-0000-4000-c170-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-b@import.test');

select pg_temp.login('00000000-0000-4000-c170-00000000000a');
select public.create_salon('Import A', 'import-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-c170-00000000000b');
select public.create_salon('Import B', 'import-b', 'America/Chicago');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'import-a') as a;
insert into public.clients (salon_id, name, email) select a, 'Avery Brooks', 'avery.brooks@example.com' from ids;
alter table ids add column avery uuid;
update ids set avery = (select id from public.clients c where c.salon_id = ids.a);
create temp table runs (name text primary key, r jsonb);
grant select on ids to authenticated;
grant all on runs to authenticated;

-- Schema ---------------------------------------------------------------------------------------
select has_column('public', 'clients', 'birthday', 'clients.birthday exists');
select has_column('public', 'appointments', 'import_key', 'appointments.import_key exists');
select is(private.phone_key('+1 (555) 201-0001'), '5552010001', 'phone_key drops formatting and the US country code');
select is(private.phone_key('12-34'), null, 'phone_key ignores numbers that are too short');

-- Clients --------------------------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-c170-00000000000a');

create temp table client_batch as select $j$[
  {"name": "Avery Brooks", "email": "AVERY.BROOKS@example.com", "tags": ["VIP"],
   "notes": "Prefers mornings", "lastVisitOn": "2026-10-01", "noShowCount": 1},
  {"name": "Jordan Lee", "phone": "555.201.0002", "birthday": "1990-04-12"},
  {"name": "Jordan L.", "phone": "(555) 201-0002"},
  {"name": "Sam Ortiz"},
  {"name": "  "},
  {"name": "Riley Chen", "email": "not-an-email"}
]$j$::jsonb as j;

insert into runs select 'clients1', public.import_clients((select a from ids), (select j from client_batch));
select is((select r - 'results' from runs where name = 'clients1'),
          '{"created": 2, "updated": 1, "unchanged": 1, "invalid": 2}'::jsonb,
          'first client import: creates, updates by email, dedupes by phone, rejects bad rows');
select is((select (r -> 'results' -> 0 ->> 'clientId')::uuid from runs where name = 'clients1'),
          (select avery from ids), 'email matches case-insensitively');
select is((select r -> 'results' -> 2 ->> 'clientId' from runs where name = 'clients1'),
          (select r -> 'results' -> 1 ->> 'clientId' from runs where name = 'clients1'),
          'phone matches regardless of formatting');
select is((select r -> 'results' -> 5 ->> 'status' from runs where name = 'clients1'), 'invalid',
          'a bad email is reported per row instead of failing the batch');
select is((select count(*)::integer from public.clients where salon_id = (select a from ids)), 3,
          'only new people were created');
select is((select row(tags, imported_no_show_count, imported_last_visit_on)::text
             from public.clients where id = (select avery from ids)),
          row('{VIP}'::text[], 1, '2026-10-01'::date)::text,
          'tags, no-shows and last visit merged into the existing client');
select is((select birthday from public.clients where phone = '555.201.0002'), '1990-04-12'::date,
          'birthday stored');
select is((select count(*)::integer from public.client_notes
            where client_id = (select avery from ids) and source = 'import'), 1,
          'imported note added');

insert into runs select 'clients2', public.import_clients((select a from ids), (select j from client_batch));
select is((select r - 'results' from runs where name = 'clients2'),
          '{"created": 0, "updated": 0, "unchanged": 4, "invalid": 2}'::jsonb,
          're-importing the same file changes nothing');
select is((select count(*)::integer from public.client_notes where client_id = (select avery from ids)), 1,
          'imported note is not duplicated');
select is((select row(no_show_count, last_visit_at)::text from public.client_summaries
            where client_id = (select avery from ids)),
          row(1, '2026-10-01 12:00 America/Chicago'::timestamptz)::text,
          'client_summaries include imported no-shows and last visit');

insert into runs select 'clients3', public.import_clients((select a from ids),
  '[{"name": "sam ortiz"}, {"name": "Avery Brooks", "email": "avery.brooks@example.com",
     "phone": "555-201-0001", "lastVisitOn": "2026-10-20", "noShowCount": 0}]'::jsonb);
select is((select r -> 'results' -> 0 ->> 'status' from runs where name = 'clients3'), 'unchanged',
          'contact-less rows match by name');
select is((select r -> 'results' -> 1 ->> 'status' from runs where name = 'clients3'), 'updated',
          'new details update a matched client');
select is((select row(phone, imported_last_visit_on, imported_no_show_count)::text
             from public.clients where id = (select avery from ids)),
          row('555-201-0001', '2026-10-20'::date, 1)::text,
          'missing phone filled, later visit kept, no-show count never lowered');
select throws_ok(
  $$ select public.import_clients((select a from ids),
       (select jsonb_agg(jsonb_build_object('name', 'C' || g)) from generate_series(1, 501) g)) $$,
  '22023', null, 'client batches are capped at 500');

-- Appointments ---------------------------------------------------------------------------------
insert into runs select 'jordan', to_jsonb(public.book_appointment((select a from ids),
  (select id from public.clients where phone = '555.201.0002'),
  '[{"kind":"busy","start":"2030-03-05T17:00Z","end":"2030-03-05T18:00Z"}]'::jsonb));

create temp table appt_batch as select jsonb_build_array(
  jsonb_build_object('key', 'vagaro:id:1', 'clientId', (select avery from ids),
    'segments', '[{"kind":"busy","start":"2030-03-05T15:00Z","end":"2030-03-05T16:00Z","label":"Root touch-up"}]'::jsonb,
    'services', '[{"serviceId":"","name":"Root touch-up"}]'::jsonb, 'priceCents', 8500,
    'notes', 'Imported from Vagaro'),
  jsonb_build_object('key', 'vagaro:id:2',
    'segments', '[{"kind":"busy","start":"2030-03-05T16:30Z","end":"2030-03-05T17:30Z"}]'::jsonb),
  jsonb_build_object('key', 'vagaro:id:3',
    'segments', '[{"kind":"busy","start":"2020-01-01T15:00Z","end":"2020-01-01T16:00Z"}]'::jsonb),
  jsonb_build_object('key', '',
    'segments', '[{"kind":"busy","start":"2030-03-06T15:00Z","end":"2030-03-06T16:00Z"}]'::jsonb),
  jsonb_build_object('key', 'vagaro:id:4', 'clientId', gen_random_uuid(),
    'segments', '[{"kind":"busy","start":"2030-03-07T15:00Z","end":"2030-03-07T16:00Z"}]'::jsonb)
) as j;
grant select on appt_batch to authenticated;

insert into runs select 'appts1', public.import_appointments((select a from ids), (select j from appt_batch));
select is((select r - 'results' from runs where name = 'appts1'),
          '{"booked": 1, "duplicate": 0, "past": 1, "conflict": 1, "invalid": 2}'::jsonb,
          'appointment import books, skips past, reports conflicts and bad rows');
select is((select r -> 'results' -> 1 -> 'conflict' ->> 'clientName' from runs where name = 'appts1'),
          'Jordan Lee', 'a conflict names the clashing appointment');
select is((select (r -> 'results' -> 1 -> 'conflict' ->> 'appointmentId') from runs where name = 'appts1'),
          (select r ->> 'id' from runs where name = 'jordan'), 'a conflict links the clashing appointment');
select is((select row(status, source, client_id, price_cents, starts_at)::text from public.appointments
            where import_key = 'vagaro:id:1'),
          row('confirmed'::public.appointment_status, 'import'::public.appointment_source,
              (select avery from ids), 8500, '2030-03-05T15:00Z'::timestamptz)::text,
          'imported appointment is confirmed, sourced import and keyed');
select is((select label from public.appointment_segments s join public.appointments a on a.id = s.appointment_id
            where a.import_key = 'vagaro:id:1'), 'Root touch-up', 'segment labels kept');

insert into runs select 'appts2', public.import_appointments((select a from ids), (select j from appt_batch));
select is((select r - 'results' from runs where name = 'appts2'),
          '{"booked": 0, "duplicate": 1, "past": 1, "conflict": 1, "invalid": 2}'::jsonb,
          're-importing appointments never double-books');
select is((select count(*)::integer from public.appointments where import_key is not null), 1,
          'one imported appointment');
select is((select array_agg(action order by action) from public.audit_log
            where salon_id = (select a from ids) and action like 'import.%'),
          '{import.appointments,import.clients,import.clients,import.clients}'::text[],
          'imports are audited');

-- Access ---------------------------------------------------------------------------------------
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-c170-00000000000b');
select throws_ok($$ select public.import_clients((select a from ids), '[]'::jsonb) $$,
                 '42501', null, 'another salon cannot import clients');
select throws_ok($$ select public.import_appointments((select a from ids), '[]'::jsonb) $$,
                 '42501', null, 'another salon cannot import appointments');
select pg_temp.logout();

select throws_ok(
  $$ insert into public.appointments (salon_id, stylist_id, status, starts_at, ends_at, import_key)
     select a, '00000000-0000-4000-c170-00000000000a', 'confirmed', '2030-04-01T15:00Z', '2030-04-01T16:00Z',
            'vagaro:id:1' from ids $$,
  '23505', null, 'import keys are unique per salon');
select is(has_function_privilege('anon', 'public.import_clients(uuid, jsonb)', 'execute'), false,
          'anon cannot import clients');
select is(has_function_privilege('anon', 'public.import_appointments(uuid, jsonb)', 'execute'), false,
          'anon cannot import appointments');

select * from finish();
rollback;
