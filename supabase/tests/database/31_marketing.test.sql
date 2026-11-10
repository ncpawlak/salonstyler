-- Marketing (#27): consent & privileges, review requests on checkout, rebook nudge candidates and
-- saving, the approve/dismiss flow, campaigns to opted-in clients, claiming (opt-out, booked and
-- channel checks), finishing with retries, one-click unsubscribe, and the cron jobs.
begin;
select plan(43);

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

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('00000000-0000-4000-f310-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-a@mkt.test', now()),
  ('00000000-0000-4000-f310-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-b@mkt.test', now());

select pg_temp.login('00000000-0000-4000-f310-00000000000a');
select public.create_salon('Marketing A', 'marketing-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-f310-00000000000b');
select public.create_salon('Marketing B', 'marketing-b', 'America/Chicago');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'marketing-a') as a,
         (select id from public.salons where slug = 'marketing-b') as b,
         '00000000-0000-4000-f310-00000000000a'::uuid as owner_a,
         '00000000-0000-4000-f310-00000000000b'::uuid as owner_b,
         gen_random_uuid() as svc;
grant select on ids to authenticated, service_role;

insert into public.services (id, salon_id, name, price_cents, rebook_interval_days)
  select svc, a, 'Root touch-up', 9000, 28 from ids;

insert into public.clients (salon_id, name, email, marketing_opt_in, tags)
  select a, 'Karina Lopez', 'karina@mkt.test', true, '{VIP}' from ids;
insert into public.clients (salon_id, name, email, marketing_opt_in)
  select a, 'Maria Optout', 'maria@mkt.test', false from ids;
insert into public.clients (salon_id, name, email, marketing_opt_in)
  select a, 'Booked Bea', 'bea@mkt.test', true from ids;
insert into public.clients (salon_id, name, marketing_opt_in)
  select a, 'Nomail Nia', true from ids;
insert into public.clients (salon_id, name, email, marketing_opt_in)
  select b, 'Other Salon', 'other@mkt.test', true from ids;

create temp view c as
  select (select id from public.clients where name = 'Karina Lopez') as karina,
         (select id from public.clients where name = 'Maria Optout') as maria,
         (select id from public.clients where name = 'Booked Bea') as bea,
         (select id from public.clients where name = 'Nomail Nia') as nia,
         (select id from public.clients where name = 'Other Salon') as other;
grant select on c to authenticated, service_role;

-- A completed visit 30 days ago for each salon-A client (Bea also has one booked next week).
create temp table appts as
  with ins as (
    insert into public.appointments (salon_id, client_id, stylist_id, starts_at, ends_at, services,
                                     price_cents, status)
    select ids.a, cl.id, ids.owner_a,
           now() - interval '30 days' + make_interval(hours => g),
           now() - interval '30 days' + make_interval(hours => g, mins => 45),
           jsonb_build_array(jsonb_build_object('serviceId', ids.svc, 'name', 'Root touch-up')),
           9000, 'completed'
      from ids, (select id, (row_number() over (order by name))::integer as g
                   from public.clients where salon_id = (select a from ids)) cl
    returning id, client_id
  ) select * from ins;
grant select on appts to authenticated, service_role;

insert into public.appointments (salon_id, client_id, stylist_id, starts_at, ends_at, services,
                                 price_cents, status)
  select ids.a, c.bea, ids.owner_a, now() + interval '7 days', now() + interval '7 days 45 minutes',
         jsonb_build_array(jsonb_build_object('serviceId', ids.svc, 'name', 'Root touch-up')),
         9000, 'confirmed'
    from ids, c;

-- Schema & privileges -------------------------------------------------------------------
select ok(
  not has_function_privilege('authenticated', 'public.claim_marketing_messages(text[],integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.finish_marketing_messages(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.marketing_nudge_candidates(integer, timestamptz, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.save_rebook_nudges(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.marketing_subscription_by_token(text)', 'execute')
  and not has_function_privilege('anon', 'public.set_marketing_subscription_by_token(text,boolean)', 'execute')
  and not has_function_privilege('authenticated', 'public.set_marketing_subscription_by_token(text,boolean)', 'execute'),
  'delivery, nudge and token RPCs are service-role only');
