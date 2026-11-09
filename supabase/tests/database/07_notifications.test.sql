-- Push notifications: outbox enqueueing, tentative approval, nudge/expiry timing, quiet hours,
-- daily agenda and the notifier RPCs (issue #8).
begin;
select plan(54);

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

-- One busy segment of p_minutes starting at p_start.
create function pg_temp.seg(p_start timestamptz, p_minutes integer default 60) returns jsonb
language sql as $$
  select jsonb_build_array(jsonb_build_object(
    'kind', 'busy', 'start', p_start, 'end', p_start + make_interval(mins => p_minutes)));
$$;
grant execute on function pg_temp.seg(timestamptz, integer) to authenticated, service_role;

insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-4000-e000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-a@notify.test'),
  ('00000000-0000-4000-e000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-b@notify.test');

select pg_temp.login('00000000-0000-4000-e000-00000000000a');
select public.create_salon('Notify A', 'notify-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-e000-00000000000b');
select public.create_salon('Notify B', 'notify-b', 'America/Chicago');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'notify-a') as a,
         (select id from public.salons where slug = 'notify-b') as b,
         '00000000-0000-4000-e000-00000000000a'::uuid as owner_a,
         '00000000-0000-4000-e000-00000000000b'::uuid as owner_b;
grant select on ids to authenticated, service_role;
create temp table t (name text primary key, id uuid);
grant select, insert on t to authenticated, service_role;

insert into public.clients (salon_id, name)
  select a, 'Karina' from ids;
insert into t select 'karina', id from public.clients where name = 'Karina'
  and salon_id = (select a from ids);

-- Schema ----------------------------------------------------------------------
select has_table('public', 'notifications_outbox', 'notifications_outbox exists');
select has_column('public', 'settings', 'quiet_hours_enabled', 'settings has quiet hours');
select has_column('public', 'settings', 'daily_agenda_enabled', 'settings has the daily agenda toggle');
select has_column('public', 'appointments', 'requested_at', 'appointments has requested_at');
select is(
  (select count(*)::integer from cron.job
    where jobname = 'notifications-tick' and command like '%notifications_tick%'),
  1, 'pg_cron drives the notifications tick');
select is(
  (select (followup_nudge_hours, hold_expiry_hours, quiet_hours_enabled, daily_agenda_enabled)::text
     from public.settings where salon_id = (select a from ids)),
  (24, 24, false, true)::text, 'defaults: nudge after 1 day, expiry 1 day, quiet hours off, agenda on');

-- New requests enqueue an actionable push ---------------------------------------
select pg_temp.as_service_role();
insert into t select 'req1', (public.book_appointment(
  (select a from ids), (select id from t where name = 'karina'), pg_temp.seg('2030-01-08 15:00+00'),
  '[{"serviceId":"x","name":"Balayage"},{"serviceId":"y","name":"Trim"}]'::jsonb,
  'requested', 'inbox', null, null, (select owner_a from ids))).id;
select pg_temp.logout();

select is(
  (select count(*)::integer from public.notifications_outbox
    where appointment_id = (select id from t where name = 'req1') and kind = 'request'),
  1, 'an inbox request enqueues one request push');
select is(
  (select (user_id, category, status, title)::text from public.notifications_outbox
    where appointment_id = (select id from t where name = 'req1') and kind = 'request'),
  ((select owner_a from ids), 'appointmentRequest', 'pending'::public.notification_status,
   'New request from Karina')::text,
  'the push goes to the stylist with the Approve / Other time / Decline category');
select is(
  (select body from public.notifications_outbox
    where appointment_id = (select id from t where name = 'req1') and kind = 'request'),
  'Tue, Jan 8 at 9:00 AM · Balayage + Trim', 'body shows salon-local time and services');
select is(
  (select data ->> 'appointmentId' from public.notifications_outbox
    where appointment_id = (select id from t where name = 'req1') and kind = 'request'),
  (select id::text from t where name = 'req1'), 'data carries the appointment id for the action');
select isnt(
  (select requested_at from public.appointments where id = (select id from t where name = 'req1')),
  null, 'requested_at is stamped');

select pg_temp.login('00000000-0000-4000-e000-00000000000a');
insert into t select 'own_req', (public.book_appointment(
  (select a from ids), null, pg_temp.seg('2030-01-08 17:00+00'), '[]', 'requested')).id;
