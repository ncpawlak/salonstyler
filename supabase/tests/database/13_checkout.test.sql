-- Checkout (#11): members draft, edit and settle checkouts through RPCs; card payments are
-- completed only by the service role; the public receipt is readable by token; owners get an
-- end-of-day payout summary push.
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
create function pg_temp.as_anon() returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
$$;
create function pg_temp.logout() returns void language sql as $$
  reset role;
  select set_config('request.jwt.claims', '', true);
$$;

insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-4000-d000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@co-a.test'),
  ('00000000-0000-4000-d000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stylist@co-a.test'),
  ('00000000-0000-4000-d000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@co-b.test');
select pg_temp.login('00000000-0000-4000-d000-00000000000a');
select public.create_salon('Checkout Salon A', 'checkout-salon-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-d000-00000000000b');
select public.create_salon('Checkout Salon B', 'checkout-salon-b', 'America/New_York');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'checkout-salon-a') as a,
         (select id from public.salons where slug = 'checkout-salon-b') as b,
         '00000000-0000-4000-d100-000000000001'::uuid as svc,
         '00000000-0000-4000-d100-000000000002'::uuid as addon,
         '00000000-0000-4000-d100-000000000003'::uuid as client;
grant select on ids to authenticated, service_role, anon;
insert into public.salon_members (salon_id, user_id, role)
  select a, '00000000-0000-4000-d000-0000000000a2', 'stylist' from ids;
insert into public.services (id, salon_id, name, price_cents) select svc, a, 'Balayage', 6000 from ids;
insert into public.service_addons (id, salon_id, name, price_cents) select addon, a, 'Toner', 1500 from ids;
insert into public.clients (id, salon_id, name) select client, a, 'Dana Rivers' from ids;

create temp table appts as
  with ins as (
    insert into public.appointments (salon_id, client_id, stylist_id, starts_at, ends_at, services, price_cents)
    select a, client, '00000000-0000-4000-d000-0000000000a2',
           now() - interval '2 hours' + make_interval(hours => g), now() - interval '1 hour' + make_interval(hours => g),
           jsonb_build_array(jsonb_build_object('serviceId', svc, 'name', 'Balayage', 'variantName', 'Long',
                                                'addonIds', jsonb_build_array(addon))),
           7500
      from ids, generate_series(0, 2) g
    returning id, starts_at)
  select (array_agg(id order by starts_at))[1] as a1,
         (array_agg(id order by starts_at))[2] as a2,
         (array_agg(id order by starts_at))[3] as a3
    from ins;
grant select on appts to authenticated, service_role, anon;

-- A $20 deposit already captured for the first appointment.
insert into public.payments (salon_id, appointment_id, stripe_payment_intent_id, amount_cents, currency, status)
  select a, a1, 'pi_deposit_a1', 2000, 'usd', 'succeeded' from ids, appts;

select has_table('public', 'checkouts', 'checkouts table exists');
select has_table('public', 'checkout_items', 'checkout_items table exists');

-- Drafting ------------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-d000-0000000000a2');
select lives_ok($$ select public.start_checkout(a1) from appts $$, 'a stylist can start a checkout');
create temp table co as select id, receipt_token from public.checkouts where appointment_id = (select a1 from appts);
grant select on co to authenticated, service_role, anon;
select results_eq(
  $$ select kind::text, name, unit_amount_cents from public.checkout_items
      where checkout_id = (select id from co) order by position $$,
  $$ values ('service', 'Balayage · Long', 6000), ('addon', 'Toner', 1500) $$,
  'the draft lists booked services and add-ons at catalog prices');
select results_eq(
  $$ select subtotal_cents, deposit_cents, amount_due_cents, currency, client_id
       from public.checkouts where id = (select id from co) $$,
  $$ select 7500, 2000, 5500, 'usd'::text, (select client from ids) $$,
  'the deposit is applied against the total');
select is((select (public.start_checkout(a1)).id from appts), (select id from co),
  'starting again returns the same checkout');

-- Editing -------------------------------------------------------------------------
select lives_ok(
  $$ select public.update_checkout((select id from co), '[
       {"kind":"service","name":"Balayage · Long","unitAmountCents":6000},
       {"kind":"addon","name":"Toner","unitAmountCents":1500},
       {"kind":"retail","name":"Shampoo","quantity":2,"unitAmountCents":1250}
     ]'::jsonb, 1000) $$,
  'lines and tip can be edited');
select results_eq(
  $$ select subtotal_cents, tip_cents, deposit_cents, amount_due_cents
       from public.checkouts where id = (select id from co) $$,
  $$ values (10000, 1000, 2000, 9000) $$,
  'totals are recomputed: services + retail + tip − deposit');
select throws_ok(
  $$ select public.update_checkout((select id from co), '[{"kind":"gift","name":"x","unitAmountCents":1}]', 0) $$,
  '22023', null, 'unknown line kinds are rejected');
select throws_ok(
  $$ select public.update_checkout((select id from co), '[{"kind":"retail","name":"x","unitAmountCents":-5}]', 0) $$,
  '22023', null, 'negative prices are rejected');
select throws_ok(
  $$ select public.update_checkout((select id from co), '[]', -1) $$,
  '22023', null, 'negative tips are rejected');
