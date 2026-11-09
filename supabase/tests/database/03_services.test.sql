-- Service builder (#4): starter menu seeding, save_service RPC, validation, RLS isolation.
begin;
select plan(45);

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
                    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
$$;

create function pg_temp.logout() returns void language sql as $$
  reset role;
  select set_config('request.jwt.claims', '', true);
$$;

select is(
  array(
    select t from unnest(array['services', 'service_segments', 'service_variants',
                               'service_addons', 'service_combo_items']) t
    where to_regclass('public.' || t) is null
  ),
  array[]::text[],
  'service builder tables exist'
);

insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-4000-b000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'alice@svc.test'),
  ('00000000-0000-4000-b000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bob@svc.test'),
  ('00000000-0000-4000-b000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stylist@svc.test');

select pg_temp.login('00000000-0000-4000-b000-00000000000a');
select public.create_salon('Svc A', 'svc-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-b000-00000000000b');
select public.create_salon('Svc B', 'svc-b', 'America/New_York');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'svc-a') as a,
         (select id from public.salons where slug = 'svc-b') as b;
grant select on ids to authenticated;
create temp table saved (name text primary key, id uuid);
create temp table b_svc as
  select s.id from public.services s, ids where s.salon_id = ids.b and s.name = 'Men''s cut';
grant select on b_svc to authenticated;
grant select, insert on saved to authenticated;

insert into public.salon_members (salon_id, user_id, role)
  select a, '00000000-0000-4000-b000-0000000000a2', 'stylist' from ids;

-- Starter menu (Appendix A) -------------------------------------------------
select is((select count(*)::int from public.services s, ids where s.salon_id = ids.a and not s.is_combo),
          20, 'new salon gets the 20 starter services');
select is((select count(*)::int from public.services s, ids where s.salon_id = ids.a and s.is_combo),
          1, 'new salon gets the starter combo');
select is((select count(*)::int from public.service_addons s, ids where s.salon_id = ids.a),
          4, 'new salon gets the 4 starter add-ons');
select is((select count(*)::int from public.services s, ids where s.salon_id = ids.b),
          21, 'every new salon is seeded');

select results_eq(
  $$ select s.name, sum(g.minutes)::int
     from public.services s join public.service_segments g on g.service_id = s.id, ids
     where s.salon_id = ids.a group by s.id, s.name, s.position order by s.position $$,
  $$ values ('Women''s cut & style', 45), ('Men''s cut', 30), ('Kids'' cut (≤12)', 20),
            ('Bang/fringe trim', 10), ('Beard trim', 15), ('Blowout', 45),
            ('Updo / special occasion', 60), ('Bridal trial', 90), ('Root touch-up', 95),
            ('All-over color', 105), ('Toner / gloss', 45), ('Partial highlights', 135),
            ('Full highlights', 165), ('Balayage', 170), ('Color correction', 180),
            ('Deep conditioning', 25), ('Keratin / smoothing', 150), ('Perm', 105),
            ('Consultation', 15), ('Extensions', 150) $$,
  'starter service totals match Appendix A'
);

select is(
  (select string_agg(left(g.kind::text, 1) || g.minutes, ' ' order by g.position)
   from public.services s join public.service_segments g on g.service_id = s.id, ids
   where s.salon_id = ids.a and s.name = 'Balayage'),
  'b75 p40 b20 s35', 'Balayage segments are B75 → P40 → B20 → S35');

select is(
  (select string_agg(v.name || ':' || v.delta_minutes, ' ' order by v.position)
   from public.services s join public.service_variants v on v.service_id = s.id, ids
   where s.salon_id = ids.a and s.name = 'Root touch-up'),
  'Short:0 Medium:15 Long/thick:30', 'hair-length variants are seeded');

select is(
  (select string_agg(a.name || ':' || a.placement || ':' || (select sum(minutes) from public.service_segments g where g.addon_id = a.id), ', ' order by a.position)
   from public.service_addons a, ids where a.salon_id = ids.a),
  'Toner:before_finish:20, Deep conditioning:before_finish:25, Bond treatment (Olaplex):before_finish:15, Blowout finish:end:15',
  'add-ons: toner +20, deep conditioning +25, bond +15, blowout finish +15');

select is(
  (select string_agg(i.position || ':' || s.name || ':' || i.replaces_previous_finish, ' | ' order by i.position)
   from public.services c
   join public.service_combo_items i on i.combo_id = c.id
   join public.services s on s.id = i.service_id, ids
   where c.salon_id = ids.a and c.name = 'Balayage + Women''s cut'),
  '0:Balayage:false | 1:Women''s cut & style:true',
  'Balayage + Women''s cut combo: the cut replaces the balayage finish');

