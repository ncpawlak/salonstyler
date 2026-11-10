-- Reports dashboard (#43): sales_report for a month reconciles with the payments data: the sum
-- of that month's daily payout summaries, the Stripe payments recorded for card checkouts, and
-- the checkout line items. Also covers month boundaries in the salon time zone, what is left
-- out (open / canceled checkouts, holds), clients, no-shows, rebook rate and access.
begin;
select plan(30);
create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
                    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
$$;
create function pg_temp.logout() returns void language sql as $$
  reset role;
  select set_config('request.jwt.claims', '', true);
$$;

insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-4000-9024-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@reports-a.test'),
  ('00000000-0000-4000-9024-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@reports-b.test');
select pg_temp.login('00000000-0000-4000-9024-00000000000a');
select public.create_salon('Reports Salon A', 'reports-salon-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-9024-00000000000b');
select public.create_salon('Reports Salon B', 'reports-salon-b', 'America/New_York');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'reports-salon-a') as a,
         '00000000-0000-4000-9024-00000000000a'::uuid as owner,
         '00000000-0000-4000-9124-0000000000c1'::uuid as cut,
         '00000000-0000-4000-9124-0000000000c2'::uuid as color,
         '00000000-0000-4000-9124-0000000000f1'::uuid as karina,
         '00000000-0000-4000-9124-0000000000f2'::uuid as maria,
         '00000000-0000-4000-9124-0000000000f3'::uuid as lee;
grant select on ids to authenticated, anon;

insert into public.services (id, salon_id, name, price_cents)
  select cut, a, 'Women''s Haircut', 6500 from ids
  union all select color, a, 'All-over Color', 12000 from ids;
insert into public.clients (id, salon_id, name)
  select karina, a, 'Karina Lopez' from ids
  union all select maria, a, 'Maria Chen' from ids
  union all select lee, a, 'Lee Park' from ids;

-- Appointments (Chicago is UTC-5 in October until Nov 1, 2 AM).
insert into public.appointments (id, salon_id, client_id, stylist_id, status, starts_at, ends_at, hold_expires_at)
select v.id::uuid, i.a, v.client, i.owner, v.status::public.appointment_status, v.s::timestamptz,
       v.s::timestamptz + interval '1 hour',
       case when v.status = 'held' then v.s::timestamptz end
  from ids i, (values
    ('00000000-0000-4000-9224-000000000000', (select karina from ids), 'completed', '2026-09-15 15:00Z'),
    ('00000000-0000-4000-9224-000000000001', (select karina from ids), 'completed', '2026-10-03 15:00Z'),
    ('00000000-0000-4000-9224-000000000002', (select maria  from ids), 'completed', '2026-10-10 15:00Z'),
    ('00000000-0000-4000-9224-000000000003', (select maria  from ids), 'completed', '2026-10-20 15:00Z'),
    ('00000000-0000-4000-9224-000000000004', (select karina from ids), 'no_show',   '2026-10-25 15:00Z'),
    ('00000000-0000-4000-9224-000000000005', (select lee    from ids), 'cancelled', '2026-10-28 15:00Z'),
    ('00000000-0000-4000-9224-000000000006', (select lee    from ids), 'held',      '2026-10-29 15:00Z'),
    ('00000000-0000-4000-9224-000000000007', (select karina from ids), 'confirmed', '2026-12-05 15:00Z')
  ) as v(id, client, status, s);

-- Checkouts. c1-c4 are October (c3 at 11:30 PM Oct 31 local); c0 and c7 are September (c7 at
-- 11 PM Sep 30 local); c5 is open and c6 canceled.
insert into public.checkouts (id, salon_id, appointment_id, client_id, status, currency,
                              subtotal_cents, tip_cents, deposit_cents, amount_due_cents,
                              method, stripe_payment_intent_id, paid_at, rebook_appointment_id)
