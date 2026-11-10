-- Optional deposits + cancellation policy (#12, docs/PLAN.md §9). Off by default.
--
-- A deposit is required only when ALL of these hold, otherwise booking works exactly as before:
--   • settings.deposits_enabled (the owner's master switch, default false)
--   • a booked service has a deposit (services.deposit_kind flat / percent) worth ≥ 0.50
--   • the salon's Stripe account can take charges
--
-- Flow (docs: supabase/docs/deposits.md):
--   public page (/b/{slug}) ─ book_public_appointment ──▶ appointment `held` (45 min) + deposit
--   text request ─ stylist approves (requested → confirmed) ──▶ trigger keeps it `held` + deposit
--   client pays at /pay/<token> (Stripe Checkout, card saved) ─ deposits Edge Function / webhook
--     ──▶ mark_deposit_paid ──▶ appointment becomes `status_after` (confirmed or requested)
--   checkout credits the deposit automatically (payments row with appointment_id, #11).
--
-- Cancellation policy: free until settings.cancellation_window_hours before the start. Later
-- cancellations and no-shows keep the deposit; earlier ones (and the salon cancelling or
-- declining) make it `refund_due`, which the deposits Edge Function refunds through Stripe.
-- cancellation_quote / cancel_appointment_with_policy are the reusable entry points (#10).

-- ---------------------------------------------------------------------------
-- Settings and per-service deposits
-- ---------------------------------------------------------------------------

create type public.deposit_kind as enum ('none', 'flat', 'percent');
create type public.deposit_status as enum
  ('pending', 'paid', 'refund_due', 'refunded', 'kept', 'canceled');

alter type public.notification_kind add value if not exists 'deposit_paid';

alter table public.settings
  add column deposits_enabled boolean not null default false,
  add column cancellation_window_hours integer not null default 24
    check (cancellation_window_hours between 0 and 336);

comment on column public.settings.deposits_enabled is
  'Master switch for deposits (off by default). Needs Stripe charges enabled to take effect.';
comment on column public.settings.cancellation_window_hours is
  'Free cancellation until this many hours before the start; later, the deposit is kept.';

alter table public.services
  add column deposit_kind public.deposit_kind not null default 'none',
  add column deposit_value integer not null default 0,
  add constraint services_deposit_value_check check (
    (deposit_kind = 'none' and deposit_value = 0)
    or (deposit_kind = 'flat' and deposit_value between 50 and 10000000)
    or (deposit_kind = 'percent' and deposit_value between 1 and 100));

comment on column public.services.deposit_value is
  'Flat: cents in the salon currency (min 50). Percent: 1-100 of price_cents.';

-- ---------------------------------------------------------------------------
-- appointment_deposits
-- ---------------------------------------------------------------------------

create table public.appointment_deposits (
  id                         uuid primary key default gen_random_uuid(),
  salon_id                   uuid not null references public.salons (id) on delete cascade,
  appointment_id             uuid not null unique,
  amount_cents               integer not null check (amount_cents between 50 and 10000000),
  currency                   text not null check (currency ~ '^[a-z]{3}$'),
  status                     public.deposit_status not null default 'pending',
  -- What the appointment becomes once paid: confirmed, or requested (still needs approval).
  status_after               public.appointment_status not null
    check (status_after in ('confirmed', 'requested')),
  -- Unguessable token for the client's pay link (/pay/<token>).
  pay_token                  text not null unique
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
    check (pay_token ~ '^[0-9a-f]{64}$'),
  stripe_checkout_session_id text check (stripe_checkout_session_id ~ '^cs_[A-Za-z0-9_]+$'),
  stripe_payment_intent_id   text unique check (stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'),
  -- Saved for no-show fees (Checkout setup_future_usage = off_session).
  stripe_customer_id         text check (stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'),
  stripe_payment_method_id   text check (stripe_payment_method_id ~ '^pm_[A-Za-z0-9_]+$'),
  paid_at                    timestamptz,
  refunded_cents             integer not null default 0 check (refunded_cents >= 0),
  resolved_at                timestamptz,
  -- Why it was kept / refunded / canceled: cancelled_early, cancelled_late, no_show,
  -- salon_cancelled, hold_expired, paid_after_release, owner_refund ...
  resolution                 text check (resolution is null or char_length(resolution) <= 60),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint appointment_deposits_appointment_fkey foreign key (salon_id, appointment_id)
    references public.appointments (salon_id, id) on delete cascade,
  constraint appointment_deposits_paid_has_time check (
    status in ('pending', 'canceled') or paid_at is not null)
);

comment on table public.appointment_deposits is
  'Deposit asked for an appointment. Written only through RPCs and the deposits Edge Function.';

create index appointment_deposits_salon_status_idx on public.appointment_deposits (salon_id, status);

create trigger appointment_deposits_set_updated_at
  before update on public.appointment_deposits
  for each row execute function private.set_updated_at();

alter table public.appointment_deposits enable row level security;
revoke all on public.appointment_deposits from anon;
revoke insert, update, delete, truncate on public.appointment_deposits from authenticated;

create policy "members can read deposits" on public.appointment_deposits
  for select to authenticated using (private.is_salon_member(salon_id));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Stripe's card minimum (0.50 in USD/EUR/GBP-like currencies); smaller deposits are skipped.
create or replace function private.min_deposit_cents()
returns integer
language sql
immutable
set search_path = ''
as $$ select 50 $$;

-- Deposit owed for a services snapshot ([{ serviceId, ... }]); 0 when deposits don't apply.
-- Mirrors serviceDepositCents / depositForServices in @chairside/core/deposits.
create or replace function private.deposit_due_cents(p_salon_id uuid, p_services jsonb)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_total integer;
begin
  if not coalesce((select st.deposits_enabled from public.settings st
                    where st.salon_id = p_salon_id), false)
     or not exists (select 1 from public.stripe_accounts a
                     where a.salon_id = p_salon_id and a.charges_enabled) then
    return 0;
  end if;

  select coalesce(sum(case s.deposit_kind
                        when 'flat' then s.deposit_value
                        when 'percent' then round(coalesce(s.price_cents, 0) * s.deposit_value / 100.0)
                        else 0 end), 0)::integer
    into v_total
    from jsonb_array_elements(case when jsonb_typeof(p_services) = 'array'
                                   then p_services else '[]'::jsonb end) e
    join public.services s on s.salon_id = p_salon_id and s.id::text = (e ->> 'serviceId')
   where jsonb_typeof(e) = 'object';

  return case when v_total < private.min_deposit_cents() then 0
              else least(v_total, 10000000) end;
end;
$$;

-- Asks for a deposit on an appointment (idempotent per appointment).
create or replace function private.create_deposit(
  p_salon_id       uuid,
  p_appointment_id uuid,
  p_amount_cents   integer,
  p_status_after   public.appointment_status
)
returns public.appointment_deposits
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deposit public.appointment_deposits;
begin
  insert into public.appointment_deposits
    (salon_id, appointment_id, amount_cents, currency, status_after)
  select p_salon_id, p_appointment_id, p_amount_cents, lower(st.currency), p_status_after
    from public.settings st where st.salon_id = p_salon_id
  on conflict (appointment_id) do update
     set amount_cents = excluded.amount_cents, status_after = excluded.status_after,
         status = 'pending', resolution = null, resolved_at = null
   where public.appointment_deposits.status = 'canceled'
  returning * into v_deposit;

  if v_deposit.id is null then
    select * into v_deposit from public.appointment_deposits d
     where d.appointment_id = p_appointment_id;
  else
    insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
    values (p_salon_id, auth.uid(), 'deposit.requested', 'appointment', p_appointment_id::text,
            jsonb_build_object('deposit_id', v_deposit.id, 'amount_cents', p_amount_cents,
                               'status_after', p_status_after));
  end if;
  return v_deposit;
end;
$$;

-- When free cancellation ends and what cancelling now would do with the deposit.
-- Mirrors cancellationOutcome in @chairside/core/deposits.
--   outcome: 'free'   nothing paid (or already settled): just cancel
--            'refund' paid, cancelled in time: the deposit is refunded
--            'keep'   paid, inside the window: the deposit is kept as the cancellation fee
create or replace function private.cancellation_quote(p_appointment_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_appt    public.appointments;
  v_hours   integer;
  v_deposit public.appointment_deposits;
  v_free    timestamptz;
  v_late    boolean;
begin
  select * into v_appt from public.appointments a where a.id = p_appointment_id;
  if not found then
    return null;
  end if;
  select coalesce(st.cancellation_window_hours, 24) into v_hours
    from public.settings st where st.salon_id = v_appt.salon_id;
  select * into v_deposit from public.appointment_deposits d where d.appointment_id = v_appt.id;

  v_free := v_appt.starts_at - make_interval(hours => coalesce(v_hours, 24));
  v_late := p_now >= v_free;

  return jsonb_build_object(
    'appointmentId', v_appt.id,
    'status', v_appt.status,
    'startsAt', v_appt.starts_at,
    'windowHours', coalesce(v_hours, 24),
    'freeUntil', v_free,
    'late', v_late,
    'depositStatus', v_deposit.status,
    'depositCents', coalesce(v_deposit.amount_cents, 0),
    'currency', v_deposit.currency,
    'outcome', case
      when v_deposit.status is distinct from 'paid' then 'free'
      when v_late then 'keep'
      else 'refund' end);
end;
$$;

-- ---------------------------------------------------------------------------
-- Public booking: ask for the deposit before the booking counts
-- ---------------------------------------------------------------------------

-- Same as 20261109320000_public_booking.sql, plus: when a deposit is due the appointment is
-- booked `held` for 45 minutes (Stripe Checkout's minimum session is 30) and the response carries
-- `deposit { amountCents, currency, payToken, holdExpiresAt }`. It becomes confirmed / requested
-- once paid (mark_deposit_paid), so no "New booking" push goes out before then.
create or replace function public.book_public_appointment(
  p_salon_id     uuid,
  p_user_id      uuid,
  p_booking      jsonb,
  p_max_upcoming integer default 3
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.settings;
  v_email    text;
  v_phone    text := nullif(left(btrim(p_booking ->> 'phone'), 32), '');
  v_name     text := nullif(left(btrim(p_booking ->> 'name'), 80), '');
  v_client   uuid;
  v_created  boolean := false;
  v_linked   boolean := false;
  v_active   integer;
  v_stylist  uuid;
  v_status   public.appointment_status;
  v_services jsonb := case when jsonb_typeof(p_booking -> 'services') = 'array'
                           then p_booking -> 'services' else '[]'::jsonb end;
  v_due      integer;
  v_appt     public.appointments;
  v_deposit  public.appointment_deposits;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only the booking service can book' using errcode = '42501';
  end if;

  select * into v_settings from public.settings s where s.salon_id = p_salon_id;
  if not found or not v_settings.public_booking_enabled then
    return jsonb_build_object('ok', false, 'reason', 'disabled');
  end if;

  select u.email into v_email from auth.users u
   where u.id = p_user_id and u.email_confirmed_at is not null;
  if v_email is null then
    raise exception 'Verify your email first' using errcode = '42501';
  end if;

  -- 1. The profile already linked to this account.
  select c.id into v_client from public.clients c
   where c.salon_id = p_salon_id and c.user_id = p_user_id;

  -- 2. An unlinked profile with the same (now verified) email: claim it. Never match by phone,
  --    which is unverified and would let anyone read or book as someone else.
  if v_client is null then
    select c.id into v_client from public.clients c
     where c.salon_id = p_salon_id and c.user_id is null and lower(c.email) = lower(v_email)
     order by c.created_at
     limit 1
     for update;
    if found then
      update public.clients
         set user_id = p_user_id, phone = coalesce(phone, v_phone)
       where id = v_client;
      v_linked := true;
    end if;
  end if;

  -- 3. A new client: pending until the owner confirms a booking.
  if v_client is null then
    if v_name is null then
      raise exception 'Name is required' using errcode = '22023';
    end if;
    insert into public.clients (salon_id, name, phone, email, pending, user_id)
    values (p_salon_id, v_name, v_phone, lower(v_email), true, p_user_id)
    returning id into v_client;
    v_created := true;
  end if;

  select count(*)::integer into v_active from public.appointments a
   where a.salon_id = p_salon_id and a.client_id = v_client and a.source = 'public'
     and a.status in ('held', 'requested', 'confirmed') and a.ends_at > now();
  if v_active >= p_max_upcoming then
    return jsonb_build_object('ok', false, 'reason', 'limit', 'clientId', v_client);
  end if;

  -- Bookings land on the owner's calendar (single-chair salons; staff routing comes later).
  select m.user_id into v_stylist from public.salon_members m
   where m.salon_id = p_salon_id and m.role = 'owner'
   order by m.created_at limit 1;

  -- Auto mode books straight away (Tentative time still becomes a request via
  -- private.appointment_request_rules); Draft mode always asks the owner first.
  v_status := case
    when v_settings.autonomy = 'auto' and not coalesce((p_booking ->> 'requiresApproval')::boolean, false)
    then 'confirmed' else 'requested' end;
  v_due := private.deposit_due_cents(p_salon_id, v_services);

  begin
    v_appt := public.book_appointment(
      p_salon_id, v_client, p_booking -> 'segments', v_services,
      case when v_due > 0 then 'held'::public.appointment_status else v_status end,
      'public', (p_booking ->> 'priceCents')::integer,
      left(p_booking ->> 'notes', 500), v_stylist);
  exception when exclusion_violation then
    return jsonb_build_object('ok', false, 'reason', 'conflict', 'clientId', v_client);
  end;

  if v_due > 0 then
    update public.appointments set hold_expires_at = now() + interval '45 minutes'
     where id = v_appt.id
    returning * into v_appt;
    v_deposit := private.create_deposit(p_salon_id, v_appt.id, v_due, v_status);
  end if;

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (p_salon_id, null, 'public_booking.booked', 'appointment', v_appt.id::text,
          jsonb_build_object('status', v_appt.status, 'client_id', v_client,
                             'client_created', v_created, 'client_linked', v_linked,
                             'client_user_id', p_user_id, 'deposit_cents', v_due));

  return jsonb_build_object(
    'ok', true, 'appointmentId', v_appt.id, 'status', v_appt.status,
    'startsAt', v_appt.starts_at, 'endsAt', v_appt.ends_at,
    'clientId', v_client, 'clientCreated', v_created, 'clientLinked', v_linked)
    || case when v_deposit.id is null then '{}'::jsonb
            else jsonb_build_object('deposit', jsonb_build_object(
                   'amountCents', v_deposit.amount_cents, 'currency', v_deposit.currency,
                   'payToken', v_deposit.pay_token, 'holdExpiresAt', v_appt.hold_expires_at))
       end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Text bookings: approving a request that needs a deposit holds the slot until it is paid
-- ---------------------------------------------------------------------------

-- requested → confirmed on an inbox / public request becomes requested → held (expiry:
-- settings.hold_expiry_hours) with a pending deposit. Every approve path (Inbox card, request
-- screen, lock-screen action) goes through here. Reschedules are exempt: the client already
-- holds a booking.
create or replace function private.hold_for_deposit_on_approve()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_due   integer;
  v_hours integer;
begin
  if new.source not in ('inbox', 'public')
     or exists (select 1 from public.appointment_deposits d
                 where d.appointment_id = new.id and d.status <> 'canceled')
     or exists (select 1 from public.captured_requests c
                 where c.appointment_id = new.id and c.intent = 'reschedule') then
    return new;
  end if;
  v_due := private.deposit_due_cents(new.salon_id, new.services);
  if v_due = 0 then
    return new;
  end if;

  select coalesce(st.hold_expiry_hours, 24) into v_hours
    from public.settings st where st.salon_id = new.salon_id;
  new.status := 'held';
  new.hold_expires_at := now() + make_interval(hours => coalesce(v_hours, 24));
  perform private.create_deposit(new.salon_id, new.id, v_due, 'confirmed');
  return new;
end;
$$;

create trigger appointments_hold_for_deposit
  before update of status on public.appointments
  for each row
  when (old.status = 'requested' and new.status = 'confirmed')
  execute function private.hold_for_deposit_on_approve();

-- Keeps the deposit in step with the appointment:
--   requested → held (approved, awaiting deposit): the text request counts as approved, so its
--     reply (with the pay link) can be sent
--   → cancelled: unpaid deposits are dropped; paid ones the policy didn't settle are refund_due
--   → no_show: the paid deposit is kept (undoing the no-show puts it back)
create or replace function private.sync_deposit_with_appointment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'requested' and new.status = 'held' then
    update public.captured_requests c
       set status = 'approved', resolved_at = now()
     where c.appointment_id = new.id and c.status = 'pending'
       and exists (select 1 from public.appointment_deposits d
                    where d.appointment_id = new.id and d.status = 'pending');
  elsif new.status = 'cancelled' then
    update public.appointment_deposits d
       set status = 'canceled', resolved_at = now(),
           resolution = coalesce(new.cancel_reason, 'cancelled')
     where d.appointment_id = new.id and d.status = 'pending';
    update public.appointment_deposits d
       set status = 'refund_due', resolved_at = now(), resolution = 'salon_cancelled'
     where d.appointment_id = new.id and d.status = 'paid';
  elsif new.status = 'no_show' then
    update public.appointment_deposits d
       set status = 'kept', resolved_at = now(), resolution = 'no_show'
     where d.appointment_id = new.id and d.status = 'paid';
  elsif old.status = 'no_show' and new.status = 'confirmed' then
    update public.appointment_deposits d
       set status = 'paid', resolved_at = null, resolution = null
     where d.appointment_id = new.id and d.status = 'kept' and d.resolution = 'no_show';
  end if;
  return null;
end;
$$;

create trigger appointments_sync_deposit
  after update of status on public.appointments
  for each row when (old.status is distinct from new.status)
  execute function private.sync_deposit_with_appointment();

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- What cancelling now would do (members of the salon, or the service role for client links).
create or replace function public.cancellation_quote(p_appointment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_salon uuid;
begin
  select a.salon_id into v_salon from public.appointments a where a.id = p_appointment_id;
  if v_salon is null or not private.can_book_for_salon(v_salon) then
    raise exception 'Appointment not found' using errcode = 'P0002';
  end if;
  return private.cancellation_quote(p_appointment_id);
end;
$$;

-- Cancels and settles the deposit by the policy. p_deposit overrides it for salon members:
-- 'refund' or 'keep' (e.g. waive the fee for an emergency). Callers with the service role (the
-- client's manage link, #10) always get the policy. Returns { appointment, quote, deposit }.
-- A refund_due deposit is refunded through Stripe by the deposits Edge Function.
create or replace function public.cancel_appointment_with_policy(
  p_appointment_id uuid,
  p_reason         text default null,
  p_deposit        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appt    public.appointments;
  v_quote   jsonb;
  v_choice  text;
  v_deposit public.appointment_deposits;
begin
  select * into v_appt from public.appointments a where a.id = p_appointment_id for update;
  if not found or not private.can_book_for_salon(v_appt.salon_id) then
    raise exception 'Appointment not found' using errcode = 'P0002';
  end if;
  if p_deposit is not null and p_deposit not in ('refund', 'keep') then
    raise exception 'Deposit choice must be refund or keep' using errcode = '22023';
  end if;
  if p_deposit is not null and not private.is_salon_member(v_appt.salon_id) then
    raise exception 'Only the salon can override the cancellation policy' using errcode = '42501';
  end if;

  v_quote := private.cancellation_quote(v_appt.id);
  v_choice := coalesce(p_deposit, case v_quote ->> 'outcome' when 'keep' then 'keep'
                                                             when 'refund' then 'refund' end);

  if v_choice is not null then
    update public.appointment_deposits d
       set status = case when v_choice = 'keep' then 'kept'::public.deposit_status
                         else 'refund_due'::public.deposit_status end,
           resolved_at = now(),
           resolution = case
             when p_deposit is not null then 'salon_' || v_choice
             when v_choice = 'keep' then 'cancelled_late'
             else 'cancelled_early' end
     where d.appointment_id = v_appt.id and d.status = 'paid'
    returning * into v_deposit;
  end if;

  v_appt := public.set_appointment_status(v_appt.id, 'cancelled',
                                          coalesce(nullif(btrim(p_reason), ''), 'cancelled'));
  select * into v_deposit from public.appointment_deposits d where d.appointment_id = v_appt.id;

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (v_appt.salon_id, auth.uid(), 'appointment.cancelled_with_policy', 'appointment',
          v_appt.id::text,
          jsonb_build_object('outcome', v_quote ->> 'outcome', 'override', p_deposit,
                             'deposit_status', v_deposit.status));

  return jsonb_build_object('appointment', to_jsonb(v_appt), 'quote', v_quote,
                            'deposit', case when v_deposit.id is null then null
                                            else to_jsonb(v_deposit) - 'pay_token' end);
end;
$$;

-- Records a successful deposit payment (deposits Edge Function and Stripe webhook; idempotent).
-- Paid in time: the appointment becomes status_after. Paid after the hold was released (or the
-- appointment was cancelled): the deposit is refund_due.
create or replace function public.mark_deposit_paid(
  p_deposit_id               uuid,
  p_payment_intent_id        text,
  p_customer_id              text default null,
  p_payment_method_id        text default null
)
returns public.appointment_deposits
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deposit public.appointment_deposits;
  v_appt    public.appointments;
  v_tz      text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only the payments service can record deposits' using errcode = '42501';
  end if;

  select * into v_deposit from public.appointment_deposits d where d.id = p_deposit_id for update;
  if not found then
    raise exception 'Deposit not found' using errcode = 'P0002';
  end if;
  if v_deposit.status not in ('pending', 'canceled') then
    return v_deposit;
  end if;

  select * into v_appt from public.appointments a where a.id = v_deposit.appointment_id for update;

  update public.appointment_deposits d
     set status = case when v_appt.status = 'held' then 'paid'::public.deposit_status
                       else 'refund_due'::public.deposit_status end,
         resolution = case when v_appt.status = 'held' then null else 'paid_after_release' end,
         resolved_at = case when v_appt.status = 'held' then null else now() end,
         paid_at = now(),
         stripe_payment_intent_id = p_payment_intent_id,
         stripe_customer_id = coalesce(p_customer_id, d.stripe_customer_id),
         stripe_payment_method_id = coalesce(p_payment_method_id, d.stripe_payment_method_id)
   where d.id = v_deposit.id
  returning * into v_deposit;

  -- Checkout credits succeeded payments on the appointment (private.appointment_deposit_cents);
  -- record it now rather than waiting for the webhook.
  insert into public.payments (salon_id, appointment_id, stripe_payment_intent_id, stripe_account_id,
                               amount_cents, currency, status, description)
  select v_deposit.salon_id, v_deposit.appointment_id, p_payment_intent_id, a.stripe_account_id,
         v_deposit.amount_cents, v_deposit.currency, 'succeeded', 'Deposit'
    from (select 1) one
    left join public.stripe_accounts a on a.salon_id = v_deposit.salon_id
  on conflict (stripe_payment_intent_id) do update
     set appointment_id = coalesce(public.payments.appointment_id, excluded.appointment_id);

  if v_appt.status = 'held' then
    -- A held slot touching Tentative hours still becomes a request (appointment_request_rules),
    -- which pushes Approve / Decline on its own.
    update public.appointments
       set status = v_deposit.status_after, hold_expires_at = null
     where id = v_appt.id
    returning * into v_appt;
    -- A text request was already approved by the stylist; don't send it back for approval.
    if v_appt.status = 'requested' and v_deposit.status_after = 'confirmed'
       and v_appt.source = 'inbox' then
      update public.appointments set status = 'confirmed' where id = v_appt.id
      returning * into v_appt;
    end if;

    if v_appt.status = 'confirmed' then
      select s.timezone into v_tz from public.salons s where s.id = v_appt.salon_id;
      perform private.enqueue_notification(
        v_appt.salon_id, v_appt.stylist_id, 'deposit_paid', v_appt.id,
        'Deposit paid · ' || private.appointment_client_name(v_appt.client_id),
        private.format_local_datetime(v_appt.starts_at, v_tz)
          || coalesce(' · ' || private.appointment_services_label(v_appt.services), '')
          || ' · ' || private.format_money(v_deposit.amount_cents::bigint, v_deposit.currency)
          || ' paid, booking confirmed',
        null,
        jsonb_build_object('type', 'deposit_paid', 'salonId', v_appt.salon_id,
                           'appointmentId', v_appt.id),
        'deposit_paid:' || v_deposit.id);
    end if;
  end if;

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (v_deposit.salon_id, null, 'deposit.paid', 'appointment', v_appt.id::text,
          jsonb_build_object('deposit_id', v_deposit.id, 'status', v_deposit.status,
                             'payment_intent_id', p_payment_intent_id,
                             'appointment_status', v_appt.status));
  return v_deposit;
end;
$$;

-- Records a Stripe refund of the deposit (deposits Edge Function).
create or replace function public.mark_deposit_refunded(
  p_deposit_id     uuid,
  p_refunded_cents integer,
  p_resolution     text default null
)
returns public.appointment_deposits
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deposit public.appointment_deposits;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only the payments service can record refunds' using errcode = '42501';
  end if;
  update public.appointment_deposits d
     set status = 'refunded',
         refunded_cents = greatest(d.refunded_cents, least(p_refunded_cents, d.amount_cents)),
         resolved_at = now(),
         resolution = coalesce(nullif(btrim(left(p_resolution, 60)), ''), d.resolution, 'refunded')
   where d.id = p_deposit_id and d.status in ('paid', 'refund_due', 'kept', 'refunded')
  returning * into v_deposit;
  if not found then
    raise exception 'Deposit not refundable' using errcode = '22023';
  end if;

  update public.payments p
     set amount_refunded_cents = greatest(p.amount_refunded_cents, v_deposit.refunded_cents),
         status = case when greatest(p.amount_refunded_cents, v_deposit.refunded_cents) >= p.amount_cents
                       then 'refunded'::public.payment_status
                       else 'partially_refunded'::public.payment_status end
   where p.stripe_payment_intent_id = v_deposit.stripe_payment_intent_id
     and p.status in ('succeeded', 'partially_refunded');

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (v_deposit.salon_id, null, 'deposit.refunded', 'appointment',
          v_deposit.appointment_id::text,
          jsonb_build_object('deposit_id', v_deposit.id, 'refunded_cents', v_deposit.refunded_cents,
                             'resolution', v_deposit.resolution));
  return v_deposit;
end;
$$;

-- What the client's pay page (/pay/<token>) may show (deposits Edge Function).
create or replace function public.deposit_pay_page(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_page jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only the payments service can read pay pages' using errcode = '42501';
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  select jsonb_build_object(
           'depositId', d.id,
           'status', d.status,
           'amountCents', d.amount_cents,
           'currency', d.currency,
           'salonName', s.name,
           'salonSlug', s.slug,
           'timezone', s.timezone,
           'appointmentStatus', a.status,
           'startsAt', a.starts_at,
           'holdExpiresAt', a.hold_expires_at,
           'services', private.appointment_services_label(a.services),
           'windowHours', st.cancellation_window_hours,
           'freeUntil', a.starts_at - make_interval(hours => st.cancellation_window_hours))
    into v_page
    from public.appointment_deposits d
    join public.appointments a on a.id = d.appointment_id
    join public.salons s on s.id = d.salon_id
    join public.settings st on st.salon_id = d.salon_id
   where d.pay_token = p_token;
  return v_page;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function private.min_deposit_cents() from public;
revoke all on function private.deposit_due_cents(uuid, jsonb) from public;
revoke all on function private.create_deposit(uuid, uuid, integer, public.appointment_status)
  from public;
revoke all on function private.cancellation_quote(uuid, timestamptz) from public;
revoke all on function private.hold_for_deposit_on_approve() from public;
revoke all on function private.sync_deposit_with_appointment() from public;

revoke all on function public.cancellation_quote(uuid) from public, anon;
revoke all on function public.cancel_appointment_with_policy(uuid, text, text) from public, anon;
revoke all on function public.mark_deposit_paid(uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.mark_deposit_refunded(uuid, integer, text)
  from public, anon, authenticated;
revoke all on function public.deposit_pay_page(text) from public, anon, authenticated;

grant execute on function public.cancellation_quote(uuid) to authenticated, service_role;
grant execute on function public.cancel_appointment_with_policy(uuid, text, text)
  to authenticated, service_role;
grant execute on function public.mark_deposit_paid(uuid, text, text, text) to service_role;
grant execute on function public.mark_deposit_refunded(uuid, integer, text) to service_role;
grant execute on function public.deposit_pay_page(text) to service_role;
