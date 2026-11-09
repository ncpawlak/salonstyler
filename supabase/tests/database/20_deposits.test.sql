-- Optional deposits + cancellation policy (#12): settings/service columns, public bookings held
-- until the deposit is paid, text requests held on approve, the policy (free / refund / keep),
-- no-shows, released holds, checkout credit, and privileges.
begin;
select plan(52);

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

create function pg_temp.segments(p_start timestamptz, p_minutes integer default 60) returns jsonb
language sql as $$
  select jsonb_build_array(jsonb_build_object(
    'kind', 'busy', 'start', p_start, 'end', p_start + make_interval(mins => p_minutes)));
$$;
grant execute on function pg_temp.segments(timestamptz, integer) to authenticated, service_role;

create function pg_temp.booking(p_start timestamptz, p_service uuid) returns jsonb
language sql as $$
  select jsonb_build_object(
    'name', 'Dana Deposit', 'phone', '+15550107777',
    'segments', pg_temp.segments(p_start),
    'services', jsonb_build_array(jsonb_build_object('serviceId', p_service, 'name', 'Color')),
    'priceCents', 20000);
$$;
grant execute on function pg_temp.booking(timestamptz, uuid) to service_role;

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('00000000-0000-4000-d000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-a@dep.test', now()),
  ('00000000-0000-4000-d000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-b@dep.test', now()),
  ('00000000-0000-4000-d000-0000000000c1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'client@dep.test', now());

select pg_temp.login('00000000-0000-4000-d000-00000000000a');
select public.create_salon('Deposit A', 'deposit-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-d000-00000000000b');
select public.create_salon('Deposit B', 'deposit-b', 'America/Chicago');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'deposit-a') as a,
         (select id from public.salons where slug = 'deposit-b') as b,
         '00000000-0000-4000-d000-00000000000a'::uuid as owner_a,
         '00000000-0000-4000-d000-00000000000b'::uuid as owner_b,
         '00000000-0000-4000-d000-0000000000c1'::uuid as client_user,
         date_trunc('day', now()) + interval '10 days 15 hours' as d10,
         date_trunc('day', now()) + interval '11 days 15 hours' as d11,
         date_trunc('day', now()) + interval '12 days 15 hours' as d12,
         date_trunc('day', now()) + interval '13 days 15 hours' as d13,
         date_trunc('day', now()) + interval '14 days 15 hours' as d14,
         date_trunc('day', now()) + interval '15 days 15 hours' as d15;
grant select on ids to authenticated, service_role;
create temp table t (name text primary key, val jsonb);
grant select, insert, update on t to authenticated, service_role;

delete from public.work_hours_template where salon_id in (select a from ids union select b from ids);
update public.settings set autonomy = 'auto' where salon_id = (select a from ids);

insert into public.services (salon_id, name, price_cents, deposit_kind, deposit_value)
  select a, 'Color', 20000, 'percent', 25 from ids;
insert into public.services (salon_id, name, price_cents) select a, 'Trim', 3000 from ids;
insert into public.services (salon_id, name, price_cents, deposit_kind, deposit_value)
  select a, 'Consult', 0, 'flat', 1500 from ids;
create temp table svc as
  select (select id from public.services where name = 'Color' and salon_id = (select a from ids)) as color,
         (select id from public.services where name = 'Trim' and salon_id = (select a from ids)) as trim,
         (select id from public.services where name = 'Consult' and salon_id = (select a from ids)) as consult;
grant select on svc to authenticated, service_role;

insert into public.clients (salon_id, name, phone) select a, 'Texty Client', '+15550108888' from ids;

-- Schema & privileges --------------------------------------------------------------
select col_default_is('public', 'settings', 'deposits_enabled', 'false', 'deposits are off by default');
select col_default_is('public', 'settings', 'cancellation_window_hours', '24',
  'free cancellation defaults to 24 hours before');
select col_default_is('public', 'services', 'deposit_kind', 'none', 'services take no deposit by default');
select throws_ok(
  $$ update public.services set deposit_kind = 'percent', deposit_value = 150
      where id = (select trim from svc) $$,
  '23514', null, 'a percent deposit is at most 100');
select throws_ok(
  $$ update public.services set deposit_kind = 'flat', deposit_value = 10
      where id = (select trim from svc) $$,
  '23514', null, 'a flat deposit is at least the card minimum');
select ok(
  not has_function_privilege('anon', 'public.mark_deposit_paid(uuid,text,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.mark_deposit_paid(uuid,text,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.mark_deposit_refunded(uuid,integer,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.deposit_pay_page(text)', 'execute')
  and not has_function_privilege('anon', 'public.cancel_appointment_with_policy(uuid,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.cancellation_quote(uuid)', 'execute'),
  'payment RPCs are service-role only; policy RPCs need a signed-in member');
select ok(not has_table_privilege('authenticated', 'public.appointment_deposits', 'insert')
          and not has_table_privilege('authenticated', 'public.appointment_deposits', 'update'),
  'deposits are written by RPCs only');

-- Deposits off: nothing changes ------------------------------------------------------
select is(private.deposit_due_cents((select a from ids),
            jsonb_build_array(jsonb_build_object('serviceId', (select color from svc)))), 0,
  'no deposit is due while deposits are off');
select pg_temp.as_service_role();
insert into t select 'off', public.book_public_appointment(
  (select a from ids), (select client_user from ids), pg_temp.booking((select d10 from ids), (select color from svc)));
select pg_temp.logout();
select ok((select val ->> 'status' = 'confirmed' and not (val ? 'deposit') from t where name = 'off'),
  'with deposits off a public booking is confirmed right away, no deposit');

update public.settings set deposits_enabled = true where salon_id = (select a from ids);
select is(private.deposit_due_cents((select a from ids),
            jsonb_build_array(jsonb_build_object('serviceId', (select color from svc)))), 0,
  'no deposit is due until Stripe can take charges');
insert into public.stripe_accounts (salon_id, stripe_account_id, charges_enabled, details_submitted)
  select a, 'acct_depositA', true, true from ids;

-- Amounts ---------------------------------------------------------------------------
select is(private.deposit_due_cents((select a from ids),
            jsonb_build_array(jsonb_build_object('serviceId', (select color from svc)),
                              jsonb_build_object('serviceId', (select consult from svc)),
                              jsonb_build_object('serviceId', (select trim from svc)))), 6500,
  '25% of $200 + $15 flat + nothing for the trim');
select is(private.deposit_due_cents((select a from ids),
            jsonb_build_array(jsonb_build_object('serviceId', (select trim from svc)))), 0,
  'services without a deposit owe nothing');
select is(private.deposit_due_cents((select b from ids),
            jsonb_build_array(jsonb_build_object('serviceId', (select color from svc)))), 0,
  'another salon''s services never count');

-- Public booking with a deposit ------------------------------------------------------
select pg_temp.as_service_role();
insert into t select 'pub', public.book_public_appointment(
  (select a from ids), (select client_user from ids), pg_temp.booking((select d11 from ids), (select color from svc)));
select pg_temp.logout();
select is((select val ->> 'status' from t where name = 'pub'), 'held',
  'a booking that needs a deposit is held');
select is((select (val -> 'deposit' ->> 'amountCents')::integer from t where name = 'pub'), 5000,
  'the response carries the deposit amount');
select ok((select val -> 'deposit' ->> 'payToken' ~ '^[0-9a-f]{64}$' from t where name = 'pub'),
  'and an unguessable pay token');
select ok((select hold_expires_at between now() + interval '40 minutes' and now() + interval '50 minutes'
             from public.appointments where id = (select (val ->> 'appointmentId')::uuid from t where name = 'pub')),
  'the slot is held for 45 minutes');
select is((select (status, status_after, currency)::text from public.appointment_deposits
            where appointment_id = (select (val ->> 'appointmentId')::uuid from t where name = 'pub')),
  ('pending', 'confirmed', 'usd')::text, 'the pending deposit confirms the booking when paid');
select is((select count(*)::integer from public.notifications_outbox
            where appointment_id = (select (val ->> 'appointmentId')::uuid from t where name = 'pub')), 0,
  'no push before the deposit is paid');

select pg_temp.as_service_role();
select is((select public.deposit_pay_page((select val -> 'deposit' ->> 'payToken' from t where name = 'pub'))
             ->> 'amountCents')::integer, 5000, 'the pay page shows the amount');
select is((select public.deposit_pay_page((select val -> 'deposit' ->> 'payToken' from t where name = 'pub'))
             ->> 'windowHours')::integer, 24, 'and the cancellation window');
select is(public.deposit_pay_page(repeat('0', 64)), null, 'unknown tokens show nothing');
insert into t select 'pubdep', to_jsonb(public.mark_deposit_paid(
  (select id from public.appointment_deposits
    where appointment_id = (select (val ->> 'appointmentId')::uuid from t where name = 'pub')),
  'pi_deposit1', 'cus_client1', 'pm_card1'));
select pg_temp.logout();
select is((select val ->> 'status' from t where name = 'pubdep'), 'paid', 'the deposit is paid');
select is((select (status, hold_expires_at)::text from public.appointments
            where id = (select (val ->> 'appointmentId')::uuid from t where name = 'pub')),
  ('confirmed', null)::text, 'paying confirms the booking');
select is((select kind::text from public.notifications_outbox
            where appointment_id = (select (val ->> 'appointmentId')::uuid from t where name = 'pub')),
  'deposit_paid', 'the stylist gets a "Deposit paid" push');
select is((select stripe_payment_method_id from public.appointment_deposits
            where id = (select (val ->> 'id')::uuid from t where name = 'pubdep')),
  'pm_card1', 'the card is saved for no-show fees');
select is(private.appointment_deposit_cents((select a from ids),
            (select (val ->> 'appointmentId')::uuid from t where name = 'pub')), 5000,
  'checkout credits the deposit');
select pg_temp.as_service_role();
select is((select (public.mark_deposit_paid((select (val ->> 'id')::uuid from t where name = 'pubdep'),
                                            'pi_deposit1')).status::text), 'paid',
  'recording the payment twice is a no-op');
select pg_temp.logout();

-- Cancellation policy -----------------------------------------------------------------
select pg_temp.login((select owner_a from ids));
select is((select public.cancellation_quote((select (val ->> 'appointmentId')::uuid from t where name = 'pub'))
             ->> 'outcome'), 'refund', 'cancelling days ahead refunds a paid deposit');
select pg_temp.logout();
update public.appointments set starts_at = now() + interval '3 hours', ends_at = now() + interval '4 hours'
 where id = (select (val ->> 'appointmentId')::uuid from t where name = 'pub');
select pg_temp.login((select owner_a from ids));
select is((select public.cancellation_quote((select (val ->> 'appointmentId')::uuid from t where name = 'pub'))
             ->> 'outcome'), 'keep', 'inside the window the deposit is kept');
select pg_temp.logout();
select pg_temp.login((select owner_b from ids));
select throws_ok(
  $$ select public.cancellation_quote((select (val ->> 'appointmentId')::uuid from t where name = 'pub')) $$,
  'P0002', null, 'other salons cannot see the quote');
select throws_ok(
  $$ select public.cancel_appointment_with_policy((select (val ->> 'appointmentId')::uuid from t where name = 'pub')) $$,
  'P0002', null, 'or cancel');
select pg_temp.logout();

-- The client's link (service role) gets the policy and cannot waive it.
select pg_temp.as_service_role();
select throws_ok(
  $$ select public.cancel_appointment_with_policy(
       (select (val ->> 'appointmentId')::uuid from t where name = 'pub'), 'client', 'refund') $$,
  '42501', null, 'only the salon can override the policy');
insert into t select 'latecancel', public.cancel_appointment_with_policy(
  (select (val ->> 'appointmentId')::uuid from t where name = 'pub'), 'client_cancelled');
select pg_temp.logout();
select is((select val -> 'appointment' ->> 'status' from t where name = 'latecancel'), 'cancelled',
  'a late cancellation cancels');
select is((select (val -> 'deposit' ->> 'status', val -> 'deposit' ->> 'resolution')::text
             from t where name = 'latecancel'),
  ('kept', 'cancelled_late')::text, 'and keeps the deposit as the fee');
select ok((select not (val -> 'deposit' ? 'pay_token') from t where name = 'latecancel'),
  'the response never leaks the pay token');

-- Member cancels early: refund_due; owner waives a late fee.
select pg_temp.as_service_role();
insert into t select 'early', public.book_public_appointment(
  (select a from ids), (select client_user from ids), pg_temp.booking((select d12 from ids), (select consult from svc)));
select public.mark_deposit_paid((select id from public.appointment_deposits
  where appointment_id = (select (val ->> 'appointmentId')::uuid from t where name = 'early')), 'pi_deposit2');
insert into t select 'waive', public.book_public_appointment(
  (select a from ids), (select client_user from ids), pg_temp.booking((select d13 from ids), (select consult from svc)));
select public.mark_deposit_paid((select id from public.appointment_deposits
  where appointment_id = (select (val ->> 'appointmentId')::uuid from t where name = 'waive')), 'pi_deposit3');
select pg_temp.logout();
select pg_temp.login((select owner_a from ids));
insert into t select 'earlycancel', public.cancel_appointment_with_policy(
  (select (val ->> 'appointmentId')::uuid from t where name = 'early'));
select is((select (val -> 'deposit' ->> 'status', val -> 'quote' ->> 'outcome')::text from t where name = 'earlycancel'),
  ('refund_due', 'refund')::text, 'an early cancellation marks the deposit for refund');
select throws_ok(
  $$ select public.cancel_appointment_with_policy(
       (select (val ->> 'appointmentId')::uuid from t where name = 'waive'), null, 'maybe') $$,
  '22023', null, 'the override is refund or keep');
insert into t select 'waived', public.cancel_appointment_with_policy(
  (select (val ->> 'appointmentId')::uuid from t where name = 'waive'), 'emergency', 'keep');
select is((select val -> 'deposit' ->> 'resolution' from t where name = 'waived'), 'salon_keep',
  'the salon can choose what happens to the deposit');
select pg_temp.logout();

select pg_temp.as_service_role();
insert into t select 'refunded', to_jsonb(public.mark_deposit_refunded(
  (select (val -> 'deposit' ->> 'id')::uuid from t where name = 'earlycancel'), 1500, null));
select pg_temp.logout();
select is((select (val ->> 'status', val ->> 'refunded_cents')::text from t where name = 'refunded'),
  ('refunded', '1500')::text, 'the refund is recorded');
select is((select (status, amount_refunded_cents)::text from public.payments where stripe_payment_intent_id = 'pi_deposit2'),
  ('refunded', '1500')::text, 'and the payment row follows');

-- No-shows keep the deposit; undoing the no-show puts it back.
select pg_temp.as_service_role();
insert into t select 'noshow', public.book_public_appointment(
  (select a from ids), (select client_user from ids), pg_temp.booking((select d14 from ids), (select consult from svc)));
select public.mark_deposit_paid((select id from public.appointment_deposits
  where appointment_id = (select (val ->> 'appointmentId')::uuid from t where name = 'noshow')), 'pi_deposit4');
select pg_temp.logout();
select pg_temp.login((select owner_a from ids));
select public.set_appointment_status((select (val ->> 'appointmentId')::uuid from t where name = 'noshow'), 'no_show');
select is((select (status, resolution)::text from public.appointment_deposits
            where appointment_id = (select (val ->> 'appointmentId')::uuid from t where name = 'noshow')),
  ('kept', 'no_show')::text, 'a no-show keeps the deposit');
select public.set_appointment_status((select (val ->> 'appointmentId')::uuid from t where name = 'noshow'), 'confirmed');
select is((select status::text from public.appointment_deposits
            where appointment_id = (select (val ->> 'appointmentId')::uuid from t where name = 'noshow')),
  'paid', 'undoing the no-show puts the deposit back');
select pg_temp.logout();

-- Released holds: the deposit is dropped; paying late flags it for refund.
select pg_temp.as_service_role();
insert into t select 'expire', public.book_public_appointment(
  (select a from ids), (select client_user from ids), pg_temp.booking((select d15 from ids), (select consult from svc)));
select pg_temp.logout();
update public.appointments set hold_expires_at = now() - interval '1 minute'
 where id = (select (val ->> 'appointmentId')::uuid from t where name = 'expire');
select private.release_expired_holds();
select is((select status::text from public.appointment_deposits
            where appointment_id = (select (val ->> 'appointmentId')::uuid from t where name = 'expire')),
  'canceled', 'an expired hold drops the unpaid deposit');
select pg_temp.as_service_role();
select is((select (public.mark_deposit_paid((select id from public.appointment_deposits
            where appointment_id = (select (val ->> 'appointmentId')::uuid from t where name = 'expire')),
            'pi_deposit5')).status::text), 'refund_due',
  'paying after the hold was released flags the deposit for refund');
select pg_temp.logout();

-- Text bookings: approving the request holds the slot for the deposit -----------------
select pg_temp.login((select owner_a from ids));
insert into t select 'text', to_jsonb(public.book_appointment(
  (select a from ids), (select id from public.clients where name = 'Texty Client'),
  pg_temp.segments((select d10 from ids) + interval '3 hours'),
  jsonb_build_array(jsonb_build_object('serviceId', (select color from svc), 'name', 'Color')),
  'requested', 'inbox'));
select pg_temp.logout();
insert into public.captured_requests (salon_id, message, intent, appointment_id, dedupe_key)
  select a, 'Can I get color Friday?', 'booking', (select (val ->> 'id')::uuid from t where name = 'text'), 'dep-1'
    from ids;
select pg_temp.login((select owner_a from ids));
select public.set_appointment_status((select (val ->> 'id')::uuid from t where name = 'text'), 'confirmed');
select pg_temp.logout();
select is((select status::text from public.appointments where id = (select (val ->> 'id')::uuid from t where name = 'text')),
  'held', 'approving a text request that needs a deposit holds the slot');
select is((select (status, amount_cents)::text from public.appointment_deposits
            where appointment_id = (select (val ->> 'id')::uuid from t where name = 'text')),
  ('pending', 5000)::text, 'with a pending deposit');
select is((select status::text from public.captured_requests where dedupe_key = 'dep-1'),
  'approved', 'and the request counts as approved, so the reply can carry the pay link');
select pg_temp.as_service_role();
select public.mark_deposit_paid((select id from public.appointment_deposits
  where appointment_id = (select (val ->> 'id')::uuid from t where name = 'text')), 'pi_deposit6');
select pg_temp.logout();
select is((select status::text from public.appointments where id = (select (val ->> 'id')::uuid from t where name = 'text')),
  'confirmed', 'paying confirms the text booking');

-- Owner-made bookings never ask for a deposit.
select pg_temp.login((select owner_a from ids));
insert into t select 'owner', to_jsonb(public.book_appointment(
  (select a from ids), (select id from public.clients where name = 'Texty Client'),
  pg_temp.segments((select d11 from ids) + interval '3 hours'),
  jsonb_build_array(jsonb_build_object('serviceId', (select color from svc), 'name', 'Color'))));
select pg_temp.logout();
select is((select (a.status::text, (select count(*) from public.appointment_deposits d where d.appointment_id = a.id))::text
             from public.appointments a where a.id = (select (val ->> 'id')::uuid from t where name = 'owner')),
  ('confirmed', 0)::text, 'bookings the stylist makes are not held for a deposit');

-- RLS ------------------------------------------------------------------------------
select pg_temp.login((select owner_b from ids));
select is((select count(*)::integer from public.appointment_deposits), 0, 'other salons see no deposits');
select pg_temp.logout();
select pg_temp.login((select owner_a from ids));
select ok((select count(*) from public.appointment_deposits) >= 6, 'members see their salon''s deposits');
select pg_temp.logout();

select * from finish();
rollback;
