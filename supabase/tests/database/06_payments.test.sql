-- Stripe Connect: salon members read their own Stripe account and payments; only the service role
-- (payments / stripe-webhook Edge Functions) writes them.
begin;
select plan(27);

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
  ('00000000-0000-4000-c000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@pay-a.test'),
  ('00000000-0000-4000-c000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stylist@pay-a.test'),
  ('00000000-0000-4000-c000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@pay-b.test');

select pg_temp.login('00000000-0000-4000-c000-00000000000a');
select public.create_salon('Pay Salon A', 'pay-salon-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-c000-00000000000b');
select public.create_salon('Pay Salon B', 'pay-salon-b', 'America/New_York');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'pay-salon-a') as a,
         (select id from public.salons where slug = 'pay-salon-b') as b;
grant select on ids to authenticated, service_role, anon;

insert into public.salon_members (salon_id, user_id, role)
  select a, '00000000-0000-4000-c000-0000000000a2', 'stylist' from ids;

create temp table appts as
  with ins as (
    insert into public.appointments (salon_id, stylist_id, starts_at, ends_at)
    select a, '00000000-0000-4000-c000-00000000000a', '2026-12-01 15:00+00', '2026-12-01 16:00+00' from ids
    returning id)
  select id as a1 from ins;
grant select on appts to authenticated, service_role, anon;

-- Service role (Edge Functions) writes ------------------------------------------
select pg_temp.as_service_role();

select lives_ok(
  $$ insert into public.stripe_accounts (salon_id, stripe_account_id, requirements_due)
     select a, 'acct_1PaySalonA', '{external_account}'::text[] from ids
     union all
     select b, 'acct_1PaySalonB', '{}'::text[] from ids $$,
  'service role can connect Stripe accounts');

select lives_ok(
  $$ update public.stripe_accounts
        set details_submitted = true, charges_enabled = true, payouts_enabled = true,
            requirements_due = '{}'
      where stripe_account_id = 'acct_1PaySalonA' $$,
  'service role can sync account status');

select lives_ok(
  $$ insert into public.payments
       (salon_id, appointment_id, stripe_payment_intent_id, stripe_account_id, amount_cents, currency, status)
     select a, a1, 'pi_3PayA0001', 'acct_1PaySalonA', 18500, 'usd', 'succeeded'::public.payment_status from ids, appts
     union all
     select b, null, 'pi_3PayB0001', 'acct_1PaySalonB', 6000, 'usd', 'pending'::public.payment_status from ids $$,
  'service role can record payments, optionally linked to an appointment');

select throws_ok(
  $$ insert into public.payments (salon_id, appointment_id, stripe_payment_intent_id, amount_cents, currency, status)
     select a, gen_random_uuid(), 'pi_noappt', 100, 'usd', 'pending' from ids $$,
  '23503', null, 'appointment_id must reference an existing appointment');

select throws_ok(
  $$ insert into public.payments (salon_id, appointment_id, stripe_payment_intent_id, amount_cents, currency, status)
     select b, a1, 'pi_crosssalon', 100, 'usd', 'pending' from ids, appts $$,
  '23503', null, 'a payment cannot reference another salon''s appointment');

select lives_ok(
  $$ insert into public.payments (salon_id, stripe_payment_intent_id, amount_cents, currency, status)
     select a, 'pi_3PayA0001', 18500, 'usd', 'partially_refunded' from ids
     on conflict (stripe_payment_intent_id)
     do update set status = excluded.status, amount_refunded_cents = 5000 $$,
  'webhook upserts are idempotent on the PaymentIntent id');

select throws_ok(
  $$ insert into public.stripe_accounts (salon_id, stripe_account_id) select a, 'acct_dupe' from ids $$,
  '23505', null, 'one Stripe account per salon');

select throws_ok(
  $$ update public.stripe_accounts set stripe_account_id = 'not-an-account' where stripe_account_id = 'acct_1PaySalonB' $$,
  '23514', null, 'stripe_account_id must look like acct_…');