select is((select amount_due_cents from public.checkouts where id = (select id from co)), 9000,
  'a rejected edit leaves the checkout unchanged');
select throws_ok(
  $$ update public.checkouts set amount_due_cents = 0 where id = (select id from co) $$,
  '42501', null, 'members cannot write checkouts directly');
select throws_ok(
  $$ select public.complete_card_checkout((select id from co), 'pi_fake') $$,
  '42501', null, 'members cannot mark a card payment');
select throws_ok(
  $$ select public.pay_checkout_offline((select id from co), 'card') $$,
  '22023', null, 'card payments cannot be recorded offline');
select pg_temp.logout();

-- Tenancy -------------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-d000-00000000000b');
select is((select count(*)::integer from public.checkouts where id = (select id from co)), 0,
  'other salons cannot see the checkout');
select throws_ok($$ select public.start_checkout(a1) from appts $$, 'P0002', null,
  'other salons cannot check out the appointment');
select throws_ok($$ select public.update_checkout((select id from co), '[]', 0) $$, 'P0002', null,
  'other salons cannot edit the checkout');
select throws_ok($$ select public.payout_summary((select a from ids)) $$, '42501', null,
  'other salons cannot read the payout summary');
select pg_temp.logout();

-- Cash ----------------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-d000-0000000000a2');
select lives_ok($$ select public.pay_checkout_offline((select id from co), 'cash') $$,
  'a checkout can be settled in cash');
select results_eq(
  $$ select status::text, method::text, paid_at is not null from public.checkouts where id = (select id from co) $$,
  $$ values ('paid', 'cash', true) $$, 'the checkout is paid');
select is((select status::text from public.appointments where id = (select a1 from appts)), 'completed',
  'paying completes the appointment');
select throws_ok($$ select public.update_checkout((select id from co), '[]', 0) $$, '22023', null,
  'paid checkouts are locked');
select pg_temp.logout();

-- Card (service role, as the checkout Edge Function does) -----------------------------
select pg_temp.login('00000000-0000-4000-d000-0000000000a2');
create temp table co2 as select (public.start_checkout(a2)).id from appts;
grant select on co2 to service_role;
select pg_temp.logout();
select pg_temp.as_service_role();
update public.checkouts set stripe_payment_intent_id = 'pi_card_a2' where id = (select id from co2);
select lives_ok(
  $$ select public.complete_card_checkout((select id from co2), 'pi_card_a2', 'visa', '4242') $$,
  'the service role completes a card checkout');
select results_eq(
  $$ select status::text, method::text, card_brand, card_last4, amount_due_cents
       from public.checkouts where id = (select id from co2) $$,
  $$ values ('paid', 'card', 'visa', '4242', 7500) $$,
  'card details are recorded; no deposit on this appointment');
select lives_ok(
  $$ select public.complete_card_checkout((select id from co2), 'pi_card_a2') $$,
  'completing again (webhook + app) is idempotent');
select is((select card_last4 from public.checkouts where id = (select id from co2)), '4242',
  'a repeat completion keeps the card details');
select is((select status::text from public.appointments where id = (select a2 from appts)), 'completed',
  'the card payment completes the appointment');
select pg_temp.logout();

-- Public receipt --------------------------------------------------------------------
select pg_temp.as_anon();
select results_eq(
  $$ select r ->> 'salonName', r ->> 'clientName', (r ->> 'amountDueCents')::integer,
            jsonb_array_length(r -> 'items')
       from (select public.get_receipt((select receipt_token from co)) as r) x $$,
  $$ values ('Checkout Salon A', 'Dana', 9000, 3) $$,
  'anyone with the link can read the receipt');
select is(public.get_receipt(repeat('0', 64)), null, 'unknown tokens return nothing');
select throws_ok($$ select count(*) from public.checkouts $$, '42501', null,
  'anon cannot read checkouts');
select pg_temp.logout();

-- Payout summary --------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-d000-00000000000a');
select results_eq(
  $$ select (s ->> 'checkouts')::integer, (s ->> 'totalCents')::integer, (s ->> 'cashCents')::integer,
            (s ->> 'cardCents')::integer, (s ->> 'tipCents')::integer
       from (select public.payout_summary((select a from ids),
                                          (now() at time zone 'America/Chicago')::date) as s) x $$,
  $$ values (2, 16500, 9000, 7500, 1000) $$,
  'the owner sees today''s takings');
select pg_temp.logout();

create temp table evening as
  select (((now() at time zone 'America/Chicago')::date + time '20:30') at time zone 'America/Chicago') as at;
select is(private.enqueue_payout_summaries((select at from evening)), 1,
  'one evening summary is queued for the owner');
select is(private.enqueue_payout_summaries((select at from evening)), 0,
  'the summary is queued once per day');
select results_eq(
  $$ select user_id, title from public.notifications_outbox
      where kind = 'payout_summary' and salon_id = (select a from ids) $$,
  $$ values ('00000000-0000-4000-d000-00000000000a'::uuid, 'Today: $165.00 from 2 checkouts'::text) $$,
  'only owners get it, with the day''s total');

select * from finish();
rollback;
