-- Inventory (#17): products and the stock ledger are salon-scoped; on_hand only changes through
-- adjust_stock / count_stock / paid checkouts; scanning (adjust_stock by barcode lookup) moves
-- stock; dropping to the reorder point pushes owners once; paid retail lines decrement stock.
begin;
select plan(32);
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
  ('00000000-0000-4000-e700-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@inv-a.test'),
  ('00000000-0000-4000-e700-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stylist@inv-a.test'),
  ('00000000-0000-4000-e700-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@inv-b.test');
select pg_temp.login('00000000-0000-4000-e700-00000000000a');
select public.create_salon('Inventory Salon A', 'inventory-salon-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-e700-00000000000b');
select public.create_salon('Inventory Salon B', 'inventory-salon-b', 'America/New_York');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'inventory-salon-a') as a,
         (select id from public.salons where slug = 'inventory-salon-b') as b,
         '00000000-0000-4000-e710-000000000001'::uuid as client;
grant select on ids to authenticated;
insert into public.salon_members (salon_id, user_id, role)
  select a, '00000000-0000-4000-e700-0000000000a2', 'stylist' from ids;
insert into public.clients (id, salon_id, name) select client, a, 'Dana Rivers' from ids;

select has_table('public', 'products', 'products table exists');
select has_table('public', 'stock_movements', 'stock_movements table exists');

-- Products ------------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-e700-0000000000a2');
select lives_ok(
  $$ insert into public.products (salon_id, name, brand, category, sku, barcode, unit,
                                  reorder_point, cost_cents, retail_price_cents, supplier)
     select a, 'Color Extend Shampoo', 'Redken', 'Retail', 'RK-CES-300', '0884486456182',
            'each', 3, 1100, 2400, 'SalonCentric' from ids $$,
  'a stylist can add a product');
select lives_ok(
  $$ insert into public.products (salon_id, name, brand, unit, reorder_point)
     select a, '6N', 'Redken Shades EQ', 'tube', 2 from ids $$,
  'back-bar products need no price');
create temp table p as
  select (select id from public.products where barcode = '0884486456182') as shampoo,
         (select id from public.products where name = '6N') as tube;
grant select on p to authenticated;
select throws_ok(
  $$ insert into public.products (salon_id, name, barcode) select a, 'Dupe', '0884486456182' from ids $$,
  '23505', null, 'barcodes are unique per salon');
select throws_ok(
  $$ update public.products set on_hand = 99 where id = (select shampoo from p) $$,
  '42501', null, 'on_hand cannot be written directly');
select lives_ok(
  $$ update public.products set retail_price_cents = 2600 where id = (select shampoo from p) $$,
  'members edit product details');
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-e700-00000000000b');
select is((select count(*)::integer from public.products), 0, 'other salons see no products');
select throws_ok(
  $$ select public.adjust_stock((select shampoo from p), 5, 'receive') $$,
  'P0002', null, 'other salons cannot move stock');
select throws_ok(
  $$ insert into public.products (salon_id, name) select a, 'Sneaky' from ids $$,
  '42501', null, 'other salons cannot add products');
select pg_temp.logout();

-- Scanning moves stock --------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-e700-0000000000a2');
-- What the scanner does: look the barcode up, then adjust.
select is(
  (select (public.adjust_stock(id, 6, 'receive', 'Delivery')).on_hand_after
     from public.products where barcode = '0884486456182'),
  6.00::numeric, 'scanning a delivery adds stock');
select is((select on_hand from public.products where id = (select shampoo from p)), 6.00::numeric,
  'on_hand follows the ledger');
select is((select count(*)::integer from public.notifications_outbox
  where kind = 'low_stock' and salon_id in (select a from ids union select b from ids)), 0,
  'restocking sends no push');
select throws_ok(
  $$ select public.adjust_stock((select shampoo from p), -10) $$,
  '22023', 'Only 6 on hand', 'manual removals cannot go below zero');
select throws_ok(
  $$ select public.adjust_stock((select shampoo from p), 1, 'sale') $$,
  '22023', null, 'sales only come from checkout');
select throws_ok(
  $$ select public.adjust_stock((select shampoo from p), -1, 'receive') $$,
  '22023', null, 'received stock must be positive');
select lives_ok($$ select public.adjust_stock((select shampoo from p), -2) $$,
  'a scan can remove stock');
select pg_temp.logout();
select is((select count(*)::integer from public.notifications_outbox
  where kind = 'low_stock' and salon_id in (select a from ids union select b from ids)), 0,
  'still above the reorder point: no push');