select throws_ok(
  $$ insert into public.payments (salon_id, stripe_payment_intent_id, amount_cents, currency, status)
     select a, 'ch_wrong', 100, 'usd', 'pending' from ids $$,
  '23514', null, 'stripe_payment_intent_id must look like pi_…');

select throws_ok(
  $$ insert into public.payments (salon_id, stripe_payment_intent_id, amount_cents, currency, status)
     select a, 'pi_negative', -1, 'usd', 'pending' from ids $$,
  '23514', null, 'amounts cannot be negative');

select throws_ok(
  $$ insert into public.payments (salon_id, stripe_payment_intent_id, amount_cents, currency, status)
     select a, 'pi_badcurrency', 100, 'USD', 'pending' from ids $$,
  '23514', null, 'currency is a lowercase ISO code');

select pg_temp.logout();

select is(
  (select count(*)::int from information_schema.table_constraints
   where table_schema = 'public' and table_name = 'payments' and constraint_type = 'FOREIGN KEY'),
  2, 'payments references salons and appointments');

-- Owner A ------------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-c000-00000000000a');

select is(
  (select stripe_account_id || ':' || charges_enabled || ':' || payouts_enabled from public.stripe_accounts),
  'acct_1PaySalonA:true:true', 'owner sees only their salon''s Stripe account');

select is(
  (select string_agg(stripe_payment_intent_id || ':' || status || ':' || amount_refunded_cents, ',') from public.payments),
  'pi_3PayA0001:partially_refunded:5000', 'owner sees only their salon''s payments');

select throws_ok(
  $$ update public.stripe_accounts set charges_enabled = false $$,
  '42501', null, 'owner cannot fake account status');

select throws_ok(
  $$ insert into public.stripe_accounts (salon_id, stripe_account_id) select a, 'acct_1Spoofed' from ids $$,
  '42501', null, 'owner cannot attach an arbitrary Stripe account');

select throws_ok(
  $$ insert into public.payments (salon_id, stripe_payment_intent_id, amount_cents, currency, status)
     select a, 'pi_fake', 100, 'usd', 'succeeded' from ids $$,
  '42501', null, 'owner cannot record payments');

select throws_ok(
  $$ update public.payments set status = 'refunded' $$,
  '42501', null, 'owner cannot change payments');

select throws_ok(
  $$ delete from public.payments $$,
  '42501', null, 'owner cannot delete payments');

select pg_temp.logout();

-- Stylist (member of A) ----------------------------------------------------------
select pg_temp.login('00000000-0000-4000-c000-0000000000a2');

select is((select count(*)::int from public.stripe_accounts), 1, 'stylist can read the salon''s Stripe status');
select is((select count(*)::int from public.payments), 1, 'stylist can read the salon''s payments');
select throws_ok(
  $$ update public.payments set amount_cents = 1 $$,
  '42501', null, 'stylist cannot change payments');

select pg_temp.logout();

-- Owner B cannot see A ---------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-c000-00000000000b');

select is(
  (select string_agg(stripe_account_id, ',') from public.stripe_accounts),
  'acct_1PaySalonB', 'other salons'' Stripe accounts are invisible');
select is(
  (select string_agg(stripe_payment_intent_id, ',') from public.payments),
  'pi_3PayB0001', 'other salons'' payments are invisible');

select pg_temp.logout();

-- Anonymous ------------------------------------------------------------------------
select pg_temp.as_anon();

select throws_ok($$ select * from public.stripe_accounts $$, '42501', null, 'anon cannot read Stripe accounts');
select throws_ok($$ select * from public.payments $$, '42501', null, 'anon cannot read payments');

select pg_temp.logout();

delete from public.appointments where id = (select a1 from appts);
select is(
  (select salon_id = (select a from ids) and appointment_id is null
   from public.payments where stripe_payment_intent_id = 'pi_3PayA0001'),
  true, 'deleting an appointment keeps the payment and clears appointment_id');

select * from finish();
rollback;
