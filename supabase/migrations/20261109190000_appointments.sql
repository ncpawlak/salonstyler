-- Appointments, segments, holds and a minimal client list (docs/PLAN.md §5 and §13, issue #30).
--
-- Segments mirror the availability engine's placed segments
-- (packages/core/src/availability/types.ts `PlacedSegment`):
--   kind  = busy | processing | style | buffer
--   range = half-open `[start, end)` tstzrange (back-to-back bookings are allowed)
-- The DB guard `no_double_booked_busy` rejects overlapping *blocking* segments (everything except
-- `processing`) for the same stylist within a salon, so another client's busy time may sit inside
-- processing. `@chairside/core` `busyRanges` / `findBusyConflicts` are the in-memory mirror.
--
-- All appointment writes go through the RPCs below (atomic, audited). Clients are plain CRUD.

create extension if not exists btree_gist with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create type public.appointment_status as enum
  ('held', 'requested', 'confirmed', 'completed', 'cancelled', 'no_show');
create type public.appointment_source as enum ('owner', 'inbox', 'public', 'import');
create type public.appointment_segment_kind as enum ('busy', 'processing', 'style', 'buffer');

-- ---------------------------------------------------------------------------
-- clients (minimal; full profiles come with issue #13)
-- ---------------------------------------------------------------------------

create table public.clients (
  id         uuid primary key default gen_random_uuid(),
  salon_id   uuid not null references public.salons (id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 80),
  phone      text check (phone is null or char_length(phone) between 1 and 32),
  email      text check (email is null or (char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+$')),
  notes      text check (notes is null or char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clients_salon_id_id_key unique (salon_id, id)
);

create index clients_salon_name_idx on public.clients (salon_id, lower(name));

create trigger clients_set_updated_at
  before update on public.clients
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- appointments
-- ---------------------------------------------------------------------------

create table public.appointments (
  id              uuid primary key default gen_random_uuid(),
  salon_id        uuid not null references public.salons (id) on delete cascade,
  client_id       uuid,
  stylist_id      uuid not null references auth.users (id),
  status          public.appointment_status not null default 'confirmed',
  source          public.appointment_source not null default 'owner',
  -- Client time (first to last non-buffer segment); kept in sync with the segments by the RPCs.
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  hold_expires_at timestamptz,
  -- Snapshot of what was booked: [{ "serviceId", "name", "colorTag", "variantId"?, ... }].
  services        jsonb not null default '[]'::jsonb check (jsonb_typeof(services) = 'array'),
  price_cents     integer check (price_cents between 0 and 10000000),
  notes           text check (notes is null or char_length(notes) <= 2000),
  cancelled_at    timestamptz,
  cancel_reason   text check (cancel_reason is null or char_length(cancel_reason) <= 200),
  created_by      uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint appointments_salon_id_id_key unique (salon_id, id),
  constraint appointments_client_fkey foreign key (salon_id, client_id)
    references public.clients (salon_id, id) on delete set null (client_id),
  constraint appointments_time_order check (ends_at > starts_at),
  constraint appointments_hold_has_expiry check (status <> 'held' or hold_expires_at is not null)
);

comment on table public.appointments is
  'A booking. Write through book_appointment / reschedule_appointment / set_appointment_status.';
comment on column public.appointments.hold_expires_at is
  'Held slots are released (status -> cancelled) by the release-expired-holds pg_cron job.';

create index appointments_salon_starts_idx on public.appointments (salon_id, starts_at);
create index appointments_client_idx on public.appointments (client_id);
create index appointments_held_expiry_idx on public.appointments (hold_expires_at)
  where status = 'held';

create trigger appointments_set_updated_at
  before update on public.appointments
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- appointment_segments
-- ---------------------------------------------------------------------------

create table public.appointment_segments (
  id             uuid primary key default gen_random_uuid(),
  salon_id       uuid not null references public.salons (id) on delete cascade,
  appointment_id uuid not null,
  stylist_id     uuid not null,
  position       integer not null check (position >= 0),
  kind           public.appointment_segment_kind not null,
  label          text check (label is null or char_length(label) <= 40),
  range          tstzrange not null check (
    not isempty(range) and lower_inc(range) and not upper_inc(range)
    and not lower_inf(range) and not upper_inf(range)
  ),
  -- Denormalized from the appointment's status: cancelled / no-show segments free their time.
  active         boolean not null default true,
  constraint appointment_segments_appointment_fkey foreign key (salon_id, appointment_id)
    references public.appointments (salon_id, id) on delete cascade,
  constraint appointment_segments_position_key unique (appointment_id, position),
  constraint no_double_booked_busy exclude using gist
    (salon_id with =, stylist_id with =, range with &&)
    where (active and kind <> 'processing')
);

comment on constraint no_double_booked_busy on public.appointment_segments is
  'Busy/style/buffer time cannot overlap within a salon+stylist; processing may (PLAN.md §5).';

create index appointment_segments_range_idx on public.appointment_segments using gist (salon_id, range);

create or replace function private.is_active_appointment_status(p_status public.appointment_status)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_status not in ('cancelled', 'no_show');
$$;

-- Status changes (including the hold-expiry job) free or re-claim the appointment's time.
create or replace function private.sync_appointment_segments_active()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.appointment_segments
     set active = private.is_active_appointment_status(new.status)
   where appointment_id = new.id
     and active is distinct from private.is_active_appointment_status(new.status);
  return null;
end;
$$;

create trigger appointments_sync_segments_active
  after update of status on public.appointments
  for each row when (old.status is distinct from new.status)
  execute function private.sync_appointment_segments_active();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.clients              enable row level security;
alter table public.appointments         enable row level security;
alter table public.appointment_segments enable row level security;

revoke all on public.clients, public.appointments, public.appointment_segments from anon;
-- Appointment writes only via the RPCs below.
revoke insert, update, delete, truncate on public.appointments, public.appointment_segments
  from authenticated;

create policy "members can read clients" on public.clients
  for select to authenticated using (private.is_salon_member(salon_id));
create policy "members can add clients" on public.clients
  for insert to authenticated with check (private.is_salon_member(salon_id));
create policy "members can update clients" on public.clients
  for update to authenticated
  using (private.is_salon_member(salon_id))
  with check (private.is_salon_member(salon_id));
create policy "owners can delete clients" on public.clients
  for delete to authenticated using (private.has_salon_role(salon_id, 'owner'));

create policy "members can read appointments" on public.appointments
  for select to authenticated using (private.is_salon_member(salon_id));
create policy "members can read appointment segments" on public.appointment_segments
  for select to authenticated using (private.is_salon_member(salon_id));

-- ---------------------------------------------------------------------------
-- Segment helpers
-- ---------------------------------------------------------------------------

-- Validates `[{ "kind", "start", "end", "label"? }]` (ordered, non-overlapping, <= 24h) and returns
-- the client span (first to last non-buffer segment).
create or replace function private.appointment_segments_span(p_segments jsonb)
returns tstzrange
language plpgsql
stable
set search_path = ''
as $$
declare
  v_prev  timestamptz;
  v_seg   jsonb;
  v_start timestamptz;
  v_end   timestamptz;
begin
  if p_segments is null or jsonb_typeof(p_segments) <> 'array'
     or jsonb_array_length(p_segments) not between 1 and 50 then
    raise exception 'An appointment needs 1 to 50 segments' using errcode = '22023';
  end if;

  for v_seg in select value from jsonb_array_elements(p_segments) loop
    if jsonb_typeof(v_seg) <> 'object'
       or (v_seg ->> 'kind') is null
       or (v_seg ->> 'kind') not in ('busy', 'processing', 'style', 'buffer')
       or (v_seg ->> 'start') is null or (v_seg ->> 'end') is null
    then
      raise exception 'Invalid appointment segment: %', v_seg using errcode = '22023';
    end if;
    v_start := (v_seg ->> 'start')::timestamptz;
    v_end := (v_seg ->> 'end')::timestamptz;
    if v_end <= v_start or (v_prev is not null and v_start < v_prev) then
      raise exception 'Appointment segments must be ordered and non-overlapping' using errcode = '22023';
    end if;
    v_prev := v_end;
  end loop;

  if v_prev - (p_segments -> 0 ->> 'start')::timestamptz > interval '24 hours' then
    raise exception 'An appointment cannot be longer than 24 hours' using errcode = '22023';
  end if;

  select min((e ->> 'start')::timestamptz), max((e ->> 'end')::timestamptz)
    into v_start, v_end
    from jsonb_array_elements(p_segments) e
   where e ->> 'kind' <> 'buffer';
  if v_start is null then
    raise exception 'An appointment needs at least one non-buffer segment' using errcode = '22023';
  end if;
  return tstzrange(v_start, v_end, '[)');
end;
$$;

-- Replaces the appointment's segments and syncs starts_at/ends_at to the client span.
create or replace function private.write_appointment_segments(p_appointment_id uuid, p_segments jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appt public.appointments;
  v_span tstzrange := private.appointment_segments_span(p_segments);
begin
  update public.appointments
     set starts_at = lower(v_span), ends_at = upper(v_span)
   where id = p_appointment_id
  returning * into v_appt;

  delete from public.appointment_segments where appointment_id = p_appointment_id;
  insert into public.appointment_segments
    (salon_id, appointment_id, stylist_id, position, kind, label, range, active)
  select v_appt.salon_id, v_appt.id, v_appt.stylist_id, (t.o - 1)::integer,
         (t.e ->> 'kind')::public.appointment_segment_kind,
         nullif(btrim(left(t.e ->> 'label', 40)), ''),
         tstzrange((t.e ->> 'start')::timestamptz, (t.e ->> 'end')::timestamptz, '[)'),
         private.is_active_appointment_status(v_appt.status)
  from jsonb_array_elements(p_segments) with ordinality as t(e, o);
end;
$$;

revoke all on function private.appointment_segments_span(jsonb) from public;
revoke all on function private.write_appointment_segments(uuid, jsonb) from public;
revoke all on function private.is_active_appointment_status(public.appointment_status) from public;
grant execute on function private.is_active_appointment_status(public.appointment_status)
  to authenticated, service_role;

create or replace function private.raise_booking_conflict()
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'That time overlaps another appointment'
    using errcode = '23P01',
          hint = 'Busy time can only overlap another client''s processing time. Pick another time.';
end;
$$;

revoke all on function private.raise_booking_conflict() from public;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Members book for their salon; trusted server code (Edge Functions, service_role) may too.
create or replace function private.can_book_for_salon(p_salon_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role' or private.is_salon_member(p_salon_id);
$$;

revoke all on function private.can_book_for_salon(uuid) from public;
grant execute on function private.can_book_for_salon(uuid) to authenticated, service_role;

create or replace function public.book_appointment(
  p_salon_id    uuid,
  p_client_id   uuid,
  p_segments    jsonb,
  p_services    jsonb default '[]'::jsonb,
  p_status      public.appointment_status default 'confirmed',
  p_source      public.appointment_source default 'owner',
  p_price_cents integer default null,
  p_notes       text default null,
  p_stylist_id  uuid default null
)
returns public.appointments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appt    public.appointments;
  v_stylist uuid := coalesce(p_stylist_id, auth.uid());
  v_hours   integer;
  v_span    tstzrange := private.appointment_segments_span(p_segments);
begin
  if not private.can_book_for_salon(p_salon_id) then
    raise exception 'Not a member of this salon' using errcode = '42501';
  end if;
  if p_status not in ('held', 'requested', 'confirmed') then
    raise exception 'New appointments must be held, requested or confirmed' using errcode = '22023';
  end if;
  if not exists (select 1 from public.salon_members m
                 where m.salon_id = p_salon_id and m.user_id = v_stylist) then
    raise exception 'Stylist is not a member of this salon' using errcode = '22023';
  end if;
  if p_client_id is not null and not exists (
    select 1 from public.clients c where c.id = p_client_id and c.salon_id = p_salon_id
  ) then
    raise exception 'Client not found' using errcode = '22023';
  end if;

  select s.hold_expiry_hours into v_hours from public.settings s where s.salon_id = p_salon_id;

  begin
    insert into public.appointments
      (salon_id, client_id, stylist_id, status, source, starts_at, ends_at, hold_expires_at,
       services, price_cents, notes)
    values
      (p_salon_id, p_client_id, v_stylist, p_status, p_source,
       lower(v_span), upper(v_span),
       case when p_status = 'held' then now() + make_interval(hours => coalesce(v_hours, 24)) end,
       coalesce(p_services, '[]'::jsonb), p_price_cents, nullif(btrim(p_notes), ''))
    returning id into v_appt.id;

    perform private.write_appointment_segments(v_appt.id, p_segments);
  exception when exclusion_violation then
    perform private.raise_booking_conflict();
  end;

  select * into v_appt from public.appointments where id = v_appt.id;
  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (p_salon_id, auth.uid(), 'appointment.booked', 'appointment', v_appt.id::text,
          jsonb_build_object('status', v_appt.status, 'source', v_appt.source,
                             'starts_at', v_appt.starts_at, 'client_id', v_appt.client_id));
  return v_appt;
end;
$$;

comment on function public.book_appointment is
  'Books an appointment from engine-laid-out segments. Overlapping busy time raises 23P01.';

-- Moves an appointment and/or changes its services/duration (segments are replaced).
create or replace function public.reschedule_appointment(
  p_appointment_id uuid,
  p_segments       jsonb,
  p_services       jsonb default null,
  p_price_cents    integer default null
)
returns public.appointments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appt public.appointments;
  v_from timestamptz;
begin
  select * into v_appt from public.appointments where id = p_appointment_id for update;
  if not found or not private.can_book_for_salon(v_appt.salon_id) then
    raise exception 'Appointment not found' using errcode = 'P0002';
  end if;
  if not private.is_active_appointment_status(v_appt.status) or v_appt.status = 'completed' then
    raise exception 'Only upcoming appointments can be moved or edited' using errcode = '22023';
  end if;
  v_from := v_appt.starts_at;

  begin
    perform private.write_appointment_segments(v_appt.id, p_segments);
  exception when exclusion_violation then
    perform private.raise_booking_conflict();
  end;

  if p_services is not null then
    update public.appointments
       set services = p_services, price_cents = p_price_cents
     where id = v_appt.id;
  end if;

  select * into v_appt from public.appointments where id = v_appt.id;
  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (v_appt.salon_id, auth.uid(), 'appointment.rescheduled', 'appointment', v_appt.id::text,
          jsonb_build_object('from', v_from, 'to', v_appt.starts_at,
                             'services_changed', p_services is not null));
  return v_appt;
end;
$$;

create or replace function public.set_appointment_status(
  p_appointment_id uuid,
  p_status         public.appointment_status,
  p_reason         text default null
)
returns public.appointments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appt public.appointments;
  v_from public.appointment_status;
begin
  select * into v_appt from public.appointments where id = p_appointment_id for update;
  if not found or not private.can_book_for_salon(v_appt.salon_id) then
    raise exception 'Appointment not found' using errcode = 'P0002';
  end if;
  v_from := v_appt.status;
  if v_from = p_status then
    return v_appt;
  end if;

  if not (
    (v_from in ('held', 'requested') and p_status in ('confirmed', 'cancelled'))
    or (v_from = 'held' and p_status = 'requested')
    or (v_from = 'confirmed' and p_status in ('completed', 'no_show', 'cancelled'))
    -- Undo a mis-tap.
    or (v_from in ('completed', 'no_show') and p_status = 'confirmed')
  ) then
    raise exception 'Cannot change an appointment from % to %', v_from, p_status
      using errcode = '22023';
  end if;

  begin
    update public.appointments
       set status = p_status,
           hold_expires_at = case when p_status = 'held' then hold_expires_at end,
           cancelled_at = case when p_status = 'cancelled' then now() end,
           cancel_reason = case when p_status = 'cancelled'
                                then nullif(btrim(left(p_reason, 200)), '') end
     where id = v_appt.id
    returning * into v_appt;
  exception when exclusion_violation then
    perform private.raise_booking_conflict();
  end;

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (v_appt.salon_id, auth.uid(), 'appointment.status_changed', 'appointment', v_appt.id::text,
          jsonb_build_object('from', v_from, 'to', p_status, 'reason', p_reason));
  return v_appt;
end;
$$;

revoke all on function public.book_appointment(uuid, uuid, jsonb, jsonb, public.appointment_status,
  public.appointment_source, integer, text, uuid) from public, anon;
revoke all on function public.reschedule_appointment(uuid, jsonb, jsonb, integer) from public, anon;
revoke all on function public.set_appointment_status(uuid, public.appointment_status, text)
  from public, anon;
grant execute on function public.book_appointment(uuid, uuid, jsonb, jsonb, public.appointment_status,
  public.appointment_source, integer, text, uuid) to authenticated, service_role;
grant execute on function public.reschedule_appointment(uuid, jsonb, jsonb, integer)
  to authenticated, service_role;
grant execute on function public.set_appointment_status(uuid, public.appointment_status, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Hold expiry (settings.hold_expiry_hours, default 24) released by pg_cron every minute.
-- ---------------------------------------------------------------------------

create or replace function private.release_expired_holds()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with released as (
    update public.appointments
       set status = 'cancelled', cancelled_at = now(), cancel_reason = 'hold_expired'
     where status = 'held' and hold_expires_at <= now()
    returning id, salon_id, hold_expires_at
  ), logged as (
    insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
    select salon_id, null, 'appointment.hold_expired', 'appointment', id::text,
           jsonb_build_object('hold_expires_at', hold_expires_at)
    from released
    returning 1
  )
  select count(*)::integer into v_count from logged;
  return v_count;
end;
$$;

revoke all on function private.release_expired_holds() from public;

select cron.schedule('release-expired-holds', '* * * * *', 'select private.release_expired_holds()');
