-- Checkout (docs/PLAN.md §9), issue #11: services + add-ons + retail + tip, minus deposits already
-- paid, settled by card (Stripe Terminal: Tap to Pay on iPhone or a simulated reader in test mode),
-- cash or other. Paying marks the appointment completed. Receipts are a public link; refunds and
-- the daily payout summary build on public.payments.
--
-- * public.checkouts: one per appointment (plus canceled drafts). Members read; the app writes
--   through start_checkout / update_checkout / pay_checkout_offline. Card payments are completed
--   by the `checkout` / `stripe-webhook` Edge Functions (service role) via complete_checkout.
-- * public.checkout_items: line items. Amounts are in the smallest currency unit.
-- * public.get_receipt(token): the public receipt page (anon) reads a paid checkout by its
--   unguessable receipt token.
-- * Daily payout summary: an end-of-day push to salon owners (notification kind payout_summary)
--   and public.payout_summary() for the Settings → Payments screen.

-- ---------------------------------------------------------------------------
-- Stripe Terminal location per salon (created lazily by the `checkout` Edge Function)
-- ---------------------------------------------------------------------------

alter table public.stripe_accounts
  add column terminal_location_id text check (terminal_location_id ~ '^tml_[A-Za-z0-9]+$');

comment on column public.stripe_accounts.terminal_location_id is
  'Stripe Terminal Location (platform account) that Tap to Pay / simulated readers connect to.';

-- ---------------------------------------------------------------------------
-- checkouts + checkout_items
-- ---------------------------------------------------------------------------

create type public.checkout_status as enum ('open', 'paid', 'canceled');
create type public.checkout_method as enum ('card', 'cash', 'other');
create type public.checkout_item_kind as enum ('service', 'addon', 'retail', 'custom');

