-- Agentic Inbox (#34): bridge tokens, capture_inbox_request, outcome sync and member actions.
begin;
select plan(45);

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
  ('00000000-0000-4000-e000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-a@inbox.test'),
  ('00000000-0000-4000-e000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-b@inbox.test');

select pg_temp.login('00000000-0000-4000-e000-00000000000a');
select public.create_salon('Inbox A', 'inbox-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-e000-00000000000b');
select public.create_salon('Inbox B', 'inbox-b', 'America/Chicago');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'inbox-a') as a,
         (select id from public.salons where slug = 'inbox-b') as b,
         '00000000-0000-4000-e000-00000000000a'::uuid as owner_a,
         date_trunc('day', now()) + interval '3 days 15 hours' as day3;
grant select on ids to authenticated, service_role;
create temp table t (name text primary key, id uuid, val text);
grant select, insert, update on t to authenticated, service_role;

insert into public.clients (salon_id, name, phone)
  select a, 'Karina Lopez', '+15550100101' from ids;
insert into t (name, id) select 'karina', id from public.clients where name = 'Karina Lopez';
insert into public.clients (salon_id, name) select b, 'Other Salon Client' from ids;

-- Schema ----------------------------------------------------------------------
select has_table('public', 'inbox_bridges', 'inbox_bridges exists');
select has_table('public', 'captured_requests', 'captured_requests exists');
select col_default_is('public', 'clients', 'pending', 'false', 'clients.pending defaults to false');
select ok(
  exists (select 1 from pg_publication_tables
           where pubname = 'supabase_realtime' and schemaname = 'public'
             and tablename = 'captured_requests'),
  'captured_requests are published to Realtime');

-- Bridge token ------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-e000-00000000000b');
select throws_ok(
  $$ select public.rotate_inbox_bridge_token((select a from ids)) $$,
  '42501', null, 'only the salon''s owner can create its token');
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-e000-00000000000a');
insert into t (name, val) select 'token1', public.rotate_inbox_bridge_token((select a from ids));
insert into t (name, val) select 'token', public.rotate_inbox_bridge_token((select a from ids));
select matches((select val from t where name = 'token'), '^csb_[0-9a-f]{64}$', 'token looks like csb_<hex>');
select is(
  (select (token_hint, keyword) from public.inbox_bridges)::text,
  (right((select val from t where name = 'token'), 4), 'Chairside')::text,
  'owner sees the hint and default keyword');
select is(
  (select count(*)::integer from public.inbox_bridges
    where token_hash like '%' || (select val from t where name = 'token') || '%'),
  0, 'the plaintext token is not stored');
update public.inbox_bridges set keyword = 'Chair side' where salon_id = (select a from ids);
select is((select keyword from public.inbox_bridges), 'Chair side', 'owner can change the keyword');
select throws_ok(
  $$ update public.inbox_bridges set token_hash = repeat('0', 64) $$,
  '42501', null, 'the token hash cannot be written directly');
select throws_ok(
  $$ select * from public.inbox_bridge_for_token('x') $$,
  '42501', null, 'members cannot resolve tokens');
select throws_ok(
  $$ select public.capture_inbox_request((select a from ids), '{}') $$,
  '42501', null, 'members cannot capture requests');
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-e000-00000000000b');
select is((select count(*)::integer from public.inbox_bridges), 0, 'other salons cannot see the bridge');
select pg_temp.logout();

select pg_temp.as_service_role();
select is(
  (select (salon_id, keyword, timezone, rate_limited)::text
     from public.inbox_bridge_for_token((select val from t where name = 'token'))),
  ((select a from ids), 'Chair side', 'America/Chicago', false)::text,
  'service role resolves the token to its salon');
select is_empty(
  $$ select * from public.inbox_bridge_for_token((select val from t where name = 'token1')) $$,
  'a rotated-out token no longer works');
select is_empty($$ select * from public.inbox_bridge_for_token(null) $$, 'no token, no salon');
select is(
  (select rate_limited from public.inbox_bridge_for_token((select val from t where name = 'token'), 1)),
  true, 'requests over the hourly limit are flagged');

-- Capture: unknown sender → pending client + requested appointment ---------------
insert into t (name, val) select 'new', public.capture_inbox_request((select a from ids), jsonb_build_object(
  'dedupeKey', 'k-new', 'channel', 'sms', 'sender', '+15550199999', 'senderPhone', '+15550199999',
  'message', 'hey can I get color + trim fri afternoon?',
  'parsed', '{"intent":"booking","timeOfDay":"afternoon"}'::jsonb, 'intent', 'booking',
  'newClient', jsonb_build_object('name', 'Text from (555) 019-9999', 'phone', '+15550199999'),
  'segments', pg_temp.seg((select day3 from ids), 90),
  'services', '[{"serviceId":"00000000-0000-4000-e000-0000000000f1","name":"All-over Color"}]'::jsonb))::text;
