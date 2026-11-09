-- Appointments, segments, holds and clients (issue #30).
begin;
select plan(39);

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
                    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
$$;

create function pg_temp.logout() returns void language sql as $$
  reset role;
  select set_config('request.jwt.claims', '', true);
$$;

-- `[{kind, start, end}]` from (kind, start, minutes) triples laid end to end.
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
grant execute on function pg_temp.segs(timestamptz, text[]) to authenticated;

insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-4000-d000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-a@appt.test'),
  ('00000000-0000-4000-d000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-b@appt.test');

select pg_temp.login('00000000-0000-4000-d000-00000000000a');
select public.create_salon('Appt A', 'appt-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-d000-00000000000b');
select public.create_salon('Appt B', 'appt-b', 'America/Chicago');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'appt-a') as a,
         (select id from public.salons where slug = 'appt-b') as b;
grant select on ids to authenticated;
create temp table t (name text primary key, id uuid);
grant select, insert on t to authenticated;

-- Schema ---------------------------------------------------------------------
select has_table('public', 'clients', 'clients exists');
select has_table('public', 'appointments', 'appointments exists');
select has_table('public', 'appointment_segments', 'appointment_segments exists');
select isnt_empty(
  $$ select 1 from pg_extension where extname = 'btree_gist' $$, 'btree_gist is installed');
select is(
  (select contype::text from pg_constraint where conname = 'no_double_booked_busy'),
  'x', 'appointment_segments has the no_double_booked_busy exclusion constraint');
select is(
  (select count(*)::integer from cron.job
    where jobname = 'release-expired-holds' and command like '%release_expired_holds%'),
  1, 'pg_cron job releases expired holds');

-- Clients ---------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-d000-00000000000a');

select lives_ok(
  $$ with x as (
       insert into public.clients (salon_id, name, phone, email, notes)
       select a, 'Karina', '555-0100', 'karina@example.com', 'Likes it warm' from ids
       returning id)
     insert into t select 'karina', id from x $$,
  'member adds a client');
select lives_ok(
  $$ with x as (insert into public.clients (salon_id, name) select a, 'Maya' from ids returning id)
     insert into t select 'maya', id from x $$,
  'member adds a client with just a name');
select throws_ok(
  $$ insert into public.clients (salon_id, name, email) select a, 'Bad', 'not-an-email' from ids $$,
  '23514', null, 'client email is validated');

-- Overlap guard ---------------------------------------------------------------
-- Karina: color 10:00 apply 30 → process 45 → style 30 (busy 10:00–10:30, 11:15–11:45).
select lives_ok(
  $$ insert into t select 'color', (public.book_appointment(
       (select a from ids), (select id from t where name = 'karina'),
       pg_temp.segs('2030-03-05 16:00+00', 'busy', '30', 'processing', '45', 'style', '30'),
       '[{"name":"Root touch-up"}]'::jsonb)).id $$,
  'owner books a color');
select is(
  (select (starts_at, ends_at)::text from public.appointments where id = (select id from t where name = 'color')),
  ('2030-03-05 16:00+00'::timestamptz, '2030-03-05 17:45+00'::timestamptz)::text,
  'starts_at/ends_at span the client segments');
select is(
  (select count(*)::integer from public.appointment_segments where appointment_id = (select id from t where name = 'color')),
  3, 'segments are stored per kind');

select throws_ok(
  $$ select public.book_appointment((select a from ids), (select id from t where name = 'maya'),
       pg_temp.segs('2030-03-05 16:15+00', 'busy', '30')) $$,
  '23P01', 'That time overlaps another appointment', 'busy vs busy is rejected with a clear message');
select lives_ok(
  $$ insert into t select 'cut', (public.book_appointment((select a from ids), (select id from t where name = 'maya'),
       pg_temp.segs('2030-03-05 16:30+00', 'busy', '45'))).id $$,
  'busy inside another client''s processing is allowed (back-to-back too)');
select throws_ok(
  $$ select public.book_appointment((select a from ids), null,
       pg_temp.segs('2030-03-05 17:40+00', 'buffer', '10', 'busy', '15')) $$,
  '23P01', null, 'buffer time blocks a busy segment');
select lives_ok(
  $$ select public.book_appointment((select a from ids), null,
       pg_temp.segs('2030-03-05 17:45+00', 'busy', '15')) $$,
  'back-to-back after the finish is allowed');
select throws_ok(
  $$ select public.book_appointment((select a from ids), null,
       '[{"kind":"busy","start":"2030-03-05T20:00Z","end":"2030-03-05T19:00Z"}]'::jsonb) $$,
  '22023', null, 'segments must be well-formed');
select throws_ok(
  $$ insert into public.appointment_segments (salon_id, appointment_id, stylist_id, position, kind, range)
     select a, (select id from t where name = 'color'), '00000000-0000-4000-d000-00000000000a', 9, 'busy',
            tstzrange('2030-03-06 10:00+00', '2030-03-06 11:00+00') from ids $$,
  '42501', null, 'segments cannot be written directly');

