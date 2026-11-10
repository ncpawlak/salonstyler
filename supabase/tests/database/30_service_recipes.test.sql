-- Service recipes (#18): owners set what a service uses; completing an appointment (or paying
-- its checkout) deducts each recipe from stock as `use` movements exactly once, combos expand to
-- their services, and the usual low-stock push fires.
begin;
select plan(41);
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
  ('00000000-0000-4000-e800-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@recipes-a.test'),
  ('00000000-0000-4000-e800-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stylist@recipes-a.test'),
  ('00000000-0000-4000-e800-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@recipes-b.test');
select pg_temp.login('00000000-0000-4000-e800-00000000000a');
select public.create_salon('Recipes Salon A', 'recipes-salon-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-e800-00000000000b');
select public.create_salon('Recipes Salon B', 'recipes-salon-b', 'America/New_York');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'recipes-salon-a') as a,
         (select id from public.salons where slug = 'recipes-salon-b') as b,
         '00000000-0000-4000-e810-000000000001'::uuid as client,
         '00000000-0000-4000-e820-000000000001'::uuid as color,
         '00000000-0000-4000-e820-000000000002'::uuid as cut,
         '00000000-0000-4000-e820-000000000003'::uuid as combo,
         '00000000-0000-4000-e830-000000000001'::uuid as tube,
         '00000000-0000-4000-e830-000000000002'::uuid as dev,
         '00000000-0000-4000-e830-000000000003'::uuid as foil,
         '00000000-0000-4000-e830-0000000000b1'::uuid as other_tube;
grant select on ids to authenticated;
insert into public.salon_members (salon_id, user_id, role)
  select a, '00000000-0000-4000-e800-0000000000a2', 'stylist' from ids;
insert into public.clients (id, salon_id, name) select client, a, 'Dana Rivers' from ids;
insert into public.services (id, salon_id, name, price_cents) select color, a, 'All-over Color', 12000 from ids;
insert into public.services (id, salon_id, name, price_cents) select cut, a, 'Women''s Cut', 6500 from ids;
insert into public.services (id, salon_id, name, price_cents, is_combo)
  select combo, a, 'Color + Cut', 17000, true from ids;
insert into public.service_combo_items (salon_id, combo_id, position, service_id)
  select a, combo, 0, color from ids union all select a, combo, 1, cut from ids;
insert into public.products (id, salon_id, name, brand, unit, reorder_point)
  select tube, a, '6N', 'Redken Shades EQ', 'tube', 2 from ids union all
  select dev, a, 'Processing Solution', 'Redken Shades EQ', 'ml', 100 from ids union all
  select foil, a, 'Foil sheets', null, 'each', 0 from ids union all
  select other_tube, b, '7N', null, 'tube', 0 from ids;
select pg_temp.login('00000000-0000-4000-e800-00000000000a');
select public.adjust_stock((select tube from ids), 5, 'receive');
select public.adjust_stock((select dev from ids), 1000, 'receive');
select public.adjust_stock((select foil from ids), 50, 'receive');
select pg_temp.logout();

select has_table('public', 'service_recipes', 'service_recipes table exists');
select has_column('public', 'stock_movements', 'appointment_id', 'movements link to appointments');

-- Setting recipes -------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-e800-0000000000a2');
select throws_ok(
  $$ select public.set_service_recipe((select color from ids),
       jsonb_build_array(jsonb_build_object('productId', (select tube from ids), 'quantity', 1))) $$,
  '42501', null, 'stylists cannot edit recipes');
select throws_ok(
  $$ insert into public.service_recipes (salon_id, service_id, product_id, quantity)
     select a, color, tube, 1 from ids $$,
  '42501', null, 'recipes cannot be written directly');
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-e800-00000000000b');
select throws_ok(
  $$ select public.set_service_recipe((select color from ids), '[]') $$,
  'P0002', null, 'other salons cannot edit recipes');
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-e800-00000000000a');
select throws_ok(
  $$ select public.set_service_recipe((select combo from ids), '[]') $$,
  '22023', null, 'combos use their services'' recipes');
select throws_ok(
  $$ select public.set_service_recipe((select color from ids),
       jsonb_build_array(jsonb_build_object('productId', (select tube from ids), 'quantity', 0))) $$,
  '22023', null, 'quantities must be above zero');
select throws_ok(
  $$ select public.set_service_recipe((select color from ids),
       jsonb_build_array(jsonb_build_object('productId', (select tube from ids), 'quantity', 1.005))) $$,
  '22023', null, 'quantities have at most 2 decimals');
