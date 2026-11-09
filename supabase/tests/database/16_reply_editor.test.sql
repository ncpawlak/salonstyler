-- Reply editor (#7): reply settings, record_client_reply, auto-reply queue.
begin;
select plan(22);

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
  ('00000000-0000-4000-e100-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-a@reply.test'),
  ('00000000-0000-4000-e100-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-b@reply.test');

select pg_temp.login('00000000-0000-4000-e100-00000000000a');
select public.create_salon('Reply A', 'reply-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-e100-00000000000b');
select public.create_salon('Reply B', 'reply-b', 'America/Chicago');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'reply-a') as a,
         (select id from public.salons where slug = 'reply-b') as b,
         date_trunc('day', now()) + interval '3 days 15 hours' as day3;
grant select on ids to authenticated, service_role;
create temp table t (name text primary key, id uuid, val text);
grant select, insert, update on t to authenticated, service_role;

insert into public.clients (salon_id, name, phone) select a, 'Karina Lopez', '+15550100101' from ids;
insert into t (name, id) select 'karina', id from public.clients where name = 'Karina Lopez';
insert into public.clients (salon_id, name) select b, 'Other Salon Client' from ids;
insert into t (name, id) select 'other_client', id from public.clients where name = 'Other Salon Client';

select pg_temp.as_service_role();
insert into t (name, val) select 'r1', public.capture_inbox_request((select a from ids), jsonb_build_object(
  'dedupeKey', 'r-1', 'sender', 'Karina', 'message', 'cut fri?', 'intent', 'booking',
  'clientId', (select id from t where name = 'karina'),
  'segments', pg_temp.seg((select day3 from ids))))::text;
insert into t (name, val) select 'r2', public.capture_inbox_request((select a from ids), jsonb_build_object(
  'dedupeKey', 'r-2', 'sender', '+15550100202', 'senderPhone', '+15550100202', 'message', 'trim sat?',
  'intent', 'booking',
  'newClient', jsonb_build_object('name', 'Text from (555) 010-0202', 'phone', '+15550100202'),
  'segments', pg_temp.seg((select day3 from ids) + interval '1 day')))::text;
insert into t (name, val) select 'r3', public.capture_inbox_request((select a from ids), jsonb_build_object(
  'dedupeKey', 'r-3', 'sender', 'Karina', 'message', 'color sun?', 'intent', 'booking',
  'clientId', (select id from t where name = 'karina'),
  'segments', pg_temp.seg((select day3 from ids) + interval '2 days')))::text;
select pg_temp.logout();
insert into t (name, id) select name || '_req', (val::jsonb ->> 'id')::uuid from t where name in ('r1', 'r2', 'r3');
insert into t (name, id) select name || '_appt', (val::jsonb ->> 'appointmentId')::uuid from t where name in ('r1', 'r2', 'r3');

-- Schema / settings -----------------------------------------------------------------
select has_table('public', 'client_replies', 'client_replies exists');
select col_default_is('public', 'settings', 'auto_send_replies', 'false', 'auto-reply is off by default');
select ok(
  exists (select 1 from pg_publication_tables
           where pubname = 'supabase_realtime' and schemaname = 'public'
             and tablename = 'client_replies'),
  'client_replies are published to Realtime');

select pg_temp.login('00000000-0000-4000-e100-00000000000a');
update public.settings
   set reply_tone_examples = 'hey love! see you then 💕', booking_link = 'https://book.example.com/a',
       reply_include_booking_link = true
 where salon_id = (select a from ids);
select is(
  (select (booking_link, reply_include_booking_link)::text from public.settings
    where salon_id = (select a from ids)),
  ('https://book.example.com/a', true)::text, 'owner saves reply preferences');
select throws_ok(
  $$ update public.settings set booking_link = 'javascript:alert(1)' where salon_id = (select a from ids) $$,
  '23514', null, 'the booking link must be https');

-- Approving without auto-reply queues nothing ------------------------------------------
select public.set_appointment_status((select id from t where name = 'r1_appt'), 'confirmed');
select is((select count(*)::integer from public.client_replies), 0,
  'with auto-reply off, approving queues no reply');

-- record_client_reply --------------------------------------------------------------------
insert into t (name, id) select 'sent1', (public.record_client_reply((select a from ids), jsonb_build_object(
  'kind', 'confirm', 'body', 'You''re booked Fri at 3!', 'channel', 'messages', 'source', 'edited',
  'toPhone', '+15550100101', 'capturedRequestId', (select id from t where name = 'r1_req')))).id;
select is(
  (select (kind, status, channel, source, appointment_id, client_id, sent_at is not null)::text
     from public.client_replies where id = (select id from t where name = 'sent1')),
  ('confirm', 'sent', 'messages', 'edited', (select id from t where name = 'r1_appt'),
   (select id from t where name = 'karina'), true)::text,
  'a sent reply is recorded and linked to the request''s appointment and client');
select is(
  (select count(*)::integer from public.audit_log where action = 'reply.sent'
     and entity_id = (select id from t where name = 'sent1')::text),
  1, 'sending a reply is audited');
select throws_ok(
  $$ select public.record_client_reply((select a from ids), '{"kind":"confirm","body":"  ","channel":"messages"}') $$,
  '22023', null, 'an empty reply is rejected');
select throws_ok(
  $$ select public.record_client_reply((select a from ids), '{"kind":"other","body":"hi","channel":"bridge"}') $$,
  '22023', null, 'the app cannot record bridge sends');
