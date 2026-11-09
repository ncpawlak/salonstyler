-- Public booking page (#14): booking-page settings, rate limiting, book_public_appointment
-- (profile linking, Auto/Draft, Tentative, cap, conflicts), own bookings only, and the push.
begin;
select plan(35);

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

create function pg_temp.booking(p_start timestamptz, p_minutes integer default 60,
                                p_extra jsonb default '{}'::jsonb) returns jsonb
language sql as $$
  select jsonb_build_object(
    'name', 'New Client', 'phone', '+15550109999',
    'segments', jsonb_build_array(jsonb_build_object(
      'kind', 'busy', 'start', p_start, 'end', p_start + make_interval(mins => p_minutes))),
    'services', jsonb_build_array(jsonb_build_object('serviceId', gen_random_uuid(), 'name', 'Haircut')),
    'priceCents', 6500) || p_extra;
$$;
grant execute on function pg_temp.booking(timestamptz, integer, jsonb) to service_role;

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('00000000-0000-4000-f000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-a@pb.test', now()),
  ('00000000-0000-4000-f000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-b@pb.test', now()),
  ('00000000-0000-4000-f000-0000000000c1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'newbie@pb.test', now()),
  ('00000000-0000-4000-f000-0000000000c2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'karina@pb.test', now()),
  ('00000000-0000-4000-f000-0000000000c3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'phone-thief@pb.test', now()),
  ('00000000-0000-4000-f000-0000000000c4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'unverified@pb.test', null);

select pg_temp.login('00000000-0000-4000-f000-00000000000a');
select public.create_salon('Booking A', 'booking-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-f000-00000000000b');
select public.create_salon('Booking B', 'booking-b', 'America/Chicago');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'booking-a') as a,
         (select id from public.salons where slug = 'booking-b') as b,
         '00000000-0000-4000-f000-00000000000a'::uuid as owner_a,
         '00000000-0000-4000-f000-0000000000c1'::uuid as newbie,
         '00000000-0000-4000-f000-0000000000c2'::uuid as karina_user,
         '00000000-0000-4000-f000-0000000000c3'::uuid as thief,
         '00000000-0000-4000-f000-0000000000c4'::uuid as unverified,
         date_trunc('day', now()) + interval '10 days 15 hours' as d10,
         date_trunc('day', now()) + interval '11 days 15 hours' as d11,
         date_trunc('day', now()) + interval '12 days 15 hours' as d12,
         date_trunc('day', now()) + interval '13 days 15 hours' as d13,
         date_trunc('day', now()) + interval '14 days 15 hours' as d14;
grant select on ids to service_role;
create temp table t (name text primary key, val jsonb);
grant select, insert, update on t to service_role;

-- Predictable hours: no template, so nothing is Tentative unless a test paints it.
delete from public.work_hours_template where salon_id in (select a from ids union select b from ids);
update public.settings set booking_page_intro = 'Hi! Book below.', booking_page_faq = 'Parking out back.'
 where salon_id = (select a from ids);

insert into public.clients (salon_id, name, phone, email)
  select a, 'Karina Lopez', '+15550100101', 'KARINA@pb.test' from ids;
insert into public.clients (salon_id, name, phone)
  select a, 'Maria Phone', '+15550100202' from ids;

-- Schema & privileges --------------------------------------------------------------
select col_default_is('public', 'settings', 'public_booking_enabled', 'true',
  'public booking is on by default');
select has_column('public', 'clients', 'user_id', 'clients link to the client''s own account');
select ok(not has_table_privilege('anon', 'private.rate_limits', 'select')
          and not has_table_privilege('authenticated', 'private.rate_limits', 'select'),
  'rate limit counters are not readable by API roles');
select ok(
  not has_function_privilege('anon', 'public.book_public_appointment(uuid,uuid,jsonb,integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.book_public_appointment(uuid,uuid,jsonb,integer)', 'execute')
  and not has_function_privilege('anon', 'public.public_client_bookings(uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.public_client_bookings(uuid,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.public_booking_page(text)', 'execute')
  and not has_function_privilege('anon', 'public.hit_rate_limit(text,integer,integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.hit_rate_limit(text,integer,integer)', 'execute'),
  'public booking RPCs are service-role only');

-- Page ------------------------------------------------------------------------------
select pg_temp.as_service_role();
select is(
  (select public.public_booking_page(' Booking-A ') - 'salonId'),
  jsonb_build_object('name', 'Booking A', 'slug', 'booking-a', 'timezone', 'America/Chicago',
                     'currency', 'USD', 'enabled', true, 'intro', 'Hi! Book below.',
                     'faq', 'Parking out back.', 'autoConfirm', false),
  'the page exposes branding and booking-page text only');
select is(public.public_booking_page('nope-nope'), null, 'unknown slugs return null');

-- Rate limiting ---------------------------------------------------------------------
select ok(public.hit_rate_limit('ip:test:1.2.3.4', 2, 60), 'first hit is allowed');
select ok(public.hit_rate_limit('ip:test:1.2.3.4', 2, 60), 'second hit is allowed');
select ok(not public.hit_rate_limit('ip:test:1.2.3.4', 2, 60), 'third hit in the window is limited');
select ok(public.hit_rate_limit('ip:test:5.6.7.8', 2, 60), 'other keys have their own window');
select pg_temp.logout();
select is((select count(*)::integer from private.rate_limits where key_hash like '%1.2.3.4%'), 0,
  'keys are stored hashed');
update private.rate_limits set window_started_at = now() - interval '2 minutes';
select pg_temp.as_service_role();
select ok(public.hit_rate_limit('ip:test:1.2.3.4', 2, 60), 'the window resets');

-- Booking: verification and new clients ---------------------------------------------
select throws_ok(
  $$ select public.book_public_appointment((select a from ids), (select unverified from ids),
                                           pg_temp.booking((select d10 from ids))) $$,
  '42501', null, 'an unverified account cannot book');

insert into t select 'new', public.book_public_appointment(
  (select a from ids), (select newbie from ids), pg_temp.booking((select d10 from ids)));
select is((select val ->> 'status' from t where name = 'new'), 'requested',
  'Draft mode turns a public booking into a request');
select ok((select (val ->> 'clientCreated')::boolean from t where name = 'new'),
  'a new client gets a profile');
select pg_temp.logout();
select is(
  (select (name, phone, email, pending, user_id)::text from public.clients
    where id = (select (val ->> 'clientId')::uuid from t where name = 'new')),
  ('New Client', '+15550109999', 'newbie@pb.test', true, (select newbie from ids))::text,
  'the profile is pending, linked to the account, with the verified email');
select is(
  (select (source, stylist_id)::text from public.appointments
    where id = (select (val ->> 'appointmentId')::uuid from t where name = 'new')),
  ('public', (select owner_a from ids))::text,
  'public bookings land on the owner''s calendar');
select is(
  (select kind::text from public.notifications_outbox
    where appointment_id = (select (val ->> 'appointmentId')::uuid from t where name = 'new')),
  'request', 'a requested public booking pushes Approve / Decline');

-- Auto mode: confirmed, with a "New booking" push ---------------------------------------
update public.settings set autonomy = 'auto' where salon_id = (select a from ids);
select pg_temp.as_service_role();
insert into t select 'auto', public.book_public_appointment(
  (select a from ids), (select newbie from ids), pg_temp.booking((select d11 from ids)));
select is((select val ->> 'status' from t where name = 'auto'), 'confirmed',
  'Auto mode confirms a public booking in Open hours');
select ok(not (select (val ->> 'clientCreated')::boolean from t where name = 'auto'),
  'the same account reuses its profile');
select pg_temp.logout();
select is(
  (select (kind, title, data ->> 'type')::text from public.notifications_outbox
    where appointment_id = (select (val ->> 'appointmentId')::uuid from t where name = 'auto')),
  ('public_booking', 'New booking from New Client', 'public_booking')::text,
  'a confirmed public booking pushes the owner');

-- Tentative hours still need approval, even in Auto mode.
insert into public.work_hours_override (salon_id, start_date, end_date, kind, blocks, breaks)
select a, (d12 at time zone 'America/Chicago')::date, (d12 at time zone 'America/Chicago')::date,
       'custom', '[{"start":"00:00","end":"24:00","type":"tentative"}]', '[]' from ids;
select pg_temp.as_service_role();
select is(
  public.book_public_appointment((select a from ids), (select newbie from ids),
                                 pg_temp.booking((select d12 from ids))) ->> 'status',
  'requested', 'a slot in Tentative hours becomes a request');

-- Per-client cap of upcoming public bookings.
select is(
  public.book_public_appointment((select a from ids), (select newbie from ids),
                                 pg_temp.booking((select d13 from ids))) ->> 'reason',
  'limit', 'a client can hold at most 3 upcoming public bookings');

-- Linking existing profiles ---------------------------------------------------------
insert into t select 'karina', public.book_public_appointment(
  (select a from ids), (select karina_user from ids),
  pg_temp.booking((select d13 from ids), 60, '{"name":"Someone Else"}'));
select ok((select (val ->> 'clientLinked')::boolean from t where name = 'karina'),
  'a verified email claims the matching unlinked profile');
select pg_temp.logout();
select is(
  (select (name, user_id)::text from public.clients
    where id = (select (val ->> 'clientId')::uuid from t where name = 'karina')),
  ('Karina Lopez', (select karina_user from ids))::text,
  'the existing profile keeps its name and is linked to the account');

select pg_temp.as_service_role();
insert into t select 'thief', public.book_public_appointment(
  (select a from ids), (select thief from ids),
  pg_temp.booking((select d14 from ids), 60, '{"name":"Maria Phone","phone":"+15550100202"}'));
select pg_temp.logout();
select ok(
  (select (val ->> 'clientCreated')::boolean from t where name = 'thief')
  and (select user_id from public.clients where name = 'Maria Phone' and phone = '+15550100202'
         and salon_id = (select a from ids) and user_id is null and email is null) is null
  and (select count(*) from public.clients where salon_id = (select a from ids)
         and name = 'Maria Phone' and user_id is null) = 1,
  'a matching phone never links someone else''s profile');

-- Conflicts and the off switch -----------------------------------------------------------
select pg_temp.as_service_role();
select is(
  public.book_public_appointment((select a from ids), (select thief from ids),
                                 pg_temp.booking((select d11 from ids))) ->> 'reason',
  'conflict', 'an overlapping slot is rejected, not double-booked');
select pg_temp.logout();
update public.settings set public_booking_enabled = false where salon_id = (select b from ids);
select pg_temp.as_service_role();
select is(
  public.book_public_appointment((select b from ids), (select newbie from ids),
                                 pg_temp.booking((select d10 from ids))) ->> 'reason',
  'disabled', 'a salon can turn its booking page off');

-- Own bookings only -------------------------------------------------------------------
select is(
  jsonb_array_length(public.public_client_bookings((select a from ids), (select newbie from ids))),
  3, 'a client sees their own upcoming bookings');
select is(
  (select array_agg(e ->> 'id') from jsonb_array_elements(
     public.public_client_bookings((select a from ids), (select karina_user from ids))) e),
  array[(select val ->> 'appointmentId' from t where name = 'karina')],
  'and nobody else''s');
select is(
  public.public_client_bookings((select b from ids), (select newbie from ids)), '[]'::jsonb,
  'bookings are per salon');
select is(public.public_client_bookings((select a from ids), null), '[]'::jsonb,
  'no account, no bookings');
select is(
  (select array_agg(k order by k) from jsonb_array_elements(
     public.public_client_bookings((select a from ids), (select karina_user from ids))) e,
     jsonb_object_keys(e) k),
  array['endsAt', 'id', 'services', 'startsAt', 'status'],
  'bookings carry times, status and services only');

-- A profile in one salon is not reused by another.
update public.settings set public_booking_enabled = true where salon_id = (select b from ids);
insert into t select 'other', public.book_public_appointment(
  (select b from ids), (select newbie from ids), pg_temp.booking((select d10 from ids)));
select ok((select (val ->> 'clientCreated')::boolean from t where name = 'other'),
  'each salon gets its own client profile');
select pg_temp.logout();

-- Every public booking is audited.
select is(
  (select count(*)::integer from public.audit_log
    where action = 'public_booking.booked' and salon_id = (select a from ids)),
  5, 'public bookings are written to the audit log');

select * from finish();
rollback;