-- Low stock -----------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-e700-0000000000a2');
select lives_ok($$ select public.adjust_stock((select shampoo from p), -2, 'use') $$,
  'dropping to the reorder point');
select pg_temp.logout();
select results_eq(
  $$ select user_id, title, body, data ->> 'productId'
       from public.notifications_outbox
  where kind = 'low_stock' and salon_id in (select a from ids union select b from ids) $$,
  $$ values ('00000000-0000-4000-e700-00000000000a'::uuid,
             'Low stock · Redken Color Extend Shampoo',
             '2 left (reorder at 3). Tap for your reorder list.',
             (select shampoo from p)::text) $$,
  'going below the reorder point pushes the owner (not the stylist)');
select pg_temp.login('00000000-0000-4000-e700-0000000000a2');
select lives_ok($$ select public.adjust_stock((select shampoo from p), -1) $$, 'still low');
select pg_temp.logout();
select is((select count(*)::integer from public.notifications_outbox
  where kind = 'low_stock' and salon_id in (select a from ids union select b from ids)), 1,
  'one push per drop, not per movement');

select pg_temp.login('00000000-0000-4000-e700-0000000000a2');
select results_eq(
  $$ select name, on_hand, reorder_point, suggested_quantity from public.reorder_list
      order by on_hand desc $$,
  $$ values ('Color Extend Shampoo'::text, 1.00::numeric, 3.00::numeric, 5.00::numeric),
            ('6N'::text, 0.00::numeric, 2.00::numeric, 4.00::numeric) $$,
  'the reorder list has everything at or below its point');
select is((public.count_stock((select tube from p), 1.5)).delta, 1.50::numeric,
  'a count records the difference (partial tubes allowed)');
select pg_temp.logout();

-- Retail sales at checkout ------------------------------------------------------------
-- Restock above the point, then sell 3 at checkout.
create temp table appt as
  with ins as (
    insert into public.appointments (salon_id, client_id, stylist_id, starts_at, ends_at, services, price_cents)
    select a, client, '00000000-0000-4000-e700-0000000000a2', now() - interval '1 hour', now(),
           '[{"name":"Trim"}]'::jsonb, 4000 from ids
    returning id)
  select id from ins;
grant select on appt to authenticated;
select pg_temp.login('00000000-0000-4000-e700-00000000000a');
select public.adjust_stock((select shampoo from p), 9, 'receive');
create temp table co as select (public.start_checkout((select id from appt))).id;
grant select on co to authenticated;
select lives_ok(
  $$ select public.update_checkout((select id from co),
       jsonb_build_array(
         jsonb_build_object('kind', 'service', 'name', 'Trim', 'unitAmountCents', 4000),
         jsonb_build_object('kind', 'retail', 'name', 'Color Extend Shampoo', 'quantity', 3,
                            'unitAmountCents', 2600, 'sourceId', (select shampoo from p)),
         jsonb_build_object('kind', 'retail', 'name', 'Free-form comb', 'unitAmountCents', 500)),
       0) $$,
  'a product is added at checkout');
select is((select on_hand from public.products where id = (select shampoo from p)), 10.00::numeric,
  'an open checkout does not touch stock');
select lives_ok($$ select public.pay_checkout_offline((select id from co), 'cash') $$, 'paid in cash');
select is((select on_hand from public.products where id = (select shampoo from p)), 7.00::numeric,
  'paying decrements stock for product lines');
select results_eq(
  $$ select reason::text, delta, checkout_id from public.stock_movements
      where product_id = (select shampoo from p) and reason = 'sale' $$,
  $$ select 'sale'::text, -3.00::numeric, (select id from co) $$,
  'the sale is in the ledger, linked to the checkout');
select lives_ok($$ select public.pay_checkout_offline((select id from co), 'cash') $$,
  'paying twice is a no-op');
select pg_temp.logout();
select is((select on_hand from public.products where id = (select shampoo from p)), 7.00::numeric,
  'stock is only decremented once');

-- Turning alerts off
update public.settings set low_stock_alerts_enabled = false where salon_id = (select a from ids);
select pg_temp.login('00000000-0000-4000-e700-00000000000a');
select public.adjust_stock((select shampoo from p), -6);
select pg_temp.logout();
select is((select count(*)::integer from public.notifications_outbox
  where kind = 'low_stock' and salon_id in (select a from ids union select b from ids)), 1,
  'no push when low-stock alerts are off');

select * from finish();
rollback;