create table public.checkouts (
  id                       uuid primary key default gen_random_uuid(),
  salon_id                 uuid not null references public.salons (id) on delete cascade,
  appointment_id           uuid,
  client_id                uuid,
  status                   public.checkout_status not null default 'open',
  currency                 text not null check (currency ~ '^[a-z]{3}$'),
  subtotal_cents           integer not null default 0 check (subtotal_cents between 0 and 100000000),
  tip_cents                integer not null default 0 check (tip_cents between 0 and 10000000),
  -- Deposits / prepayments already captured for the appointment, applied against this total.
  deposit_cents            integer not null default 0 check (deposit_cents >= 0),
  amount_due_cents         integer not null default 0 check (amount_due_cents >= 0),
  method                   public.checkout_method,
  stripe_payment_intent_id text unique check (stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'),
  card_brand               text check (card_brand is null or char_length(card_brand) <= 40),
  card_last4               text check (card_last4 ~ '^[0-9]{4}$'),
  -- Unguessable token for the public receipt link (/receipt/<token>).
  receipt_token            text not null unique
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
    check (receipt_token ~ '^[0-9a-f]{64}$'),
  paid_at                  timestamptz,
  created_by               uuid default auth.uid() references auth.users (id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint checkouts_salon_id_id_key unique (salon_id, id),
  constraint checkouts_appointment_fkey foreign key (salon_id, appointment_id)
    references public.appointments (salon_id, id) on delete set null (appointment_id),
  constraint checkouts_client_fkey foreign key (salon_id, client_id)
    references public.clients (salon_id, id) on delete set null (client_id),
  constraint checkouts_amounts check (
    amount_due_cents = greatest(subtotal_cents + tip_cents - deposit_cents, 0)),
  constraint checkouts_paid_has_method check (
    (status = 'paid') = (method is not null and paid_at is not null))
);

comment on table public.checkouts is
  'Checkout for an appointment. Write through start_checkout / update_checkout / pay_checkout_offline; card payments are completed by the checkout Edge Function.';
comment on column public.checkouts.amount_due_cents is
  'subtotal + tip − deposit (never negative): what is charged at checkout.';

-- One live (open or paid) checkout per appointment; canceled drafts don't count.
create unique index checkouts_appointment_live_key on public.checkouts (appointment_id)
  where appointment_id is not null and status <> 'canceled';
create index checkouts_salon_paid_idx on public.checkouts (salon_id, paid_at desc)
  where status = 'paid';

create trigger checkouts_set_updated_at
  before update on public.checkouts
  for each row execute function private.set_updated_at();

create table public.checkout_items (
  id                uuid primary key default gen_random_uuid(),
  salon_id          uuid not null references public.salons (id) on delete cascade,
  checkout_id       uuid not null,
  position          integer not null check (position >= 0),
  kind              public.checkout_item_kind not null,
  name              text not null check (char_length(btrim(name)) between 1 and 80),
  quantity          integer not null default 1 check (quantity between 1 and 99),
  unit_amount_cents integer not null check (unit_amount_cents between 0 and 10000000),
  amount_cents      integer generated always as (quantity * unit_amount_cents) stored,
  -- Catalog row the line came from (service / add-on), for reporting; no FK so edits keep history.
  source_id         uuid,
  constraint checkout_items_checkout_fkey foreign key (salon_id, checkout_id)
    references public.checkouts (salon_id, id) on delete cascade,
  constraint checkout_items_position_key unique (checkout_id, position)
);

comment on table public.checkout_items is
  'Line items of a checkout. Retail lines are free-form until inventory (#17) lands.';

alter table public.checkouts      enable row level security;
alter table public.checkout_items enable row level security;

revoke all on public.checkouts, public.checkout_items from anon;
revoke insert, update, delete, truncate on public.checkouts, public.checkout_items from authenticated;

create policy "members can read checkouts" on public.checkouts
  for select to authenticated using (private.is_salon_member(salon_id));

create policy "members can read checkout items" on public.checkout_items
  for select to authenticated using (private.is_salon_member(salon_id));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Net amount already captured for an appointment outside any checkout (deposits, prepayments).
create or replace function private.appointment_deposit_cents(p_salon_id uuid, p_appointment_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(p.amount_cents - p.amount_refunded_cents), 0)::integer
    from public.payments p
   where p.salon_id = p_salon_id
     and p.appointment_id = p_appointment_id
     and p.status in ('succeeded', 'partially_refunded')
     and not exists (select 1 from public.checkouts c
                      where c.stripe_payment_intent_id = p.stripe_payment_intent_id);
$$;

-- Recomputes a checkout's totals from its items, tip and the appointment's deposits.
create or replace function private.recompute_checkout(p_checkout_id uuid, p_tip_cents integer default null)
returns public.checkouts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_checkout public.checkouts;
  v_subtotal integer;
  v_deposit  integer := 0;
  v_tip      integer;
begin
  select * into v_checkout from public.checkouts where id = p_checkout_id;
  v_tip := coalesce(p_tip_cents, v_checkout.tip_cents);
  select coalesce(sum(i.amount_cents), 0)::integer into v_subtotal
    from public.checkout_items i where i.checkout_id = p_checkout_id;
  if v_checkout.appointment_id is not null then
    v_deposit := least(private.appointment_deposit_cents(v_checkout.salon_id,
                                                         v_checkout.appointment_id),
                       v_subtotal + v_tip);
  end if;
  update public.checkouts
     set subtotal_cents = v_subtotal,
         tip_cents = v_tip,
         deposit_cents = v_deposit,
         amount_due_cents = greatest(v_subtotal + v_tip - v_deposit, 0)
   where id = p_checkout_id
  returning * into v_checkout;
  return v_checkout;
end;
$$;

-- Marks a checkout paid and its appointment completed. Idempotent: paying twice is a no-op that
-- only fills in missing card details.
create or replace function private.complete_checkout(
  p_checkout_id       uuid,
  p_method            public.checkout_method,
  p_payment_intent_id text default null,
  p_card_brand        text default null,
  p_card_last4        text default null
)
returns public.checkouts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_checkout public.checkouts;
begin
  select * into v_checkout from public.checkouts where id = p_checkout_id for update;
  if not found then
    raise exception 'Checkout not found' using errcode = 'P0002';
  end if;

  if v_checkout.status = 'paid' then
    update public.checkouts
       set card_brand = coalesce(card_brand, p_card_brand),
           card_last4 = coalesce(card_last4, p_card_last4)
     where id = p_checkout_id
       and method = 'card'
       and stripe_payment_intent_id is not distinct from p_payment_intent_id
    returning * into v_checkout;
    if not found then
      select * into v_checkout from public.checkouts where id = p_checkout_id;
    end if;
    return v_checkout;
  end if;
  if v_checkout.status = 'canceled' and p_method <> 'card' then
    raise exception 'This checkout was canceled' using errcode = '22023';
  end if;

  update public.checkouts
     set status = 'paid',
         method = p_method,
         paid_at = now(),
         stripe_payment_intent_id = coalesce(p_payment_intent_id, stripe_payment_intent_id),
         card_brand = p_card_brand,
         card_last4 = p_card_last4
   where id = p_checkout_id
  returning * into v_checkout;

  -- A card payment can land after the stylist moved the appointment on; only close it out
  -- from confirmed (completed already is fine; cancelled / no-show stay as they are).
  update public.appointments a
     set status = 'completed'
   where a.id = v_checkout.appointment_id
     and a.salon_id = v_checkout.salon_id
     and a.status = 'confirmed';

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (v_checkout.salon_id, auth.uid(), 'checkout.paid', 'checkout', v_checkout.id::text,
          jsonb_build_object('appointment_id', v_checkout.appointment_id,
                             'method', p_method,
                             'amount_due_cents', v_checkout.amount_due_cents,
                             'tip_cents', v_checkout.tip_cents,
                             'payment_intent', p_payment_intent_id));
  return v_checkout;
end;
$$;

revoke all on function private.appointment_deposit_cents(uuid, uuid) from public;
revoke all on function private.recompute_checkout(uuid, integer) from public;
revoke all on function private.complete_checkout(uuid, public.checkout_method, text, text, text)
  from public;

-- ---------------------------------------------------------------------------
-- App RPCs
-- ---------------------------------------------------------------------------

-- Opens (or returns) the checkout for an appointment. A new checkout is drafted from the booked
-- services and add-ons at today's catalog prices; the stylist can edit the lines before charging.
create or replace function public.start_checkout(p_appointment_id uuid)
returns public.checkouts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appt     public.appointments;
  v_checkout public.checkouts;
  v_currency text;
begin
  select * into v_appt from public.appointments where id = p_appointment_id for update;
  if not found or not private.can_book_for_salon(v_appt.salon_id) then
    raise exception 'Appointment not found' using errcode = 'P0002';
  end if;

  select * into v_checkout from public.checkouts c
   where c.appointment_id = v_appt.id and c.status <> 'canceled';
  if found then
    if v_checkout.status = 'open' then
      v_checkout := private.recompute_checkout(v_checkout.id);
    end if;
    return v_checkout;
  end if;

  if v_appt.status not in ('confirmed', 'completed') then
    raise exception 'Only confirmed or completed appointments can be checked out'
      using errcode = '22023';
  end if;

  select coalesce(lower(st.currency), 'usd') into v_currency
    from public.salons s left join public.settings st on st.salon_id = s.id
   where s.id = v_appt.salon_id;

  insert into public.checkouts (salon_id, appointment_id, client_id, currency)
  values (v_appt.salon_id, v_appt.id, v_appt.client_id, coalesce(v_currency, 'usd'))
  returning * into v_checkout;

  -- Services in booked order, each followed by its add-ons.
  insert into public.checkout_items
    (salon_id, checkout_id, position, kind, name, unit_amount_cents, source_id)
  select v_appt.salon_id, v_checkout.id,
         (row_number() over (order by l.svc_ord, l.addon_ord nulls first) - 1)::integer,
         l.kind, l.name, l.price, l.source_id
    from (
      select e.ord as svc_ord, null::bigint as addon_ord, 'service'::public.checkout_item_kind as kind,
             left(btrim(concat_ws(' · ', coalesce(sv.name, e.svc ->> 'name'),
                                  nullif(btrim(e.svc ->> 'variantName'), ''))), 80) as name,
             coalesce(sv.price_cents, 0) as price,
             sv.id as source_id
        from jsonb_array_elements(v_appt.services) with ordinality as e(svc, ord)
        left join public.services sv
          on sv.salon_id = v_appt.salon_id
         and sv.id::text = e.svc ->> 'serviceId'
       where coalesce(sv.name, e.svc ->> 'name') is not null
      union all
      select e.ord, a.ord, 'addon', left(btrim(ad.name), 80), coalesce(ad.price_cents, 0), ad.id
        from jsonb_array_elements(v_appt.services) with ordinality as e(svc, ord)
        cross join lateral jsonb_array_elements_text(
          case when jsonb_typeof(e.svc -> 'addonIds') = 'array' then e.svc -> 'addonIds'
               else '[]'::jsonb end) with ordinality as a(addon_id, ord)
        join public.service_addons ad
          on ad.salon_id = v_appt.salon_id and ad.id::text = a.addon_id
    ) l
   where char_length(btrim(l.name)) > 0;

  -- No catalog prices but a booked total: fall back to one line at the booked price.
  if v_appt.price_cents is not null and v_appt.price_cents > 0 and not exists (
    select 1 from public.checkout_items i
     where i.checkout_id = v_checkout.id and i.unit_amount_cents > 0
  ) then
    delete from public.checkout_items where checkout_id = v_checkout.id;
    insert into public.checkout_items
      (salon_id, checkout_id, position, kind, name, unit_amount_cents)
    values (v_appt.salon_id, v_checkout.id, 0, 'service',
            coalesce(left(private.appointment_services_label(v_appt.services), 80), 'Services'),
            v_appt.price_cents);
  end if;

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (v_appt.salon_id, auth.uid(), 'checkout.started', 'checkout', v_checkout.id::text,
          jsonb_build_object('appointment_id', v_appt.id));
  return private.recompute_checkout(v_checkout.id);
end;
$$;

comment on function public.start_checkout is
  'Returns the live checkout for an appointment, creating it from the booked services if needed.';

-- Replaces an open checkout's lines and tip. p_items: [{ kind, name, quantity?, unitAmountCents,
-- sourceId? }].
create or replace function public.update_checkout(
  p_checkout_id uuid,
  p_items       jsonb,
  p_tip_cents   integer default 0
)
returns public.checkouts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_checkout public.checkouts;
begin
  select * into v_checkout from public.checkouts where id = p_checkout_id for update;
  if not found or not private.can_book_for_salon(v_checkout.salon_id) then
    raise exception 'Checkout not found' using errcode = 'P0002';
  end if;
  if v_checkout.status <> 'open' then
    raise exception 'This checkout is already %', v_checkout.status using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 50 then
    raise exception 'Items must be an array of at most 50 lines' using errcode = '22023';
  end if;
  if coalesce(p_tip_cents, 0) not between 0 and 10000000 then
    raise exception 'Tip must be between 0 and 100,000' using errcode = '22023';
  end if;

  delete from public.checkout_items where checkout_id = p_checkout_id;
  begin
    insert into public.checkout_items
      (salon_id, checkout_id, position, kind, name, quantity, unit_amount_cents, source_id)
    select v_checkout.salon_id, p_checkout_id, (e.ord - 1)::integer,
           (e.item ->> 'kind')::public.checkout_item_kind,
           btrim(e.item ->> 'name'),
           coalesce((e.item ->> 'quantity')::integer, 1),
           (e.item ->> 'unitAmountCents')::integer,
           nullif(e.item ->> 'sourceId', '')::uuid
      from jsonb_array_elements(p_items) with ordinality as e(item, ord);
  exception
    when check_violation or not_null_violation or invalid_text_representation
         or numeric_value_out_of_range then
      raise exception 'Invalid checkout line: %', sqlerrm using errcode = '22023';
  end;

  return private.recompute_checkout(p_checkout_id, coalesce(p_tip_cents, 0));
