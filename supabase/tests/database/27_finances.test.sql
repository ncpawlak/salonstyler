-- Booth-renter finances (#44): owner-only expenses and booth rent, recurring posting (weekly /
-- monthly, month-end clamp, backfill, idempotent), reminder pushes, restock links, receipts and
-- finance_report (income from sales_report - expenses = profit, tax set-aside, per month).
begin;
select plan(42);
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
  ('00000000-0000-4000-9027-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@fin-a.test'),
  ('00000000-0000-4000-9027-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@fin-b.test'),
  ('00000000-0000-4000-9027-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stylist@fin-a.test');
select pg_temp.login('00000000-0000-4000-9027-00000000000a');
select public.create_salon('Finance Salon A', 'finance-salon-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-9027-00000000000b');
select public.create_salon('Finance Salon B', 'finance-salon-b', 'America/New_York');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'finance-salon-a') as a,
         (select id from public.salons where slug = 'finance-salon-b') as b,
         '00000000-0000-4000-9027-00000000000a'::uuid as owner,
         '00000000-0000-4000-9027-00000000000b'::uuid as other,
         '00000000-0000-4000-9027-00000000000c'::uuid as stylist;
grant select on ids to authenticated, anon;
insert into public.salon_members (salon_id, user_id, role)
  select a, stylist, 'stylist' from ids;

select has_table('public', 'expenses', 'expenses table exists');
select has_table('public', 'recurring_expenses', 'recurring_expenses table exists');
select has_function('public', 'finance_report', array['uuid', 'date', 'date'], 'finance_report exists');
select col_default_is('public', 'settings', 'tax_set_aside_percent', '25.0',
  'tax set-aside defaults to 25%');

-- Expenses: owner only ---------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-9027-00000000000a');
select lives_ok(
  $$ insert into public.expenses (salon_id, spent_on, category, amount_cents, vendor)
     select a, '2026-10-05', 'products', 3000, 'SalonCentric' from ids $$,
  'owner records an expense');
select lives_ok(
  $$ insert into public.expenses (salon_id, spent_on, category, amount_cents, vendor, note)
     select a, '2026-10-01', 'booth_rent', 8000, 'Studio Nine', 'Booth rent' from ids $$,
  'owner records booth rent');
select throws_ok(
  $$ insert into public.expenses (salon_id, spent_on, category, amount_cents)
     select a, '2026-10-05', 'tools', 0 from ids $$,
  '23514', null, 'amounts must be positive');
select throws_ok(
  $$ insert into public.expenses (salon_id, spent_on, category, amount_cents, receipt_path)
     select a, '2026-10-05', 'tools', 100, b || '/r.jpg' from ids $$,
  '23514', null, 'receipt paths live in the salon''s folder');
select throws_ok(
  $$ update public.expenses set created_by = null $$,
  '42501', null, 'created_by is not editable');
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-9027-00000000000c');
select is((select count(*)::integer from public.expenses), 0, 'stylists cannot see expenses');
select throws_ok(
  $$ insert into public.expenses (salon_id, spent_on, category, amount_cents)
     select a, '2026-10-05', 'tools', 100 from ids $$,
  '42501', null, 'stylists cannot add expenses');
select throws_ok(
  $$ select public.finance_report((select a from ids), '2026-10-01', '2026-10-31') $$,
  '42501', null, 'stylists cannot see the finance report');
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-9027-00000000000b');
select is((select count(*)::integer from public.expenses), 0, 'other salons cannot see expenses');
select pg_temp.logout();

-- Restock links ----------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-9027-00000000000a');
insert into public.products (salon_id, name, unit, cost_cents)
  select a, 'Shades EQ 6N', 'tube', 1150 from ids;
create temp table mv as
  select (public.adjust_stock((select id from public.products where name = 'Shades EQ 6N'),
                              4, 'receive', 'Delivery')).id as received,
         (public.adjust_stock((select id from public.products where name = 'Shades EQ 6N'),
                              -1, 'use')).id as used;
grant select on mv to authenticated;
select is((select estimated_cents from public.restock_purchases where id = (select received from mv)),
  4600::bigint, 'restocks show an estimated cost');