select v.id::uuid, i.a, v.appt::uuid, v.client, v.status::public.checkout_status, 'usd',
       v.sub, v.tip, v.dep, greatest(v.sub + v.tip - v.dep, 0), v.method::public.checkout_method,
       v.pi, v.paid::timestamptz, v.rebook::uuid
  from ids i, (values
    ('00000000-0000-4000-9324-000000000000', '00000000-0000-4000-9224-000000000000', (select karina from ids), 'paid', 6500, 1000, 0, 'cash', null, '2026-09-15 20:00Z', null),
    ('00000000-0000-4000-9324-000000000001', '00000000-0000-4000-9224-000000000001', (select karina from ids), 'paid', 17600, 3000, 2000, 'card', 'pi_rep1', '2026-10-03 17:00Z', '00000000-0000-4000-9224-000000000007'),
    ('00000000-0000-4000-9324-000000000002', '00000000-0000-4000-9224-000000000002', (select maria from ids), 'paid', 6500, 1500, 0, 'cash', null, '2026-10-10 18:00Z', null),
    ('00000000-0000-4000-9324-000000000003', '00000000-0000-4000-9224-000000000003', (select maria from ids), 'paid', 18500, 0, 0, 'card', 'pi_rep3', '2026-11-01 04:30Z', null),
    ('00000000-0000-4000-9324-000000000004', null, (select lee from ids), 'paid', 2900, 0, 0, 'other', null, '2026-10-15 16:00Z', null),
    ('00000000-0000-4000-9324-000000000005', null, (select lee from ids), 'open', 9900, 0, 0, null, null, null, null),
    ('00000000-0000-4000-9324-000000000006', null, (select lee from ids), 'canceled', 4400, 0, 0, null, null, null, null),
    ('00000000-0000-4000-9324-000000000007', null, null, 'paid', 5000, 0, 0, 'cash', null, '2026-10-01 04:00Z', null)
  ) as v(id, appt, client, status, sub, tip, dep, method, pi, paid, rebook);

insert into public.checkout_items (salon_id, checkout_id, position, kind, name, quantity, unit_amount_cents, source_id)
select i.a, v.c::uuid, v.pos, v.kind::public.checkout_item_kind, v.name, v.qty, v.unit, v.src
  from ids i, (values
    ('00000000-0000-4000-9324-000000000000', 0, 'service', 'Women''s Haircut', 1, 6500, (select cut from ids)),
    ('00000000-0000-4000-9324-000000000001', 0, 'service', 'All-over Color', 1, 12000, (select color from ids)),
    ('00000000-0000-4000-9324-000000000001', 1, 'addon', 'Gloss', 1, 2000, null),
    ('00000000-0000-4000-9324-000000000001', 2, 'retail', 'Shampoo', 2, 1800, null),
    ('00000000-0000-4000-9324-000000000002', 0, 'service', 'Women''s Haircut', 1, 6500, (select cut from ids)),
    ('00000000-0000-4000-9324-000000000003', 0, 'service', 'Women''s Haircut', 1, 6500, (select cut from ids)),
    ('00000000-0000-4000-9324-000000000003', 1, 'service', 'All-over Color', 1, 12000, (select color from ids)),
    ('00000000-0000-4000-9324-000000000004', 0, 'retail', 'Texture spray', 1, 2400, null),
    ('00000000-0000-4000-9324-000000000004', 1, 'custom', 'Gift wrap', 1, 500, null),
    ('00000000-0000-4000-9324-000000000005', 0, 'service', 'Women''s Haircut', 1, 9900, (select cut from ids)),
    ('00000000-0000-4000-9324-000000000006', 0, 'retail', 'Shampoo', 1, 4400, null),
    ('00000000-0000-4000-9324-000000000007', 0, 'service', 'Women''s Haircut', 1, 5000, (select cut from ids))
  ) as v(c, pos, kind, name, qty, unit, src);

