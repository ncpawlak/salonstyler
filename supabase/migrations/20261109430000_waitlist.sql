-- Waitlist auto-fill on cancellation (issue #21).
--
-- Clients join a waitlist for a day (optionally a time window) from the public booking page, or
-- the stylist adds them. When an appointment is cancelled (by the stylist, from the client's
-- manage link, or a lapsed deposit hold), private.waitlist_on_cancel records the freed time as a
-- waitlist opening and pokes the `waitlist` Edge Function. That function runs the scheduling
-- engine (@chairside/core) for each waiting client whose day matches: only clients whose services
-- fit the freed time, inside their window, in Open hours, get an offer. The model never does slot
-- math.
--
-- Offers are drafts by default: the stylist reviews them on the Waitlist screen and sends each
-- one (email, or a text from his phone with the client's /w/<token> link). With "Send offers
-- automatically" on, offers go straight out by email. The first client to accept gets the slot
-- (accept_waitlist_offer locks the opening and books through book_appointment, so the no-overlap
-- constraint has the last word); everyone else's offer becomes "taken".
--
-- This adds its own trigger on appointments. It does not touch private.client_change_policy or
-- private.on_client_change (the deposits policy hook).
--
-- Delivery reuses the notifier's Vault secrets: `notifier_secret`, and `waitlist_url` (optional;
-- defaults to `notifier_url` with /notifier replaced by /waitlist). See supabase/docs/waitlist.md.

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

alter table public.settings
  add column waitlist_enabled boolean not null default true,
  add column waitlist_auto_offer boolean not null default false,
  add column waitlist_offer_minutes integer not null default 120
    check (waitlist_offer_minutes between 15 and 1440);

comment on column public.settings.waitlist_enabled is
  'Clients can join the waitlist from the booking page, and cancellations are matched against it.';
comment on column public.settings.waitlist_auto_offer is
  'Opt-in: email offers to matching waitlist clients without the stylist approving each one.';
comment on column public.settings.waitlist_offer_minutes is
  'How long a sent offer stays open before it expires and the next clients can be offered.';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create type public.waitlist_entry_status as enum ('waiting', 'offered', 'booked', 'cancelled', 'expired');
create type public.waitlist_offer_status as enum ('draft', 'sent', 'accepted', 'taken', 'expired', 'withdrawn');

create table public.waitlist_entries (
  id             uuid primary key default gen_random_uuid(),
  salon_id       uuid not null references public.salons (id) on delete cascade,
  client_id      uuid not null references public.clients (id) on delete cascade,
  -- [{ serviceId, variantId? }] as picked; the engine re-resolves them against the menu.
  items          jsonb not null check (jsonb_typeof(items) = 'array'
                                       and jsonb_array_length(items) between 1 and 5),
  services_label text not null check (char_length(services_label) between 1 and 200),
  day            date not null,
  window_start   time,
  window_end     time,
  status         public.waitlist_entry_status not null default 'waiting',
  token          text not null unique
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
    check (token ~ '^[0-9a-f]{64}$'),
  source         text not null default 'owner' check (source in ('owner', 'public')),
  notes          text check (notes is null or char_length(notes) <= 500),
  appointment_id uuid references public.appointments (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check ((window_start is null) = (window_end is null)),
  check (window_start is null or window_start < window_end)
);

comment on table public.waitlist_entries is
  'Clients waiting for a day (and optional window) to open up. token unlocks /w/<token>.';

create index waitlist_entries_salon_day_idx on public.waitlist_entries (salon_id, day)
  where status in ('waiting', 'offered');
-- One live entry per client per day; joining again updates it.
create unique index waitlist_entries_client_day_key on public.waitlist_entries (salon_id, client_id, day)
  where status in ('waiting', 'offered');

create trigger waitlist_entries_set_updated_at
  before update on public.waitlist_entries
  for each row execute function private.set_updated_at();

create table public.waitlist_openings (
  id             uuid primary key default gen_random_uuid(),
  salon_id       uuid not null references public.salons (id) on delete cascade,
  appointment_id uuid not null unique references public.appointments (id) on delete cascade,
  stylist_id     uuid,
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  day            date not null,
  -- pending: to be matched · offered: offers drafted/sent · filled: someone accepted ·
  -- closed: nobody fits, or it's in the past
  status         text not null default 'pending'
    check (status in ('pending', 'offered', 'filled', 'closed')),
  processed_at   timestamptz,
  created_at     timestamptz not null default now(),
  check (starts_at < ends_at)
);

comment on table public.waitlist_openings is
  'Time freed by a cancellation, matched against the waitlist by the waitlist Edge Function.';

create index waitlist_openings_pending_idx on public.waitlist_openings (created_at)
  where status = 'pending';

create table public.waitlist_offers (
  id             uuid primary key default gen_random_uuid(),
  salon_id       uuid not null references public.salons (id) on delete cascade,
  opening_id     uuid not null references public.waitlist_openings (id) on delete cascade,
  entry_id       uuid not null references public.waitlist_entries (id) on delete cascade,
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  -- Engine-placed segments and the service snapshot to book with.
  segments       jsonb not null check (jsonb_typeof(segments) = 'array'),
  services       jsonb not null default '[]'::jsonb check (jsonb_typeof(services) = 'array'),
  price_cents    integer check (price_cents is null or price_cents >= 0),
  status         public.waitlist_offer_status not null default 'draft',
  sent_via       text check (sent_via in ('email', 'text')),
  sent_at        timestamptz,
  expires_at     timestamptz,
  accepted_at    timestamptz,
  appointment_id uuid references public.appointments (id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (opening_id, entry_id)
);

comment on table public.waitlist_offers is
  'A freed slot offered to one waitlist client. Drafts wait for the stylist; first accept wins.';

create index waitlist_offers_live_idx on public.waitlist_offers (expires_at) where status = 'sent';
create index waitlist_offers_entry_idx on public.waitlist_offers (entry_id);

alter table public.waitlist_entries  enable row level security;
alter table public.waitlist_openings enable row level security;
alter table public.waitlist_offers   enable row level security;

-- Members read; every change goes through the RPCs below (public clients only via the
-- service-role Edge Function).
create policy "members read their salon's waitlist" on public.waitlist_entries
  for select to authenticated using (private.is_salon_member(salon_id));
create policy "members read their salon's openings" on public.waitlist_openings
  for select to authenticated using (private.is_salon_member(salon_id));
create policy "members read their salon's offers" on public.waitlist_offers
  for select to authenticated using (private.is_salon_member(salon_id));

revoke all on public.waitlist_entries, public.waitlist_openings, public.waitlist_offers from anon;
revoke insert, update, delete, truncate
  on public.waitlist_entries, public.waitlist_openings, public.waitlist_offers from authenticated;
grant select on public.waitlist_entries, public.waitlist_openings, public.waitlist_offers
  to authenticated;

alter type public.notification_kind add value if not exists 'waitlist';

-- ---------------------------------------------------------------------------
-- Poking the waitlist Edge Function
-- ---------------------------------------------------------------------------

create or replace function private.dispatch_waitlist()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
begin
  if not exists (select 1 from public.waitlist_openings o where o.status = 'pending') then
    return null;
  end if;

  select d.decrypted_secret into v_url from vault.decrypted_secrets d where d.name = 'waitlist_url';
  if v_url is null then
    select regexp_replace(d.decrypted_secret, '/notifier/?$', '/waitlist') into v_url
      from vault.decrypted_secrets d where d.name = 'notifier_url';
  end if;
  select d.decrypted_secret into v_secret
    from vault.decrypted_secrets d where d.name = 'notifier_secret';
  if v_url is null or v_secret is null then
    return null;
  end if;

  return net.http_post(
    url := v_url,
    body := '{"action":"process"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notifier-secret', v_secret),
    timeout_milliseconds := 30000);
end;
$$;

-- ---------------------------------------------------------------------------
-- Cancellation → opening
-- ---------------------------------------------------------------------------

-- Records the freed time when a future appointment is cancelled and someone is waiting for that
-- day. Its own trigger: the deposits/self-service policy hooks are left alone.
create or replace function private.waitlist_on_cancel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz  text;
  v_day date;
begin
  if new.status <> 'cancelled' or old.status not in ('held', 'requested', 'confirmed')
     or new.starts_at <= now() then
    return null;
  end if;
  if not exists (select 1 from public.settings s
                  where s.salon_id = new.salon_id and s.waitlist_enabled) then
    return null;
  end if;

  select s.timezone into v_tz from public.salons s where s.id = new.salon_id;
  v_day := (new.starts_at at time zone v_tz)::date;
  if not exists (
    select 1 from public.waitlist_entries e
     where e.salon_id = new.salon_id and e.day = v_day and e.status in ('waiting', 'offered')
  ) then
    return null;
  end if;

  insert into public.waitlist_openings (salon_id, appointment_id, stylist_id, starts_at, ends_at, day)
  values (new.salon_id, new.id, new.stylist_id, new.starts_at, new.ends_at, v_day)
  on conflict (appointment_id) do update
    set status = 'pending', starts_at = excluded.starts_at, ends_at = excluded.ends_at,
        day = excluded.day, processed_at = null
    where public.waitlist_openings.status <> 'filled';

  perform private.dispatch_waitlist();
  return null;
end;
$$;

create trigger appointments_waitlist_on_cancel
  after update of status on public.appointments
  for each row
  when (new.status = 'cancelled' and old.status is distinct from new.status)
  execute function private.waitlist_on_cancel();

-- ---------------------------------------------------------------------------
-- Matching RPCs (service_role: the waitlist Edge Function)
-- ---------------------------------------------------------------------------

-- Claims up to p_limit pending openings (all salons, or one) and returns each with the waiting
-- clients for its day who haven't been offered it yet, oldest first. The function runs the
-- engine on them and hands the fits to save_waitlist_offers.
create or replace function public.claim_waitlist_openings(
  p_salon_id uuid default null,
  p_limit    integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_o   public.waitlist_openings;
  v_s   public.settings;
  v_tz  text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only the waitlist service can claim openings' using errcode = '42501';
  end if;

  -- Past openings can't be offered any more.
  update public.waitlist_openings o set status = 'closed', processed_at = now()
   where o.status = 'pending' and o.starts_at <= now()
     and (p_salon_id is null or o.salon_id = p_salon_id);

  for v_o in
    select * from public.waitlist_openings o
     where o.status = 'pending' and (p_salon_id is null or o.salon_id = p_salon_id)
     order by o.created_at
     limit greatest(1, least(coalesce(p_limit, 10), 50))
     for update skip locked
  loop
    update public.waitlist_openings set status = 'offered', processed_at = now() where id = v_o.id;
    select * into v_s from public.settings s where s.salon_id = v_o.salon_id;
    select s.timezone into v_tz from public.salons s where s.id = v_o.salon_id;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'openingId', v_o.id,
      'salonId', v_o.salon_id,
      'stylistId', v_o.stylist_id,
      'startsAt', v_o.starts_at,
      'endsAt', v_o.ends_at,
      'day', v_o.day,
      'timezone', v_tz,
      'enabled', coalesce(v_s.waitlist_enabled, false),
      'entries', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'entryId', e.id,
                 'clientId', e.client_id,
                 'items', e.items,
                 'windowStart', to_char(e.window_start, 'HH24:MI'),
                 'windowEnd', to_char(e.window_end, 'HH24:MI'),
                 'createdAt', e.created_at) order by e.created_at)
          from public.waitlist_entries e
         where e.salon_id = v_o.salon_id and e.day = v_o.day and e.status = 'waiting'
           and not exists (select 1 from public.waitlist_offers f
                            where f.opening_id = v_o.id and f.entry_id = e.id)), '[]'::jsonb)));
  end loop;

  return v_out;