end;
$$;

-- Settles an open checkout with cash or another off-app method (also used when deposits cover
-- the whole amount).
create or replace function public.pay_checkout_offline(
  p_checkout_id uuid,
  p_method      public.checkout_method
)
returns public.checkouts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_checkout public.checkouts;
begin
  select * into v_checkout from public.checkouts where id = p_checkout_id for update;
  if not found or not private.can_book_for_salon(v_checkout.salon_id) then
    raise exception 'Checkout not found' using errcode = 'P0002';
  end if;
  if p_method is null or p_method = 'card' then
    raise exception 'Card payments go through the checkout Edge Function' using errcode = '22023';
  end if;
  if v_checkout.status = 'paid' then
    return v_checkout;
  end if;
  if v_checkout.status <> 'open' then
    raise exception 'This checkout was canceled' using errcode = '22023';
  end if;
  -- Refresh deposits so a payment captured meanwhile is not charged twice.
  perform private.recompute_checkout(p_checkout_id);
  return private.complete_checkout(p_checkout_id, p_method);
end;
$$;

-- Card payments: called by the checkout / stripe-webhook Edge Functions after Stripe reports the
-- PaymentIntent succeeded.
create or replace function public.complete_card_checkout(
  p_checkout_id       uuid,
  p_payment_intent_id text,
  p_card_brand        text default null,
  p_card_last4        text default null
)
returns public.checkouts
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.complete_checkout(p_checkout_id, 'card', p_payment_intent_id,
                                   nullif(left(p_card_brand, 40), ''),
                                   case when p_card_last4 ~ '^[0-9]{4}$' then p_card_last4 end);