insert into t select 'own_conf', (public.book_appointment(
  (select a from ids), null, pg_temp.seg('2030-01-08 18:00+00'))).id;
select pg_temp.logout();
select is(
  (select count(*)::integer from public.notifications_outbox
    where appointment_id in (select id from t where name in ('own_req', 'own_conf'))),
  0, 'his own bookings never notify him');

-- Tentative hours always require approval ---------------------------------------
-- Tuesdays: 9-12 open, 12-17 tentative (America/Chicago).
insert into public.work_hours_template (salon_id, weekday, blocks)
  select a, 2, '[{"start":"09:00","end":"12:00","type":"open"},{"start":"12:00","end":"17:00","type":"tentative"}]'
  from ids;

select pg_temp.as_service_role();
insert into t select 'tent', (public.book_appointment(
  (select a from ids), null, pg_temp.seg('2030-01-15 18:30+00'), '[]', 'confirmed', 'public',
  null, null, (select owner_a from ids))).id;
insert into t select 'open', (public.book_appointment(
  (select a from ids), null, pg_temp.seg('2030-01-15 15:00+00'), '[]', 'confirmed', 'public',
  null, null, (select owner_a from ids))).id;
insert into t select 'edge', (public.book_appointment(
  (select a from ids), null, pg_temp.seg('2030-01-15 17:30+00', 30), '[]', 'confirmed', 'public',
  null, null, (select owner_a from ids))).id;
insert into t select 'held_tent', (public.book_appointment(
  (select a from ids), null, pg_temp.seg('2030-01-15 20:00+00'), '[]', 'held', 'public',
  null, null, (select owner_a from ids))).id;
select public.set_appointment_status((select id from t where name = 'held_tent'), 'confirmed');
select pg_temp.logout();

select is(
  (select status from public.appointments where id = (select id from t where name = 'tent')),
  'requested'::public.appointment_status, 'a client booking in Tentative hours becomes a request');
select is(
  (select count(*)::integer from public.notifications_outbox
    where appointment_id = (select id from t where name = 'tent') and kind = 'request'),
  1, 'the tentative booking sends a request push');
select is(
  (select status from public.appointments where id = (select id from t where name = 'open')),
  'confirmed'::public.appointment_status, 'a client booking in Open hours stays confirmed');
select is(
  (select status from public.appointments where id = (select id from t where name = 'edge')),
  'confirmed'::public.appointment_status, 'ending exactly where Tentative starts is not tentative');
select is(
  (select status from public.appointments where id = (select id from t where name = 'held_tent')),
  'requested'::public.appointment_status, 'confirming a hold in Tentative hours needs approval');

select pg_temp.login('00000000-0000-4000-e000-00000000000a');
insert into t select 'owner_tent', (public.book_appointment(
  (select a from ids), null, pg_temp.seg('2030-01-15 22:00+00'))).id;
select pg_temp.logout();
select is(
  (select status from public.appointments where id = (select id from t where name = 'owner_tent')),
  'confirmed'::public.appointment_status, 'he can book his own Tentative time directly');

-- A date override replaces the template.
insert into public.work_hours_override (salon_id, start_date, end_date, kind, blocks)
  select a, '2030-01-22', '2030-01-22', 'custom', '[{"start":"09:00","end":"17:00","type":"open"}]'
  from ids;
select is(
  private.overlaps_tentative_hours((select a from ids), '2030-01-22 18:30+00', '2030-01-22 19:30+00'),
  false, 'an all-open override beats the tentative template');
select is(
  private.overlaps_tentative_hours((select a from ids), '2030-01-29 18:30+00', '2030-01-29 19:30+00'),
  true, 'the template applies again the next week');

-- Nudge after followup_nudge_hours; one per request --------------------------------
select is(private.enqueue_request_nudges(now() + interval '23 hours 59 minutes'), 0,
  'no nudge before the nudge delay');
select is(private.enqueue_request_nudges(now() + interval '24 hours'), 3,
  'all three unanswered requests are nudged after 1 day');
select is(private.enqueue_request_nudges(now() + interval '25 hours'), 0,
  'each request is nudged only once');