select ok(
  not has_table_privilege('anon', 'public.marketing_messages', 'select')
  and not has_table_privilege('authenticated', 'public.marketing_messages', 'insert')
  and not has_table_privilege('authenticated', 'public.marketing_messages', 'update')
  and not has_table_privilege('authenticated', 'public.marketing_campaigns', 'insert')
  and not has_function_privilege('anon', 'public.approve_marketing_message(uuid,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.send_marketing_campaign(uuid,timestamptz)', 'execute'),
  'members change marketing only through RPCs; signed-out callers get nothing');
select is(
  (select count(*)::integer from cron.job where jobname in ('marketing-tick', 'marketing-nudge-scan')),
  2, 'the marketing cron jobs are scheduled');
select is(
  (select row(marketing_nudges_enabled, marketing_nudges_auto_send, marketing_reviews_enabled,
              marketing_reviews_auto_send, marketing_review_url)::text
     from public.settings where salon_id = (select a from ids)),
  row(true, false, true, false, null::text)::text,
  'nudges and reviews on, both need approval, no review URL by default');
select ok(
  (select bool_and(marketing_token ~ '^[0-9a-f]{64}$') and count(distinct marketing_token) = count(*)
     from public.clients where salon_id in (select a from ids union select b from ids)),
  'every client gets their own unsubscribe token');
select throws_ok(
  $$ update public.settings set marketing_review_url = 'http://example.com' where salon_id = (select a from ids) $$,
  '23514', null, 'the review URL must be https');

-- Rebook nudge candidates ---------------------------------------------------------------
select pg_temp.as_service_role();
create temp table cand as select public.marketing_nudge_candidates() as j;
select pg_temp.logout();
select is(
  (select array_agg(e ->> 'clientId' order by e ->> 'clientName') from cand, jsonb_array_elements(j) e),
  array[(select karina from c)::text],
  'candidates: opted in, with an email, nothing booked (Bea is booked, Maria opted out, Nia has no email)');
select is(
  (select e -> 'services' -> 0 ->> 'rebookIntervalDays' from cand, jsonb_array_elements(j) e),
  '28', 'candidates carry the service interval for the rebook engine');
select pg_temp.as_service_role();
select is(
  (select jsonb_array_length(public.marketing_nudge_candidates(200,
     (select (e -> 'visit' ->> 'startsAt')::timestamptz from cand, jsonb_array_elements(j) e),
     (select (e ->> 'clientId')::uuid from cand, jsonb_array_elements(j) e)))),
  0, 'candidates page by the last row seen');
select pg_temp.logout();

select pg_temp.as_service_role();
select is(
  public.save_rebook_nudges(jsonb_build_array(
    jsonb_build_object('clientId', (select karina from c),
                       'appointmentId', (select id from appts where client_id = (select karina from c)),
                       'subject', 'Time for a touch-up?', 'body', 'Hi {firstName}! {bookingLink}'),
    jsonb_build_object('clientId', (select bea from c),
                       'appointmentId', (select id from appts where client_id = (select bea from c)),
                       'subject', 'Time for a touch-up?', 'body', 'Hi!'))),
  '{"saved": 1, "queued": 0}'::jsonb,
  'nudges are saved as drafts; a client who has booked is skipped');
select is(
  (select jsonb_array_length(public.marketing_nudge_candidates())), 0,
  'a nudged visit is not a candidate again');
select pg_temp.logout();

-- Review requests -----------------------------------------------------------------------
-- No URL yet: completing a visit asks for nothing.
insert into public.appointments (salon_id, client_id, stylist_id, starts_at, ends_at, services, price_cents)
  select ids.a, c.karina, ids.owner_a, now() - interval '3 hours', now() - interval '2 hours',
         '[]'::jsonb, 9000 from ids, c;
update public.appointments set status = 'completed'
 where client_id = (select karina from c) and starts_at > now() - interval '1 day';
select is((select count(*)::integer from public.marketing_messages where kind = 'review_request'), 0,
  'no review request without a review URL');

update public.settings set marketing_review_url = 'https://g.page/r/marketing-a/review'
 where salon_id = (select a from ids);
create temp table visit as
  select ids.a, c.karina, c.maria, c.nia, ids.owner_a from ids, c;
insert into public.appointments (salon_id, client_id, stylist_id, starts_at, ends_at, services, price_cents)
  select a, cl, owner_a, now() - interval '5 hours' + make_interval(mins => 10 * g),
         now() - interval '5 hours' + make_interval(mins => 10 * g + 5), '[]'::jsonb, 9000
    from visit, lateral (values (karina, 1), (maria, 2), (nia, 3)) v(cl, g);
