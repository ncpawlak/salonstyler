-- "Running late" cascade: apply_running_late moves several appointments atomically (issue #37).
begin;
select plan(15);

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
  ('00000000-0000-4000-e000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-a@late.test'),
  ('00000000-0000-4000-e000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-b@late.test');

select pg_temp.login('00000000-0000-4000-e000-00000000000a');
select public.create_salon('Late A', 'late-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-e000-00000000000b');
select public.create_salon('Late B', 'late-b', 'America/Chicago');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'late-a') as a,
         (select id from public.salons where slug = 'late-b') as b;
grant select on ids to authenticated;
create temp table t (name text primary key, id uuid);
grant select, insert on t to authenticated;

select has_function('public', 'apply_running_late',
  array['uuid', 'integer', 'jsonb', 'text'], 'apply_running_late exists');

select pg_temp.login('00000000-0000-4000-e000-00000000000a');

-- Three back-to-back cuts 10:00, 10:30, 11:00 and a fourth at 12:00.
insert into t select 'one', (public.book_appointment((select a from ids), null,
  pg_temp.segs('2030-04-02 15:00+00', 'busy', '30'))).id;
insert into t select 'two', (public.book_appointment((select a from ids), null,
  pg_temp.segs('2030-04-02 15:30+00', 'busy', '30'))).id;
insert into t select 'three', (public.book_appointment((select a from ids), null,
  pg_temp.segs('2030-04-02 16:00+00', 'busy', '30'))).id;
insert into t select 'four', (public.book_appointment((select a from ids), null,
  pg_temp.segs('2030-04-02 17:00+00', 'busy', '30'))).id;

-- One at a time, moving the first 15 minutes later collides with the second.
select throws_ok(
  $$ select public.reschedule_appointment((select id from t where name = 'one'),
       pg_temp.segs('2030-04-02 15:15+00', 'busy', '30')) $$,
  '23P01', null, 'moving one back-to-back appointment alone would double-book');

select lives_ok(
  $$ select public.apply_running_late((select a from ids), 15, jsonb_build_array(
       jsonb_build_object('appointmentId', (select id from t where name = 'one'),
                          'segments', pg_temp.segs('2030-04-02 15:15+00', 'busy', '30')),
       jsonb_build_object('appointmentId', (select id from t where name = 'two'),
                          'segments', pg_temp.segs('2030-04-02 15:45+00', 'busy', '30')),
       jsonb_build_object('appointmentId', (select id from t where name = 'three'),
                          'segments', pg_temp.segs('2030-04-02 16:15+00', 'busy', '30'))),
       'ripple') $$,
  'the cascade moves all three at once');
select is(
  (select array_agg(starts_at order by starts_at) from public.appointments
    where salon_id = (select a from ids)),
  array['2030-04-02 15:15+00', '2030-04-02 15:45+00', '2030-04-02 16:15+00',
        '2030-04-02 17:00+00']::timestamptz[],
  'starts_at follow the new segments; untouched appointments stay put');
select is(
  (select lower(range) from public.appointment_segments
    where appointment_id = (select id from t where name = 'three')),
  '2030-04-02 16:15+00'::timestamptz, 'segments are rewritten');
select is(
  (select count(*)::integer from public.audit_log
    where salon_id = (select a from ids) and action = 'appointment.rescheduled'
      and details ->> 'reason' = 'running_late'),
  3, 'each move is audited');
select is(
  (select (details ->> 'delay_minutes')::integer from public.audit_log
    where salon_id = (select a from ids) and action = 'appointment.running_late'),
  15, 'the cascade itself is audited');

select throws_ok(
  $$ select public.apply_running_late((select a from ids), 30, jsonb_build_array(
       jsonb_build_object('appointmentId', (select id from t where name = 'three'),
                          'segments', pg_temp.segs('2030-04-02 16:45+00', 'busy', '30')))) $$,
  '23P01', null, 'the final state is still checked for overlaps');
select is(
  (select starts_at from public.appointments where id = (select id from t where name = 'three')),
  '2030-04-02 16:15+00'::timestamptz, 'a failed cascade changes nothing');

select throws_ok(
  $$ select public.apply_running_late((select a from ids), 15, jsonb_build_array(
       jsonb_build_object('appointmentId', (select id from t where name = 'four'),
                          'segments', pg_temp.segs('2030-04-02 17:15+00', 'busy', '30')),
       jsonb_build_object('appointmentId', (select id from t where name = 'four'),
                          'segments', pg_temp.segs('2030-04-02 17:30+00', 'busy', '30')))) $$,
  '22023', 'Each appointment can only move once', 'duplicate moves are rejected');
select throws_ok(
  $$ select public.apply_running_late((select a from ids), 0, jsonb_build_array(
       jsonb_build_object('appointmentId', (select id from t where name = 'four'),
                          'segments', pg_temp.segs('2030-04-02 17:15+00', 'busy', '30')))) $$,
  '22023', null, 'the delay must be positive');

select public.set_appointment_status((select id from t where name = 'four'), 'completed');
select throws_ok(
  $$ select public.apply_running_late((select a from ids), 15, jsonb_build_array(
       jsonb_build_object('appointmentId', (select id from t where name = 'four'),
                          'segments', pg_temp.segs('2030-04-02 17:15+00', 'busy', '30')))) $$,
  '22023', 'Only upcoming appointments can be moved', 'completed appointments stay put');

-- Another salon's owner can't move salon A's appointments, even via their own salon id.
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-e000-00000000000b');
select throws_ok(
  $$ select public.apply_running_late((select a from ids), 15, jsonb_build_array(
       jsonb_build_object('appointmentId', (select id from t where name = 'one'),
                          'segments', pg_temp.segs('2030-04-02 15:30+00', 'busy', '30')))) $$,
  '42501', null, 'non-members cannot run a cascade');
select throws_ok(
  $$ select public.apply_running_late((select b from ids), 15, jsonb_build_array(
       jsonb_build_object('appointmentId', (select id from t where name = 'one'),
                          'segments', pg_temp.segs('2030-04-02 15:30+00', 'busy', '30')))) $$,
  'P0002', null, 'appointments from another salon are not found');
select pg_temp.logout();

set local role anon;
select throws_ok(
  $$ select public.apply_running_late('00000000-0000-0000-0000-000000000000', 15, '[]'::jsonb) $$,
  '42501', null, 'anon cannot call apply_running_late');
reset role;

select * from finish();
rollback;
