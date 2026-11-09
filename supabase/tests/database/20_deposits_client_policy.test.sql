-- Deposits × the client's manage link (#12 × #10): cancelling from /m/<token> applies the
-- cancellation policy. In time the deposit is refunded, inside the window it is kept as the fee,
-- unpaid deposits are dropped, and the link warns the client before a late cancel.
begin;
select plan(16);

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
                    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
$$;

create function pg_temp.as_service_role() returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
$$;

create function pg_temp.logout() returns void language sql as $$
  reset role;
  select set_config('request.jwt.claims', '', true);
$$;

create function pg_temp.booking(p_start timestamptz, p_service uuid, p_phone text) returns jsonb
language sql as $$
  select jsonb_build_object(
    'name', 'Dana Deposit', 'phone', p_phone,
    'segments', jsonb_build_array(jsonb_build_object(
      'kind', 'busy', 'start', p_start, 'end', p_start + interval '1 hour')),
    'services', jsonb_build_array(jsonb_build_object('serviceId', p_service, 'name', 'Color')),
    'priceCents', 20000);
$$;
grant execute on function pg_temp.booking(timestamptz, uuid, text) to service_role;

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('00000000-0000-4000-d200-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@dcp.test', now()),
  ('00000000-0000-4000-d200-0000000000c1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'client1@dcp.test', now()),
  ('00000000-0000-4000-d200-0000000000c2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'client2@dcp.test', now());

select pg_temp.login('00000000-0000-4000-d200-00000000000a');
select public.create_salon('Policy Salon', 'policy-salon', 'America/Chicago');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'policy-salon') as a,
         '00000000-0000-4000-d200-0000000000c1'::uuid as client_user,
         '00000000-0000-4000-d200-0000000000c2'::uuid as client_user2,
         date_trunc('day', now()) + interval '10 days 15 hours' as d10,
         date_trunc('day', now()) + interval '11 days 15 hours' as d11,
         date_trunc('day', now()) + interval '12 days 15 hours' as d12,
         date_trunc('day', now()) + interval '13 days 15 hours' as d13;
grant select on ids to authenticated, service_role;
create temp table t (name text primary key, val jsonb);
grant select, insert, update on t to authenticated, service_role;

delete from public.work_hours_template where salon_id = (select a from ids);
update public.settings
   set autonomy = 'auto', deposits_enabled = true, client_self_service_enabled = true,
       cancellation_window_hours = 24
 where salon_id = (select a from ids);
insert into public.stripe_accounts (salon_id, stripe_account_id, charges_enabled, details_submitted)
  select a, 'acct_policy', true, true from ids;
insert into public.services (salon_id, name, price_cents, deposit_kind, deposit_value)
  select a, 'Policy Color', 20000, 'flat', 3000 from ids;

-- Books on the public page (a client may hold three upcoming bookings), pays the deposit unless
-- p_pay is false, and stores { appointmentId, token, depositId } in t.
create function pg_temp.book(p_name text, p_start timestamptz, p_phone text, p_pay boolean default true,
                             p_user uuid default null)
returns void language plpgsql as $$
declare
  v_res jsonb;
  v_appt uuid;
  v_dep uuid;
begin
  perform pg_temp.as_service_role();
  v_res := public.book_public_appointment(
    (select a from ids), coalesce(p_user, (select client_user from ids)),
    pg_temp.booking(p_start, (select id from public.services where name = 'Policy Color'
                                and salon_id = (select a from ids)), p_phone));
  perform pg_temp.logout();
  v_appt := (v_res ->> 'appointmentId')::uuid;
  select id into v_dep from public.appointment_deposits where appointment_id = v_appt;
  if p_pay then
    perform pg_temp.as_service_role();
    perform public.mark_deposit_paid(v_dep, 'pi_' || p_name);
    perform pg_temp.logout();
  end if;
  insert into t values (p_name, jsonb_build_object(
    'appointmentId', v_appt, 'depositId', v_dep,
    'token', (select manage_token from public.appointments where id = v_appt)));
end;
$$;

select pg_temp.book('early', (select d10 from ids), '+15550108001');
select pg_temp.book('late', (select d11 from ids), '+15550108002');
select pg_temp.book('unpaid', (select d12 from ids), '+15550108003', false);
select pg_temp.book('moved', (select d13 from ids), '+15550108004', true, (select client_user2 from ids));
-- Inside the 24-hour window (moved directly: the slot itself doesn't matter here).
update public.appointments set starts_at = now() + interval '3 hours', ends_at = now() + interval '4 hours'
 where id = (select (val ->> 'appointmentId')::uuid from t where name = 'late');

select is((select string_agg(status::text, ',' order by status::text) from public.appointment_deposits d
            where d.salon_id = (select a from ids)),
  'paid,paid,paid,pending', 'three paid deposits and one unpaid');

-- What the link shows ------------------------------------------------------------------
select pg_temp.as_service_role();
insert into t select 'view_early', public.manage_booking((select val ->> 'token' from t where name = 'early'));
insert into t select 'view_late', public.manage_booking((select val ->> 'token' from t where name = 'late'));
select pg_temp.logout();
select is((select (val ->> 'canCancel', val ->> 'feeCents')::text from t where name = 'view_early'),
  ('true', '0')::text, 'in time: the client may cancel with no fee');
select ok((select val ->> 'policyMessage' like 'Cancel by % and your deposit is refunded.'
             from t where name = 'view_early'),
  'and is told when free cancellation ends');
select is((select (val ->> 'canCancel', val ->> 'feeCents')::text from t where name = 'view_late'),
  ('true', '3000')::text, 'late: the client may still cancel, and the fee is the deposit');
select ok((select val ->> 'policyMessage' like 'Free cancellation ended %the salon keeps your deposit.'
             from t where name = 'view_late'),
  'and is warned before cancelling');

-- Cancelling ---------------------------------------------------------------------------
select pg_temp.as_service_role();
insert into t select 'cancel_early', public.cancel_booking_by_token((select val ->> 'token' from t where name = 'early'));
insert into t select 'cancel_late', public.cancel_booking_by_token((select val ->> 'token' from t where name = 'late'));
insert into t select 'cancel_unpaid', public.cancel_booking_by_token((select val ->> 'token' from t where name = 'unpaid'));
select pg_temp.logout();

select is((select (val ->> 'ok', val ->> 'feeCents')::text from t where name = 'cancel_early'),
  ('true', '0')::text, 'an early cancel goes through with no fee');
select is((select (status, resolution)::text from public.appointment_deposits
            where id = (select (val ->> 'depositId')::uuid from t where name = 'early')),
  ('refund_due', 'cancelled_early')::text, 'and the deposit is due back to the client');
select is((select status::text from public.appointments
            where id = (select (val ->> 'appointmentId')::uuid from t where name = 'early')),
  'cancelled', 'the slot is freed');

select is((select (val ->> 'ok', val ->> 'feeCents')::text from t where name = 'cancel_late'),
  ('true', '3000')::text, 'a late cancel reports the fee');
select is((select (status, resolution, refunded_cents)::text from public.appointment_deposits
            where id = (select (val ->> 'depositId')::uuid from t where name = 'late')),
  ('kept', 'cancelled_late', 0)::text, 'and the salon keeps the deposit');
select is(private.appointment_deposit_cents((select a from ids),
            (select (val ->> 'appointmentId')::uuid from t where name = 'late')), 3000,
  'the kept deposit stays recorded as paid to the salon');

select is((select (val ->> 'ok', val ->> 'feeCents')::text from t where name = 'cancel_unpaid'),
  ('true', '0')::text, 'cancelling an unpaid hold costs nothing');
select is((select status::text from public.appointment_deposits
            where id = (select (val ->> 'depositId')::uuid from t where name = 'unpaid')),
  'canceled', 'and drops the unpaid deposit');

-- Rescheduling keeps the deposit with the appointment ------------------------------------
select pg_temp.as_service_role();
insert into t select 'view_moved', public.manage_booking((select val ->> 'token' from t where name = 'moved'));
insert into t select 'move', public.reschedule_booking_by_token(
  (select val ->> 'token' from t where name = 'moved'),
  jsonb_build_array(jsonb_build_object('kind', 'busy',
    'start', (select d13 from ids) + interval '2 hours', 'end', (select d13 from ids) + interval '3 hours')));
select pg_temp.logout();
select is((select val ->> 'canReschedule' from t where name = 'view_moved'), 'true',
  'a client with a paid deposit can still reschedule');
select is((select val ->> 'ok' from t where name = 'move'), 'true', 'the move goes through');
select is((select status::text from public.appointment_deposits
            where id = (select (val ->> 'depositId')::uuid from t where name = 'moved')),
  'paid', 'and the deposit stays paid on the moved appointment');

select * from finish();
rollback;