end;
$$;

-- Sends one offer: sets its expiry and moves the client to "offered". Returns what an email or a
-- text needs. Shared by save_waitlist_offers (auto) and send_waitlist_offer (the stylist).
create or replace function private.waitlist_send_offer(p_offer_id uuid, p_via text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_f    public.waitlist_offers;
  v_e    public.waitlist_entries;
  v_c    public.clients;
  v_min  integer;
  v_salon public.salons;
begin
  select * into v_f from public.waitlist_offers where id = p_offer_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  select * into v_e from public.waitlist_entries where id = v_f.entry_id;
  if v_f.status not in ('draft', 'sent') or v_e.status not in ('waiting', 'offered')
     or v_f.starts_at <= now()
     or exists (select 1 from public.waitlist_openings o where o.id = v_f.opening_id and o.status = 'filled') then
    return jsonb_build_object('ok', false, 'reason', 'unavailable',
      'message', 'This slot isn''t available to offer any more.');
  end if;
  select * into v_c from public.clients where id = v_e.client_id;
  if p_via = 'email' and v_c.email is null then
    return jsonb_build_object('ok', false, 'reason', 'no_email',
      'message', 'This client has no email. Text the offer instead.');
  end if;

  select s.waitlist_offer_minutes into v_min from public.settings s where s.salon_id = v_f.salon_id;
  select * into v_salon from public.salons where id = v_f.salon_id;

  update public.waitlist_offers
     set status = 'sent', sent_via = p_via, sent_at = now(),
         expires_at = least(now() + make_interval(mins => coalesce(v_min, 120)), v_f.starts_at)
   where id = v_f.id
  returning * into v_f;
  update public.waitlist_entries set status = 'offered' where id = v_e.id;

  return jsonb_build_object(
    'ok', true,
    'offerId', v_f.id,
    'token', v_e.token,
    'clientName', v_c.name,
    'email', v_c.email,
    'phone', v_c.phone,
    'salonName', v_salon.name,
    'timezone', v_salon.timezone,
    'startsAt', v_f.starts_at,
    'endsAt', v_f.ends_at,
    'servicesLabel', v_e.services_label,
    'expiresAt', v_f.expires_at);
end;
$$;

-- Stores the engine's fits for an opening. Drafts by default; with auto-offer on, clients with
-- an email are sent straight away (the function emails them from the returned list). Pushes the
-- stylist either way. p_offers: [{ entryId, startsAt, endsAt, segments, services, priceCents }].
create or replace function public.save_waitlist_offers(p_opening_id uuid, p_offers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_o     public.waitlist_openings;
  v_auto  boolean;
  v_tz    text;
  v_item  jsonb;
  v_id    uuid;
  v_ids   uuid[] := '{}';
  v_sent  jsonb := '[]'::jsonb;
  v_res   jsonb;
  v_count integer;
  v_names text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only the waitlist service can save offers' using errcode = '42501';
  end if;
  select * into v_o from public.waitlist_openings where id = p_opening_id for update;
  if not found or v_o.status = 'filled' then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_offers, '[]'::jsonb)) loop
    insert into public.waitlist_offers
      (salon_id, opening_id, entry_id, starts_at, ends_at, segments, services, price_cents)
    select v_o.salon_id, v_o.id, e.id, (v_item ->> 'startsAt')::timestamptz,
           (v_item ->> 'endsAt')::timestamptz, v_item -> 'segments',
           coalesce(v_item -> 'services', '[]'::jsonb), (v_item ->> 'priceCents')::integer
      from public.waitlist_entries e
     where e.id = (v_item ->> 'entryId')::uuid and e.salon_id = v_o.salon_id
       and e.status = 'waiting'
    on conflict (opening_id, entry_id) do nothing
    returning id into v_id;
    if v_id is not null then
      v_ids := v_ids || v_id;
    end if;
    v_id := null;
  end loop;

  v_count := coalesce(array_length(v_ids, 1), 0);
  if v_count = 0 then
    -- Nobody fits. Stays closed unless the time is cancelled again.
    if not exists (select 1 from public.waitlist_offers f
                    where f.opening_id = v_o.id and f.status in ('draft', 'sent')) then
      update public.waitlist_openings set status = 'closed' where id = v_o.id;
    end if;
    return jsonb_build_object('ok', true, 'saved', 0, 'sent', '[]'::jsonb);
  end if;

  select s.waitlist_auto_offer into v_auto from public.settings s where s.salon_id = v_o.salon_id;
  if coalesce(v_auto, false) then
    for v_id in select unnest(v_ids) loop
      if exists (select 1 from public.waitlist_offers f
                   join public.waitlist_entries e on e.id = f.entry_id
                   join public.clients c on c.id = e.client_id
                  where f.id = v_id and c.email is not null) then
        v_res := private.waitlist_send_offer(v_id, 'email');
        if coalesce((v_res ->> 'ok')::boolean, false) then
          v_sent := v_sent || jsonb_build_array(v_res);
        end if;
      end if;
    end loop;
  end if;

  select s.timezone into v_tz from public.salons s where s.id = v_o.salon_id;
  select string_agg(c.name, ', ' order by f.created_at) into v_names
    from public.waitlist_offers f
    join public.waitlist_entries e on e.id = f.entry_id
    join public.clients c on c.id = e.client_id
   where f.id = any (v_ids);

  if v_o.stylist_id is not null then
    perform private.enqueue_notification(
      v_o.salon_id, v_o.stylist_id, 'waitlist', null,
      case when jsonb_array_length(v_sent) > 0
           then 'Offered a cancelled slot to the waitlist'
           else 'Waitlist clients fit a cancelled slot' end,
      private.format_local_datetime(v_o.starts_at, v_tz) || ' · ' || v_names
        || case when jsonb_array_length(v_sent) > 0 then '' else '. Review and send the offers.' end,
      null,
      jsonb_build_object('type', 'waitlist', 'salonId', v_o.salon_id),
      'waitlist_match:' || v_o.id || ':' || extract(epoch from clock_timestamp())::text);
  end if;

  return jsonb_build_object('ok', true, 'saved', v_count, 'sent', v_sent);