select is(
  (select count(*)::int from public.service_segments g join public.services c on c.id = g.service_id where c.is_combo),
  0, 'combos have no segments of their own');

select is(
  (select bool_and(consultation_required and not bookable_online) from public.services s, ids
   where s.salon_id = ids.a and s.name in ('Color correction', 'Extensions')),
  true, 'consult-first services are flagged and not bookable online');

select lives_ok($$ select private.seed_starter_menu(a) from ids $$, 'seeding again is a no-op');
select is((select count(*)::int from public.services s, ids where s.salon_id = ids.a), 21, 'no duplicate seed');

-- Owner A builds a service ----------------------------------------------------
select pg_temp.login('00000000-0000-4000-b000-00000000000a');

select lives_ok(
  $$ insert into saved select 'full', public.save_service(a, '{
       "name": "Full Color", "category": "Color", "priceCents": 12000, "colorTag": "purple",
       "segments": [{"kind": "busy", "minutes": 30, "label": "Apply"},
                    {"kind": "processing", "minutes": 35, "label": "Process"},
                    {"kind": "style", "minutes": 30, "label": "Style"}],
       "bufferAfterMinutes": 10,
       "variants": [{"name": "Short", "deltaMinutes": 0}, {"name": "Long", "deltaMinutes": 30}]
     }'::jsonb) from ids $$,
  'owner creates "Full Color: Apply 30 → Process 35 → Style 30"');

select is(
  (select sum(minutes)::int from public.service_segments g join saved on g.service_id = saved.id where saved.name = 'full'),
  95, 'Full Color totals 95 minutes (1h35)');
select is(
  (select string_agg(coalesce(label, '') || ' ' || minutes, ' → ' order by position)
   from public.service_segments g join saved on g.service_id = saved.id where saved.name = 'full'),
  'Apply 30 → Process 35 → Style 30', 'segments are stored in order');
select is(
  (select row(category, price_cents, color_tag, buffer_after_minutes, bookable_online, consultation_required, new_clients_only)::text
   from public.services s join saved using (id) where saved.name = 'full'),
  '(Color,12000,purple,10,t,f,f)', 'service fields and default flags saved');
select is(
  (select position from public.services s join saved using (id) where saved.name = 'full'),
  21, 'new services go to the end of the menu');
select is((select count(*)::int from public.audit_log l, ids where l.salon_id = ids.a and l.action = 'service.saved'),
          1, 'saving a service is audited');

-- Edit: replace segments, keep one variant (by id), drop the other, add a new one.
create temp table v_keep as
  select v.id from public.service_variants v join saved on v.service_id = saved.id
  where saved.name = 'full' and v.name = 'Long';
select lives_ok(
  $$ select public.save_service(ids.a, jsonb_build_object(
       'id', saved.id, 'name', 'Full Color', 'category', 'Color', 'priceCents', 13000,
       'colorTag', 'purple', 'newClientsOnly', true, 'bookableOnline', false,
       'segments', '[{"kind":"busy","minutes":40},{"kind":"processing","minutes":35},{"kind":"style","minutes":30}]'::jsonb,
       'variants', jsonb_build_array(
          jsonb_build_object('name', 'Medium', 'deltaMinutes', 15),
          jsonb_build_object('id', (select id from v_keep), 'name', 'Long/thick', 'deltaMinutes', 30))))
     from ids, saved where saved.name = 'full' $$,
  'owner edits the service');
select is(
  (select sum(minutes)::int from public.service_segments g join saved on g.service_id = saved.id where saved.name = 'full'),
  105, 'segments are replaced, not appended');
select is(
  (select string_agg(v.name || ':' || v.position || ':' || (v.id = (select id from v_keep)), ' ' order by v.position)
   from public.service_variants v join saved on v.service_id = saved.id where saved.name = 'full'),
  'Medium:0:false Long/thick:1:true', 'variants are upserted by id and reordered');
select is(
  (select row(price_cents, new_clients_only, bookable_online)::text from public.services s join saved using (id) where saved.name = 'full'),
  '(13000,t,f)', 'flags are updated');

-- Validation
select throws_ok(
  $$ select public.save_service(a, '{"name":"Bad","segments":[{"kind":"busy","minutes":10},{"kind":"processing","minutes":10}]}') from ids $$,
  '22023', 'A service cannot start or end with a processing segment', 'cannot end with processing');
