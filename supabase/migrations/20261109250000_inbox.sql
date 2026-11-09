-- Agentic Inbox (#34): client texts forwarded by the iOS Shortcut keyword bridge
-- (docs/spikes/ios-shortcut-keyword-bridge.md) become booking requests the stylist approves.
--
--   phone ──POST /functions/v1/inbox (X-Bridge-Token)──▶ inbox Edge Function
--     • inbox_bridge_for_token: token → salon (sha256 lookup, per-token rate limit)
--     • the LLM only classifies + parses the text; @chairside/core picks the slot
--     • capture_inbox_request: auto-creates a pending client, books the slot as a `requested`
--       appointment (source inbox → push + request lifecycle from #62) and stores the request.
--
-- Privacy: messages the model classifies as not booking-related are never stored. Only parsed
-- requests land in captured_requests. Draft mode: nothing is ever sent back to the client.
--
-- Approve / decline / expiry act on the appointment as usual; a trigger mirrors the outcome onto
-- the captured request (and, for a reschedule, releases the old appointment on approval).

-- ---------------------------------------------------------------------------
-- Clients created from an unknown number stay "pending" until a booking is confirmed.
-- ---------------------------------------------------------------------------

alter table public.clients add column pending boolean not null default false;

comment on column public.clients.pending is
  'Auto-created by the inbox from an unknown sender. Cleared when one of their bookings is confirmed.';

-- ---------------------------------------------------------------------------
-- inbox_bridges: one write-only token per salon for the phone Shortcut.
-- ---------------------------------------------------------------------------

create table public.inbox_bridges (
  salon_id          uuid primary key references public.salons (id) on delete cascade,
  -- Hex sha256 of the token; the token itself is shown once by rotate_inbox_bridge_token.
  token_hash        text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint        text not null check (char_length(token_hint) between 1 and 8),
  keyword           text not null default 'Chairside'
                    check (char_length(btrim(keyword)) between 2 and 30),
  -- Fixed one-hour rate-limit window.
  window_started_at timestamptz not null default now(),
  window_count      integer not null default 0,
  last_received_at  timestamptz,
  created_at        timestamptz not null default now(),
  rotated_at        timestamptz not null default now()
);

comment on table public.inbox_bridges is
  'Per-salon bridge token for the iOS Shortcut. Inbox-write-only; rotate from Settings → Text bridge.';
comment on column public.inbox_bridges.keyword is
  'The trigger word the Shortcut listens for. The server strips it but never requires it.';

-- ---------------------------------------------------------------------------
-- captured_requests: parsed booking / reschedule / cancel requests from the inbox.
-- ---------------------------------------------------------------------------

create type public.captured_request_intent as enum ('booking', 'reschedule', 'cancel');
create type public.captured_request_status as enum
  ('pending', 'approved', 'declined', 'expired', 'dismissed');

create table public.captured_requests (
  id                    uuid primary key default gen_random_uuid(),
  salon_id              uuid not null references public.salons (id) on delete cascade,
  channel               text not null default 'sms' check (channel ~ '^[a-z_]{1,20}$'),
  -- As the phone reported it: a contact name or a number.
  sender                text check (sender is null or char_length(sender) <= 120),
  -- E.164 when known.
  sender_phone          text check (sender_phone is null or char_length(sender_phone) <= 32),
  client_id             uuid,
  client_created        boolean not null default false,
  -- The client's text with the bridge keyword removed.
  message               text not null check (char_length(message) between 1 and 2000),
  -- What the model understood: services, date, time of day, client name… (InboxParse).
  parsed                jsonb not null default '{}'::jsonb check (jsonb_typeof(parsed) = 'object'),
  intent                public.captured_request_intent not null,
  -- The `requested` appointment holding the proposed slot (null when nothing fit).
  appointment_id        uuid,
  -- The client's existing appointment a reschedule / cancel refers to.
  target_appointment_id uuid,
  status                public.captured_request_status not null default 'pending',
  note                  text check (note is null or char_length(note) <= 300),
  -- sender + text + receivedAt: the bridge may retry.
  dedupe_key            text not null check (char_length(dedupe_key) between 1 and 128),
  received_at           timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  resolved_at           timestamptz,
  constraint captured_requests_dedupe_key unique (salon_id, dedupe_key),
  constraint captured_requests_client_fkey foreign key (salon_id, client_id)
    references public.clients (salon_id, id) on delete set null (client_id),
  constraint captured_requests_appointment_fkey foreign key (salon_id, appointment_id)
    references public.appointments (salon_id, id) on delete set null (appointment_id),
  constraint captured_requests_target_fkey foreign key (salon_id, target_appointment_id)
    references public.appointments (salon_id, id) on delete set null (target_appointment_id)
);

comment on table public.captured_requests is
  'Inbox requests (only booking-related texts are kept). Written by the inbox Edge Function.';

create index captured_requests_salon_status_idx
  on public.captured_requests (salon_id, status, created_at desc);
create index captured_requests_appointment_idx on public.captured_requests (appointment_id)
  where appointment_id is not null;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.inbox_bridges     enable row level security;
alter table public.captured_requests enable row level security;

revoke all on public.inbox_bridges, public.captured_requests from anon;
revoke insert, update, delete, truncate on public.inbox_bridges, public.captured_requests
  from authenticated;
-- Owners may change the keyword or turn the bridge off; the token only via the RPC.
grant update (keyword) on public.inbox_bridges to authenticated;
grant delete on public.inbox_bridges to authenticated;

create policy "owners can read the inbox bridge" on public.inbox_bridges
  for select to authenticated using (private.has_salon_role(salon_id, 'owner'));
create policy "owners can update the inbox bridge" on public.inbox_bridges
  for update to authenticated
  using (private.has_salon_role(salon_id, 'owner'))
  with check (private.has_salon_role(salon_id, 'owner'));
create policy "owners can remove the inbox bridge" on public.inbox_bridges
  for delete to authenticated using (private.has_salon_role(salon_id, 'owner'));

create policy "members can read captured requests" on public.captured_requests
  for select to authenticated using (private.is_salon_member(salon_id));

-- ---------------------------------------------------------------------------
-- Bridge token
-- ---------------------------------------------------------------------------

create or replace function private.inbox_token_hash(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(pg_catalog.sha256(convert_to(p_token, 'UTF8')), 'hex');
$$;

revoke all on function private.inbox_token_hash(text) from public;

-- Creates or replaces the salon's token and returns it. It is never readable again.
create or replace function public.rotate_inbox_bridge_token(p_salon_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text := 'csb_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if not private.has_salon_role(p_salon_id, 'owner') then
    raise exception 'Only owners can manage the text bridge' using errcode = '42501';
  end if;

  insert into public.inbox_bridges (salon_id, token_hash, token_hint)
  values (p_salon_id, private.inbox_token_hash(v_token), right(v_token, 4))
  on conflict (salon_id) do update
     set token_hash = excluded.token_hash,
         token_hint = excluded.token_hint,
         rotated_at = now(),
         window_started_at = now(),
         window_count = 0;

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id)
  values (p_salon_id, auth.uid(), 'inbox.bridge_token_rotated', 'inbox_bridge', p_salon_id::text);
  return v_token;
end;
$$;

-- Service role (inbox Edge Function): resolves a token and counts the request against the
-- per-token hourly limit. No row = unknown token.
create or replace function public.inbox_bridge_for_token(p_token text, p_hourly_limit integer default 60)
returns table (salon_id uuid, keyword text, timezone text, rate_limited boolean)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with b as (
    update public.inbox_bridges ib
       set window_started_at = case when ib.window_started_at <= now() - interval '1 hour'
                                    then now() else ib.window_started_at end,
           window_count = case when ib.window_started_at <= now() - interval '1 hour'
                               then 1 else ib.window_count + 1 end,
           last_received_at = now()
     where ib.token_hash = private.inbox_token_hash(coalesce(p_token, ''))
    returning ib.salon_id, ib.keyword, ib.window_count
  )
  select b.salon_id, b.keyword, s.timezone, b.window_count > p_hourly_limit
    from b join public.salons s on s.id = b.salon_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Capture (service role): client + `requested` appointment + captured request, atomically.
-- ---------------------------------------------------------------------------
-- p_request: {
--   dedupeKey, channel?, sender?, senderPhone?, message, parsed, intent, receivedAt?, note?,
--   clientId? | newClient?: { name, phone? },
--   segments?, services?, priceCents?, notes?   (the slot the engine picked)
--   targetAppointmentId?
-- }
-- Returns { id, duplicate, clientId, clientCreated, appointmentId, note }.
create or replace function public.capture_inbox_request(p_salon_id uuid, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id      uuid;
  v_client  uuid := nullif(p_request ->> 'clientId', '')::uuid;
  v_created boolean := false;
  v_appt    uuid;
  v_stylist uuid;
  v_note    text := nullif(btrim(p_request ->> 'note'), '');
  v_target  uuid := nullif(p_request ->> 'targetAppointmentId', '')::uuid;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only the inbox service can capture requests' using errcode = '42501';
  end if;

  select c.id into v_id from public.captured_requests c
   where c.salon_id = p_salon_id and c.dedupe_key = p_request ->> 'dedupeKey';
  if found then
    return jsonb_build_object('id', v_id, 'duplicate', true);
  end if;

  if v_client is not null and not exists (
    select 1 from public.clients c where c.id = v_client and c.salon_id = p_salon_id
  ) then
    raise exception 'Client not found' using errcode = '22023';
  end if;
  if v_target is not null and not exists (
    select 1 from public.appointments a where a.id = v_target and a.salon_id = p_salon_id
  ) then
    raise exception 'Appointment not found' using errcode = '22023';
  end if;

  if v_client is null and jsonb_typeof(p_request -> 'newClient') = 'object' then
    insert into public.clients (salon_id, name, phone, pending)
    values (p_salon_id,
            left(btrim(p_request -> 'newClient' ->> 'name'), 80),
            nullif(btrim(p_request -> 'newClient' ->> 'phone'), ''),
            true)
    returning id into v_client;
    v_created := true;
  end if;

  if jsonb_typeof(p_request -> 'segments') = 'array' then
    -- Requests land on the owner's calendar (single-chair salons; staff routing comes later).
    select m.user_id into v_stylist from public.salon_members m
     where m.salon_id = p_salon_id and m.role = 'owner'
     order by m.created_at limit 1;
    begin
      select (public.book_appointment(
                p_salon_id, v_client, p_request -> 'segments',
                case when jsonb_typeof(p_request -> 'services') = 'array'
                     then p_request -> 'services' else '[]'::jsonb end, 'requested', 'inbox',
                (p_request ->> 'priceCents')::integer, p_request ->> 'notes', v_stylist)).id
        into v_appt;
    exception when exclusion_violation then
      -- Someone took the slot between the engine's pick and now: keep the request, no hold.
      v_note := 'The suggested time was just taken. Pick another time.';
    end;
  end if;

  insert into public.captured_requests
    (salon_id, channel, sender, sender_phone, client_id, client_created, message, parsed, intent,
     appointment_id, target_appointment_id, note, dedupe_key, received_at)
  values
    (p_salon_id,
     coalesce(nullif(p_request ->> 'channel', ''), 'sms'),
     nullif(left(btrim(p_request ->> 'sender'), 120), ''),
     nullif(btrim(p_request ->> 'senderPhone'), ''),
     v_client, v_created,
     left(p_request ->> 'message', 2000),
     case when jsonb_typeof(p_request -> 'parsed') = 'object'
          then p_request -> 'parsed' else '{}'::jsonb end,
     (p_request ->> 'intent')::public.captured_request_intent,
     v_appt, v_target, left(v_note, 300),
     p_request ->> 'dedupeKey',
     coalesce((p_request ->> 'receivedAt')::timestamptz, now()))
  returning id into v_id;

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (p_salon_id, null, 'inbox.request_captured', 'captured_request', v_id::text,
          jsonb_build_object('intent', p_request ->> 'intent', 'appointment_id', v_appt,
                             'client_created', v_created));

  return jsonb_build_object('id', v_id, 'duplicate', false, 'clientId', v_client,
                            'clientCreated', v_created, 'appointmentId', v_appt, 'note', v_note);
end;
$$;

-- ---------------------------------------------------------------------------
-- Outcome sync: approve / decline / expiry happen on the appointment (Inbox, request screen,
-- lock-screen actions, cron); mirror them onto the request.
-- ---------------------------------------------------------------------------

create or replace function private.sync_captured_request_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if new.status = 'confirmed' then
    update public.clients set pending = false where id = new.client_id and pending;
    for r in
      update public.captured_requests c
         set status = 'approved', resolved_at = now()
       where c.appointment_id = new.id and c.status = 'pending'
      returning c.intent, c.target_appointment_id
    loop
      -- Approving a reschedule frees the old time.
      if r.intent = 'reschedule' and r.target_appointment_id is not null then
        update public.appointments a
           set status = 'cancelled', cancelled_at = now(), cancel_reason = 'rescheduled',
               hold_expires_at = null
         where a.id = r.target_appointment_id and a.status in ('held', 'requested', 'confirmed');
        if found then
          insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id,
                                        details)
          values (new.salon_id, auth.uid(), 'appointment.status_changed', 'appointment',
                  r.target_appointment_id::text,
                  jsonb_build_object('to', 'cancelled', 'reason', 'rescheduled',
                                     'replaced_by', new.id));
        end if;
      end if;
    end loop;
  elsif new.status = 'cancelled' then
    update public.captured_requests c
       set status = case when new.cancel_reason in ('hold_expired', 'request_expired')
                         then 'expired'::public.captured_request_status
                         else 'declined'::public.captured_request_status end,
           resolved_at = now()
     where c.appointment_id = new.id and c.status = 'pending';
  end if;
  return null;
end;
$$;

revoke all on function private.sync_captured_request_status() from public;

create trigger appointments_sync_captured_requests
  after update of status on public.appointments
  for each row when (old.status is distinct from new.status)
  execute function private.sync_captured_request_status();

-- ---------------------------------------------------------------------------
-- Member actions that don't map to an appointment status change.
--   dismiss            : not a real request; releases its slot quietly (reason 'ignored').
--   cancel_appointment : the client asked to cancel; cancels the appointment it refers to.
-- ---------------------------------------------------------------------------

create or replace function public.resolve_captured_request(p_request_id uuid, p_action text)
returns public.captured_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.captured_requests;
begin
  select * into v_req from public.captured_requests where id = p_request_id for update;
  if not found or not private.is_salon_member(v_req.salon_id) then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'This request was already handled' using errcode = '22023';
  end if;

  if p_action = 'dismiss' then
    update public.captured_requests
       set status = 'dismissed', resolved_at = now()
     where id = v_req.id
    returning * into v_req;
    if exists (select 1 from public.appointments a
                where a.id = v_req.appointment_id and a.status in ('held', 'requested')) then
      perform public.set_appointment_status(v_req.appointment_id, 'cancelled', 'ignored');
    end if;
  elsif p_action = 'cancel_appointment' then
    if v_req.intent <> 'cancel' or v_req.target_appointment_id is null then
      raise exception 'This request has no appointment to cancel' using errcode = '22023';
    end if;
    perform public.set_appointment_status(v_req.target_appointment_id, 'cancelled',
                                          'Cancelled by client');
    update public.captured_requests
       set status = 'approved', resolved_at = now()
     where id = v_req.id
    returning * into v_req;
  else
    raise exception 'Unknown action %', p_action using errcode = '22023';
  end if;

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (v_req.salon_id, auth.uid(), 'inbox.request_resolved', 'captured_request',
          v_req.id::text, jsonb_build_object('action', p_action));
  return v_req;
end;
$$;

revoke all on function public.rotate_inbox_bridge_token(uuid) from public, anon;
revoke all on function public.inbox_bridge_for_token(text, integer) from public, anon, authenticated;
revoke all on function public.capture_inbox_request(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.resolve_captured_request(uuid, text) from public, anon;
grant execute on function public.rotate_inbox_bridge_token(uuid) to authenticated;
grant execute on function public.inbox_bridge_for_token(text, integer) to service_role;
grant execute on function public.capture_inbox_request(uuid, jsonb) to service_role;
grant execute on function public.resolve_captured_request(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: the Inbox updates live when a text arrives.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'captured_requests'
  ) then
    alter publication supabase_realtime add table public.captured_requests;
  end if;
end;
$$;