select throws_ok(
  $$ insert into public.expenses (salon_id, spent_on, category, amount_cents, stock_movement_id)
     select a, '2026-10-06', 'products', 4600, (select used from mv) from ids $$,
  '22023', null, 'only received stock can be linked');
select lives_ok(
  $$ insert into public.expenses (salon_id, spent_on, category, amount_cents, stock_movement_id)
     select a, '2026-09-20', 'products', 4600, (select received from mv) from ids $$,
  'a product purchase links to its restock');
select is((select expense_id is not null from public.restock_purchases where id = (select received from mv)),
  true, 'the restock shows which expense paid for it');
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-9027-00000000000b');
select is((select count(*)::integer from public.restock_purchases), 0,
  'other salons cannot see restocks');
select throws_ok(
  $$ insert into public.expenses (salon_id, spent_on, category, amount_cents, stock_movement_id)
     select b, '2026-10-06', 'products', 4600, (select received from mv) from ids $$,
  '22023', null, 'cannot link another salon''s restock');
select pg_temp.logout();

-- Receipts bucket --------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-9027-00000000000a');
select lives_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     select 'receipts', a || '/receipt-1.jpg', auth.uid() from ids $$,
  'owner uploads a receipt photo');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     select 'receipts', b || '/receipt-1.jpg', auth.uid() from ids $$,
  '42501', null, 'cannot upload into another salon''s receipts');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-9027-00000000000c');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     select 'receipts', a || '/receipt-2.jpg', auth.uid() from ids $$,
  '42501', null, 'stylists cannot upload receipts');
select is((select count(*)::integer from storage.objects where bucket_id = 'receipts'), 0,
  'stylists cannot read receipts');
select pg_temp.logout();

-- Due dates --------------------------------------------------------------------------
select is(
  (select array_agg(d) from private.expense_due_dates('monthly', '2031-01-31', '2031-01-01', '2031-05-31') d),
  array['2031-01-31', '2031-02-28', '2031-03-31', '2031-04-30', '2031-05-31']::date[],
  'monthly on the 31st falls on the last day of shorter months');
select is(
  (select array_agg(d) from private.expense_due_dates('monthly', '2031-12-29', '2032-02-01', '2032-03-31') d),
  array['2032-02-29', '2032-03-29']::date[], 'monthly handles leap years');
select is(
  (select array_agg(d) from private.expense_due_dates('weekly', '2031-01-03', '2031-01-05', '2031-01-31') d),
  array['2031-01-10', '2031-01-17', '2031-01-24', '2031-01-31']::date[],
  'weekly continues every 7 days from the start');

-- Recurring booth rent ---------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-9027-00000000000b');
select lives_ok(
  $$ insert into public.recurring_expenses (salon_id, amount_cents, frequency, starts_on, vendor, remind)
     select b, 25000, 'weekly', (now() at time zone 'America/New_York')::date - 14, 'Studio Nine', false
       from ids $$,
  'owner sets up weekly booth rent');
select is(
  (select count(*)::integer from public.expenses e
     join public.recurring_expenses r on r.id = e.recurring_expense_id
    where r.frequency = 'weekly' and e.category = 'booth_rent' and e.amount_cents = 25000),
  3, 'saving it posts the rent already due (backfill)');
select pg_temp.logout();

select is(private.post_recurring_expenses(), 0, 'posting again adds nothing');

select pg_temp.login('00000000-0000-4000-9027-00000000000a');
insert into public.recurring_expenses (salon_id, label, amount_cents, frequency, starts_on, vendor, remind_days_before)
  select a, 'Booth rent', 90000, 'monthly', '2031-01-31', 'Studio Nine', 1 from ids;
select pg_temp.logout();

select is(private.post_recurring_expenses('2031-04-15 17:00Z', (select id from public.recurring_expenses where amount_cents = 90000)), 3,
  'the tick posts each due date up to today');
select is(
  (select array_agg(spent_on order by spent_on) from public.expenses where amount_cents = 90000),
  array['2031-01-31', '2031-02-28', '2031-03-31']::date[], 'posted on the right days');
