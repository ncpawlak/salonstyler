-- Client self-service (#10): manage tokens, client email triggers, reminders, the notifier's
-- claim/finish, the manage-link RPCs (only the token's own appointment), the policy hook and the
-- reminder queue.
begin;
select plan(57);

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

create function pg_temp.segs(p_start timestamptz, p_minutes integer default 60) returns jsonb
language sql immutable as $$
  select jsonb_build_array(jsonb_build_object(
    'kind', 'busy', 'label', 'Cut', 'start', p_start, 'end', p_start + make_interval(mins => p_minutes)));
$$;
grant execute on function pg_temp.segs(timestamptz, integer) to authenticated, service_role;

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('00000000-0000-4000-f100-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-a@css.test', now()),
  ('00000000-0000-4000-f100-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-b@css.test', now());

select pg_temp.login('00000000-0000-4000-f100-00000000000a');
select public.create_salon('Self Service A', 'self-service-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-f100-00000000000b');
select public.create_salon('Self Service B', 'self-service-b', 'America/Chicago');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'self-service-a') as a,
         (select id from public.salons where slug = 'self-service-b') as b,
         '00000000-0000-4000-f100-00000000000a'::uuid as owner_a,
         '00000000-0000-4000-f100-00000000000b'::uuid as owner_b,
         date_trunc('hour', now()) + interval '10 days' as d10,
         date_trunc('hour', now()) + interval '11 days' as d11,
         date_trunc('hour', now()) + interval '12 days' as d12,
         date_trunc('hour', now()) + interval '13 days' as d13,
         date_trunc('hour', now()) + interval '14 days' as d14,
         ((((now() at time zone 'America/Chicago')::date + 1) + time '10:00')
           at time zone 'America/Chicago') as tomorrow;
grant select on ids to authenticated, service_role;
create temp table t (name text primary key, val jsonb);
grant select, insert, update on t to authenticated, service_role;

delete from public.work_hours_template where salon_id in (select a from ids union select b from ids);

insert into public.clients (salon_id, name, phone, email)
  select a, 'Karina Lopez', '+15550100101', 'karina@css.test' from ids;
insert into public.clients (salon_id, name, phone)
  select a, 'Maria NoEmail', '+15550100202' from ids;
insert into public.clients (salon_id, name, phone, email)
  select b, 'Bea Other', '+15550100303', 'bea@css.test' from ids;

create temp view c as
  select (select id from public.clients where name = 'Karina Lopez') as karina,
         (select id from public.clients where name = 'Maria NoEmail') as maria,
         (select id from public.clients where name = 'Bea Other') as bea;
grant select on c to authenticated, service_role;

-- Schema & privileges --------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.claim_client_emails(integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.claim_client_emails(integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.finish_client_emails(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.manage_booking(text)', 'execute')
  and not has_function_privilege('authenticated', 'public.manage_booking(text)', 'execute')
  and not has_function_privilege('anon', 'public.cancel_booking_by_token(text)', 'execute')
  and not has_function_privilege('authenticated', 'public.cancel_booking_by_token(text)', 'execute')
  and not has_function_privilege('anon', 'public.reschedule_booking_by_token(text,jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.reschedule_booking_by_token(text,jsonb)', 'execute'),
  'manage-link and notifier RPCs are service-role only');
select ok(
  not has_function_privilege('anon', 'public.reminder_queue(uuid,date)', 'execute')
  and not has_function_privilege('anon', 'public.mark_text_reminder_sent(uuid,boolean)', 'execute')
  and not has_table_privilege('anon', 'public.client_email_outbox', 'select')
  and not has_table_privilege('authenticated', 'public.client_email_outbox', 'insert'),
  'signed-out callers can''t read the reminder queue or the email outbox');
select is((select count(*)::integer from cron.job where jobname = 'client-emails-tick'), 1,
  'the client-emails-tick cron job is scheduled');
select throws_ok(
  $$ update public.settings set client_reminder_hours = '{0}' where salon_id = (select a from ids) $$,
  '23514', null, 'reminder hours must be 1-168');
select throws_ok(
  $$ update public.settings set client_reminder_hours = '{1,2,3,4}' where salon_id = (select a from ids) $$,
  '23514', null, 'at most three reminders');

-- Confirmation emails ----------------------------------------------------------------
select pg_temp.login((select owner_a from ids));
insert into t select 'karina', to_jsonb(public.book_appointment(
  (select a from ids), (select karina from c), pg_temp.segs((select d10 from ids)),
  '[{"name":"Haircut"}]'::jsonb));
insert into t select 'maria', to_jsonb(public.book_appointment(
  (select a from ids), (select maria from c), pg_temp.segs((select d11 from ids))));
insert into t select 'imported', to_jsonb(public.book_appointment(
  (select a from ids), (select karina from c), pg_temp.segs((select d12 from ids)), '[]', 'confirmed', 'import'));
insert into t select 'requested', to_jsonb(public.book_appointment(
  (select a from ids), (select karina from c), pg_temp.segs((select d13 from ids)), '[]', 'requested'));
select pg_temp.logout();

create temp view appt as
  select (select (val ->> 'id')::uuid from t where name = 'karina') as karina,
         (select (val ->> 'id')::uuid from t where name = 'maria') as maria,
         (select (val ->> 'id')::uuid from t where name = 'imported') as imported,
         (select (val ->> 'id')::uuid from t where name = 'requested') as requested,
         (select val ->> 'manage_token' from t where name = 'karina') as token;
grant select on appt to authenticated, service_role;

select ok((select token from appt) ~ '^[0-9a-f]{64}$', 'manage tokens are 64 hex characters');
select isnt((select manage_token from public.appointments where id = (select maria from appt)),
  (select token from appt), 'each appointment gets its own token');
select is(
  (select array_agg(kind::text) from public.client_email_outbox where appointment_id = (select karina from appt)),
  array['confirmation'], 'a confirmed booking queues a confirmation email');
select is((select count(*)::integer from public.client_email_outbox where appointment_id = (select maria from appt)),
  0, 'clients without an email get none');
select is((select count(*)::integer from public.client_email_outbox where appointment_id = (select imported from appt)),
  0, 'imported appointments don''t email a confirmation');
select is((select count(*)::integer from public.client_email_outbox where appointment_id = (select requested from appt)),
  0, 'requests don''t email until confirmed');

select pg_temp.login((select owner_a from ids));
select public.set_appointment_status((select requested from appt), 'confirmed');
select pg_temp.logout();
select is(
  (select array_agg(kind::text) from public.client_email_outbox where appointment_id = (select requested from appt)),
  array['confirmation'], 'approving a request queues the confirmation');

update public.settings set client_emails_enabled = false where salon_id = (select a from ids);
select pg_temp.login((select owner_a from ids));
insert into t select 'quiet', to_jsonb(public.book_appointment(
  (select a from ids), (select karina from c), pg_temp.segs((select d14 from ids))));
select pg_temp.logout();
select is((select count(*)::integer from public.client_email_outbox
            where appointment_id = (select (val ->> 'id')::uuid from t where name = 'quiet')),
  0, 'no emails when the salon turned client emails off');
update public.settings set client_emails_enabled = true where salon_id = (select a from ids);

-- Moves: small nudges are quiet, real moves email ----------------------------------------
select pg_temp.login((select owner_a from ids));
select public.reschedule_appointment((select requested from appt),
  pg_temp.segs((select d13 from ids) + interval '30 minutes'));
select pg_temp.logout();
select is((select count(*)::integer from public.client_email_outbox
            where appointment_id = (select requested from appt) and kind = 'rescheduled'),
  0, 'a 30-minute same-day nudge doesn''t email');
select pg_temp.login((select owner_a from ids));
select public.reschedule_appointment((select requested from appt),
  pg_temp.segs((select d13 from ids) + interval '3 days'));
select pg_temp.logout();
select is((select count(*)::integer from public.client_email_outbox
            where appointment_id = (select requested from appt) and kind = 'rescheduled'),
  1, 'moving to another day emails the client');

-- Reminders ------------------------------------------------------------------------------
select is(private.enqueue_client_reminders(now()), 0, 'nothing is due yet');
select is(private.enqueue_client_reminders((select d10 from ids) - interval '47 hours'), 1,
  '48 hours out, the 48h reminder is due');
select is(
  (select reminder_hours from public.client_email_outbox
    where appointment_id = (select karina from appt) and kind = 'reminder'),
  48, 'it is the 48h reminder');
select is(private.enqueue_client_reminders((select d10 from ids) - interval '47 hours'), 0,
  'reminders are queued once');
select is(private.enqueue_client_reminders((select d10 from ids) - interval '1 hour'), 1,
  'the 2h reminder follows');
select is(
  (select array_agg(reminder_hours order by reminder_hours) from public.client_email_outbox
    where appointment_id = (select karina from appt) and kind = 'reminder'),
  array[2, 48], 'both reminders are queued, one each');

-- A booking made 30 hours out only gets the 2h reminder, never a late "48h" one.
select pg_temp.login((select owner_a from ids));
insert into t select 'late', to_jsonb(public.book_appointment(
  (select a from ids), (select karina from c), pg_temp.segs(date_trunc('hour', now()) + interval '30 hours')));
select pg_temp.logout();
select is(private.enqueue_client_reminders(date_trunc('hour', now()) + interval '5 hours'), 0,
  'a booking made inside the 48h window skips that reminder');
select is(private.enqueue_client_reminders(date_trunc('hour', now()) + interval '29 hours'), 1,
  'and gets the 2h one');

-- Claim / finish ---------------------------------------------------------------------------
select pg_temp.as_service_role();
insert into t select 'claimed', public.claim_client_emails(200);
select pg_temp.logout();
select is(
  (select e - 'id' - 'startsAt' - 'endsAt' from t, jsonb_array_elements(val) e
    where name = 'claimed' and e ->> 'appointmentId' = (select karina::text from appt)
      and e ->> 'kind' = 'confirmation'),
  jsonb_build_object('kind', 'confirmation', 'to', 'karina@css.test', 'reminderHours', null,
    'appointmentId', (select karina from appt),
    'salon', jsonb_build_object('name', 'Self Service A', 'slug', 'self-service-a', 'timezone', 'America/Chicago'),
    'clientName', 'Karina Lopez', 'services', 'Haircut', 'manageToken', (select token from appt),
    'sequence', 0),
  'a claimed email carries what the notifier renders');
select is(
  (select status::text || ':' || last_error from public.client_email_outbox
    where appointment_id = (select requested from appt) and kind = 'confirmation'),
  'skipped:appointment_changed', 'emails for a time that has since moved are skipped');
select is(
  (select (e ->> 'sequence')::integer from t, jsonb_array_elements(val) e
    where name = 'claimed' and e ->> 'appointmentId' = (select requested::text from appt)),
  1, 'a move bumps the calendar invite''s sequence');
select is(
  (select count(*)::integer from public.client_email_outbox where status = 'sending'),
  (select jsonb_array_length(val) from t where name = 'claimed'), 'claimed emails are marked sending');

select pg_temp.as_service_role();
select is(public.finish_client_emails(jsonb_build_array(
  jsonb_build_object('id', (select id from public.client_email_outbox
                             where appointment_id = (select karina from appt) and kind = 'confirmation'),
                     'outcome', 'sent', 'providerId', 'msg_1'),
  jsonb_build_object('id', (select id from public.client_email_outbox
                             where appointment_id = (select requested from appt) and kind = 'rescheduled'),
                     'outcome', 'retry', 'error', 'smtp down'))), 2, 'finish records outcomes');
select pg_temp.logout();
select is(
  (select (status, provider_id, sent_at is not null)::text from public.client_email_outbox
    where appointment_id = (select karina from appt) and kind = 'confirmation'),
  ('sent', 'msg_1', true)::text, 'sent emails are stamped');
select is(
  (select (status, last_error, send_after > now())::text from public.client_email_outbox
    where appointment_id = (select requested from appt) and kind = 'rescheduled'),
  ('pending', 'smtp down', true)::text, 'retries back off');

-- The manage link: one appointment only --------------------------------------------------
select pg_temp.login((select owner_a from ids));
select throws_ok($$ select public.manage_booking((select token from appt)) $$, '42501', null,
  'signed-in members can''t call the manage-link RPCs directly');
select pg_temp.logout();

select pg_temp.as_service_role();
insert into t select 'view', public.manage_booking((select token from appt));
select is(public.manage_booking(repeat('0', 64)), null, 'unknown tokens find nothing');
select is(public.manage_booking('x'' or 1=1 --'), null, 'malformed tokens find nothing');
select pg_temp.logout();
select is(
  (select array_agg(k order by k) from t, jsonb_object_keys(val) k where name = 'view'),
  array['appointmentId', 'canCancel', 'canReschedule', 'clientFirstName', 'endsAt', 'feeCents',
        'policyMessage', 'salon', 'salonId', 'segments', 'services', 'startsAt', 'status', 'stylistId'],
  'the view has no phone, email, notes or price');
select is(
  (select (val ->> 'clientFirstName', val ->> 'canCancel', val ->> 'canReschedule',
           jsonb_array_length(val -> 'segments'))::text from t where name = 'view'),
  ('Karina', 'true', 'true', 1)::text, 'the client sees their first name and what they may do');

-- Reschedule
select pg_temp.as_service_role();
select is(public.reschedule_booking_by_token((select token from appt),
  pg_temp.segs((select d10 from ids) + interval '2 hours', 90)) ->> 'reason',
  'invalid', 'a reschedule must keep the booked shape');
select is(public.reschedule_booking_by_token((select token from appt),
  '[{"kind":"busy","start":"nope"}]') ->> 'reason', 'invalid', 'garbage segments are invalid');
select is(public.reschedule_booking_by_token((select token from appt),
  pg_temp.segs(now() - interval '2 hours')) ->> 'reason', 'unavailable', 'it can''t move into the past');
select is(public.reschedule_booking_by_token((select token from appt),
  pg_temp.segs((select d11 from ids))) ->> 'reason', 'conflict', 'it can''t move onto another booking');
select pg_temp.logout();

insert into public.work_hours_override (salon_id, start_date, end_date, kind, blocks, breaks)
select a, ((d10 + interval '3 days') at time zone 'America/Chicago')::date,
       ((d10 + interval '3 days') at time zone 'America/Chicago')::date,
       'custom', '[{"start":"00:00","end":"24:00","type":"tentative"}]', '[]' from ids;
select pg_temp.as_service_role();
select is(public.reschedule_booking_by_token((select token from appt),
  pg_temp.segs((select d10 from ids) + interval '3 days')) ->> 'reason', 'unavailable',
  'Tentative hours need the salon');
insert into t select 'moved', public.reschedule_booking_by_token((select token from appt),
  pg_temp.segs((select d10 from ids) + interval '1 day 2 hours'));
select pg_temp.logout();
select is((select val ->> 'ok' from t where name = 'moved'), 'true', 'the client can move it');
select is(
  (select starts_at from public.appointments where id = (select karina from appt)),
  (select d10 + interval '1 day 2 hours' from ids), 'the appointment moved');
select is(
  (select (kind, user_id, title)::text from public.notifications_outbox
    where appointment_id = (select karina from appt) and kind = 'client_rescheduled'),
  ('client_rescheduled', (select owner_a from ids), 'Karina Lopez moved their appointment')::text,
  'the stylist gets a push');
select is(
  (select count(*)::integer from public.client_email_outbox
    where appointment_id = (select karina from appt) and kind = 'rescheduled' and status = 'pending'),
  1, 'the client gets a "moved" email');
select is(
  (select count(*)::integer from public.audit_log
    where entity_id = (select karina::text from appt) and action = 'client_self_service.rescheduled'),
  1, 'the move is audited');

-- Policy hook: self-service off
update public.settings set client_self_service_enabled = false where salon_id = (select a from ids);
select pg_temp.as_service_role();
select is(
  (select (v ->> 'canCancel', v ->> 'canReschedule', v ->> 'policyMessage')::text
     from (select public.manage_booking((select token from appt)) as v) x),
  ('false', 'false', 'Contact the salon to change this appointment.')::text,
  'with self-service off the link is view-only');
select is(public.cancel_booking_by_token((select token from appt)) ->> 'reason', 'disabled',
  'and cancelling is refused');
select pg_temp.logout();
update public.settings set client_self_service_enabled = true where salon_id = (select a from ids);

-- Cancel
select pg_temp.as_service_role();
select is(public.cancel_booking_by_token((select token from appt)) ->> 'status', 'cancelled',
  'the client can cancel');
select is(public.cancel_booking_by_token((select token from appt)) ->> 'alreadyCancelled', 'true',
  'cancelling twice is harmless');
select is(public.reschedule_booking_by_token((select token from appt),
  pg_temp.segs((select d10 from ids) + interval '2 days')) ->> 'reason', 'not_allowed',
  'a cancelled appointment can''t be moved');
select pg_temp.logout();
select is(
  (select count(*)::integer from public.notifications_outbox
    where appointment_id = (select karina from appt) and kind = 'cancellation'),
  1, 'the stylist gets the cancellation push');
select is(
  (select count(*)::integer from public.client_email_outbox
    where appointment_id = (select karina from appt) and kind = 'cancellation'),
  1, 'the client gets a cancellation email');
select pg_temp.login((select owner_a from ids));
select lives_ok(
  $$ select public.book_appointment((select a from ids), (select maria from c),
       pg_temp.segs((select d10 from ids) + interval '1 day 2 hours')) $$,
  'the freed slot can be booked again');
select pg_temp.logout();

-- Reminder queue ---------------------------------------------------------------------------
select pg_temp.login((select owner_a from ids));
insert into t select 'tomorrow', to_jsonb(public.book_appointment(
  (select a from ids), (select maria from c), pg_temp.segs((select tomorrow from ids))));
select ok(
  (select jsonb_agg(i - 'startsAt' - 'manageToken') from jsonb_array_elements(
     public.reminder_queue((select a from ids)) -> 'items') i)
  @> jsonb_build_array(jsonb_build_object(
       'appointmentId', (select val ->> 'id' from t where name = 'tomorrow'),
       'clientId', (select maria from c), 'clientName', 'Maria NoEmail', 'phone', '+15550100202',
       'services', null, 'textReminderSentAt', null)),
  'the queue lists tomorrow''s confirmed clients with their phone');
select isnt(public.mark_text_reminder_sent((select (val ->> 'id')::uuid from t where name = 'tomorrow')),
  null, 'he can mark a text reminder sent');
select pg_temp.logout();

select pg_temp.login((select owner_b from ids));
select throws_ok($$ select public.reminder_queue((select a from ids)) $$, '42501', null,
  'other salons can''t read the queue');
select throws_ok(
  $$ select public.mark_text_reminder_sent((select (val ->> 'id')::uuid from t where name = 'tomorrow')) $$,
  'P0002', null, 'or mark its reminders');
select pg_temp.logout();

select * from finish();
rollback;