update public.appointments set status = 'completed'
 where status = 'confirmed' and starts_at < now() and salon_id = (select a from ids);
select is(
  (select array_agg(client_id) from public.marketing_messages where kind = 'review_request'),
  array[(select karina from c)],
  'checkout drafts a review request only for opted-in clients with an email');
select is(
  (select row(status, due_at > now() + interval '1 hour', body like '%{reviewLink}%')::text
     from public.marketing_messages where kind = 'review_request'),
  row('draft'::public.marketing_message_status, true, true)::text,
  'it is a draft due after the delay, linking the review page');

-- Approving & dismissing ----------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-f310-00000000000b');
select throws_ok(
  $$ select public.approve_marketing_message((select id from public.marketing_messages limit 1)) $$,
  'P0002', null, 'another salon can''t approve');
select is((select count(*)::integer from public.marketing_messages), 0,
  'another salon can''t read the messages');
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-f310-00000000000a');
select is(
  (select row(m.status, m.subject)::text from public.approve_marketing_message(
     (select id from public.marketing_messages where kind = 'rebook_nudge'), 'Touch-up time!') m),
  row('queued'::public.marketing_message_status, 'Touch-up time!')::text,
  'a member approves a draft, editing the subject');
select throws_ok(
  $$ select public.approve_marketing_message((select id from public.marketing_messages where kind = 'rebook_nudge')) $$,
  '55000', null, 'approving twice fails');
select is(
  (select status::text from public.dismiss_marketing_message(
     (select id from public.marketing_messages where kind = 'review_request'))),
  'dismissed', 'a member dismisses a draft');

-- Campaigns -----------------------------------------------------------------------------
select is(public.marketing_audience_count((select a from ids), '{}'), 2,
  'the audience is opted-in clients with an email (Karina, Bea)');
select is(public.marketing_audience_count((select a from ids), '{"tags":["vip"]}'), 1,
  'tags narrow the audience (case-insensitive)');
select is(public.marketing_audience_count((select a from ids), '{"noVisitForDays": 60}'), 0,
  'lapsed-client filter');
select throws_ok(
  $$ select public.marketing_audience_count((select a from ids), '{"bogus": 1}') $$,
  '22023', null, 'unknown audience keys are rejected');
select throws_ok(
  $$ select public.marketing_audience_count((select b from ids), '{}') $$,
  '42501', null, 'only members count an audience');

create temp table camp as
  select * from public.save_marketing_campaign((select a from ids), null, 'Holiday hours',
    'Open late before the holidays', E'Hi {firstName},\nWe''re open late! {bookingLink}', '{}');
select is((select status::text from camp), 'draft', 'a campaign starts as a draft');
select lives_ok(
  $$ select public.save_marketing_campaign((select a from ids), (select id from camp), 'Holiday hours',
       'Open late this December', 'Hi {firstName}! {bookingLink}', '{}') $$,
  'drafts can be edited');
select is(
  (select row(status, recipient_count)::text
     from public.send_marketing_campaign((select id from camp))),
  row('sent'::public.marketing_campaign_status, 2)::text,
  'approving a campaign queues one message per opted-in client');
select is(
  (select count(*)::integer from public.marketing_messages
    where campaign_id = (select id from camp) and status = 'queued'
      and subject = 'Open late this December'),
  2, 'with the edited copy');
select throws_ok(
  $$ select public.send_marketing_campaign((select id from camp)) $$,
  '55000', null, 'a campaign is sent once');

create temp table later as
  select * from public.save_marketing_campaign((select a from ids), null, 'New year',
    'New year promo', 'Hi {firstName}!', '{"tags":["VIP"]}');
select is(
  (select status::text from public.send_marketing_campaign((select id from later), now() + interval '2 days')),
  'scheduled', 'a campaign can be scheduled');
select public.cancel_marketing_campaign((select id from later));
select is(
  (select row(c.status, (select count(*) from public.marketing_messages m
                          where m.campaign_id = c.id and m.status = 'dismissed'))::text
     from public.marketing_campaigns c where c.id = (select id from later)),
  row('cancelled'::public.marketing_campaign_status, 1::bigint)::text,
  'cancelling a scheduled campaign dismisses its messages');
select pg_temp.logout();