select throws_ok(
  $$ select public.set_service_recipe((select color from ids), jsonb_build_array(
       jsonb_build_object('productId', (select tube from ids), 'quantity', 1),
       jsonb_build_object('productId', (select tube from ids), 'quantity', 2))) $$,
  '22023', null, 'a product appears once per recipe');
select throws_ok(
  $$ select public.set_service_recipe((select color from ids),
       jsonb_build_array(jsonb_build_object('productId', (select other_tube from ids), 'quantity', 1))) $$,
  'P0002', null, 'recipes only use the salon''s own products');
select throws_ok(
  $$ select public.set_service_recipe((select color from ids), '{}') $$,
  '22023', null, 'lines must be an array');
select is(
  (select count(*)::integer from public.set_service_recipe((select color from ids), jsonb_build_array(
     jsonb_build_object('productId', (select tube from ids), 'quantity', 2),
     jsonb_build_object('productId', (select foil from ids), 'quantity', 10)))),
  2, 'the owner sets a recipe');
select results_eq(
  $$ select product_id, quantity from public.set_service_recipe((select color from ids), jsonb_build_array(
       jsonb_build_object('productId', (select tube from ids), 'quantity', 1),
       jsonb_build_object('productId', (select dev from ids), 'quantity', 60)))
     order by quantity $$,
  $$ values ((select tube from ids), 1.00::numeric), ((select dev from ids), 60.00::numeric) $$,
  'setting a recipe replaces it');
select is(
  (select count(*)::integer from public.set_service_recipe((select cut from ids), jsonb_build_array(
     jsonb_build_object('productId', (select dev from ids), 'quantity', 15.5)))),
  1, 'a second service gets its own recipe');
select is(
  (select count(*)::integer from public.audit_log
    where action = 'service.recipe_set' and salon_id = (select a from ids)),
  3, 'recipe changes are audited');
select pg_temp.logout();

select pg_temp.login('00000000-0000-4000-e800-0000000000a2');
select is((select count(*)::integer from public.service_recipes), 3, 'members read recipes');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-e800-00000000000b');
select is((select count(*)::integer from public.service_recipes), 0, 'other salons see no recipes');
select pg_temp.logout();

-- Completing deducts ------------------------------------------------------------------
create temp table appt as
  select '00000000-0000-4000-e840-000000000001'::uuid as color_visit,
         '00000000-0000-4000-e840-000000000002'::uuid as combo_visit,
         '00000000-0000-4000-e840-000000000003'::uuid as triple_visit,
         '00000000-0000-4000-e840-000000000004'::uuid as cut_visit;
grant select on appt to authenticated;
insert into public.appointments (id, salon_id, client_id, stylist_id, starts_at, ends_at, services, status)
  select color_visit, a, client, '00000000-0000-4000-e800-0000000000a2'::uuid,
         now() - interval '10 hours', now() - interval '9 hours',
         jsonb_build_array(jsonb_build_object('serviceId', color, 'name', 'All-over Color')),
         'confirmed'::public.appointment_status
    from ids, appt
  union all
  select combo_visit, a, client, '00000000-0000-4000-e800-0000000000a2',
         now() - interval '8 hours', now() - interval '7 hours',
         jsonb_build_array(jsonb_build_object('serviceId', combo, 'name', 'Color + Cut')),
         'confirmed'
    from ids, appt
  union all
  select triple_visit, a, client, '00000000-0000-4000-e800-0000000000a2',
         now() - interval '6 hours', now() - interval '5 hours',
         jsonb_build_array(jsonb_build_object('serviceId', color, 'name', 'All-over Color'),
                           jsonb_build_object('serviceId', color, 'name', 'All-over Color'),
                           jsonb_build_object('serviceId', color, 'name', 'All-over Color'),
                           jsonb_build_object('name', 'Free-text service')),
         'confirmed'
    from ids, appt
  union all
  select cut_visit, a, client, '00000000-0000-4000-e800-0000000000a2',
         now() - interval '4 hours', now() - interval '3 hours',
         jsonb_build_array(jsonb_build_object('serviceId', cut, 'name', 'Women''s Cut')),
         'confirmed'
    from ids, appt;

select pg_temp.login('00000000-0000-4000-e800-0000000000a2');
select is((select on_hand from public.products where id = (select tube from ids)), 5.00::numeric,
  'booking does not touch stock');