insert into t (name, id) select 'new_req', (val::jsonb ->> 'id')::uuid from t where name = 'new';
insert into t (name, id) select 'new_appt', (val::jsonb ->> 'appointmentId')::uuid from t where name = 'new';
insert into t (name, id) select 'new_client', (val::jsonb ->> 'clientId')::uuid from t where name = 'new';

select is((select (val::jsonb ->> 'clientCreated')::boolean from t where name = 'new'), true,
  'an unknown number creates a client');
select is(
  (select (name, phone, pending)::text from public.clients where id = (select id from t where name = 'new_client')),
  ('Text from (555) 019-9999', '+15550199999', true)::text, 'the new client is pending');
select is(
  (select (status, source, stylist_id, requested_at is not null)::text from public.appointments
    where id = (select id from t where name = 'new_appt')),
  ('requested', 'inbox', (select owner_a from ids), true)::text,
  'the slot is held as a requested inbox appointment on the owner''s calendar');
select is(
  (select (status, intent, client_created, appointment_id)::text from public.captured_requests
    where id = (select id from t where name = 'new_req')),
  ('pending', 'booking', true, (select id from t where name = 'new_appt'))::text,
  'the captured request is pending and linked to the hold');
select is(
  (select count(*)::integer from public.notifications_outbox
    where appointment_id = (select id from t where name = 'new_appt') and kind = 'request'),
  1, 'the owner gets a request push');

select is(
  public.capture_inbox_request((select a from ids), jsonb_build_object(
    'dedupeKey', 'k-new', 'message', 'hey can I get color + trim fri afternoon?', 'intent', 'booking',
    'newClient', jsonb_build_object('name', 'Dup'), 'segments', pg_temp.seg((select day3 from ids) + interval '3 hours'))),
  jsonb_build_object('id', (select id from t where name = 'new_req'), 'duplicate', true),
  'a retried message is deduplicated');
select is((select count(*)::integer from public.clients where name = 'Dup'), 0,
  'a duplicate creates nothing');

-- Known client, slot taken in the meantime --------------------------------------
insert into t (name, val) select 'taken', public.capture_inbox_request((select a from ids), jsonb_build_object(
  'dedupeKey', 'k-taken', 'message', 'cut fri?', 'intent', 'booking',
  'clientId', (select id from t where name = 'karina'),
  'segments', pg_temp.seg((select day3 from ids) + interval '30 minutes', 30)))::text;
select is(
  (select (val::jsonb -> 'appointmentId', val::jsonb ->> 'clientCreated')::text from t where name = 'taken'),
  ('null'::jsonb, 'false')::text, 'a conflicting slot is not booked and no client is created');
select is(
  (select note from public.captured_requests where dedupe_key = 'k-taken'),
  'The suggested time was just taken. Pick another time.', 'the request explains why there is no hold');

select throws_ok(
  $$ select public.capture_inbox_request((select a from ids), jsonb_build_object(
       'dedupeKey', 'k-x', 'message', 'x', 'intent', 'booking',
       'clientId', (select id from public.clients where salon_id = (select b from ids) limit 1))) $$,
  '22023', null, 'clients from another salon are rejected');
select pg_temp.logout();

-- RLS ---------------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-e000-00000000000b');
select is((select count(*)::integer from public.captured_requests), 0, 'other salons see no requests');
select throws_ok(
  $$ select public.resolve_captured_request((select id from t where name = 'new_req'), 'dismiss') $$,
  'P0002', null, 'other salons cannot act on a request');
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-e000-00000000000a');
select is((select count(*)::integer from public.captured_requests), 2, 'members see their requests');
select throws_ok(
  $$ insert into public.captured_requests (salon_id, message, intent, dedupe_key)
     values ((select a from ids), 'x', 'booking', 'x') $$,
  '42501', null, 'members cannot write requests directly');

-- Approve: request approved, client no longer pending ------------------------------
select public.set_appointment_status((select id from t where name = 'new_appt'), 'confirmed');
select is(
  (select (status, resolved_at is not null)::text from public.captured_requests
    where id = (select id from t where name = 'new_req')),
  ('approved', true)::text, 'approving the appointment approves the request');
select is((select pending from public.clients where id = (select id from t where name = 'new_client')),
  false, 'a confirmed booking makes the client a regular client');
select throws_ok(
  $$ select public.resolve_captured_request((select id from t where name = 'new_req'), 'dismiss') $$,
  '22023', null, 'a handled request cannot be resolved again');
select pg_temp.logout();