-- Claiming ------------------------------------------------------------------------------
-- Bea's campaign email is fine (campaigns don't care about bookings); a queued nudge for a
-- client who has since booked would be skipped. Maria opts out after being queued.
insert into public.marketing_messages (salon_id, client_id, kind, subject, body, status, dedupe_key)
  select a, bea, 'rebook_nudge', 'x', 'y', 'queued', 'test:bea' from ids, c;
insert into public.marketing_messages (salon_id, client_id, kind, subject, body, status, dedupe_key)
  select a, maria, 'campaign', 'x', 'y', 'queued', 'test:maria' from ids, c;
insert into public.marketing_messages (salon_id, client_id, kind, channel, subject, body, status, dedupe_key)
  select a, karina, 'campaign', 'sms', 'x', 'y', 'queued', 'test:sms' from ids, c;

select pg_temp.as_service_role();
create temp table claimed as select public.claim_marketing_messages(array['email'], 50) as j;
select pg_temp.logout();
select is(
  (select jsonb_array_length(j) from claimed), 3,
  'claims the approved nudge and both campaign emails');
select is(
  (select array_agg(dedupe_key || ':' || last_error order by dedupe_key)
     from public.marketing_messages where status = 'skipped'),
  array['test:bea:already_booked', 'test:maria:opted_out'],
  'skips nudges for booked clients and anyone who opted out');
select is(
  (select status::text from public.marketing_messages where dedupe_key = 'test:sms'), 'queued',
  'SMS stays queued until a channel can deliver it');
select ok(
  (select bool_and(e ? 'unsubscribeToken' and e ->> 'to' is not null and e -> 'salon' ->> 'name' = 'Marketing A'
                   and e ->> 'reviewUrl' = 'https://g.page/r/marketing-a/review')
     from claimed, jsonb_array_elements(j) e),
  'claimed rows carry the address, unsubscribe token, salon and review URL');

select pg_temp.as_service_role();
select is(
  public.finish_marketing_messages((
    select jsonb_agg(jsonb_build_object(
             'id', e ->> 'id',
             'outcome', case when e ->> 'kind' = 'rebook_nudge' then 'retry' else 'sent' end,
             'providerId', 'p1'))
      from claimed, jsonb_array_elements(j) e)),
  3, 'finishing records every claimed message');
select pg_temp.logout();
select is(
  (select array_agg(kind || ':' || status order by kind, status)
     from public.marketing_messages
    where id in (select (e ->> 'id')::uuid from claimed, jsonb_array_elements(j) e)),
  array['rebook_nudge:queued', 'campaign:sent', 'campaign:sent'],
  'sent ones are done; a retry goes back to the queue');
select ok(
  (select due_at > now() from public.marketing_messages where kind = 'rebook_nudge' and status = 'queued'),
  'with a backoff');

-- One-click unsubscribe -----------------------------------------------------------------
insert into public.marketing_messages (salon_id, client_id, kind, subject, body, status, dedupe_key)
  select a, karina, 'campaign', 'x', 'y', 'draft', 'test:karina-draft' from ids, c;
select pg_temp.as_service_role();
select is(
  public.marketing_subscription_by_token((select marketing_token from public.clients where id = (select karina from c))),
  '{"salonName": "Marketing A", "clientFirstName": "Karina", "subscribed": true}'::jsonb,
  'the link shows who is subscribed (first name only)');
select is(
  public.set_marketing_subscription_by_token(
    (select marketing_token from public.clients where id = (select karina from c)), false) ->> 'subscribed',
  'false', 'one click unsubscribes');
select is(public.marketing_subscription_by_token(repeat('0', 64)), null, 'unknown tokens show nothing');
select pg_temp.logout();
select ok(
  (select not marketing_opt_in and marketing_opted_out_at is not null
     from public.clients where id = (select karina from c))
  and not exists (select 1 from public.marketing_messages
                   where client_id = (select karina from c) and status in ('draft', 'queued')),
  'the client is opted out and their pending marketing is skipped');
select pg_temp.as_service_role();
select public.set_marketing_subscription_by_token(
  (select marketing_token from public.clients where id = (select karina from c)), true);
select pg_temp.logout();
select ok(
  (select marketing_opt_in and marketing_opted_out_at is null
     from public.clients where id = (select karina from c)),
  'opting back in from the link clears the stamp');

select * from finish();
rollback;
