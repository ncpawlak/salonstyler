-- Public booking page + client concierge (#14, docs/PLAN.md §6).
--
--   browser ──POST /functions/v1/public-booking──▶ public-booking Edge Function (service role)
--     • public_booking_page: slug → salon branding + booking-page settings (no client data)
--     • hit_rate_limit: fixed-window counters per IP / phone / email / user (hashed keys)
--     • book_public_appointment: the verified client's own profile (auto-created or linked by
--       verified email) and a confirmed (Auto) or requested (Draft / Tentative) appointment on the
--       owner's calendar, after the engine re-checked the slot
--     • public_client_bookings: the verified client's own upcoming bookings, nothing else
--
-- Every function here is service-role only: anon and authenticated callers never reach salon data
-- directly. The Edge Function decides *what* is bookable (engine + rules); Postgres enforces
-- ownership, the per-client cap and calendar overlaps.

-- ---------------------------------------------------------------------------
-- Settings: the booking page
-- ---------------------------------------------------------------------------

alter table public.settings
  add column public_booking_enabled boolean not null default true,
  add column booking_page_intro text
    check (booking_page_intro is null or char_length(booking_page_intro) <= 500),
  add column booking_page_faq text
    check (booking_page_faq is null or char_length(booking_page_faq) <= 4000);

comment on column public.settings.public_booking_enabled is
  'Whether chairside.app/b/{slug} accepts bookings.';
comment on column public.settings.booking_page_intro is
  'Short welcome text shown at the top of the public booking page.';
comment on column public.settings.booking_page_faq is
  'Policies and FAQ (parking, cancellations, prep). The client concierge answers only from this.';

-- ---------------------------------------------------------------------------
-- Clients: link a profile to the client's own (email-verified) account
-- ---------------------------------------------------------------------------

alter table public.clients
  add column user_id uuid references auth.users (id) on delete set null;

comment on column public.clients.user_id is
  'The client''s own account (public booking page). Linked by verified email only, never by phone.';

create unique index clients_salon_user_key on public.clients (salon_id, user_id)
  where user_id is not null;

-- ---------------------------------------------------------------------------
-- Rate limiting (fixed windows). Keys are hashed so IPs, phones and emails are not stored.
-- ---------------------------------------------------------------------------

create table private.rate_limits (
  key_hash          text primary key,
  window_started_at timestamptz not null default now(),
  window_count      integer not null default 0
);

comment on table private.rate_limits is
  'Fixed-window request counters for public endpoints. Keyed by sha256 of e.g. "ip:book:1.2.3.4".';