select is(private.post_recurring_expenses('2031-04-15 20:00Z', (select id from public.recurring_expenses where amount_cents = 90000)), 0,
  'idempotent on the same day');

-- Reminders: the day before at 9am salon time.
select is(private.enqueue_expense_reminders('2031-04-29 13:00Z'), 0, 'no reminder before 9am');
select is(private.enqueue_expense_reminders('2031-04-29 15:00Z'), 1, 'reminder the day before');
select is(private.enqueue_expense_reminders('2031-04-29 18:00Z'), 0, 'reminded once');
select results_eq(
  $$ select user_id, title, body, data ->> 'type', data ->> 'date'
       from public.notifications_outbox
      where kind = 'expense_due' and salon_id = (select a from ids) $$,
  $$ values ('00000000-0000-4000-9027-00000000000a'::uuid, 'Booth rent due tomorrow',
             '$900.00 to Studio Nine. It goes into your expenses on the day.',
             'expense_due', '2031-04-30') $$,
  'the owner gets the reminder');

-- Finance report ---------------------------------------------------------------------
insert into public.checkouts (id, salon_id, status, currency, subtotal_cents, tip_cents,
                              deposit_cents, amount_due_cents, method, paid_at)
select '00000000-0000-4000-9327-000000000001', a, 'paid', 'usd', 12000, 1500, 0, 13500, 'cash',
       '2026-10-10 18:00Z' from ids;
insert into public.checkout_items (salon_id, checkout_id, position, kind, name, quantity, unit_amount_cents)
select a, '00000000-0000-4000-9327-000000000001', v.pos, v.kind::public.checkout_item_kind, v.name, 1, v.amt
  from ids, (values (0, 'service', 'Haircut', 10000), (1, 'retail', 'Shampoo', 2000)) v(pos, kind, name, amt);

select pg_temp.login('00000000-0000-4000-9027-00000000000a');
create temp table fr as
  select public.finance_report((select a from ids), '2026-09-15', '2026-10-31') as j,
         public.sales_report((select a from ids), '2026-10-01', '2026-10-31') as s;
select pg_temp.logout();

select is(((select j from fr) -> 'months' -> 1 -> 'income' ->> 'totalCents')::bigint,
  ((select s from fr) ->> 'salesCents')::bigint + ((select s from fr) ->> 'tipsCents')::bigint,
  'income is the Reports sales plus tips');
select is((select j -> 'months' -> 1 from fr) - 'month' - 'from' - 'to',
  jsonb_build_object(
    'currency', 'usd',
    'income', jsonb_build_object('servicesCents', 10000, 'retailCents', 2000, 'otherSalesCents', 0,
                                 'tipsCents', 1500, 'keptDepositsCents', 0, 'refundedCents', 0,
                                 'totalCents', 13500),
    'expenses', jsonb_build_object('totalCents', 11000, 'count', 2,
      'byCategory', jsonb_build_object('booth_rent', 8000, 'products', 3000, 'tools', 0,
                                       'education', 0, 'other', 0)),
    'profitCents', 2500,
    'taxSetAsideCents', 625),
  'October: profit after booth rent and expenses, with a 25% set-aside');
select is(
  (select array[j -> 'months' -> 0 ->> 'month', j -> 'months' -> 0 ->> 'from',
                j -> 'months' -> 0 ->> 'profitCents', j -> 'months' -> 1 ->> 'month'] from fr),
  array['2026-09', '2026-09-15', '-4600', '2026-10'],
  'months are clipped to the range; a loss sets nothing aside');
select is((select (j ->> 'profitCents')::bigint from fr), -2100::bigint, 'range total');

update public.settings set tax_set_aside_percent = 30 where salon_id = (select a from ids);
select pg_temp.login('00000000-0000-4000-9027-00000000000a');
select is((public.finance_report((select a from ids), '2026-10-01', '2026-10-31') ->> 'taxSetAsideCents')::bigint,
  750::bigint, 'the set-aside follows the owner''s percentage');
select throws_ok(
  $$ select public.finance_report((select a from ids), '2025-01-01', '2026-10-31') $$,
  '22023', null, 'at most a year');
select pg_temp.logout();

select * from finish();
rollback;