select lives_ok(
  $$ select public.set_appointment_status((select color_visit from appt), 'completed') $$,
  'a stylist completes a color appointment');
select is((select on_hand from public.products where id = (select tube from ids)), 4.00::numeric,
  'completing deducts the color tube');
select is((select on_hand from public.products where id = (select dev from ids)), 940.00::numeric,
  'and the developer');
select results_eq(
  $$ select reason::text, delta, appointment_id, note from public.stock_movements
      where appointment_id = (select color_visit from appt) order by delta $$,
  $$ values ('use'::text, -60.00::numeric, (select color_visit from appt), 'Used for All-over Color'::text),
            ('use'::text, -1.00::numeric, (select color_visit from appt), 'Used for All-over Color'::text) $$,
  'deductions are use movements linked to the appointment');
select lives_ok(
  $$ select public.set_appointment_status((select color_visit from appt), 'confirmed');
     select public.set_appointment_status((select color_visit from appt), 'completed') $$,
  'undoing and redoing a completion');
select is((select on_hand from public.products where id = (select tube from ids)), 4.00::numeric,
  're-completing does not deduct again');

-- Checkout after completing: still once.
create temp table co as select (public.start_checkout((select color_visit from appt))).id;
select lives_ok($$ select public.pay_checkout_offline((select id from co), 'cash') $$,
  'checking out a completed appointment');
select is((select on_hand from public.products where id = (select tube from ids)), 4.00::numeric,
  'completing and checking out deducts exactly once');

-- Checking out (without completing first) completes and deducts; combos expand.
create temp table co2 as select (public.start_checkout((select combo_visit from appt))).id;
select lives_ok($$ select public.pay_checkout_offline((select id from co2), 'other') $$,
  'checking out a combo appointment');
select is((select status::text from public.appointments where id = (select combo_visit from appt)),
  'completed', 'paying completes the appointment');
select is((select on_hand from public.products where id = (select tube from ids)), 3.00::numeric,
  'the combo deducts its color service');
select is((select on_hand from public.products where id = (select dev from ids)), 864.50::numeric,
  'and sums the developer of both services into one movement');
select is((select count(*)::integer from public.stock_movements
  where appointment_id = (select combo_visit from appt)), 2, 'one movement per product');
select lives_ok($$ select public.pay_checkout_offline((select id from co2), 'other') $$,
  'paying twice');
select is((select on_hand from public.products where id = (select dev from ids)), 864.50::numeric,
  'paying twice deducts once');
select pg_temp.logout();

select is((select count(*)::integer from public.notifications_outbox
  where kind = 'low_stock' and salon_id = (select a from ids)), 0, 'still above the reorder point');

-- Low stock, negative stock, archived products -----------------------------------------
update public.products set active = false where id = (select dev from ids);
select pg_temp.login('00000000-0000-4000-e800-0000000000a2');
select lives_ok(
  $$ select public.set_appointment_status((select triple_visit from appt), 'completed') $$,
  'completing three color services');
select is((select on_hand from public.products where id = (select tube from ids)), 0.00::numeric,
  'repeated services add up');
select is((select on_hand from public.products where id = (select dev from ids)), 864.50::numeric,
  'archived products are not deducted');
select pg_temp.logout();
select results_eq(
  $$ select user_id, data ->> 'productId' from public.notifications_outbox
      where kind = 'low_stock' and salon_id = (select a from ids) $$,
  $$ values ('00000000-0000-4000-e800-00000000000a'::uuid, (select tube from ids)::text) $$,
  'a recipe crossing the reorder point pushes the owner');
select is((select count(*)::integer from public.audit_log
  where action = 'stock.recipe_used' and salon_id = (select a from ids)), 3,
  'deductions are audited per appointment');

select pg_temp.login('00000000-0000-4000-e800-00000000000a');
select is((select count(*)::integer from public.set_service_recipe((select color from ids), '[]')), 0,
  'an empty list clears a recipe');
select pg_temp.logout();
update public.appointments set services = jsonb_build_array(
  jsonb_build_object('serviceId', (select color from ids), 'name', 'All-over Color'))
  where id = (select cut_visit from appt);
select pg_temp.login('00000000-0000-4000-e800-0000000000a2');
select public.set_appointment_status((select cut_visit from appt), 'completed');
select is((select count(*)::integer from public.stock_movements
  where appointment_id = (select cut_visit from appt)), 0, 'a service without a recipe deducts nothing');
select pg_temp.logout();

select * from finish();
rollback;