-- Move / edit / lifecycle ------------------------------------------------------
select throws_ok(
  $$ select public.reschedule_appointment((select id from t where name = 'cut'),
       pg_temp.segs('2030-03-05 15:45+00', 'busy', '45')) $$,
  '23P01', null, 'moving onto busy time is blocked');
select is(
  (select starts_at from public.appointments where id = (select id from t where name = 'cut')),
  '2030-03-05 16:30+00'::timestamptz, 'a blocked move leaves the appointment in place');
select lives_ok(
  $$ select public.reschedule_appointment((select id from t where name = 'cut'),
       pg_temp.segs('2030-03-05 19:00+00', 'busy', '60'), '[{"name":"Long cut"}]'::jsonb, 9000) $$,
  'moving to a free time (and editing services/duration) works');
select is(
  (select (starts_at, ends_at, price_cents)::text from public.appointments where id = (select id from t where name = 'cut')),
  ('2030-03-05 19:00+00'::timestamptz, '2030-03-05 20:00+00'::timestamptz, 9000)::text,
  'the move and edit are saved');
select throws_ok(
  $$ select public.set_appointment_status((select id from t where name = 'cut'), 'held') $$,
  '22023', null, 'invalid status transitions are rejected');
select lives_ok(
  $$ select public.set_appointment_status((select id from t where name = 'color'), 'cancelled', 'Client sick') $$,
  'owner cancels');
select is(
  (select bool_or(active) from public.appointment_segments where appointment_id = (select id from t where name = 'color')),
  false, 'cancelling frees the segments');
select lives_ok(
  $$ insert into t select 'rebook', (public.book_appointment((select a from ids), null,
       pg_temp.segs('2030-03-05 16:00+00', 'busy', '30'))).id $$,
  'the cancelled slot can be rebooked');
select lives_ok(
  $$ select public.set_appointment_status((select id from t where name = 'rebook'), 'no_show') $$,
  'owner marks a no-show');
select lives_ok(
  $$ select public.book_appointment((select a from ids), null, pg_temp.segs('2030-03-05 16:00+00', 'busy', '15')) $$,
  'a no-show frees the slot');
select throws_ok(
  $$ select public.set_appointment_status((select id from t where name = 'rebook'), 'confirmed') $$,
  '23P01', null, 'undoing a no-show onto a re-booked slot is blocked');
select is(
  (public.set_appointment_status((select id from t where name = 'cut'), 'completed')).status,
  'completed'::public.appointment_status, 'owner marks completed');

-- Tenant isolation -----------------------------------------------------------
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-d000-00000000000b');
select is_empty($$ select 1 from public.appointments a, ids where a.salon_id = ids.a $$,
  'another salon cannot see appointments');
select is_empty($$ select 1 from public.clients c, ids where c.salon_id = ids.a $$,
  'another salon cannot see clients');
select throws_ok(
  $$ select public.set_appointment_status((select id from t where name = 'cut'), 'confirmed') $$,
  'P0002', null, 'another salon cannot change appointments');
select throws_ok(
  $$ select public.book_appointment((select a from ids), null, pg_temp.segs('2030-03-07 16:00+00', 'busy', '30')) $$,
  '42501', null, 'another salon cannot book');

-- Holds ----------------------------------------------------------------------
select pg_temp.logout();
update public.settings set hold_expiry_hours = 2 from ids where salon_id = ids.a;
select pg_temp.login('00000000-0000-4000-d000-00000000000a');
insert into t select 'hold', (public.book_appointment((select a from ids), null,
  pg_temp.segs('2030-03-06 16:00+00', 'busy', '60'), p_status => 'held')).id;
select is(
  (select hold_expires_at from public.appointments where id = (select id from t where name = 'hold')),
  now() + interval '2 hours', 'hold expiry comes from settings.hold_expiry_hours');
select throws_ok(
  $$ select public.book_appointment((select a from ids), null, pg_temp.segs('2030-03-06 16:30+00', 'busy', '30')) $$,
  '23P01', null, 'a hold blocks its slot');

select pg_temp.logout();
update public.appointments set hold_expires_at = now() - interval '1 minute'
  where id = (select id from t where name = 'hold');
select is(private.release_expired_holds(), 1, 'the cron job function releases the expired hold');
select is(
  (select (status, cancel_reason)::text from public.appointments where id = (select id from t where name = 'hold')),
  ('cancelled'::public.appointment_status, 'hold_expired')::text, 'expired hold is cancelled');
select pg_temp.login('00000000-0000-4000-d000-00000000000a');
select lives_ok(
  $$ select public.book_appointment((select a from ids), null, pg_temp.segs('2030-03-06 16:30+00', 'busy', '30')) $$,
  'an expired hold frees its slot');

select * from finish();
rollback;
