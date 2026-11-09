-- Rebook at checkout (#42): per-service rebook intervals, booking the next visit from a paid
-- checkout in one call (same stylist, engine segments, overlap-checked), skipping, and the
-- rebook rate for reports.
begin;
select plan(26);
create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
                    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
$$;
create function pg_temp.as_anon() returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
$$;
create function pg_temp.logout() returns void language sql as $$
  reset role;
  select set_config('request.jwt.claims', '', true);
$$;
create function pg_temp.segs(p_start timestamptz, variadic p_parts text[]) returns jsonb
language plpgsql as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_t   timestamptz := p_start;
  i     integer := 1;
begin
  while i < array_length(p_parts, 1) loop
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'kind', p_parts[i], 'start', v_t,
      'end', v_t + make_interval(mins => p_parts[i + 1]::integer)));
    v_t := v_t + make_interval(mins => p_parts[i + 1]::integer);
    i := i + 2;
  end loop;
  return v_out;
end;
$$;
grant execute on function pg_temp.segs(timestamptz, text[]) to authenticated, anon;

insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-4000-9019-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@rebook-a.test'),
  ('00000000-0000-4000-9019-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stylist@rebook-a.test'),
  ('00000000-0000-4000-9019-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@rebook-b.test');
select pg_temp.login('00000000-0000-4000-9019-00000000000a');
select public.create_salon('Rebook Salon A', 'rebook-salon-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-9019-00000000000b');
select public.create_salon('Rebook Salon B', 'rebook-salon-b', 'America/New_York');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'rebook-salon-a') as a,
         '00000000-0000-4000-9119-000000000001'::uuid as svc,
         '00000000-0000-4000-9119-000000000003'::uuid as client;
grant select on ids to authenticated, anon;
insert into public.salon_members (salon_id, user_id, role)
  select a, '00000000-0000-4000-9019-0000000000a2', 'stylist' from ids;
insert into public.services (id, salon_id, name, price_cents) select svc, a, 'All-over color', 9000 from ids;
insert into public.clients (id, salon_id, name) select client, a, 'Karina Lopez' from ids;

-- Three visits today with the stylist, each checked out below.
create temp table appts as
  with ins as (
    insert into public.appointments (salon_id, client_id, stylist_id, starts_at, ends_at, services, price_cents)
    select a, client, '00000000-0000-4000-9019-0000000000a2',
           now() - interval '6 hours' + make_interval(hours => 2 * g),
           now() - interval '5 hours' + make_interval(hours => 2 * g),
           jsonb_build_array(jsonb_build_object('serviceId', svc, 'name', 'All-over color')),
           9000
      from ids, generate_series(0, 2) g
    returning id, starts_at)
  select (array_agg(id order by starts_at))[1] as a1,
         (array_agg(id order by starts_at))[2] as a2,
         (array_agg(id order by starts_at))[3] as a3
    from ins;
grant select on appts to authenticated, anon;

select has_column('public', 'services', 'rebook_interval_days', 'services have a rebook interval');
select has_column('public', 'checkouts', 'rebook_appointment_id', 'checkouts link their rebook');

-- Service interval -----------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-9019-00000000000a');
select lives_ok($$ update public.services set rebook_interval_days = 42 where id = (select svc from ids) $$,
  'the owner sets a service''s rebook interval');
select is((select rebook_interval_days from public.services where id = (select svc from ids)), 42,
  'the interval is saved');
select throws_ok($$ update public.services set rebook_interval_days = 400 where id = (select svc from ids) $$,
  '23514', null, 'intervals over a year are rejected');

-- Rebooking ------------------------------------------------------------------------
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-9019-0000000000a2');
create temp table co as
  select (public.start_checkout(a1)).id as c1, (public.start_checkout(a2)).id as c2,
         (public.start_checkout(a3)).id as c3
    from appts;
grant select on co to authenticated, anon;

select throws_ok(
  $$ select public.rebook_from_checkout((select c1 from co), pg_temp.segs('2030-04-12 15:00+00', 'busy', '60')) $$,
  '22023', 'Only paid checkouts can be rebooked', 'an open checkout cannot be rebooked');
select lives_ok($$ select public.pay_checkout_offline(c, 'cash') from co, unnest(array[c1, c2, c3]) c $$,
  'the visits are paid');