end;
$$;

-- ---------------------------------------------------------------------------
-- The client's waitlist link (/w/<token>, service_role)
-- ---------------------------------------------------------------------------

create or replace function private.waitlist_entry_by_token(p_token text)
returns public.waitlist_entries
language sql
stable
security definer
set search_path = ''
as $$
  select e.* from public.waitlist_entries e
   where p_token ~ '^[0-9a-f]{64}$' and e.token = p_token;
$$;

-- The entry behind the token, its live offer (if any) and the salon. Never other clients.
create or replace function public.waitlist_by_token(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_e     public.waitlist_entries;
  v_salon public.salons;
  v_offer jsonb;
  v_appt  public.appointments;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only the waitlist service can read waitlist links' using errcode = '42501';
  end if;
  v_e := private.waitlist_entry_by_token(p_token);
  if v_e.id is null then
    return null;
  end if;
  select * into v_salon from public.salons where id = v_e.salon_id;

  select jsonb_build_object('offerId', f.id, 'startsAt', f.starts_at, 'endsAt', f.ends_at,
                            'expiresAt', f.expires_at, 'items', v_e.items,
                            'segments', f.segments, 'services', f.services,
                            'priceCents', f.price_cents)
    into v_offer
    from public.waitlist_offers f
   where f.entry_id = v_e.id and f.status = 'sent' and f.expires_at > now()
     and f.starts_at > now()
   order by f.sent_at desc
   limit 1;

  if v_e.appointment_id is not null then
    select * into v_appt from public.appointments where id = v_e.appointment_id;
  end if;

  return jsonb_build_object(
    'salonId', v_e.salon_id,
    'entry', jsonb_build_object(
      'status', v_e.status,
      'day', v_e.day,
      'windowStart', to_char(v_e.window_start, 'HH24:MI'),
      'windowEnd', to_char(v_e.window_end, 'HH24:MI'),
      'servicesLabel', v_e.services_label,
      'clientFirstName', (select split_part(c.name, ' ', 1) from public.clients c where c.id = v_e.client_id)),
    'offer', v_offer,
    'booking', case when v_appt.id is null then null
                    else jsonb_build_object('startsAt', v_appt.starts_at, 'endsAt', v_appt.ends_at,
                                            'status', v_appt.status, 'manageToken', v_appt.manage_token) end,
    'salon', jsonb_build_object('name', v_salon.name, 'slug', v_salon.slug, 'timezone', v_salon.timezone));
end;
$$;

create or replace function public.leave_waitlist_by_token(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_e public.waitlist_entries;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only the waitlist service can change waitlist links' using errcode = '42501';
  end if;
  v_e := private.waitlist_entry_by_token(p_token);
  if v_e.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_e.status in ('waiting', 'offered') then
    update public.waitlist_entries set status = 'cancelled' where id = v_e.id;
    update public.waitlist_offers set status = 'withdrawn'
     where entry_id = v_e.id and status in ('draft', 'sent');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- First to accept gets it. p_segments are the engine's re-check of the offered time. Books as a
-- confirmed owner booking ("From the waitlist", no deposit), so the client gets the usual
-- confirmation email and manage link. Returns { ok, appointmentId, startsAt, endsAt } or
-- { ok: false, reason: 'not_found' | 'expired' | 'taken' | 'conflict' }.
create or replace function public.accept_waitlist_offer(
  p_token    text,
  p_offer_id uuid,
  p_segments jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_e    public.waitlist_entries;
  v_f    public.waitlist_offers;
  v_o    public.waitlist_openings;
  v_appt public.appointments;
  v_tz   text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only the waitlist service can accept offers' using errcode = '42501';
  end if;
  v_e := private.waitlist_entry_by_token(p_token);
  if v_e.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  select * into v_f from public.waitlist_offers where id = p_offer_id and entry_id = v_e.id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  -- The opening is the lock every competing accept waits on.
  select * into v_o from public.waitlist_openings where id = v_f.opening_id for update;
  select * into v_f from public.waitlist_offers where id = p_offer_id for update;

  if v_o.status = 'filled' or v_f.status = 'taken' then
    return jsonb_build_object('ok', false, 'reason', 'taken');
  end if;
  if v_f.status <> 'sent' or v_f.expires_at <= now() or v_f.starts_at <= now()
     or v_e.status not in ('waiting', 'offered') then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  begin
    v_appt := public.book_appointment(
      v_f.salon_id, v_e.client_id, coalesce(p_segments, v_f.segments), v_f.services,
      'confirmed', 'owner', v_f.price_cents, 'From the waitlist', v_o.stylist_id);
  exception when exclusion_violation then
    update public.waitlist_offers set status = 'taken' where id = v_f.id;
    return jsonb_build_object('ok', false, 'reason', 'conflict');
  end;

  update public.waitlist_offers
     set status = 'accepted', accepted_at = now(), appointment_id = v_appt.id
   where id = v_f.id;
  update public.waitlist_offers set status = 'taken'
   where opening_id = v_o.id and id <> v_f.id and status in ('draft', 'sent');
  update public.waitlist_openings set status = 'filled' where id = v_o.id;
  update public.waitlist_entries set status = 'booked', appointment_id = v_appt.id
   where id = v_e.id;
  -- Clients who were offered this slot go back to waiting unless another offer is live.
  update public.waitlist_entries e set status = 'waiting'
   where e.status = 'offered' and e.id <> v_e.id
     and exists (select 1 from public.waitlist_offers f where f.entry_id = e.id and f.opening_id = v_o.id)
     and not exists (select 1 from public.waitlist_offers f
                      where f.entry_id = e.id and f.status = 'sent' and f.expires_at > now());

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (v_f.salon_id, null, 'waitlist.accepted', 'appointment', v_appt.id::text,
          jsonb_build_object('offer_id', v_f.id, 'entry_id', v_e.id, 'opening_id', v_o.id,
                             'cancelled_appointment_id', v_o.appointment_id));

  select s.timezone into v_tz from public.salons s where s.id = v_f.salon_id;
  perform private.enqueue_notification(
    v_appt.salon_id, v_appt.stylist_id, 'waitlist', v_appt.id,
    private.appointment_client_name(v_appt.client_id) || ' took a slot from the waitlist',
    private.format_local_datetime(v_appt.starts_at, v_tz)
      || coalesce(' · ' || private.appointment_services_label(v_appt.services), ''),
    null,
    jsonb_build_object('type', 'waitlist', 'salonId', v_appt.salon_id, 'appointmentId', v_appt.id),
    'waitlist_filled:' || v_o.id);

  return jsonb_build_object('ok', true, 'appointmentId', v_appt.id,
                            'startsAt', v_appt.starts_at, 'endsAt', v_appt.ends_at);
end;
$$;

-- ---------------------------------------------------------------------------
-- Joining from the public booking page (service_role)
-- ---------------------------------------------------------------------------

-- Links the verified email to a client like book_public_appointment does (linked profile →
-- unlinked profile with the same email → new pending client), then adds or updates the client's
-- entry for that day. Returns { ok, token } or { ok: false, reason: 'disabled' | 'limit' }.
create or replace function public.join_waitlist(
  p_salon_id   uuid,
  p_user_id    uuid,
  p_entry      jsonb,
  p_max_active integer default 3
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.settings;
  v_email    text;
  v_phone    text := nullif(left(btrim(p_entry ->> 'phone'), 32), '');
  v_name     text := nullif(left(btrim(p_entry ->> 'name'), 80), '');
  v_client   uuid;
  v_day      date := (p_entry ->> 'day')::date;
  v_ws       time := (p_entry ->> 'windowStart')::time;
  v_we       time := (p_entry ->> 'windowEnd')::time;
  v_entry    public.waitlist_entries;
  v_tz       text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only the booking service can join the waitlist' using errcode = '42501';
  end if;

  select * into v_settings from public.settings s where s.salon_id = p_salon_id;
  if not found or not v_settings.public_booking_enabled or not v_settings.waitlist_enabled then
    return jsonb_build_object('ok', false, 'reason', 'disabled');
  end if;
  select s.timezone into v_tz from public.salons s where s.id = p_salon_id;
  if v_day is null or v_day < (now() at time zone v_tz)::date then
    raise exception 'Pick a day from today on' using errcode = '22023';
  end if;

  select u.email into v_email from auth.users u
   where u.id = p_user_id and u.email_confirmed_at is not null;
  if v_email is null then
    raise exception 'Verify your email first' using errcode = '42501';
  end if;

  select c.id into v_client from public.clients c
   where c.salon_id = p_salon_id and c.user_id = p_user_id;
  if v_client is null then
    select c.id into v_client from public.clients c
     where c.salon_id = p_salon_id and c.user_id is null and lower(c.email) = lower(v_email)
     order by c.created_at
     limit 1
     for update;
    if found then
      update public.clients set user_id = p_user_id, phone = coalesce(phone, v_phone)
       where id = v_client;
    end if;
  end if;
  if v_client is null then
    if v_name is null then
      raise exception 'Name is required' using errcode = '22023';
    end if;
    insert into public.clients (salon_id, name, phone, email, pending, user_id)
    values (p_salon_id, v_name, v_phone, lower(v_email), true, p_user_id)
    returning id into v_client;
  end if;

  select * into v_entry from public.waitlist_entries e
   where e.salon_id = p_salon_id and e.client_id = v_client and e.day = v_day
     and e.status in ('waiting', 'offered');
  if found then
    update public.waitlist_entries
       set items = p_entry -> 'items', services_label = left(p_entry ->> 'servicesLabel', 200),
           window_start = v_ws, window_end = v_we,
           notes = coalesce(nullif(left(btrim(p_entry ->> 'notes'), 500), ''), notes)
     where id = v_entry.id
    returning * into v_entry;
  else
    if (select count(*) from public.waitlist_entries e
         where e.salon_id = p_salon_id and e.client_id = v_client
           and e.status in ('waiting', 'offered')) >= p_max_active then
      return jsonb_build_object('ok', false, 'reason', 'limit');
    end if;
    insert into public.waitlist_entries
      (salon_id, client_id, items, services_label, day, window_start, window_end, source, notes)
    values (p_salon_id, v_client, p_entry -> 'items', left(p_entry ->> 'servicesLabel', 200),
            v_day, v_ws, v_we, 'public', nullif(left(btrim(p_entry ->> 'notes'), 500), ''))
    returning * into v_entry;
  end if;

  return jsonb_build_object('ok', true, 'token', v_entry.token, 'day', v_entry.day);
end;
$$;

-- ---------------------------------------------------------------------------
-- The stylist's side (salon members)
-- ---------------------------------------------------------------------------

-- Adds (or updates) a client's entry for a day. p_items: [{ serviceId, variantId? }].
create or replace function public.add_waitlist_entry(
  p_salon_id       uuid,
  p_client_id      uuid,
  p_items          jsonb,
  p_services_label text,
  p_day            date,
  p_window_start   time default null,
  p_window_end     time default null,
  p_notes          text default null
)
returns public.waitlist_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry public.waitlist_entries;
begin
  if not private.is_salon_member(p_salon_id) then
    raise exception 'Not a member of this salon' using errcode = '42501';
  end if;
  if not exists (select 1 from public.clients c where c.id = p_client_id and c.salon_id = p_salon_id) then
    raise exception 'Unknown client' using errcode = '22023';
  end if;

  update public.waitlist_entries
     set items = p_items, services_label = p_services_label, window_start = p_window_start,
         window_end = p_window_end, notes = coalesce(p_notes, notes)
   where salon_id = p_salon_id and client_id = p_client_id and day = p_day
     and status in ('waiting', 'offered')
  returning * into v_entry;
  if v_entry.id is null then
    insert into public.waitlist_entries
      (salon_id, client_id, items, services_label, day, window_start, window_end, source, notes)
    values (p_salon_id, p_client_id, p_items, p_services_label, p_day, p_window_start,
            p_window_end, 'owner', p_notes)
    returning * into v_entry;
  end if;
  return v_entry;
end;
$$;

create or replace function public.remove_waitlist_entry(p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_e public.waitlist_entries;
begin
  select * into v_e from public.waitlist_entries where id = p_entry_id;
  if not found or not private.is_salon_member(v_e.salon_id) then
    raise exception 'Not found' using errcode = '42501';
  end if;
  if v_e.status in ('waiting', 'offered') then
    update public.waitlist_entries set status = 'cancelled' where id = v_e.id;
    update public.waitlist_offers set status = 'withdrawn'
     where entry_id = v_e.id and status in ('draft', 'sent');
  end if;
end;
$$;

-- The stylist approves a drafted offer. p_via 'text': he texts the returned link from his phone;
-- 'email': the waitlist function emails it.
create or replace function public.send_waitlist_offer(p_offer_id uuid, p_via text default 'text')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_salon uuid;
begin
  if p_via not in ('text', 'email') then
    raise exception 'Send by text or email' using errcode = '22023';
  end if;
  select f.salon_id into v_salon from public.waitlist_offers f where f.id = p_offer_id;
  if v_salon is null
     or not (private.is_salon_member(v_salon)
             or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then
    raise exception 'Not found' using errcode = '42501';
  end if;
  return private.waitlist_send_offer(p_offer_id, p_via);
end;
$$;

create or replace function public.dismiss_waitlist_offer(p_offer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_f public.waitlist_offers;
begin
  select * into v_f from public.waitlist_offers where id = p_offer_id;
  if not found or not private.is_salon_member(v_f.salon_id) then
    raise exception 'Not found' using errcode = '42501';
  end if;
  if v_f.status in ('draft', 'sent') then
    update public.waitlist_offers set status = 'withdrawn' where id = v_f.id;
    update public.waitlist_entries e set status = 'waiting'
     where e.id = v_f.entry_id and e.status = 'offered'
       and not exists (select 1 from public.waitlist_offers f
                        where f.entry_id = e.id and f.status = 'sent' and f.expires_at > now());
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Housekeeping (pg_cron, every minute)
-- ---------------------------------------------------------------------------

-- Expires lapsed offers (their clients go back to waiting, and the opening is matched again so
-- the next clients in line get a chance), closes past openings, expires past days, then pokes
-- the function if anything is pending.
create or replace function private.waitlist_tick(p_now timestamptz default now())
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  with expired as (
    update public.waitlist_offers f set status = 'expired'
     where f.status = 'sent' and (f.expires_at <= p_now or f.starts_at <= p_now)
    returning f.entry_id, f.opening_id
  ), back as (
    update public.waitlist_entries e set status = 'waiting'
     where e.status = 'offered' and e.id in (select entry_id from expired)
       and not exists (select 1 from public.waitlist_offers f
                        where f.entry_id = e.id and f.status = 'sent' and f.expires_at > p_now)
    returning e.id
  )
  update public.waitlist_openings o set status = 'pending', processed_at = null
   where o.id in (select opening_id from expired) and o.status = 'offered'
     and o.starts_at > p_now
     and not exists (select 1 from public.waitlist_offers f
                      where f.opening_id = o.id and (f.status = 'draft'
                            or (f.status = 'sent' and f.expires_at > p_now)));

  update public.waitlist_offers f set status = 'expired'
   where f.status = 'draft' and f.starts_at <= p_now;
  update public.waitlist_openings o set status = 'closed'
   where o.status in ('pending', 'offered') and o.starts_at <= p_now;
  update public.waitlist_entries e set status = 'expired'
   where e.status in ('waiting', 'offered')
     and e.day < (p_now at time zone (select s.timezone from public.salons s where s.id = e.salon_id))::date;

  perform private.dispatch_waitlist();
end;
$$;

revoke all on function private.dispatch_waitlist() from public;
revoke all on function private.waitlist_on_cancel() from public;
revoke all on function private.waitlist_send_offer(uuid, text) from public;
revoke all on function private.waitlist_entry_by_token(text) from public;
revoke all on function private.waitlist_tick(timestamptz) from public;

revoke all on function public.claim_waitlist_openings(uuid, integer) from public, anon, authenticated;
revoke all on function public.save_waitlist_offers(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.waitlist_by_token(text) from public, anon, authenticated;
revoke all on function public.leave_waitlist_by_token(text) from public, anon, authenticated;
revoke all on function public.accept_waitlist_offer(text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.join_waitlist(uuid, uuid, jsonb, integer) from public, anon, authenticated;
grant execute on function public.claim_waitlist_openings(uuid, integer) to service_role;
grant execute on function public.save_waitlist_offers(uuid, jsonb) to service_role;
grant execute on function public.waitlist_by_token(text) to service_role;
grant execute on function public.leave_waitlist_by_token(text) to service_role;
grant execute on function public.accept_waitlist_offer(text, uuid, jsonb) to service_role;
grant execute on function public.join_waitlist(uuid, uuid, jsonb, integer) to service_role;

revoke all on function public.add_waitlist_entry(uuid, uuid, jsonb, text, date, time, time, text) from public, anon;
revoke all on function public.remove_waitlist_entry(uuid) from public, anon;
revoke all on function public.send_waitlist_offer(uuid, text) from public, anon;
revoke all on function public.dismiss_waitlist_offer(uuid) from public, anon;
grant execute on function public.add_waitlist_entry(uuid, uuid, jsonb, text, date, time, time, text)
  to authenticated, service_role;
grant execute on function public.remove_waitlist_entry(uuid) to authenticated, service_role;
grant execute on function public.send_waitlist_offer(uuid, text) to authenticated, service_role;
grant execute on function public.dismiss_waitlist_offer(uuid) to authenticated, service_role;

select cron.schedule('waitlist-tick', '* * * * *', 'select private.waitlist_tick()');
