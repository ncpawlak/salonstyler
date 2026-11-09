-- Work hours: template + overrides + booking rules (issue #3).
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
  ('00000000-0000-4000-b000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-a@wh.test'),
  ('00000000-0000-4000-b000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-b@wh.test'),
  ('00000000-0000-4000-b000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stylist-a@wh.test');

select pg_temp.login('00000000-0000-4000-b000-00000000000a');
select public.create_salon('Hours A', 'hours-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-b000-00000000000b');
select public.create_salon('Hours B', 'hours-b', 'America/New_York');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'hours-a') as a,
         (select id from public.salons where slug = 'hours-b') as b;
grant select on ids to authenticated;
insert into public.salon_members (salon_id, user_id, role)
  select a, '00000000-0000-4000-b000-0000000000a2', 'stylist' from ids;

-- Schema ---------------------------------------------------------------------
select has_table('public', 'work_hours_template', 'work_hours_template exists');
select has_table('public', 'work_hours_override', 'work_hours_override exists');
select is(
  (select min_notice_minutes from public.settings, ids where salon_id = ids.a),
  120, 'default min notice is 2h');
select is(
  (select slot_grid_minutes from public.settings, ids where salon_id = ids.a),
  15, 'default slot grid is 15 minutes');
select is(
  (select booking_window_days from public.settings, ids where salon_id = ids.a),
  60, 'default booking window is 60 days');

-- Owner A: acceptance scenario ----------------------------------------------
select pg_temp.login('00000000-0000-4000-b000-00000000000a');

select lives_ok(
  $$ insert into public.work_hours_template (salon_id, weekday, blocks, breaks)
     select ids.a, d,
            '[{"start":"09:00","end":"18:00","type":"open"}]'::jsonb,
            '[{"start":"12:00","end":"13:00"}]'::jsonb
     from ids, generate_series(2, 6) d $$,
  'owner sets Tue–Sat 9–6 with lunch');
select lives_ok(
  $$ insert into public.work_hours_template (salon_id, weekday, blocks)
     select ids.a, 0, '[{"start":"10:00","end":"14:00","type":"tentative"}]'::jsonb from ids $$,
  'owner marks Sunday 10–2 tentative');
select lives_ok(
  $$ insert into public.work_hours_override (salon_id, start_date, end_date, kind, note)
     select ids.a, '2026-12-24', '2026-12-26', 'vacation', 'Christmas' from ids $$,
  'owner takes Dec 24–26 off');
select lives_ok(
  $$ insert into public.work_hours_override (salon_id, start_date, end_date, blocks)
     select ids.a, '2026-12-31', '2026-12-31',
            '[{"start":"08:00","end":"24:00","type":"open"}]'::jsonb from ids $$,
  'owner paints a single custom day (24:00 end allowed)');
select is((select count(*)::int from public.work_hours_template), 6, 'owner sees 6 template rows');
select lives_ok(
  $$ update public.settings set min_notice_minutes = 60, slot_grid_minutes = 30,
            booking_window_days = 120
     from ids where settings.salon_id = ids.a $$,
  'owner updates booking rules');

-- Validation
select throws_ok(
  $$ insert into public.work_hours_template (salon_id, weekday) select ids.a, 7 from ids $$,
  '23514', null, 'weekday must be 0–6');
select throws_ok(
  $$ update public.work_hours_template set blocks = '[{"start":"18:00","end":"09:00","type":"open"}]'
     from ids where salon_id = ids.a and weekday = 2 $$,
  '23514', null, 'inverted block rejected');
select throws_ok(
  $$ update public.work_hours_template set blocks = '[{"start":"9:00","end":"17:00","type":"open"}]'
     from ids where salon_id = ids.a and weekday = 2 $$,
  '23514', null, 'non-HH:MM time rejected');
select throws_ok(
  $$ update public.work_hours_template set blocks = '[{"start":"09:00","end":"17:00","type":"maybe"}]'
     from ids where salon_id = ids.a and weekday = 2 $$,
  '23514', null, 'unknown block type rejected');
select throws_ok(
  $$ update public.work_hours_template set breaks = '[{"start":"12:00","end":"13:00","type":"open"}]'
     from ids where salon_id = ids.a and weekday = 2 $$,
  '23514', null, 'breaks cannot carry a type');
select throws_ok(
  $$ update public.work_hours_template set blocks = '{"start":"09:00"}'
     from ids where salon_id = ids.a and weekday = 2 $$,
  '23514', null, 'blocks must be an array');
select throws_ok(
  $$ insert into public.work_hours_override (salon_id, start_date, end_date)
     select ids.a, '2027-01-05', '2027-01-04' from ids $$,
  '23514', null, 'override range must not be inverted');
select throws_ok(
  $$ insert into public.work_hours_override (salon_id, start_date, end_date, kind, blocks)
     select ids.a, '2027-01-05', '2027-01-05', 'day_off',
            '[{"start":"09:00","end":"10:00","type":"open"}]'::jsonb from ids $$,
  '23514', null, 'day off cannot have blocks');
select throws_ok(
  $$ insert into public.work_hours_override (salon_id, start_date, end_date, kind)
     select ids.a, '2026-12-24', '2026-12-26', 'day_off' from ids $$,
  '23505', null, 'one override per exact range (upsert target)');
select throws_ok(
  $$ update public.settings set slot_grid_minutes = 7 from ids where settings.salon_id = ids.a $$,
  '23514', null, 'slot grid must be a supported step');
select pg_temp.logout();

-- Stylist A: read-only ---------------------------------------------------------
select pg_temp.login('00000000-0000-4000-b000-0000000000a2');
select is((select count(*)::int from public.work_hours_override), 2, 'stylist reads salon overrides');
select throws_ok(
  $$ insert into public.work_hours_override (salon_id, start_date, end_date, kind)
     select ids.a, '2027-02-01', '2027-02-01', 'day_off' from ids $$,
  '42501', null, 'stylist cannot add overrides');
update public.work_hours_template set blocks = '[]' from ids where salon_id = ids.a;
delete from public.work_hours_override using ids where work_hours_override.salon_id = ids.a;
select pg_temp.logout();
select is(
  (select count(*)::int from public.work_hours_template, ids
   where salon_id = ids.a and blocks <> '[]'::jsonb),
  6, 'stylist cannot change the template');
select is(
  (select count(*)::int from public.work_hours_override, ids where salon_id = ids.a),
  2, 'stylist cannot delete overrides');

-- Owner B: isolated ------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-b000-00000000000b');
select is((select count(*)::int from public.work_hours_template), 0, 'B cannot read A template');
select is((select count(*)::int from public.work_hours_override), 0, 'B cannot read A overrides');
select throws_ok(
  $$ insert into public.work_hours_template (salon_id, weekday) select ids.a, 1 from ids $$,
  '42501', null, 'B cannot write A template');
delete from public.work_hours_override using ids where work_hours_override.salon_id = ids.a;
select pg_temp.logout();
select is(
  (select count(*)::int from public.work_hours_override, ids where salon_id = ids.a),
  2, 'A overrides untouched by B');

-- Anonymous ----------------------------------------------------------------------
set local role anon;
select throws_ok('select * from public.work_hours_template', '42501', null, 'anon cannot read hours');
reset role;

select * from finish();
rollback;