end;
$$;

-- The public receipt page. Returns null unless the token belongs to a paid checkout.
create or replace function public.get_receipt(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'salonName', s.name,
           'timezone', s.timezone,
           'clientName', split_part(btrim(cl.name), ' ', 1),
           'appointmentStartsAt', a.starts_at,
           'paidAt', c.paid_at,
           'currency', c.currency,
           'subtotalCents', c.subtotal_cents,
           'tipCents', c.tip_cents,
           'depositCents', c.deposit_cents,
           'amountDueCents', c.amount_due_cents,
           'method', c.method,
           'cardBrand', c.card_brand,
           'cardLast4', c.card_last4,
           'refundedCents', coalesce(p.amount_refunded_cents, 0),
           'items', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'kind', i.kind, 'name', i.name, 'quantity', i.quantity,
                      'unitAmountCents', i.unit_amount_cents, 'amountCents', i.amount_cents)
                      order by i.position)
               from public.checkout_items i where i.checkout_id = c.id), '[]'::jsonb))
    from public.checkouts c
    join public.salons s on s.id = c.salon_id
    left join public.appointments a on a.id = c.appointment_id
    left join public.clients cl on cl.id = c.client_id
    left join public.payments p on p.stripe_payment_intent_id = c.stripe_payment_intent_id
   where c.receipt_token = p_token
     and c.status = 'paid'
     and p_token ~ '^[0-9a-f]{64}$';