-- Stripe payments: the two card checkouts (one part-refunded on Oct 31 local) and Karina's
-- deposit, which her checkout credited.
insert into public.payments (salon_id, appointment_id, stripe_payment_intent_id, amount_cents,
                             amount_refunded_cents, currency, status, created_at, updated_at)
select i.a, v.appt::uuid, v.pi, v.amount, v.refunded, 'usd', v.status::public.payment_status,
       v.created::timestamptz, v.updated::timestamptz
  from ids i, (values
    ('00000000-0000-4000-9224-000000000001', 'pi_rep1', 18600, 0, 'succeeded', '2026-10-03 17:00Z', '2026-10-03 17:00Z'),
    ('00000000-0000-4000-9224-000000000003', 'pi_rep3', 18500, 1000, 'partially_refunded', '2026-11-01 04:30Z', '2026-11-01 04:40Z'),
    ('00000000-0000-4000-9224-000000000001', 'pi_dep1', 2000, 0, 'succeeded', '2026-09-30 15:00Z', '2026-09-30 15:00Z')
  ) as v(appt, pi, amount, refunded, status, created, updated);

-- Karina's no-show kept her $25 deposit.
insert into public.appointment_deposits (salon_id, appointment_id, amount_cents, currency, status,
                                         status_after, paid_at, resolved_at, resolution)
select a, '00000000-0000-4000-9224-000000000004', 2500, 'usd', 'kept', 'confirmed',
       '2026-10-20 15:00Z', '2026-10-25 17:00Z', 'no_show' from ids;

select has_function('public', 'sales_report', array['uuid', 'date', 'date'], 'sales_report exists');

select pg_temp.login('00000000-0000-4000-9024-00000000000a');
create temp table r as select public.sales_report((select a from ids), '2026-10-01', '2026-10-31') as j;
select pg_temp.logout();

-- Headline numbers ----------------------------------------------------------------
select is((select (j->>'checkouts')::int from r), 4,
  'paid checkouts in the month count, by salon-local paid date; open and canceled ones do not');
select is((select (j->>'salesCents')::bigint from r), 45500::bigint, 'sales are the paid subtotals');
select is((select (j->>'servicesCents')::bigint from r), 39000::bigint, 'services include add-ons');
select is((select (j->>'retailCents')::bigint from r), 6000::bigint, 'retail is the retail lines');
select is((select (j->>'retailItems')::int from r), 3, 'retail items count quantities');
select is((select (j->>'otherSalesCents')::bigint from r), 500::bigint, 'custom lines are other sales');
select is((select (j->>'tipsCents')::bigint from r), 4500::bigint, 'tips');
select is((select (j->>'avgTicketCents')::bigint from r), 11375::bigint,
  'average ticket is sales per checkout, before tips');
select is((select (j->>'keptDepositsCents')::bigint from r), 2500::bigint,
  'kept deposits (no-show / late-cancel fees) are reported');
select is((select j->'topServices' from r),
  '[{"name": "All-over Color", "count": 2, "cents": 24000},
    {"name": "Women''s Haircut", "count": 2, "cents": 13000}]'::jsonb,
  'top services by revenue');
select is((select jsonb_array_length(j->'daily') from r), 31, 'one daily point per day');
select is((select (j->'daily'->30->>'salesCents')::bigint from r), 18500::bigint,
  '11:30 PM on Oct 31 local lands on Oct 31');
select is((select (j->'daily'->0->>'salesCents')::bigint from r), 0::bigint,
  '11 PM on Sep 30 local is not in October');

-- Reconciliation with the payments data ----------------------------------------------
select is((select (j->>'servicesCents')::bigint + (j->>'retailCents')::bigint
                  + (j->>'otherSalesCents')::bigint from r),
          (select (j->>'salesCents')::bigint from r),
  'services + retail + other = sales');