select is(
  (select (title, category)::text from public.notifications_outbox
    where appointment_id = (select id from t where name = 'req1') and kind = 'request_nudge'),
  ('You haven''t responded to Karina''s request', 'requestNudge')::text,
  'the nudge says he hasn''t responded and offers Respond / Ignore');

update public.settings set followup_nudge_hours = 2 where salon_id = (select b from ids);
select pg_temp.as_service_role();
insert into t select 'req_b', (public.book_appointment(
  (select b from ids), null, pg_temp.seg('2030-01-08 15:00+00'), '[]', 'requested', 'inbox',
  null, null, (select owner_b from ids))).id;
select pg_temp.logout();
select is(private.enqueue_request_nudges(now() + interval '1 hour 59 minutes'), 0,
  'a 2 hour nudge setting waits 2 hours');
select is(private.enqueue_request_nudges(now() + interval '2 hours'), 1,
  'the nudge delay follows the salon setting');

-- Expiry: hold_expiry_hours after the nudge -----------------------------------------
select is(private.release_unanswered_requests(now() + interval '47 hours 59 minutes'), 1,
  'only salon B''s request (2h nudge + 24h expiry) has expired before 48 hours');
select is(
  (select (status, cancel_reason)::text from public.appointments
    where id = (select id from t where name = 'req_b')),
  ('cancelled'::public.appointment_status, 'request_expired')::text,
  'an unanswered request is released');
select is(
  (select title from public.notifications_outbox
    where appointment_id = (select id from t where name = 'req_b') and kind = 'cancellation'),
  'A client''s request expired', 'he is told the request expired');

-- Ignore releases the hold without another alert.
select pg_temp.login('00000000-0000-4000-e000-00000000000a');
select public.set_appointment_status((select id from t where name = 'tent'), 'cancelled', 'ignored');
select pg_temp.logout();
select is(
  (select count(*)::integer from public.notifications_outbox
    where appointment_id = (select id from t where name = 'tent') and kind = 'cancellation'),
  0, 'ignoring a request frees the time without a cancellation alert');

update public.settings set hold_expiry_hours = 48 where salon_id = (select a from ids);
select is(private.release_unanswered_requests(now() + interval '48 hours'), 0,
  'a longer hold expiry keeps the request open');
select is(private.release_unanswered_requests(now() + interval '72 hours'), 3,
  'and releases it 1 day (nudge) + 2 days (expiry) after it arrived');

-- Cancellation alerts ------------------------------------------------------------------
select pg_temp.as_service_role();
select public.set_appointment_status((select id from t where name = 'open'), 'cancelled', 'client');
select pg_temp.logout();
select is(
  (select (kind, title)::text from public.notifications_outbox
    where appointment_id = (select id from t where name = 'open') and kind = 'cancellation'),
  ('cancellation'::public.notification_kind, 'A client cancelled')::text,
  'a client cancellation alerts him');
select pg_temp.login('00000000-0000-4000-e000-00000000000a');
select public.set_appointment_status((select id from t where name = 'own_conf'), 'cancelled');
select pg_temp.logout();
select is(
  (select count(*)::integer from public.notifications_outbox
    where appointment_id = (select id from t where name = 'own_conf')),
  0, 'cancelling his own appointment does not alert him');

-- Quiet hours (salon timezone) ---------------------------------------------------------
update public.settings set quiet_hours_enabled = true, quiet_hours_start = '21:00', quiet_hours_end = '07:00'
  where salon_id = (select a from ids);
select is(private.in_quiet_hours((select a from ids), '2030-01-08 02:59+00'), false,
  '8:59 PM local is before quiet hours');
select is(private.in_quiet_hours((select a from ids), '2030-01-08 03:00+00'), true,
  '9:00 PM local starts quiet hours');
select is(private.in_quiet_hours((select a from ids), '2030-01-08 12:59+00'), true,
  'quiet hours wrap past midnight');
select is(private.in_quiet_hours((select a from ids), '2030-01-08 13:00+00'), false,
  '7:00 AM local ends quiet hours');
select is(private.in_quiet_hours((select b from ids), '2030-01-08 03:00+00'), false,
  'quiet hours are off unless enabled');

-- Daily agenda at 8am (salon timezone) -------------------------------------------------
select pg_temp.login('00000000-0000-4000-e000-00000000000a');
select public.book_appointment((select a from ids), (select id from t where name = 'karina'),
  pg_temp.seg('2030-02-05 15:00+00'));
