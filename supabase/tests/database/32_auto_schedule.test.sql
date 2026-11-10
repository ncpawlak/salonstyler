-- Auto-Schedule (#84): schedule_captured_request books / moves the picked slot and approves.
begin;
select plan(20);

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

create function pg_temp.seg(p_start timestamptz, p_minutes integer default 60) returns jsonb
language sql as $$
  select jsonb_build_array(jsonb_build_object(
    'kind', 'busy', 'start', p_start, 'end', p_start + make_interval(mins => p_minutes)));
$$;
grant execute on function pg_temp.seg(timestamptz, integer) to authenticated, service_role;

insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-4000-e320-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-a@autosched.test'),
  ('00000000-0000-4000-e320-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-b@autosched.test');

select pg_temp.login('00000000-0000-4000-e320-00000000000a');
select public.create_salon('Auto A', 'auto-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-e320-00000000000b');
select public.create_salon('Auto B', 'auto-b', 'America/Chicago');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'auto-a') as a,
         date_trunc('day', now()) + interval '3 days 15 hours' as day3;
grant select on ids to authenticated, service_role;
create temp table t (name text primary key, id uuid);
grant select, insert, update on t to authenticated, service_role;

create function pg_temp.capture(p_key text, p_request jsonb) returns uuid language sql as $$
  select (public.capture_inbox_request((select a from ids),
            jsonb_build_object('dedupeKey', p_key, 'sender', 'Karina', 'message', 'text ' || p_key)
            || p_request) ->> 'id')::uuid;
$$;
grant execute on function pg_temp.capture(text, jsonb) to service_role;

insert into public.clients (salon_id, name, phone) select a, 'Karina Lopez', '+15550100101' from ids;
insert into t (name, id) select 'karina', id from public.clients where name = 'Karina Lopez';

-- Karina's confirmed appointment (day 4, 10 AM) that she asks to move.
select pg_temp.login('00000000-0000-4000-e320-00000000000a');
insert into t (name, id) select 'target', (public.book_appointment(
  (select a from ids), (select id from t where name = 'karina'),
  pg_temp.seg((select day3 from ids) + interval '1 day'), '[]', 'confirmed', 'owner')).id;
-- Someone else at day 5, 10 AM.
insert into t (name, id) select 'other', (public.book_appointment(
  (select a from ids), null, pg_temp.seg((select day3 from ids) + interval '2 days'))).id;
select pg_temp.logout();

select pg_temp.as_service_role();
-- r1: a booking the pipeline held a slot for (day 3, 10 AM).
insert into t (name, id) select 'r1', pg_temp.capture('r1', jsonb_build_object(
  'intent', 'booking', 'clientId', (select id from t where name = 'karina'),
  'segments', pg_temp.seg((select day3 from ids))));
-- r2: a new client's booking that nothing was held for.
insert into t (name, id) select 'r2', pg_temp.capture('r2', jsonb_build_object(
  'intent', 'booking', 'parsed', jsonb_build_object('notes', 'long hair'),
  'newClient', jsonb_build_object('name', 'Text from Rachel', 'phone', '+15550100303')));
-- r3: "move my appointment to next week", with a held slot on day 4 at 11.
insert into t (name, id) select 'r3', pg_temp.capture('r3', jsonb_build_object(
  'intent', 'reschedule', 'clientId', (select id from t where name = 'karina'),
  'targetAppointmentId', (select id from t where name = 'target'),
  'segments', pg_temp.seg((select day3 from ids) + interval '1 day 1 hour')));
insert into t (name, id) select 'r4', pg_temp.capture('r4', jsonb_build_object(
  'intent', 'cancel', 'clientId', (select id from t where name = 'karina'),
  'targetAppointmentId', (select id from t where name = 'target')));
insert into t (name, id) select 'r5', pg_temp.capture('r5', jsonb_build_object(
  'intent', 'booking', 'clientId', (select id from t where name = 'karina')));
select pg_temp.logout();
insert into t (name, id) select 'r1_hold', appointment_id from public.captured_requests
 where id = (select id from t where name = 'r1');
insert into t (name, id) select 'r3_hold', appointment_id from public.captured_requests
 where id = (select id from t where name = 'r3');

select has_function('public', 'schedule_captured_request',
  array['uuid', 'jsonb', 'jsonb', 'integer'], 'schedule_captured_request exists');

-- Another salon can't touch it -----------------------------------------------------------
select pg_temp.login('00000000-0000-4000-e320-00000000000b');
select throws_ok(
  $$ select public.schedule_captured_request((select id from t where name = 'r1'),
       pg_temp.seg((select day3 from ids) + interval '2 hours')) $$,
  'P0002', null, 'another salon cannot schedule the request');
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-e320-00000000000a');

-- Booking with a held slot: the hold moves and is approved ---------------------------------
select is(
  (select (id, status, starts_at)::text from public.schedule_captured_request(
     (select id from t where name = 'r1'), pg_temp.seg((select day3 from ids) + interval '2 hours'),
     '[{"serviceId":"00000000-0000-4000-8000-0000000000c1","name":"Cut"}]', 6500)),
  ((select id from t where name = 'r1_hold'), 'confirmed', (select day3 from ids) + interval '2 hours')::text,
  'the request''s hold moves to the picked time and is confirmed');