-- Counts one hit against `p_key` and returns true while the window is still under `p_limit`.
create or replace function public.hit_rate_limit(
  p_key            text,
  p_limit          integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only the booking service can count requests' using errcode = '42501';
  end if;
  if p_key is null or btrim(p_key) = '' or p_limit < 1 or p_window_seconds < 1 then
    raise exception 'Invalid rate limit' using errcode = '22023';
  end if;

  insert into private.rate_limits as r (key_hash, window_started_at, window_count)
  values (encode(pg_catalog.sha256(convert_to(p_key, 'UTF8')), 'hex'), now(), 1)
  on conflict (key_hash) do update
     set window_started_at = case
           when r.window_started_at <= now() - make_interval(secs => p_window_seconds)
           then now() else r.window_started_at end,
         window_count = case
           when r.window_started_at <= now() - make_interval(secs => p_window_seconds)
           then 1 else r.window_count + 1 end
  returning window_count into v_count;

  return v_count <= p_limit;
end;
$$;

select cron.schedule(
  'rate-limits-purge', '17 * * * *',
  $$delete from private.rate_limits where window_started_at < now() - interval '2 days'$$);

-- ---------------------------------------------------------------------------
-- Page
-- ---------------------------------------------------------------------------

-- What the public page may show about a salon: branding and booking-page text, nothing else.
create or replace function public.public_booking_page(p_slug text)
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
    raise exception 'Only the booking service can read booking pages' using errcode = '42501';
  end if;

  select jsonb_build_object(
           'salonId', s.id,
           'name', s.name,
           'slug', s.slug,
           'timezone', s.timezone,
           'currency', st.currency,
           'enabled', st.public_booking_enabled,
           'intro', st.booking_page_intro,
           'faq', st.booking_page_faq,
           'autoConfirm', st.autonomy = 'auto')
    into v_page
    from public.salons s
    join public.settings st on st.salon_id = s.id
   where s.slug = lower(btrim(p_slug));
  return v_page;
end;
$$;

-- ---------------------------------------------------------------------------
-- Booking
-- ---------------------------------------------------------------------------

-- p_user_id is the client's verified account (the Edge Function checked the JWT). The email is
-- read from auth.users, never from the request.
-- p_booking = {
--   name, phone,                               (used only when a new profile is created)
--   segments, services, priceCents, notes,     (laid out by the engine; re-checked server-side)
--   requiresApproval                           (the slot touches Tentative hours, or the service
--                                               needs a consultation)
-- }
-- Returns { ok: true, appointmentId, status, startsAt, endsAt, clientId, clientCreated,
-- clientLinked } or { ok: false, reason: 'disabled' | 'limit' | 'conflict' }.
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
  v_appt     public.appointments;
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

  begin
    v_appt := public.book_appointment(
      p_salon_id, v_client, p_booking -> 'segments',
      case when jsonb_typeof(p_booking -> 'services') = 'array'
           then p_booking -> 'services' else '[]'::jsonb end,
      v_status, 'public', (p_booking ->> 'priceCents')::integer,
      left(p_booking ->> 'notes', 500), v_stylist);
  exception when exclusion_violation then
    return jsonb_build_object('ok', false, 'reason', 'conflict', 'clientId', v_client);
  end;

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (p_salon_id, null, 'public_booking.booked', 'appointment', v_appt.id::text,
          jsonb_build_object('status', v_appt.status, 'client_id', v_client,
                             'client_created', v_created, 'client_linked', v_linked,
                             'client_user_id', p_user_id));

  return jsonb_build_object(
    'ok', true, 'appointmentId', v_appt.id, 'status', v_appt.status,
    'startsAt', v_appt.starts_at, 'endsAt', v_appt.ends_at,
    'clientId', v_client, 'clientCreated', v_created, 'clientLinked', v_linked);
end;
$$;

-- The verified client's own upcoming bookings at this salon (for the concierge / page).
create or replace function public.public_client_bookings(p_salon_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only the booking service can list bookings' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'status', a.status, 'startsAt', a.starts_at, 'endsAt', a.ends_at,
             'services', private.appointment_services_label(a.services))
             order by a.starts_at)
      from public.appointments a
      join public.clients c on c.id = a.client_id and c.salon_id = a.salon_id
     where a.salon_id = p_salon_id
       and c.user_id = p_user_id
       and p_user_id is not null
       and a.status in ('held', 'requested', 'confirmed')
       and a.ends_at > now()), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Push: "New booking" when a public booking is confirmed straight away. Requests already push
-- through private.enqueue_appointment_notifications (Approve / Decline).
-- ---------------------------------------------------------------------------

alter type public.notification_kind add value if not exists 'public_booking';

create or replace function private.enqueue_public_booking_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz   text;
  v_what text;
begin
  select s.timezone into v_tz from public.salons s where s.id = new.salon_id;
  v_what := private.appointment_services_label(new.services);
  perform private.enqueue_notification(
    new.salon_id, new.stylist_id, 'public_booking', new.id,
    'New booking from ' || private.appointment_client_name(new.client_id),
    private.format_local_datetime(new.starts_at, v_tz) || coalesce(' · ' || v_what, '')
      || ' · booked online',
    null,
    jsonb_build_object('type', 'public_booking', 'salonId', new.salon_id, 'appointmentId', new.id),
    'public_booking:' || new.id);
  return null;
end;
$$;

create trigger appointments_enqueue_public_booking
  after insert on public.appointments
  for each row
  when (new.source = 'public' and new.status = 'confirmed')
  execute function private.enqueue_public_booking_notification();

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on table private.rate_limits from public, anon, authenticated;
revoke all on function private.enqueue_public_booking_notification() from public;
revoke all on function public.hit_rate_limit(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.public_booking_page(text) from public, anon, authenticated;
revoke all on function public.book_public_appointment(uuid, uuid, jsonb, integer)
  from public, anon, authenticated;
revoke all on function public.public_client_bookings(uuid, uuid) from public, anon, authenticated;
grant execute on function public.hit_rate_limit(text, integer, integer) to service_role;
grant execute on function public.public_booking_page(text) to service_role;
grant execute on function public.book_public_appointment(uuid, uuid, jsonb, integer)
  to service_role;
grant execute on function public.public_client_bookings(uuid, uuid) to service_role;