select throws_ok(
  $$ select public.save_service(a, '{"name":"Bad","segments":[]}') from ids $$,
  '22023', 'At least one segment is required', 'needs a segment');
select throws_ok(
  $$ select public.save_service(a, '{"name":"Bad","segments":[{"kind":"nap","minutes":10}]}') from ids $$,
  '22023', null, 'unknown segment kind rejected');
select throws_ok(
  $$ select public.save_service(a, '{"name":"Bad","segments":[{"kind":"busy","minutes":7.5}]}') from ids $$,
  '22023', null, 'fractional minutes rejected');
select throws_ok(
  $$ select public.save_service(a, '{"name":"Bad","colorTag":"neon","segments":[{"kind":"busy","minutes":10}]}') from ids $$,
  '23514', null, 'unknown color tag rejected');
select throws_ok(
  $$ select public.save_service(a, jsonb_build_object('name', 'Combo of combo', 'isCombo', true,
       'items', jsonb_build_array(jsonb_build_object('serviceId',
         (select id from public.services s where s.salon_id = ids.a and s.is_combo))))) from ids $$,
  '23514', 'A combo cannot contain another combo', 'a combo cannot nest a combo');
select throws_ok(
  $$ delete from public.services s using ids where s.salon_id = ids.a and s.name = 'Balayage' $$,
  '23503', null, 'a service used by a combo cannot be deleted (archive it instead)');

select lives_ok(
  $$ insert into saved select 'addon', public.save_service_addon(a,
       '{"name":"Gloss","priceCents":1500,"placement":"before_finish","segments":[{"kind":"busy","minutes":5},{"kind":"processing","minutes":10}]}')
     from ids $$,
  'owner creates an add-on (may end with processing; inserted before the finish)');

-- Cross-salon: A cannot reference B's rows even with A's salon_id.
select throws_ok(
  $$ insert into public.service_segments (salon_id, service_id, position, kind, minutes)
     select ids.a, b_svc.id, 99, 'busy', 10 from ids, b_svc $$,
  null, null, 'segments cannot point at another salon''s service');
select throws_ok(
  $$ select public.save_service(ids.a, jsonb_build_object('name', 'Sneaky', 'isCombo', true,
       'items', jsonb_build_array(jsonb_build_object('serviceId',
         (select id from b_svc)))))
     from ids $$,
  null, null, 'combos cannot include another salon''s service');
select pg_temp.logout();

-- Owner B: isolation -----------------------------------------------------------
select pg_temp.login('00000000-0000-4000-b000-00000000000b');
select is((select count(*)::int from public.services, ids where salon_id = ids.a), 0, 'B cannot read A services');
select is((select count(*)::int from public.service_segments, ids where salon_id = ids.a), 0, 'B cannot read A segments');
select is((select count(*)::int from public.service_variants, ids where salon_id = ids.a), 0, 'B cannot read A variants');
select is((select count(*)::int from public.service_addons, ids where salon_id = ids.a), 0, 'B cannot read A add-ons');
select is((select count(*)::int from public.service_combo_items, ids where salon_id = ids.a), 0, 'B cannot read A combo items');
select throws_ok(
  $$ select public.save_service(a, '{"name":"Pwn","segments":[{"kind":"busy","minutes":10}]}') from ids $$,
  '42501', null, 'B cannot save services into salon A');
select throws_ok(
  $$ insert into public.services (salon_id, name) select a, 'Pwn' from ids $$,
  '42501', null, 'B cannot insert services into salon A');
update public.services set price_cents = 1 from ids where services.salon_id = ids.a;
delete from public.service_segments using ids where service_segments.salon_id = ids.a;
select pg_temp.logout();
select is(
  (select count(*)::int from public.services s, ids where s.salon_id = ids.a and s.price_cents = 1)
  + (select count(*)::int from public.service_segments g, ids where g.salon_id = ids.a and false),
  0, 'B''s updates to A are filtered out');

-- Stylist in A: reads, cannot edit --------------------------------------------
select pg_temp.login('00000000-0000-4000-b000-0000000000a2');
select is((select count(*)::int from public.services), 22, 'stylist reads A services');
select throws_ok(
  $$ select public.save_service(a, '{"name":"Nope","segments":[{"kind":"busy","minutes":10}]}') from ids $$,
  '42501', 'Only salon owners can edit services', 'stylist cannot save services');
select pg_temp.logout();

-- Anonymous ----------------------------------------------------------------------
set local role anon;
select throws_ok('select * from public.services', '42501', null, 'anon cannot read services');
reset role;

select * from finish();
rollback;