select is(
  (select (status, appointment_id, resolved_at is not null)::text
     from public.captured_requests where id = (select id from t where name = 'r1')),
  ('approved', (select id from t where name = 'r1_hold'), true)::text,
  'the request is approved');
select is(
  (select (services ->> 0)::jsonb ->> 'name' || ' ' || price_cents
     from public.appointments where id = (select id from t where name = 'r1_hold')),
  'Cut 6500', 'the picked services and price are saved');
select is(
  (select count(*)::integer from public.audit_log
    where action = 'captured_request.auto_scheduled'
      and entity_id = (select id from t where name = 'r1')::text),
  1, 'auto-scheduling is audited');

select throws_ok(
  $$ select public.schedule_captured_request((select id from t where name = 'r1'),
       pg_temp.seg((select day3 from ids) + interval '4 hours')) $$,
  '22023', null, 'a handled request cannot be scheduled again');

-- Booking without a hold: a new inbox appointment ---------------------------------------
insert into t (name, id) select 'r2_appt', (public.schedule_captured_request(
  (select id from t where name = 'r2'), pg_temp.seg((select day3 from ids) + interval '5 hours'))).id;
select is(
  (select (a.status, a.source, a.notes, c.pending)::text
     from public.appointments a join public.clients c on c.id = a.client_id
    where a.id = (select id from t where name = 'r2_appt')),
  ('confirmed', 'inbox', 'Requested by text: long hair', false)::text,
  'a new inbox appointment is booked and confirmed; the new client is no longer pending');
select is(
  (select (status, appointment_id)::text
     from public.captured_requests where id = (select id from t where name = 'r2')),
  ('approved', (select id from t where name = 'r2_appt'))::text,
  'the request is linked to the new appointment and approved');

-- Reschedule: the existing appointment moves in place ------------------------------------
-- Overlaps both the old time (10–11) and the held slot (11–12): neither blocks the move.
select is(
  (select (id, status, starts_at)::text from public.schedule_captured_request(
     (select id from t where name = 'r3'),
     pg_temp.seg((select day3 from ids) + interval '1 day 30 minutes', 60))),
  ((select id from t where name = 'target'), 'confirmed',
   (select day3 from ids) + interval '1 day 30 minutes')::text,
  'a reschedule moves the client''s appointment');
select is(
  (select (status, cancel_reason)::text from public.appointments
    where id = (select id from t where name = 'r3_hold')),
  ('cancelled', 'replaced')::text, 'the slot the pipeline held is released');
select is(
  (select (status, appointment_id)::text
     from public.captured_requests where id = (select id from t where name = 'r3')),
  ('approved', (select id from t where name = 'target'))::text,
  'the reschedule request is approved (not declined by releasing its hold)');
select is(
  (select count(*)::integer from public.appointments
    where client_id = (select id from t where name = 'karina') and status = 'confirmed'
      and starts_at::date = ((select day3 from ids) + interval '1 day')::date),
  1, 'the client still has exactly one appointment that day');

-- Guards -------------------------------------------------------------------------------
select throws_ok(
  $$ select public.schedule_captured_request((select id from t where name = 'r4'),
       pg_temp.seg((select day3 from ids) + interval '6 hours')) $$,
  '22023', null, 'a cancellation cannot be scheduled');
select throws_ok(
  $$ select public.schedule_captured_request((select id from t where name = 'r5'),
       pg_temp.seg((select day3 from ids) + interval '2 days 30 minutes')) $$,
  '23P01', null, 'a slot overlapping another appointment is refused');
select is(
  (select (status, appointment_id is null)::text
     from public.captured_requests where id = (select id from t where name = 'r5')),
  ('pending', true)::text, 'a refused slot leaves the request pending');

-- Auto-send on: approving queues the confirmation ---------------------------------------
select public.rotate_inbox_bridge_token((select a from ids));
update public.settings set auto_send_replies = true where salon_id = (select a from ids);
select lives_ok(
  $$ select public.schedule_captured_request((select id from t where name = 'r5'),
       pg_temp.seg((select day3 from ids) + interval '3 days')) $$,
  'with auto-send on, the stylist schedules the request');
select is(
  (select (kind, status, to_phone)::text from public.client_replies
    where captured_request_id = (select id from t where name = 'r5')),
  ('confirm', 'queued', '+15550100101')::text,
  'the confirmation is queued for the bridge');
select is(
  (select count(*)::integer from public.client_replies
    where captured_request_id in ((select id from t where name = 'r1'), (select id from t where name = 'r3'))),
  0, 'with auto-send off, nothing was queued (the app drafts the reply)');
select pg_temp.logout();

select ok(
  has_function_privilege('authenticated',
    'public.schedule_captured_request(uuid, jsonb, jsonb, integer)', 'execute')
  and not has_function_privilege('anon',
    'public.schedule_captured_request(uuid, jsonb, jsonb, integer)', 'execute'),
  'signed-in members can call it; anonymous callers cannot');

select * from finish();
rollback;