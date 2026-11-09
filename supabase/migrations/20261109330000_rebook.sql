-- Rebook at checkout (docs/PLAN.md §11b, issue #42).
--
-- After payment the app suggests the client's next visit from the service interval (learned from
-- their history, else the service's setting, else a typical one) and books it in one tap. The
-- checkout remembers the rebook (or the skip) so the prompt isn't repeated and the rebook rate can
-- be reported.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

alter table public.services
  add column rebook_interval_days integer
    check (rebook_interval_days between 1 and 365);

comment on column public.services.rebook_interval_days is
  'Typical days until the client should come back for this service. Null = the app''s default for the kind of service; a client''s own history wins over both.';

alter table public.checkouts
  add column rebook_appointment_id uuid,
  add column rebook_declined_at    timestamptz,
  add constraint checkouts_rebook_appointment_fkey foreign key (salon_id, rebook_appointment_id)
    references public.appointments (salon_id, id) on delete set null (rebook_appointment_id);

comment on column public.checkouts.rebook_appointment_id is
  'Next appointment booked from this checkout''s rebook prompt (rebook_from_checkout).';
comment on column public.checkouts.rebook_declined_at is
  'When the stylist skipped the rebook prompt (skip_rebook).';

create unique index checkouts_rebook_appointment_key on public.checkouts (rebook_appointment_id)
  where rebook_appointment_id is not null;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Books the client's next visit from a paid checkout. Segments come from the availability engine,
-- like book_appointment; overlapping busy time raises 23P01. The new appointment goes to the same
-- stylist as the visit being checked out.
create or replace function public.rebook_from_checkout(
  p_checkout_id uuid,
  p_segments    jsonb,
  p_services    jsonb default '[]'::jsonb,
  p_status      public.appointment_status default 'confirmed',
  p_price_cents integer default null
)
returns public.appointments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_checkout public.checkouts;
  v_stylist  uuid;
  v_appt     public.appointments;
begin
  select * into v_checkout from public.checkouts where id = p_checkout_id for update;
  if not found or not private.can_book_for_salon(v_checkout.salon_id) then
    raise exception 'Checkout not found' using errcode = 'P0002';
  end if;
  if v_checkout.status <> 'paid' then
    raise exception 'Only paid checkouts can be rebooked' using errcode = '22023';
  end if;
  if v_checkout.client_id is null then
    raise exception 'This checkout has no client to rebook' using errcode = '22023';
  end if;
  if p_status not in ('held', 'confirmed') then
    raise exception 'A rebook is held or confirmed' using errcode = '22023';
  end if;
  if exists (select 1 from public.appointments a
              where a.id = v_checkout.rebook_appointment_id
                and a.status not in ('cancelled', 'no_show')) then
    raise exception 'The next visit is already booked' using errcode = '22023';
  end if;

  select a.stylist_id into v_stylist from public.appointments a
   where a.id = v_checkout.appointment_id;

  v_appt := public.book_appointment(
    v_checkout.salon_id, v_checkout.client_id, p_segments, p_services, p_status, 'owner',
    p_price_cents, null, v_stylist);

  update public.checkouts
     set rebook_appointment_id = v_appt.id, rebook_declined_at = null
   where id = v_checkout.id;

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (v_checkout.salon_id, auth.uid(), 'checkout.rebooked', 'checkout', v_checkout.id::text,
          jsonb_build_object('appointment_id', v_appt.id, 'status', v_appt.status,
                             'starts_at', v_appt.starts_at));
  return v_appt;
end;
$$;

comment on function public.rebook_from_checkout is
  'Books the next visit for a paid checkout''s client (same stylist) and links it to the checkout.';

-- The stylist dismissed the prompt ("not now"). Rebooking later still works.
create or replace function public.skip_rebook(p_checkout_id uuid)
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
  if v_checkout.status <> 'paid' then
    raise exception 'Only paid checkouts can skip the rebook' using errcode = '22023';
  end if;

  update public.checkouts
     set rebook_declined_at = coalesce(rebook_declined_at, now())
   where id = v_checkout.id
  returning * into v_checkout;
  return v_checkout;
end;
$$;

comment on function public.skip_rebook is 'Records that the rebook prompt was skipped for a checkout.';

-- Rebook rate for reports: of the paid checkouts with a client in [p_from, p_to] (salon-local
-- dates, inclusive), how many booked their next visit from checkout. Defaults to the last 30 days.
create or replace function public.rebook_stats(
  p_salon_id uuid,
  p_from     date default null,
  p_to       date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz      text;
  v_to      date;
  v_from    date;
  v_total   integer;
  v_rebook  integer;
  v_decline integer;
begin
  if not private.is_salon_member(p_salon_id) then
    raise exception 'Not a member of this salon' using errcode = '42501';
  end if;
  select s.timezone into v_tz from public.salons s where s.id = p_salon_id;
  v_to   := coalesce(p_to, (now() at time zone v_tz)::date);
  v_from := coalesce(p_from, v_to - 29);
  if v_from > v_to then
    raise exception 'p_from must not be after p_to' using errcode = '22023';
  end if;

  select count(*)::integer,
         count(*) filter (where a.id is not null)::integer,
         count(*) filter (where a.id is null and c.rebook_declined_at is not null)::integer
    into v_total, v_rebook, v_decline
    from public.checkouts c
    left join public.appointments a
      on a.id = c.rebook_appointment_id and a.status not in ('cancelled', 'no_show')
   where c.salon_id = p_salon_id
     and c.status = 'paid'
     and c.client_id is not null
     and c.paid_at >= (v_from::timestamp at time zone v_tz)
     and c.paid_at <  ((v_to + 1)::timestamp at time zone v_tz);

  return jsonb_build_object(
    'from', v_from, 'to', v_to,
    'checkouts', v_total, 'rebooked', v_rebook, 'declined', v_decline,
    'rate', case when v_total > 0 then round(v_rebook::numeric / v_total, 4) end);
end;
$$;

comment on function public.rebook_stats is
  'Paid checkouts with a client, rebooked and declined counts and the rebook rate for a date range.';

revoke all on function public.rebook_from_checkout(uuid, jsonb, jsonb, public.appointment_status, integer)
  from public, anon;
revoke all on function public.skip_rebook(uuid) from public, anon;
revoke all on function public.rebook_stats(uuid, date, date) from public, anon;
grant execute on function public.rebook_from_checkout(uuid, jsonb, jsonb, public.appointment_status, integer)
  to authenticated, service_role;
grant execute on function public.skip_rebook(uuid) to authenticated, service_role;
grant execute on function public.rebook_stats(uuid, date, date) to authenticated, service_role;