select is((select sum((d->>'salesCents')::bigint)::bigint from r, jsonb_array_elements(j->'daily') d),
          (select (j->>'salesCents')::bigint from r), 'the daily series adds up to sales');
select is((select (j->>'salesCents')::bigint + (j->>'tipsCents')::bigint from r),
          (select (j->>'collectedCents')::bigint + (j->>'depositsAppliedCents')::bigint from r),
  'sales + tips = collected at checkout + deposits credited');

create temp table payouts as
  select sum((s->>'totalCents')::bigint)::bigint as total, sum((s->>'tipCents')::bigint)::bigint as tips,
         sum((s->>'cardCents')::bigint)::bigint as card, sum((s->>'cashCents')::bigint)::bigint as cash,
         sum((s->>'otherCents')::bigint)::bigint as other, sum((s->>'refundedCents')::bigint)::bigint as refunded,
         sum((s->>'checkouts')::int)::bigint as checkouts
    from ids, generate_series('2026-10-01'::date, '2026-10-31'::date, interval '1 day') d,
         lateral private.payout_summary(a, d::date) s;
select results_eq(
  $$ select (j->>'collectedCents')::bigint, (j->>'tipsCents')::bigint, (j->>'cardCents')::bigint,
            (j->>'cashCents')::bigint, (j->>'otherCents')::bigint, (j->>'refundedCents')::bigint,
            (j->>'checkouts')::bigint from r $$,
  $$ select total, tips, card, cash, other, refunded, checkouts::bigint from payouts $$,
  'the month equals the sum of its daily payout summaries');
select is((select (j->>'collectedCents')::bigint from r), 48000::bigint, 'collected');
select is((select (j->>'cardCents')::bigint from r),
          (select sum(p.amount_cents)::bigint from public.payments p
             join public.checkouts c on c.stripe_payment_intent_id = p.stripe_payment_intent_id
            where c.status = 'paid' and c.method = 'card'
              and c.paid_at >= '2026-10-01 05:00Z' and c.paid_at < '2026-11-01 05:00Z'),
  'card takings equal the Stripe payments recorded for the month''s card checkouts');
select is((select (j->>'depositsAppliedCents')::bigint from r),
          (select sum(amount_cents)::bigint from public.payments where stripe_payment_intent_id = 'pi_dep1'),
  'deposits credited equal the deposit payments');
select is((select (j->>'refundedCents')::bigint from r), 1000::bigint,
  'refunds recorded during the month');

-- Clients, appointments, rebook -----------------------------------------------------
select is((select j->'clients' from r), '{"served": 3, "new": 2, "returning": 1}'::jsonb,
  'Maria and Lee are new this month; Karina is returning');
select is((select j->'appointments' from r),
  '{"booked": 5, "completed": 3, "noShows": 1, "cancelled": 1}'::jsonb,
  'appointments by outcome; holds are left out');
select is((select j->'rebook'->>'rate' from r), '0.2500', 'rebook rate comes from rebook_stats');

-- Access and validation ---------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-9024-00000000000b');
select throws_ok($$ select public.sales_report((select a from ids), '2026-10-01', '2026-10-31') $$,
  '42501', 'Not a member of this salon', 'other salons cannot read the report');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-9024-00000000000a');
select throws_ok($$ select public.sales_report((select a from ids), '2026-10-31', '2026-10-01') $$,
  '22023', 'p_from must not be after p_to', 'ranges must not be reversed');
select throws_ok($$ select public.sales_report((select a from ids), '2024-01-01', '2026-10-01') $$,
  '22023', 'Reports cover at most a year', 'ranges are capped at a year');
select is((select (public.sales_report((select a from ids))->>'to')::date
             - (public.sales_report((select a from ids))->>'from')::date), 29,
  'the default range is the last 30 days');
select pg_temp.logout();
select ok(not has_function_privilege('anon', 'public.sales_report(uuid, date, date)', 'execute'),
  'anon cannot run reports');

select * from finish();
rollback;
