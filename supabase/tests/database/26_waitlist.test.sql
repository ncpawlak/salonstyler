-- Waitlist auto-fill (#21): entries and their privileges, cancellation → opening (own trigger),
-- the function's claim/save RPCs, stylist approval (drafts) vs auto-offer, first accept wins,
-- expiry re-opening the slot, joining from the booking page and leaving by token.
begin;
select plan(46);

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
  ('00000000-0000-4000-f260-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-a@wl.test', now()),
  ('00000000-0000-4000-f260-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-b@wl.test', now()),
  ('00000000-0000-4000-f260-0000000000c1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nina@wl.test', now()),
  ('00000000-0000-4000-f260-0000000000c2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'unverified@wl.test', null);

select pg_temp.login('00000000-0000-4000-f260-00000000000a');
select public.create_salon('Waitlist A', 'waitlist-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-f260-00000000000b');
select public.create_salon('Waitlist B', 'waitlist-b', 'America/Chicago');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'waitlist-a') as a,
         (select id from public.salons where slug = 'waitlist-b') as b,
         '00000000-0000-4000-f260-00000000000a'::uuid as owner_a,
         '00000000-0000-4000-f260-00000000000b'::uuid as owner_b,
         (((now() at time zone 'America/Chicago')::date + 10) + time '10:00') at time zone 'America/Chicago' as d10,
         (((now() at time zone 'America/Chicago')::date + 11) + time '10:00') at time zone 'America/Chicago' as d11,
         (((now() at time zone 'America/Chicago')::date + 12) + time '10:00') at time zone 'America/Chicago' as d12,
         (now() at time zone 'America/Chicago')::date + 10 as day10,
         (now() at time zone 'America/Chicago')::date + 11 as day11,
         (now() at time zone 'America/Chicago')::date + 14 as day14;
grant select on ids to authenticated, service_role;
create temp table t (name text primary key, val jsonb);
grant select, insert, update on t to authenticated, service_role;

delete from public.work_hours_template where salon_id in (select a from ids union select b from ids);

insert into public.clients (salon_id, name, phone, email)
  select a, 'Karina Lopez', '+15550100101', 'karina@wl.test' from ids;
insert into public.clients (salon_id, name, phone)
  select a, 'Maria NoEmail', '+15550100202' from ids;
insert into public.clients (salon_id, name, phone, email)
  select a, 'Lena Auto', '+15550100303', 'lena@wl.test' from ids;
insert into public.clients (salon_id, name, phone)
  select a, 'Cancel Me', '+15550100404' from ids;
insert into public.clients (salon_id, name, phone, email)
  select a, 'Nina Online', '+15550100505', 'NINA@wl.test' from ids;

create temp view c as
  select (select id from public.clients where name = 'Karina Lopez') as karina,
         (select id from public.clients where name = 'Maria NoEmail') as maria,
         (select id from public.clients where name = 'Lena Auto') as lena,
         (select id from public.clients where name = 'Cancel Me') as other,
         (select id from public.clients where name = 'Nina Online') as nina;
grant select on c to authenticated, service_role;

-- Schema & privileges --------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.claim_waitlist_openings(uuid,integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.claim_waitlist_openings(uuid,integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.save_waitlist_offers(uuid,jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.waitlist_by_token(text)', 'execute')
  and not has_function_privilege('anon', 'public.leave_waitlist_by_token(text)', 'execute')
  and not has_function_privilege('authenticated', 'public.accept_waitlist_offer(text,uuid,jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.join_waitlist(uuid,uuid,jsonb,integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.join_waitlist(uuid,uuid,jsonb,integer)', 'execute'),
  'matching, token and join RPCs are service-role only');
select ok(
  not has_table_privilege('anon', 'public.waitlist_entries', 'select')
  and not has_table_privilege('anon', 'public.waitlist_offers', 'select')
  and not has_table_privilege('authenticated', 'public.waitlist_entries', 'insert')
  and not has_table_privilege('authenticated', 'public.waitlist_offers', 'update')
  and not has_function_privilege('anon', 'public.add_waitlist_entry(uuid,uuid,jsonb,text,date,time,time,text)', 'execute'),
  'signed-out callers can''t touch the waitlist; members change it only through RPCs');
select is((select count(*)::integer from cron.job where jobname = 'waitlist-tick'), 1,
  'the waitlist-tick cron job is scheduled');
select is(
  (select row(waitlist_enabled, waitlist_auto_offer, waitlist_offer_minutes)::text
     from public.settings where salon_id = (select a from ids)),
  row(true, false, 120)::text,
  'waitlist on, offers need approval, 2-hour expiry by default');

-- The stylist adds clients ---------------------------------------------------------
select pg_temp.login('00000000-0000-4000-f260-00000000000a');
select is(
  (select (public.add_waitlist_entry((select a from ids), (select karina from c),
     '[{"serviceId":"x"}]', 'Cut', (select day10 from ids))).status::text),
  'waiting', 'a member adds a client to the waitlist');
select lives_ok(
  $$ select public.add_waitlist_entry((select a from ids), (select maria from c),
       '[{"serviceId":"x"}]', 'Cut', (select day10 from ids), '09:00', '12:00') $$,
  'with a time window');
select public.add_waitlist_entry((select a from ids), (select karina from c),
  '[{"serviceId":"x"}]', 'Cut + Style', (select day10 from ids));
select is(
  (select count(*)::integer from public.waitlist_entries where client_id = (select karina from c)),
  1, 'adding the same client for the same day updates the entry');
select throws_ok(
  $$ insert into public.waitlist_entries (salon_id, client_id, items, services_label, day)
     values ((select a from ids), (select karina from c), '[{"serviceId":"x"}]', 'Cut', current_date) $$,
  '42501', null, 'members can''t write entries directly');
select throws_ok(
  $$ select public.add_waitlist_entry((select a from ids), (select karina from c), '[{"serviceId":"x"}]',
       'Cut', (select day10 from ids), '12:00', '09:00') $$,
  '23514', null, 'the window must end after it starts');
select pg_temp.logout();
update public.waitlist_entries set created_at = now() - interval '1 hour' where client_id = (select karina from c);

select pg_temp.login('00000000-0000-4000-f260-00000000000b');
select is((select count(*)::integer from public.waitlist_entries), 0,
  'another salon can''t see the waitlist');
select throws_ok(
  $$ select public.add_waitlist_entry((select a from ids), (select karina from c),
       '[{"serviceId":"x"}]', 'Cut', (select day10 from ids)) $$,
  '42501', null, 'another salon can''t add to it');
select throws_ok(
  $$ select public.remove_waitlist_entry((select id from public.waitlist_entries limit 1)) $$,
  '42501', null, 'or remove from it');
select pg_temp.logout();

-- Cancellation → opening ----------------------------------------------------------
select pg_temp.login('00000000-0000-4000-f260-00000000000a');
insert into t
  select 'appt10', to_jsonb((public.book_appointment((select a from ids), (select other from c),
                                                     pg_temp.segs((select d10 from ids), 90))).id);
insert into t
  select 'appt12', to_jsonb((public.book_appointment((select a from ids), (select other from c),
                                                     pg_temp.segs((select d12 from ids)))).id);
select public.set_appointment_status((select (val #>> '{}')::uuid from t where name = 'appt12'), 'cancelled', null);
select is((select count(*)::integer from public.waitlist_openings), 0,
  'no opening when nobody is waiting for that day');
select public.set_appointment_status((select (val #>> '{}')::uuid from t where name = 'appt10'), 'cancelled', null);
select is(
  (select row(status, day, starts_at, ends_at, stylist_id)::text from public.waitlist_openings),
  row('pending', (select day10 from ids), (select d10 from ids), (select d10 from ids) + interval '90 minutes',
      (select owner_a from ids))::text,
  'cancelling a future appointment on a waited-for day records the freed time');
select is((select count(*)::integer from public.waitlist_openings), 1, 'visible to members');
select pg_temp.logout();

-- The function claims and saves the engine's fits -------------------------------------
select pg_temp.as_service_role();
insert into t select 'claim', public.claim_waitlist_openings();
select is((select jsonb_array_length(val) from t where name = 'claim'), 1, 'one opening claimed');
select is(
  (select jsonb_path_query_array(val, '$[0].entries[*].clientId') from t where name = 'claim'),
  jsonb_build_array((select karina from c), (select maria from c)),
  'with the waiting clients for that day, oldest first');
select is(
  (select val #>> '{0,entries,1,windowStart}' || '-' || (val #>> '{0,entries,1,windowEnd}') from t where name = 'claim'),
  '09:00-12:00', 'and their windows');
select is(public.claim_waitlist_openings(), '[]'::jsonb, 'an opening is only claimed once');

insert into t select 'save', public.save_waitlist_offers(
  (select (val #>> '{0,openingId}')::uuid from t where name = 'claim'),
  jsonb_build_array(
    jsonb_build_object('entryId', (select val #>> '{0,entries,0,entryId}' from t where name = 'claim'),
      'startsAt', (select d10 from ids), 'endsAt', (select d10 from ids) + interval '60 minutes',
      'segments', pg_temp.segs((select d10 from ids)), 'services', '[{"name":"Cut"}]'::jsonb, 'priceCents', 5000),
    jsonb_build_object('entryId', (select val #>> '{0,entries,1,entryId}' from t where name = 'claim'),
      'startsAt', (select d10 from ids) + interval '30 minutes', 'endsAt', (select d10 from ids) + interval '90 minutes',
      'segments', pg_temp.segs((select d10 from ids) + interval '30 minutes'), 'services', '[]'::jsonb)));
select is((select val - 'ok' from t where name = 'save'), '{"saved": 2, "sent": []}'::jsonb,
  'offers are saved as drafts by default');
select pg_temp.logout();

select is(
  (select array_agg(status::text) from public.waitlist_offers), array['draft', 'draft'],
  'nothing goes out without the stylist');
select is(
  (select count(*)::integer from public.notifications_outbox
    where kind = 'waitlist' and user_id = (select owner_a from ids) and title = 'Waitlist clients fit a cancelled slot'),
  1, 'the stylist gets a push to review them');

create temp view o as
  select (select f.id from public.waitlist_offers f join public.waitlist_entries e on e.id = f.entry_id
           where e.client_id = (select karina from c)) as karina,
         (select f.id from public.waitlist_offers f join public.waitlist_entries e on e.id = f.entry_id
           where e.client_id = (select maria from c)) as maria,
         (select token from public.waitlist_entries where client_id = (select karina from c)) as karina_token,
         (select token from public.waitlist_entries where client_id = (select maria from c)) as maria_token;
grant select on o to authenticated, service_role;

select pg_temp.as_service_role();
select is((public.waitlist_by_token((select karina_token from o))) -> 'offer', 'null'::jsonb,
  'a draft isn''t visible on the client''s link');
select pg_temp.logout();

-- The stylist sends offers ----------------------------------------------------------
select pg_temp.login('00000000-0000-4000-f260-00000000000a');
select is((public.send_waitlist_offer((select maria from o), 'email')) ->> 'reason', 'no_email',
  'no email offer for a client without an address');
insert into t select 'sent', public.send_waitlist_offer((select karina from o), 'text');
select is(
  (select (val ->> 'token') = (select karina_token from o) and (val ->> 'expiresAt') is not null from t where name = 'sent'),
  true, 'sending returns the client''s link to text, with an expiry');
select is((select status::text from public.waitlist_entries where client_id = (select karina from c)),
  'offered', 'the client is now offered');
select public.send_waitlist_offer((select maria from o), 'text');
select pg_temp.logout();

-- First to accept gets it -----------------------------------------------------------
select pg_temp.as_service_role();
select ok((public.waitlist_by_token((select karina_token from o))) #>> '{offer,offerId}' = (select karina::text from o),
  'the sent offer shows on the client''s link');
select is((public.accept_waitlist_offer((select maria_token from o), (select karina from o))) ->> 'reason',
  'not_found', 'a token only accepts its own offer');
insert into t select 'accept', public.accept_waitlist_offer((select karina_token from o), (select karina from o));
select is((select val ->> 'ok' from t where name = 'accept'), 'true', 'the first client to accept books it');
select is((public.accept_waitlist_offer((select maria_token from o), (select maria from o))) ->> 'reason',
  'taken', 'everyone after that hears it was taken');
select pg_temp.logout();

select is(
  (select row(status, source, notes, client_id, starts_at, price_cents)::text from public.appointments
    where id = (select (val ->> 'appointmentId')::uuid from t where name = 'accept')),
  row('confirmed', 'owner', 'From the waitlist', (select karina from c), (select d10 from ids), 5000)::text,
  'booked as a confirmed appointment from the waitlist');
select is((select status from public.waitlist_openings), 'filled', 'the opening is filled');
select is(
  (select array_agg(f.status::text order by e.created_at) from public.waitlist_offers f
     join public.waitlist_entries e on e.id = f.entry_id),
  array['accepted', 'taken'], 'the other offer is marked taken');
select is(
  (select array_agg(status::text order by created_at) from public.waitlist_entries),
  array['booked', 'waiting'], 'the other client keeps waiting');
select is(
  (select count(*)::integer from public.notifications_outbox
    where kind = 'waitlist' and title = 'Karina Lopez took a slot from the waitlist'),
  1, 'the stylist hears who took it');
select is(
  (select count(*)::integer from public.client_email_outbox
    where appointment_id = (select (val ->> 'appointmentId')::uuid from t where name = 'accept')
      and kind = 'confirmation'),
  1, 'the client gets the usual confirmation email with their manage link');

-- Auto-offer, expiry ------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-f260-00000000000a');
update public.settings set waitlist_auto_offer = true where salon_id = (select a from ids);
select public.add_waitlist_entry((select a from ids), (select lena from c), '[{"serviceId":"x"}]', 'Cut',
  (select day11 from ids));
insert into t
  select 'appt11', to_jsonb((public.book_appointment((select a from ids), (select other from c),
                                                     pg_temp.segs((select d11 from ids)))).id);
select public.set_appointment_status((select (val #>> '{}')::uuid from t where name = 'appt11'), 'cancelled', null);
select pg_temp.logout();

select pg_temp.as_service_role();
insert into t select 'claim11', public.claim_waitlist_openings((select a from ids));
insert into t select 'save11', public.save_waitlist_offers(
  (select (val #>> '{0,openingId}')::uuid from t where name = 'claim11'),
  jsonb_build_array(jsonb_build_object(
    'entryId', (select val #>> '{0,entries,0,entryId}' from t where name = 'claim11'),
    'startsAt', (select d11 from ids), 'endsAt', (select d11 from ids) + interval '60 minutes',
    'segments', pg_temp.segs((select d11 from ids)))));
select is(
  (select (val #>> '{sent,0,email}') || ' ' || (val #>> '{sent,0,clientName}') from t where name = 'save11'),
  'lena@wl.test Lena Auto', 'with auto-offer on, offers go straight out by email');
select pg_temp.logout();
select is(
  (select row(f.status, f.sent_via)::text from public.waitlist_offers f
     join public.waitlist_entries e on e.id = f.entry_id where e.client_id = (select lena from c)),
  row('sent', 'email')::text, 'and are recorded as sent');

select private.waitlist_tick(now() + interval '3 hours');
select is(
  (select row(f.status, e.status, p.status)::text from public.waitlist_offers f
     join public.waitlist_entries e on e.id = f.entry_id
     join public.waitlist_openings p on p.id = f.opening_id
    where e.client_id = (select lena from c)),
  row('expired', 'waiting', 'pending')::text,
  'an unanswered offer expires, the client keeps waiting and the slot is matched again');
select private.waitlist_tick(now() + interval '20 days');
select is(
  (select count(*)::integer from public.waitlist_entries where status in ('waiting', 'offered')),
  0, 'entries for past days expire');

-- Joining from the booking page ------------------------------------------------------
select pg_temp.as_service_role();
insert into t select 'join', public.join_waitlist((select a from ids), '00000000-0000-4000-f260-0000000000c1',
  jsonb_build_object('name', 'Nina', 'phone', '+15550100505', 'items', '[{"serviceId":"x"}]'::jsonb,
                     'servicesLabel', 'Cut', 'day', (select day14 from ids),
                     'windowStart', '13:00', 'windowEnd', '17:00'));
select is(
  (select row(e.client_id, e.source, e.window_start, c.user_id)::text from public.waitlist_entries e
     join public.clients c on c.id = e.client_id where e.token = (select val ->> 'token' from t where name = 'join')),
  row((select nina from c), 'public', time '13:00', '00000000-0000-4000-f260-0000000000c1'::uuid)::text,
  'a verified email claims the matching client and joins with a window');
select is(
  (public.join_waitlist((select a from ids), '00000000-0000-4000-f260-0000000000c1',
     jsonb_build_object('items', '[{"serviceId":"x"}]'::jsonb, 'servicesLabel', 'Color', 'day', (select day14 from ids)))) ->> 'token',
  (select val ->> 'token' from t where name = 'join'), 'joining again for the same day updates the entry');
select throws_ok(
  $$ select public.join_waitlist((select a from ids), '00000000-0000-4000-f260-0000000000c2',
       jsonb_build_object('name', 'X', 'items', '[{"serviceId":"x"}]'::jsonb, 'servicesLabel', 'Cut',
                          'day', (select day14 from ids))) $$,
  '42501', null, 'an unverified email can''t join');
select is(
  (public.leave_waitlist_by_token((select val ->> 'token' from t where name = 'join'))) ->> 'ok', 'true',
  'the client can leave from their link');
select is(
  (select status::text from public.waitlist_entries where token = (select val ->> 'token' from t where name = 'join')),
  'cancelled', 'and the entry is cancelled');
select pg_temp.logout();

update public.settings set waitlist_enabled = false where salon_id = (select a from ids);
select pg_temp.as_service_role();
select is(
  (public.join_waitlist((select a from ids), '00000000-0000-4000-f260-0000000000c1',
     jsonb_build_object('items', '[{"serviceId":"x"}]'::jsonb, 'servicesLabel', 'Cut', 'day', (select day14 from ids)))) ->> 'reason',
  'disabled', 'nobody can join while the waitlist is off');
select pg_temp.logout();

select * from finish();
rollback;