$$;

-- What a salon took on a day (salon timezone): for Settings → Payments and the evening push.
create or replace function private.payout_summary(p_salon_id uuid, p_day date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select (p_day::timestamp at time zone s.timezone) as from_at,
           ((p_day + 1)::timestamp at time zone s.timezone) as to_at,
           coalesce(lower(st.currency), 'usd') as currency
      from public.salons s left join public.settings st on st.salon_id = s.id
     where s.id = p_salon_id
  ), paid as (
    select c.* from public.checkouts c, bounds b
     where c.salon_id = p_salon_id and c.status = 'paid'
       and c.paid_at >= b.from_at and c.paid_at < b.to_at
  ), refunds as (
    select coalesce(sum(p.amount_refunded_cents), 0)::bigint as cents
      from public.payments p, bounds b
     where p.salon_id = p_salon_id and p.amount_refunded_cents > 0
       and p.updated_at >= b.from_at and p.updated_at < b.to_at
  )
  select jsonb_build_object(
           'day', p_day,
           'currency', coalesce((select max(currency) from paid), (select currency from bounds)),
           'checkouts', (select count(*) from paid),
           'totalCents', (select coalesce(sum(amount_due_cents), 0) from paid),
           'cardCents', (select coalesce(sum(amount_due_cents), 0) from paid where method = 'card'),
           'cashCents', (select coalesce(sum(amount_due_cents), 0) from paid where method = 'cash'),
           'otherCents', (select coalesce(sum(amount_due_cents), 0) from paid where method = 'other'),
           'tipCents', (select coalesce(sum(tip_cents), 0) from paid),
           'refundedCents', (select cents from refunds));
$$;