select throws_ok(
  $$ select public.record_client_reply((select a from ids),
       jsonb_build_object('kind', 'other', 'body', 'hi', 'channel', 'copy',
                          'clientId', (select id from t where name = 'other_client'))) $$,
  'P0002', null, 'replies cannot reference another salon''s client');
select throws_ok(
  $$ insert into public.client_replies (salon_id, kind, body, channel)
     values ((select a from ids), 'other', 'x', 'messages') $$,
  '42501', null, 'members cannot write replies directly');
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-e100-00000000000b');
select is((select count(*)::integer from public.client_replies), 0, 'other salons cannot see replies');
select throws_ok(
  $$ select public.record_client_reply((select a from ids), '{"kind":"other","body":"hi","channel":"copy"}') $$,
  '42501', null, 'non-members cannot record replies');
select pg_temp.logout();

-- Auto-reply needs the bridge -------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-e100-00000000000a');
update public.settings set auto_send_replies = true where salon_id = (select a from ids);
select public.set_appointment_status((select id from t where name = 'r2_appt'), 'confirmed');
select is((select count(*)::integer from public.client_replies where status = 'queued'), 0,
  'auto-reply without a text bridge queues nothing');
select pg_temp.logout();

-- Auto-reply on + bridge: approving queues a bridge reply -------------------------------------
select pg_temp.login('00000000-0000-4000-e100-00000000000a');
select public.rotate_inbox_bridge_token((select a from ids));
select public.set_appointment_status((select id from t where name = 'r3_appt'), 'confirmed');
select is(
  (select (kind, status, channel, to_phone, body is null, appointment_id)::text
     from public.client_replies where captured_request_id = (select id from t where name = 'r3_req')),
  ('confirm', 'queued', 'bridge', '+15550100101', true, (select id from t where name = 'r3_appt'))::text,
  'approving queues a confirmation for the bridge to send');
select pg_temp.logout();

-- A new-client request falls back to the sender's phone; a cancel queues "cancelled". -------------
select pg_temp.as_service_role();
insert into t (name, val) select 'r4', public.capture_inbox_request((select a from ids), jsonb_build_object(
  'dedupeKey', 'r-4', 'sender', '+15550100404', 'senderPhone', '+15550100404', 'message', 'cut mon?',
  'intent', 'booking',
  'newClient', jsonb_build_object('name', 'Text from (555) 010-0404'),
  'segments', pg_temp.seg((select day3 from ids) + interval '4 days')))::text;
insert into t (name, id) select 'r4_appt', (val::jsonb ->> 'appointmentId')::uuid from t where name = 'r4';
insert into t (name, id) select 'r4_req', (val::jsonb ->> 'id')::uuid from t where name = 'r4';
select public.set_appointment_status((select id from t where name = 'r4_appt'), 'confirmed');
select is(
  (select to_phone from public.client_replies where captured_request_id = (select id from t where name = 'r4_req')),
  '+15550100404', 'a client without a phone gets the reply at the sender''s number');

insert into t (name, val) select 'r5', public.capture_inbox_request((select a from ids), jsonb_build_object(
  'dedupeKey', 'r-5', 'sender', 'Karina', 'message', 'cancel my sun appt', 'intent', 'cancel',
  'clientId', (select id from t where name = 'karina'),
  'targetAppointmentId', (select id from t where name = 'r3_appt')))::text;
insert into t (name, id) select 'r5_req', (val::jsonb ->> 'id')::uuid from t where name = 'r5';
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-e100-00000000000a');
select public.resolve_captured_request((select id from t where name = 'r5_req'), 'cancel_appointment');
select is(
  (select (kind, status, appointment_id)::text from public.client_replies
    where captured_request_id = (select id from t where name = 'r5_req')),
  ('cancelled', 'queued', (select id from t where name = 'r3_appt'))::text,
  'approving a cancellation queues a "cancelled" reply');

-- Sending from the editor cancels the queued bridge reply ---------------------------------------
select public.record_client_reply((select a from ids), jsonb_build_object(
  'kind', 'cancelled', 'body', 'All set, you''re cancelled.', 'channel', 'messages',
  'capturedRequestId', (select id from t where name = 'r5_req')));
select is(
  (select string_agg(status, ',' order by status) from public.client_replies
    where captured_request_id = (select id from t where name = 'r5_req')),
  'cancelled,sent', 'a reply sent from the editor cancels the queued one');
select pg_temp.logout();

-- Turning auto-reply off stops queueing -------------------------------------------------------
select pg_temp.login('00000000-0000-4000-e100-00000000000a');
update public.settings set auto_send_replies = false where salon_id = (select a from ids);
select is((select auto_send_replies from public.settings where salon_id = (select a from ids)), false,
  'owner can turn auto-reply off');
select pg_temp.logout();

-- Constraints -------------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.client_replies (salon_id, kind, status, channel)
     values ((select a from ids), 'confirm', 'sent', 'bridge') $$,
  '23514', null, 'a sent reply needs a body and sent_at');
select throws_ok(
  $$ insert into public.client_replies (salon_id, client_id, kind, status, channel)
     values ((select a from ids), (select id from t where name = 'other_client'), 'confirm', 'queued', 'bridge') $$,
  '23503', null, 'replies cannot reference another salon''s client (FK)');

select * from finish();
rollback;