create temp table rb (id uuid);
grant select, insert on rb to authenticated;
select lives_ok(
  $$ insert into rb select (public.rebook_from_checkout((select c1 from co),
       pg_temp.segs('2030-04-12 15:00+00', 'busy', '30', 'processing', '30'),
       '[{"serviceId":"00000000-0000-4000-9119-000000000001","name":"All-over color"}]'::jsonb,
       'confirmed', 9000)).id $$,
  'one call books the next visit from a paid checkout');
select results_eq(
  $$ select client_id, stylist_id, status::text, source::text, starts_at, ends_at, price_cents
       from public.appointments where id = (select id from rb) $$,
  $$ select (select client from ids), '00000000-0000-4000-9019-0000000000a2'::uuid, 'confirmed',
            'owner', '2030-04-12 15:00+00'::timestamptz, '2030-04-12 16:00+00'::timestamptz, 9000 $$,
  'the rebook is for the same client and stylist at the suggested time');
select is((select rebook_appointment_id from public.checkouts where id = (select c1 from co)),
  (select id from rb), 'the checkout links its rebook');
select is(
  (select count(*)::integer from public.audit_log
    where action = 'checkout.rebooked' and entity_id = (select c1 from co)::text), 1,
  'the rebook is audited');
select throws_ok(
  $$ select public.rebook_from_checkout((select c1 from co), pg_temp.segs('2030-04-19 15:00+00', 'busy', '60')) $$,
  '22023', 'The next visit is already booked', 'a checkout is rebooked once');
select throws_ok(
  $$ select public.rebook_from_checkout((select c2 from co), pg_temp.segs('2030-04-12 15:00+00', 'busy', '30')) $$,
  '23P01', null, 'rebooks are overlap-checked like any booking');
select throws_ok(
  $$ select public.rebook_from_checkout((select c2 from co), pg_temp.segs('2030-04-13 15:00+00', 'busy', '30'),
       '[]', 'requested') $$,
  '22023', 'A rebook is held or confirmed', 'a rebook is held or confirmed');
select lives_ok(
  $$ insert into rb select (public.rebook_from_checkout((select c2 from co),
       pg_temp.segs('2030-04-13 15:00+00', 'busy', '30'), '[]', 'held')).id $$,
  'a rebook can be held for the client to confirm');
select ok((select hold_expires_at is not null from public.appointments a
            join public.checkouts c on c.rebook_appointment_id = a.id
           where c.id = (select c2 from co) and a.status = 'held'),
  'a held rebook expires like any hold');
select ok((select (public.skip_rebook(c3)).rebook_declined_at is not null from co),
  'skipping records the decline');

-- Rebook rate ----------------------------------------------------------------------
select is(public.rebook_stats((select a from ids)) - 'from' - 'to',
  '{"checkouts": 3, "rebooked": 2, "declined": 1, "rate": 0.6667}'::jsonb,
  'the rebook rate counts paid checkouts, rebooks and skips');
select is(public.rebook_stats((select a from ids), current_date - 60, current_date - 31) ->> 'checkouts', '0',
  'the rate is for the given date range');
select throws_ok($$ select public.rebook_stats((select a from ids), current_date, current_date - 1) $$,
  '22023', null, 'an inverted range is rejected');

-- A cancelled rebook stops counting and can be booked again.
select pg_temp.logout();
update public.appointments set status = 'cancelled'
 where id = (select rebook_appointment_id from public.checkouts where id = (select c2 from co));
select pg_temp.login('00000000-0000-4000-9019-0000000000a2');
select is((public.rebook_stats((select a from ids)) ->> 'rebooked')::integer, 1,
  'cancelled rebooks don''t count');
select lives_ok(
  $$ select public.rebook_from_checkout((select c2 from co), pg_temp.segs('2030-04-20 15:00+00', 'busy', '30')) $$,
  'a cancelled rebook can be booked again');

-- Isolation ------------------------------------------------------------------------
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-9019-00000000000b');
select throws_ok(
  $$ select public.rebook_from_checkout((select c3 from co), pg_temp.segs('2030-05-01 15:00+00', 'busy', '30')) $$,
  'P0002', null, 'other salons cannot rebook');
select throws_ok($$ select public.skip_rebook((select c3 from co)) $$,
  'P0002', null, 'other salons cannot skip');
select throws_ok($$ select public.rebook_stats((select a from ids)) $$,
  '42501', null, 'other salons cannot read the rebook rate');
select pg_temp.logout();
select pg_temp.as_anon();
select throws_ok($$ select public.rebook_stats((select a from ids)) $$,
  '42501', null, 'anon cannot read the rebook rate');
select pg_temp.logout();

select * from finish();
rollback;