-- Decline / expiry -------------------------------------------------------------------
select pg_temp.as_service_role();
insert into t (name, id) select 'decl', (public.capture_inbox_request((select a from ids), jsonb_build_object(
  'dedupeKey', 'k-decl', 'message', 'cut sat?', 'intent', 'booking',
  'clientId', (select id from t where name = 'karina'),
  'segments', pg_temp.seg((select day3 from ids) + interval '1 day'))) ->> 'appointmentId')::uuid;
insert into t (name, id) select 'exp', (public.capture_inbox_request((select a from ids), jsonb_build_object(
  'dedupeKey', 'k-exp', 'message', 'cut sun?', 'intent', 'booking',
  'clientId', (select id from t where name = 'karina'),
  'segments', pg_temp.seg((select day3 from ids) + interval '2 days'))) ->> 'appointmentId')::uuid;
select public.set_appointment_status((select id from t where name = 'exp'), 'cancelled', 'request_expired');
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-e000-00000000000a');
select public.set_appointment_status((select id from t where name = 'decl'), 'cancelled', 'declined');
select is((select status::text from public.captured_requests where appointment_id = (select id from t where name = 'decl')),
  'declined', 'declining the appointment declines the request');
select is((select status::text from public.captured_requests where appointment_id = (select id from t where name = 'exp')),
  'expired', 'an expired request is marked expired');

-- Reschedule: approving the new time frees the old one -----------------------------
select public.book_appointment((select a from ids), (select id from t where name = 'karina'),
  pg_temp.seg((select day3 from ids) + interval '5 days'));
insert into t (name, id) select 'old', id from public.appointments
  where starts_at = (select day3 from ids) + interval '5 days';
select pg_temp.logout();

select pg_temp.as_service_role();
insert into t (name, id) select 'moved', (public.capture_inbox_request((select a from ids), jsonb_build_object(
  'dedupeKey', 'k-move', 'message', 'can I move my cut to the 6th?', 'intent', 'reschedule',
  'clientId', (select id from t where name = 'karina'),
  'targetAppointmentId', (select id from t where name = 'old'),
  'segments', pg_temp.seg((select day3 from ids) + interval '6 days'))) ->> 'appointmentId')::uuid;
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-e000-00000000000a');
select is((select status::text from public.appointments where id = (select id from t where name = 'old')),
  'confirmed', 'the old appointment stays until the move is approved');
select public.set_appointment_status((select id from t where name = 'moved'), 'confirmed');
select is(
  (select (status, cancel_reason)::text from public.appointments where id = (select id from t where name = 'old')),
  ('cancelled', 'rescheduled')::text, 'approving the move cancels the old appointment');
select is((select status::text from public.captured_requests where dedupe_key = 'k-move'),
  'approved', 'the reschedule request is approved');
select pg_temp.logout();

-- Dismiss and cancel ------------------------------------------------------------------
select pg_temp.as_service_role();
insert into t (name, id) select 'junk', (public.capture_inbox_request((select a from ids), jsonb_build_object(
  'dedupeKey', 'k-junk', 'message', 'book me lol', 'intent', 'booking',
  'clientId', (select id from t where name = 'karina'),
  'segments', pg_temp.seg((select day3 from ids) + interval '7 days'))) ->> 'id')::uuid;
insert into t (name, id) select 'cxl', (public.capture_inbox_request((select a from ids), jsonb_build_object(
  'dedupeKey', 'k-cxl', 'message', 'need to cancel on the 6th sorry', 'intent', 'cancel',
  'clientId', (select id from t where name = 'karina'),
  'targetAppointmentId', (select id from t where name = 'moved'))) ->> 'id')::uuid;
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-e000-00000000000a');
select is(
  (select (status, resolved_at is not null)::text
     from public.resolve_captured_request((select id from t where name = 'junk'), 'dismiss')),
  ('dismissed', true)::text, 'dismiss marks the request dismissed');
select is(
  (select (a.status, a.cancel_reason)::text from public.appointments a
     join public.captured_requests c on c.appointment_id = a.id
    where c.id = (select id from t where name = 'junk')),
  ('cancelled', 'ignored')::text, 'dismissing releases the hold quietly');
select is((select status::text from public.captured_requests where id = (select id from t where name = 'junk')),
  'dismissed', 'the release does not turn a dismissal into a decline');
select throws_ok(
  $$ select public.resolve_captured_request((select id from t where name = 'cxl'), 'nope') $$,
  '22023', null, 'unknown actions are rejected');
select is(
  (select status::text from public.resolve_captured_request((select id from t where name = 'cxl'), 'cancel_appointment')),
  'approved', 'confirming a cancellation approves the request');
select is(
  (select (status, cancel_reason)::text from public.appointments where id = (select id from t where name = 'moved')),
  ('cancelled', 'Cancelled by client')::text, 'and cancels the appointment it refers to');
select pg_temp.logout();

select * from finish();
rollback;