create or replace function public.payout_summary(p_salon_id uuid, p_day date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_day date := p_day;
begin
  if not private.is_salon_member(p_salon_id) then
    raise exception 'Not a member of this salon' using errcode = '42501';
  end if;
  if v_day is null then
    select (now() at time zone s.timezone)::date into v_day
      from public.salons s where s.id = p_salon_id;
  end if;
  return private.payout_summary(p_salon_id, v_day);
end;
$$;

revoke all on function public.start_checkout(uuid) from public, anon;
revoke all on function public.update_checkout(uuid, jsonb, integer) from public, anon;
revoke all on function public.pay_checkout_offline(uuid, public.checkout_method) from public, anon;
revoke all on function public.complete_card_checkout(uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.get_receipt(text) from public;
revoke all on function private.payout_summary(uuid, date) from public;
revoke all on function public.payout_summary(uuid, date) from public, anon;

grant execute on function public.start_checkout(uuid) to authenticated, service_role;
grant execute on function public.update_checkout(uuid, jsonb, integer) to authenticated, service_role;
grant execute on function public.pay_checkout_offline(uuid, public.checkout_method)
  to authenticated, service_role;
grant execute on function public.complete_card_checkout(uuid, text, text, text) to service_role;
grant execute on function public.get_receipt(text) to anon, authenticated, service_role;
grant execute on function public.payout_summary(uuid, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Daily payout summary push (owners, 8pm salon time)
-- ---------------------------------------------------------------------------

alter type public.notification_kind add value if not exists 'payout_summary';

alter table public.settings
  add column payout_summary_enabled boolean not null default true;

comment on column public.settings.payout_summary_enabled is
  'Push owners the day''s takings (card, cash, tips) at 8pm salon time.';

-- From 20:00 until midnight so a missed tick still sends it. Days with no checkouts are skipped.
-- plpgsql (not sql) so the new enum value is only resolved at run time.
create or replace function private.enqueue_payout_summaries(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  r       record;
  v_sum   jsonb;
begin
  for r in
    select s.id as salon_id, (p_now at time zone s.timezone)::date as day, m.user_id
      from public.salons s
      join public.settings st on st.salon_id = s.id
      join public.salon_members m on m.salon_id = s.id and m.role = 'owner'
     where st.payout_summary_enabled
       and (p_now at time zone s.timezone)::time >= time '20:00'
  loop
    if exists (select 1 from public.notifications_outbox o
                where o.dedupe_key = 'payout_summary:' || r.salon_id || ':' || r.user_id || ':' || r.day) then
      continue;
    end if;
    v_sum := private.payout_summary(r.salon_id, r.day);
    if (v_sum ->> 'checkouts')::integer = 0 then
      continue;
    end if;
    if private.enqueue_notification(
         r.salon_id, r.user_id, 'payout_summary', null,
         'Today: ' || private.format_money((v_sum ->> 'totalCents')::bigint, v_sum ->> 'currency')
           || ' from ' || (v_sum ->> 'checkouts')
           || case when (v_sum ->> 'checkouts')::integer = 1 then ' checkout' else ' checkouts' end,
         concat_ws(' · ',
           'Card ' || private.format_money((v_sum ->> 'cardCents')::bigint, v_sum ->> 'currency'),
           'Cash ' || private.format_money((v_sum ->> 'cashCents')::bigint, v_sum ->> 'currency'),
           'Tips ' || private.format_money((v_sum ->> 'tipCents')::bigint, v_sum ->> 'currency'),
           case when (v_sum ->> 'refundedCents')::bigint > 0 then
             'Refunds ' || private.format_money((v_sum ->> 'refundedCents')::bigint,
                                                v_sum ->> 'currency') end),
         null,
         jsonb_build_object('type', 'payout_summary', 'salonId', r.salon_id, 'date', r.day),
         'payout_summary:' || r.salon_id || ':' || r.user_id || ':' || r.day) is not null then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

-- "$1,234.50" for usd; other currencies as "1,234.50 EUR".
create or replace function private.format_money(p_cents bigint, p_currency text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case lower(p_currency)
           when 'usd' then '$' || btrim(to_char(p_cents / 100.0, 'FM999,999,990.00'))
           else btrim(to_char(p_cents / 100.0, 'FM999,999,990.00')) || ' ' || upper(p_currency)
         end;
$$;

create or replace function private.payout_summary_tick(p_now timestamptz default now())
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.enqueue_payout_summaries(p_now) > 0 then
    perform private.dispatch_notifications();
  end if;
end;
$$;

revoke all on function private.enqueue_payout_summaries(timestamptz) from public;
revoke all on function private.format_money(bigint, text) from public;
revoke all on function private.payout_summary_tick(timestamptz) from public;

select cron.schedule('payout-summary-tick', '*/15 * * * *', 'select private.payout_summary_tick()');
