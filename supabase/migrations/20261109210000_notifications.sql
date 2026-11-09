-- Push notifications (docs/PLAN.md §1 and §7, issue #8).
--
-- Flow:
--   1. Triggers on public.appointments enqueue rows in public.notifications_outbox when an
--      appointment becomes `requested` (actionable push) or is cancelled by someone else.
--   2. pg_cron (every minute) enqueues the follow-up nudge for unanswered requests
--      (settings.followup_nudge_hours), the 8am daily agenda (salon timezone), releases requests
--      nobody answered, and pokes the `notifier` Edge Function through pg_net.
--   3. The notifier claims due rows (claim_notifications skips quiet hours and stale requests),
--      sends them through Expo Push and reports back with finish_notifications.
--
-- Request lifecycle (PLAN.md §1, "Unanswered requests"):
--   requested_at ── followup_nudge_hours ──▶ nudge "You haven't responded…" [Respond] [Ignore]
--                └─ + hold_expiry_hours ───▶ released (status cancelled, reason request_expired)
--   Ignore = set_appointment_status(cancelled, 'ignored') from the notification action.
--
-- Delivery needs two Vault secrets (see supabase/README.md): `notifier_url` and `notifier_secret`.
-- Without them the outbox just accumulates (local dev and tests).

create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- Settings: nudge delay (followup_nudge_hours, foundation), hold expiry (hold_expiry_hours,
-- foundation), quiet hours and the daily agenda.
-- ---------------------------------------------------------------------------

alter table public.settings
  add column quiet_hours_enabled  boolean not null default false,
  add column quiet_hours_start    time not null default '21:00',
  add column quiet_hours_end      time not null default '07:00',
  add column daily_agenda_enabled boolean not null default true,
  add constraint settings_quiet_hours_distinct check (quiet_hours_start <> quiet_hours_end);

comment on column public.settings.followup_nudge_hours is
  'Unanswered requests get a follow-up push this long after they arrive.';
comment on column public.settings.hold_expiry_hours is
  'Held slots are released this long after booking; unanswered requests this long after the nudge.';
comment on column public.settings.quiet_hours_start is
  'Wall-clock time in the salon timezone. Pushes due during quiet hours wait until they end.';
comment on column public.settings.daily_agenda_enabled is
  'Push the day''s appointments at 8am (salon timezone).';

-- ---------------------------------------------------------------------------
-- appointments.requested_at: when the appointment last became `requested`.
-- ---------------------------------------------------------------------------

alter table public.appointments add column requested_at timestamptz;

comment on column public.appointments.requested_at is
  'When the appointment last became requested; drives the follow-up nudge and request expiry.';

update public.appointments set requested_at = created_at where status = 'requested';

-- True when [p_starts, p_ends) touches a Tentative block of the salon's resolved work hours.
-- Resolution mirrors packages/core/src/hours: a date override beats the weekly template; among
-- overlapping overrides the shorter range wins, then the most recently updated.
create or replace function private.overlaps_tentative_hours(
  p_salon_id uuid,
  p_starts   timestamptz,
  p_ends     timestamptz
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz     text;
  v_day    date;
  v_last   date;
  v_blocks jsonb;
  v_block  jsonb;
begin
  select s.timezone into v_tz from public.salons s where s.id = p_salon_id;
  if v_tz is null or p_ends <= p_starts then
    return false;
  end if;

  v_day := (p_starts at time zone v_tz)::date;
  v_last := ((p_ends - interval '1 microsecond') at time zone v_tz)::date;
  while v_day <= v_last loop
    v_blocks := null;
    select o.blocks into v_blocks
      from public.work_hours_override o
     where o.salon_id = p_salon_id and v_day between o.start_date and o.end_date
     order by o.end_date - o.start_date, o.updated_at desc
     limit 1;
    if not found then
      select t.blocks into v_blocks
        from public.work_hours_template t
       where t.salon_id = p_salon_id and t.weekday = extract(dow from v_day)::smallint;
    end if;

    for v_block in select value from jsonb_array_elements(coalesce(v_blocks, '[]'::jsonb)) loop
      -- `24:00` is a valid Postgres time, so date + time lands on the next midnight.
      if v_block ->> 'type' = 'tentative'
         and ((v_day + (v_block ->> 'start')::time) at time zone v_tz) < p_ends
         and p_starts < ((v_day + (v_block ->> 'end')::time) at time zone v_tz)
      then
        return true;
      end if;
    end loop;
    v_day := v_day + 1;
  end loop;
  return false;
end;
$$;

revoke all on function private.overlaps_tentative_hours(uuid, timestamptz, timestamptz) from public;
grant execute on function private.overlaps_tentative_hours(uuid, timestamptz, timestamptz)
  to authenticated, service_role;

-- * Tentative hours are bookable but always need his approval (PLAN.md §1): a confirmation that
--   does not come from a salon member (inbox, public booking page, client confirming a hold)
--   becomes a request when it touches Tentative time.
-- * Stamps requested_at whenever the appointment becomes requested.
create or replace function private.appointment_request_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'confirmed'
     and (tg_op = 'INSERT' or old.status = 'held')
     and not private.is_salon_member(new.salon_id)
     and private.overlaps_tentative_hours(new.salon_id, new.starts_at, new.ends_at)
  then
    new.status := 'requested';
  end if;

  if new.status = 'requested' and (tg_op = 'INSERT' or old.status is distinct from 'requested') then
    new.requested_at := now();
  end if;
  return new;
end;
$$;

revoke all on function private.appointment_request_rules() from public;

create trigger appointments_request_rules
  before insert or update of status on public.appointments
  for each row execute function private.appointment_request_rules();

-- ---------------------------------------------------------------------------
-- notifications_outbox
-- ---------------------------------------------------------------------------

create type public.notification_kind as enum
  ('request', 'request_nudge', 'cancellation', 'daily_agenda');
create type public.notification_status as enum ('pending', 'sending', 'sent', 'skipped', 'failed');

create table public.notifications_outbox (
  id             uuid primary key default gen_random_uuid(),
  salon_id       uuid not null references public.salons (id) on delete cascade,
  -- Recipient; the notifier sends to every push token this user registered for the salon.
  user_id        uuid not null references auth.users (id) on delete cascade,
  kind           public.notification_kind not null,
  appointment_id uuid references public.appointments (id) on delete cascade,
  title          text not null check (char_length(title) between 1 and 200),
  body           text not null check (char_length(body) between 1 and 1000),
  -- iOS notification category (action buttons); see packages/notifications/src/categories.ts.
  category       text check (category is null or category ~ '^[A-Za-z0-9_]{1,64}$'),
  data           jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  -- Makes enqueueing idempotent (cron jobs re-run every minute).
  dedupe_key     text not null unique check (char_length(dedupe_key) between 1 and 300),
  status         public.notification_status not null default 'pending',
  send_after     timestamptz not null default now(),
  attempts       integer not null default 0 check (attempts >= 0),
  claimed_at     timestamptz,
  sent_at        timestamptz,
  last_error     text check (last_error is null or char_length(last_error) <= 1000),
  tickets        jsonb,
  created_at     timestamptz not null default now()
);

comment on table public.notifications_outbox is
  'Pushes waiting for (or already through) the notifier Edge Function. Written by triggers and cron.';

create index notifications_outbox_due_idx on public.notifications_outbox (send_after)
  where status in ('pending', 'sending');
create index notifications_outbox_appointment_idx on public.notifications_outbox (appointment_id);
create index notifications_outbox_user_idx on public.notifications_outbox (user_id, created_at desc);

alter table public.notifications_outbox enable row level security;
revoke all on public.notifications_outbox from anon;
revoke insert, update, delete, truncate on public.notifications_outbox from authenticated;

create policy "users read their own notifications" on public.notifications_outbox
  for select to authenticated
  using (user_id = (select auth.uid()) and private.is_salon_member(salon_id));

create or replace function private.enqueue_notification(
  p_salon_id       uuid,
  p_user_id        uuid,
  p_kind           public.notification_kind,
  p_appointment_id uuid,
  p_title          text,
  p_body           text,
  p_category       text,
  p_data           jsonb,
  p_dedupe_key     text,
  p_send_after     timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.notifications_outbox
    (salon_id, user_id, kind, appointment_id, title, body, category, data, dedupe_key, send_after)
  values
    (p_salon_id, p_user_id, p_kind, p_appointment_id, left(p_title, 200), left(p_body, 1000),
     p_category, coalesce(p_data, '{}'::jsonb), p_dedupe_key, coalesce(p_send_after, now()))
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function private.enqueue_notification(uuid, uuid, public.notification_kind, uuid,
  text, text, text, jsonb, text, timestamptz) from public;

-- "Fri, Nov 13 at 2:00 PM" in the salon's timezone.
create or replace function private.format_local_datetime(p_at timestamptz, p_tz text)
returns text
language sql
stable
set search_path = ''
as $$
  select to_char(p_at at time zone p_tz, 'Dy, Mon FMDD "at" FMHH12:MI AM');
$$;

-- "Balayage + Trim (Long)" from the appointment's services snapshot (null when empty).
create or replace function private.appointment_services_label(p_services jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(string_agg(
           (e ->> 'name') || coalesce(' (' || (e ->> 'variantName') || ')', ''),
           ' + ' order by o), '')
    from jsonb_array_elements(coalesce(p_services, '[]'::jsonb)) with ordinality as t(e, o)
   where jsonb_typeof(e) = 'object' and e ->> 'name' is not null;
$$;

create or replace function private.appointment_client_name(p_client_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select c.name from public.clients c where c.id = p_client_id), 'A client');
$$;

revoke all on function private.format_local_datetime(timestamptz, text) from public;
revoke all on function private.appointment_services_label(jsonb) from public;
revoke all on function private.appointment_client_name(uuid) from public;

-- New requests (actionable) and cancellations he didn't make himself.
create or replace function private.enqueue_appointment_notifications()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz      text;
  v_name    text;
  v_when    text;
  v_what    text;
  v_title   text;
begin
  -- The stylist acting on their own appointment never needs to be told about it.
  if auth.uid() is not distinct from new.stylist_id then
    return null;
  end if;

  select s.timezone into v_tz from public.salons s where s.id = new.salon_id;
  v_name := private.appointment_client_name(new.client_id);
  v_when := private.format_local_datetime(new.starts_at, v_tz);
  v_what := private.appointment_services_label(new.services);

  if new.status = 'requested' and (tg_op = 'INSERT' or old.status is distinct from 'requested') then
    perform private.enqueue_notification(
      new.salon_id, new.stylist_id, 'request', new.id,
      'New request from ' || v_name,
      v_when || coalesce(' · ' || v_what, ''),
      'appointmentRequest',
      jsonb_build_object('type', 'request', 'salonId', new.salon_id, 'appointmentId', new.id),
      'request:' || new.id || ':' || extract(epoch from new.requested_at)::text);
  elsif tg_op = 'UPDATE'
        and new.status = 'cancelled'
        and old.status in ('requested', 'confirmed')
        and coalesce(new.cancel_reason, '') <> 'ignored'
  then
    v_title := case
      when new.cancel_reason = 'request_expired' then v_name || '''s request expired'
      else v_name || ' cancelled'
    end;
    perform private.enqueue_notification(
      new.salon_id, new.stylist_id, 'cancellation', new.id,
      v_title,
      v_when || coalesce(' · ' || v_what, '') || '. The time is free again.',
      null,
      jsonb_build_object('type', 'cancellation', 'salonId', new.salon_id, 'appointmentId', new.id),
      'cancellation:' || new.id || ':' || extract(epoch from coalesce(new.cancelled_at, now()))::text);
  end if;
  return null;
end;
$$;

revoke all on function private.enqueue_appointment_notifications() from public;

create trigger appointments_enqueue_notifications
  after insert or update of status on public.appointments
  for each row execute function private.enqueue_appointment_notifications();

-- ---------------------------------------------------------------------------
-- Quiet hours (salon timezone). Start > end wraps midnight, e.g. 21:00 → 07:00.
-- ---------------------------------------------------------------------------

create or replace function private.in_quiet_hours(p_salon_id uuid, p_at timestamptz default now())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select st.quiet_hours_enabled and case
             when st.quiet_hours_start < st.quiet_hours_end then
               (p_at at time zone s.timezone)::time >= st.quiet_hours_start
               and (p_at at time zone s.timezone)::time < st.quiet_hours_end
             else
               (p_at at time zone s.timezone)::time >= st.quiet_hours_start
               or (p_at at time zone s.timezone)::time < st.quiet_hours_end
           end
      from public.settings st
      join public.salons s on s.id = st.salon_id
     where st.salon_id = p_salon_id), false);
$$;

revoke all on function private.in_quiet_hours(uuid, timestamptz) from public;
grant execute on function private.in_quiet_hours(uuid, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Scheduled work (pg_cron, every minute). Each takes p_now so tests can time-travel.
-- ---------------------------------------------------------------------------

-- "You haven't responded to Karina's request" [Respond] [Ignore], followup_nudge_hours after it
-- arrived. One nudge per request (dedupe on requested_at); requests he made himself aren't nudged.
create or replace function private.enqueue_request_nudges(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with due as (
    select a.id, a.salon_id, a.stylist_id, a.client_id, a.starts_at, a.services, a.requested_at,
           s.timezone
      from public.appointments a
      join public.settings st on st.salon_id = a.salon_id
      join public.salons s on s.id = a.salon_id
     where a.status = 'requested'
       and a.requested_at is not null
       and a.requested_at + make_interval(hours => st.followup_nudge_hours) <= p_now
       and a.starts_at > p_now
       -- Only requests he was pushed about (not ones he created himself).
       and exists (select 1 from public.notifications_outbox o
                    where o.dedupe_key = 'request:' || a.id || ':'
                                         || extract(epoch from a.requested_at)::text)
  ), queued as (
    insert into public.notifications_outbox
      (salon_id, user_id, kind, appointment_id, title, body, category, data, dedupe_key)
    select d.salon_id, d.stylist_id, 'request_nudge', d.id,
           'You haven''t responded to ' || private.appointment_client_name(d.client_id) || '''s request',
           private.format_local_datetime(d.starts_at, d.timezone)
             || coalesce(' · ' || private.appointment_services_label(d.services), '')
             || '. Respond, or ignore to release the time.',
           'requestNudge',
           jsonb_build_object('type', 'request_nudge', 'salonId', d.salon_id, 'appointmentId', d.id),
           'request_nudge:' || d.id || ':' || extract(epoch from d.requested_at)::text
      from due d
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select count(*)::integer into v_count from queued;
  return v_count;
end;
$$;

-- Requests nobody answered: released hold_expiry_hours after the nudge (or once their start time
-- has passed). Cancelling frees the time and alerts him ("Karina's request expired").
create or replace function private.release_unanswered_requests(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with released as (
    update public.appointments a
       set status = 'cancelled', cancelled_at = p_now, cancel_reason = 'request_expired'
      from public.settings st
     where st.salon_id = a.salon_id
       and a.status = 'requested'
       and a.requested_at is not null
       and (a.requested_at
              + make_interval(hours => st.followup_nudge_hours + st.hold_expiry_hours) <= p_now
            or a.starts_at <= p_now)
    returning a.id, a.salon_id, a.requested_at
  ), logged as (
    insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
    select salon_id, null, 'appointment.request_expired', 'appointment', id::text,
           jsonb_build_object('requested_at', requested_at)
      from released
    returning 1
  )
  select count(*)::integer into v_count from logged;
  return v_count;
end;
$$;

-- The 8am agenda (salon timezone): one push per stylist with appointments or requests that day.
-- Enqueued from 8:00 until noon so a missed tick still sends it; quiet hours may delay delivery.
create or replace function private.enqueue_daily_agendas(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with salons_due as (
    select s.id as salon_id, s.timezone, (p_now at time zone s.timezone)::date as day
      from public.salons s
      join public.settings st on st.salon_id = s.id
     where st.daily_agenda_enabled
       and (p_now at time zone s.timezone)::time >= time '08:00'
       and (p_now at time zone s.timezone)::time < time '12:00'
  ), per_stylist as (
    select d.salon_id, d.timezone, d.day, a.stylist_id,
           count(*) filter (where a.status = 'confirmed')::integer as booked,
           count(*) filter (where a.status = 'requested')::integer as requests,
           (array_agg(a.id order by a.starts_at) filter (where a.status = 'confirmed'))[1] as first_id
      from salons_due d
      join public.appointments a
        on a.salon_id = d.salon_id
       and a.status in ('confirmed', 'requested')
       and a.starts_at >= (d.day::timestamp at time zone d.timezone)
       and a.starts_at < ((d.day + 1)::timestamp at time zone d.timezone)
     group by d.salon_id, d.timezone, d.day, a.stylist_id
  ), queued as (
    insert into public.notifications_outbox
      (salon_id, user_id, kind, title, body, data, dedupe_key)
    select p.salon_id, p.stylist_id, 'daily_agenda',
           case p.booked
             when 0 then 'Today: no appointments yet'
             when 1 then 'Today: 1 appointment'
             else 'Today: ' || p.booked || ' appointments'
           end,
           concat_ws(' ',
             case when f.id is not null then
               'First up: ' || private.appointment_client_name(f.client_id) || ' at '
               || to_char(f.starts_at at time zone p.timezone, 'FMHH12:MI AM') || '.'
             end,
             case p.requests
               when 0 then null
               when 1 then '1 request is waiting for you.'
               else p.requests || ' requests are waiting for you.'
             end),
           jsonb_build_object('type', 'daily_agenda', 'salonId', p.salon_id, 'date', p.day),
           'daily_agenda:' || p.salon_id || ':' || p.stylist_id || ':' || p.day
      from per_stylist p
      left join public.appointments f on f.id = p.first_id
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select count(*)::integer into v_count from queued;
  return v_count;
end;
$$;

-- Pokes the notifier when something is due. Reads its URL and shared secret from Vault; does
-- nothing until both exist (local dev, tests).
create or replace function private.dispatch_notifications()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
begin
  if not exists (
    select 1 from public.notifications_outbox o
     where o.status = 'pending' and o.send_after <= now()
  ) then
    return null;
  end if;

  select d.decrypted_secret into v_url from vault.decrypted_secrets d where d.name = 'notifier_url';
  select d.decrypted_secret into v_secret
    from vault.decrypted_secrets d where d.name = 'notifier_secret';
  if v_url is null or v_secret is null then
    return null;
  end if;

  return net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notifier-secret', v_secret),
    timeout_milliseconds := 30000);
end;
$$;

create or replace function private.notifications_tick(p_now timestamptz default now())
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.release_unanswered_requests(p_now);
  perform private.enqueue_request_nudges(p_now);
  perform private.enqueue_daily_agendas(p_now);
  perform private.dispatch_notifications();
end;
$$;

revoke all on function private.enqueue_request_nudges(timestamptz) from public;
revoke all on function private.release_unanswered_requests(timestamptz) from public;
revoke all on function private.enqueue_daily_agendas(timestamptz) from public;
revoke all on function private.dispatch_notifications() from public;
revoke all on function private.notifications_tick(timestamptz) from public;

select cron.schedule('notifications-tick', '* * * * *', 'select private.notifications_tick()');

-- ---------------------------------------------------------------------------
-- Notifier RPCs (service_role only)
-- ---------------------------------------------------------------------------

-- Claims up to p_limit due rows (pending, or stuck in `sending` for 5+ minutes) outside the
-- salon's quiet hours. Request pushes whose appointment is no longer `requested` are skipped first.
create or replace function public.claim_notifications(p_limit integer default 100)
returns setof public.notifications_outbox
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.notifications_outbox o
     set status = 'skipped', last_error = 'appointment_no_longer_requested'
    from public.appointments a
   where a.id = o.appointment_id
     and o.kind in ('request', 'request_nudge')
     and o.status in ('pending', 'sending')
     and a.status <> 'requested';

  return query
  with due as (
    select o.id
      from public.notifications_outbox o
     where ((o.status = 'pending' and o.send_after <= now())
            or (o.status = 'sending' and o.claimed_at < now() - interval '5 minutes'))
       and not private.in_quiet_hours(o.salon_id, now())
     order by o.send_after, o.created_at
     limit greatest(1, least(coalesce(p_limit, 100), 500))
     for update of o skip locked
  )
  update public.notifications_outbox o
     set status = 'sending', claimed_at = now(), attempts = o.attempts + 1
    from due
   where o.id = due.id
  returning o.*;
end;
$$;

-- p_results: [{ "id", "outcome": "sent" | "skipped" | "retry", "error"?, "tickets"? }].
-- `retry` backs off 2^attempts minutes and gives up (failed) after 5 attempts.
create or replace function public.finish_notifications(p_results jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_results is null or jsonb_typeof(p_results) <> 'array' then
    raise exception 'p_results must be an array' using errcode = '22023';
  end if;

  with r as (
    select (e ->> 'id')::uuid as id, e ->> 'outcome' as outcome,
           left(e ->> 'error', 1000) as error, e -> 'tickets' as tickets
      from jsonb_array_elements(p_results) e
     where e ->> 'outcome' in ('sent', 'skipped', 'retry')
  ), done as (
    update public.notifications_outbox o
       set status = case
                      when r.outcome = 'sent' then 'sent'::public.notification_status
                      when r.outcome = 'skipped' then 'skipped'::public.notification_status
                      when o.attempts >= 5 then 'failed'::public.notification_status
                      else 'pending'::public.notification_status
                    end,
           sent_at = case when r.outcome = 'sent' then now() end,
           send_after = case
                          when r.outcome = 'retry'
                          then now() + make_interval(mins => power(2, least(o.attempts, 10))::integer)
                          else o.send_after
                        end,
           last_error = r.error,
           tickets = coalesce(r.tickets, o.tickets)
      from r
     where o.id = r.id and o.status = 'sending'
    returning 1
  )
  select count(*)::integer into v_count from done;
  return v_count;
end;
$$;

revoke all on function public.claim_notifications(integer) from public, anon, authenticated;
revoke all on function public.finish_notifications(jsonb) from public, anon, authenticated;
grant execute on function public.claim_notifications(integer) to service_role;
grant execute on function public.finish_notifications(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Push token registration (expo-notifications, on sign-in). A device token belongs to whoever
-- signed in on it last, so re-registering moves it to the caller.
-- ---------------------------------------------------------------------------

create or replace function public.register_push_token(
  p_salon_id uuid,
  p_token    text,
  p_platform public.push_platform
)
returns public.push_tokens
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.push_tokens;
begin
  if auth.uid() is null or not private.is_salon_member(p_salon_id) then
    raise exception 'Not a member of this salon' using errcode = '42501';
  end if;
  if p_token is null or char_length(btrim(p_token)) not between 1 and 255 then
    raise exception 'Invalid push token' using errcode = '22023';
  end if;

  insert into public.push_tokens (salon_id, user_id, token, platform)
  values (p_salon_id, auth.uid(), btrim(p_token), p_platform)
  on conflict (salon_id, token) do update
    set user_id = excluded.user_id, platform = excluded.platform, last_seen_at = now()
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function public.register_push_token(uuid, text, public.push_platform)
  from public, anon;
grant execute on function public.register_push_token(uuid, text, public.push_platform)
  to authenticated;