select public.book_appointment((select a from ids), null, pg_temp.seg('2030-02-05 17:00+00'));
select public.book_appointment((select a from ids), null, pg_temp.seg('2030-02-06 15:00+00'));
select pg_temp.logout();

select is(private.enqueue_daily_agendas('2030-02-05 07:59 America/Chicago'), 0,
  'no agenda before 8am local');
select is(private.enqueue_daily_agendas('2030-02-05 08:00 America/Chicago'), 1,
  'the agenda is enqueued at 8am local');
select is(private.enqueue_daily_agendas('2030-02-05 08:01 America/Chicago'), 0,
  'one agenda per day');
select is(
  (select (title, body)::text from public.notifications_outbox
    where kind = 'daily_agenda' and data ->> 'date' = '2030-02-05'),
  ('Today: 2 appointments', 'First up: Karina at 9:00 AM.')::text,
  'the agenda counts the day and names the first client');

-- Notifier RPCs --------------------------------------------------------------------------
-- Quiet hours around "now" for salon A, off for salon B.
update public.settings
   set quiet_hours_start = ((now() at time zone 'America/Chicago') - interval '1 hour')::time,
       quiet_hours_end = ((now() at time zone 'America/Chicago') + interval '1 hour')::time
 where salon_id = (select a from ids);
select pg_temp.as_service_role();
create temp table claimed as select * from public.claim_notifications(100);
select pg_temp.logout();
select is(
  (select count(*)::integer from claimed where salon_id = (select a from ids)), 0,
  'nothing is delivered during quiet hours');
select ok(
  (select count(*) from claimed where salon_id = (select b from ids)) > 0,
  'other salons still get their pushes');
select is(
  (select count(*)::integer from public.notifications_outbox
    where kind in ('request', 'request_nudge') and status = 'skipped'
      and appointment_id = (select id from t where name = 'req_b')),
  2, 'request pushes for an appointment that is no longer requested are skipped');

update public.settings set quiet_hours_enabled = false where salon_id = (select a from ids);
select pg_temp.as_service_role();
insert into claimed select * from public.claim_notifications(100);
select is(
  public.finish_notifications(jsonb_build_array(
    jsonb_build_object('id', (select id from claimed where kind = 'daily_agenda'), 'outcome', 'sent',
                       'tickets', '[{"status":"ok","id":"t1"}]'::jsonb),
    jsonb_build_object('id', (select id from claimed where kind = 'cancellation'
                                and appointment_id = (select id from t where name = 'open')),
                       'outcome', 'retry', 'error', 'Expo 503'))),
  2, 'finish_notifications records the outcome');
select pg_temp.logout();
select is(
  (select (status, sent_at is not null)::text from public.notifications_outbox where kind = 'daily_agenda'),
  ('sent'::public.notification_status, true)::text, 'a delivered push is marked sent');
select is(
  (select (status, attempts, send_after > now(), last_error)::text from public.notifications_outbox
    where kind = 'cancellation' and appointment_id = (select id from t where name = 'open')),
  ('pending'::public.notification_status, 1, true, 'Expo 503')::text,
  'a failed push is retried later with backoff');

-- Access ---------------------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-e000-00000000000a');
select throws_ok($$ select public.claim_notifications(10) $$, '42501', null,
  'only the notifier (service role) can claim notifications');
select throws_ok(
  $$ insert into public.notifications_outbox (salon_id, user_id, kind, title, body, dedupe_key)
     select a, owner_a, 'daily_agenda', 'x', 'y', 'z' from ids $$,
  '42501', null, 'members cannot write the outbox');
select ok(
  (select count(*) > 0 and bool_and(user_id = (select owner_a from ids))
     from public.notifications_outbox),
  'members read only their own notifications');
select is(
  (public.register_push_token((select a from ids), 'ExponentPushToken[abc]', 'ios')).user_id,
  (select owner_a from ids), 'a member registers a push token');
select throws_ok(
  $$ select public.register_push_token((select b from ids), 'ExponentPushToken[abc]', 'ios') $$,
  '42501', null, 'tokens can only be registered for your own salon');
select pg_temp.logout();

select * from finish();
rollback;
