-- Client self-service (docs/PLAN.md §7, issue #10).
--
--   * Every appointment gets an unguessable manage link (/m/<manage_token>). The signed-out
--     `manage-booking` Edge Function reads, cancels and reschedules through the service-role RPCs
--     below, which only ever touch the one appointment behind the token.
--   * Client emails (confirmation with an .ics invite, reminders, rescheduled, cancelled) queue in
--     public.client_email_outbox. The `notifier` Edge Function (the same one that sends pushes)
--     drains it through Resend or SMTP. See supabase/docs/client-self-service.md.
--   * Reminder emails go out settings.client_reminder_hours before the start (48h and 2h by
--     default). The `client-emails-tick` pg_cron job enqueues them and pokes the notifier, like
--     payout-summary-tick does: it reuses pg_net, the Vault secrets and the notifier rather than
--     redefining private.notifications_tick, so parallel migrations can't clobber each other.
--   * The reminder queue: tomorrow's confirmed clients, so he can text each one from his phone.
--   * Cancellation policy hook: private.client_change_policy decides whether a client may still
--     cancel or move, and private.on_client_change runs after they do. #12 (deposits and the
--     cancellation policy) replaces them with `create or replace` to add cutoffs and fees.
--
-- Cancelling from the link uses set_appointment_status, so the slot frees immediately and the
-- existing "X cancelled" push reaches the stylist.

-- ---------------------------------------------------------------------------
-- Appointments: manage link, text reminder stamp
-- ---------------------------------------------------------------------------

alter table public.appointments
  add column manage_token text not null unique
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
    check (manage_token ~ '^[0-9a-f]{64}$'),
  add column text_reminder_sent_at timestamptz;

comment on column public.appointments.manage_token is
  'Unguessable token for the client''s manage link (/m/<token>): view, reschedule, cancel.';
comment on column public.appointments.text_reminder_sent_at is
  'When he texted the client a reminder from the reminder queue.';

create index appointments_confirmed_starts_idx on public.appointments (starts_at)
  where status = 'confirmed';

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

create or replace function private.valid_reminder_hours(p_hours integer[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_hours is not null
     and coalesce(cardinality(p_hours), 0) <= 3
     and array_position(p_hours, null) is null
     and coalesce((select bool_and(h between 1 and 168) from unnest(p_hours) h), true)
     and (select count(distinct h) from unnest(p_hours) h) = coalesce(cardinality(p_hours), 0);
$$;

revoke all on function private.valid_reminder_hours(integer[]) from public;
grant execute on function private.valid_reminder_hours(integer[]) to authenticated, service_role;

alter table public.settings
  add column client_emails_enabled boolean not null default true,
  add column client_reminder_hours integer[] not null default '{48,2}'
    check (private.valid_reminder_hours(client_reminder_hours)),
  add column client_self_service_enabled boolean not null default true;

comment on column public.settings.client_emails_enabled is
  'Email clients a confirmation (with a calendar invite), reminders and changes.';
comment on column public.settings.client_reminder_hours is
  'Reminder emails go out this many hours before the start (up to 3, each 1-168).';
comment on column public.settings.client_self_service_enabled is
  'Clients may cancel or reschedule from their manage link.';

-- ---------------------------------------------------------------------------
-- client_email_outbox
-- ---------------------------------------------------------------------------

create type public.client_email_kind as enum ('confirmation', 'reminder', 'rescheduled', 'cancellation');

create table public.client_email_outbox (
  id             uuid primary key default gen_random_uuid(),
  salon_id       uuid not null references public.salons (id) on delete cascade,
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  kind           public.client_email_kind not null,
  -- The appointment's start when queued: a later move makes the email stale (skipped).
  starts_at      timestamptz not null,
  reminder_hours integer check (reminder_hours is null or reminder_hours between 1 and 168),
  -- Recipient, stamped when claimed (the client's current email).
  to_email       text check (to_email is null or char_length(to_email) <= 254),
  dedupe_key     text not null unique check (char_length(dedupe_key) between 1 and 300),
  status         public.notification_status not null default 'pending',
  send_after     timestamptz not null default now(),
  attempts       integer not null default 0 check (attempts >= 0),
  claimed_at     timestamptz,
  sent_at        timestamptz,
  last_error     text check (last_error is null or char_length(last_error) <= 1000),
  provider_id    text check (provider_id is null or char_length(provider_id) <= 200),
  created_at     timestamptz not null default now()
);

comment on table public.client_email_outbox is
  'Client emails waiting for (or already through) the notifier Edge Function.';

create index client_email_outbox_due_idx on public.client_email_outbox (send_after)
  where status in ('pending', 'sending');
create index client_email_outbox_appointment_idx on public.client_email_outbox (appointment_id);

alter table public.client_email_outbox enable row level security;
revoke all on public.client_email_outbox from anon;
revoke insert, update, delete, truncate on public.client_email_outbox from authenticated;

create policy "members read their salon's client emails" on public.client_email_outbox
  for select to authenticated
  using (private.is_salon_member(salon_id));

-- Queues one email if the salon sends client emails, the client has an address and the
-- appointment hasn't started. Returns the new row id (null when skipped or a duplicate).
create or replace function private.enqueue_client_email(
  p_appointment    public.appointments,
  p_kind           public.client_email_kind,
  p_dedupe_key     text,
  p_reminder_hours integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_appointment.client_id is null or p_appointment.starts_at <= now() then
    return null;
  end if;
  if not exists (select 1 from public.settings st
                  where st.salon_id = p_appointment.salon_id and st.client_emails_enabled) then
    return null;
  end if;
  if not exists (select 1 from public.clients c
                  where c.id = p_appointment.client_id and c.email is not null) then
    return null;
  end if;

  insert into public.client_email_outbox
    (salon_id, appointment_id, kind, starts_at, reminder_hours, dedupe_key)
  values
    (p_appointment.salon_id, p_appointment.id, p_kind, p_appointment.starts_at, p_reminder_hours,
     p_dedupe_key)
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function private.enqueue_client_email(public.appointments, public.client_email_kind,
  text, integer) from public;

-- Confirmation when an appointment becomes confirmed (imports excluded: those clients already
-- know), "moved" when a confirmed appointment changes day or shifts by an hour or more (small
-- running-late nudges don't email), and "cancelled" when a confirmed appointment is cancelled.
create or replace function private.enqueue_appointment_client_emails()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz text;
begin
  if new.status = 'confirmed'
     and (tg_op = 'INSERT' or old.status in ('held', 'requested'))
     and new.source <> 'import'
  then
    perform private.enqueue_client_email(new, 'confirmation', 'confirmation:' || new.id);
  elsif tg_op = 'UPDATE'
        and new.status = 'confirmed' and old.status = 'confirmed'
        and new.starts_at <> old.starts_at
  then
    select s.timezone into v_tz from public.salons s where s.id = new.salon_id;
    if abs(extract(epoch from new.starts_at - old.starts_at)) >= 3600
       or (new.starts_at at time zone v_tz)::date <> (old.starts_at at time zone v_tz)::date
    then
      perform private.enqueue_client_email(
        new, 'rescheduled',
        'rescheduled:' || new.id || ':' || extract(epoch from new.starts_at)::text || ':'
          || extract(epoch from clock_timestamp())::text);
    end if;
  elsif tg_op = 'UPDATE' and new.status = 'cancelled' and old.status = 'confirmed' then
    perform private.enqueue_client_email(new, 'cancellation', 'cancellation:' || new.id);
  end if;
  return null;
end;
$$;

revoke all on function private.enqueue_appointment_client_emails() from public;

create trigger appointments_enqueue_client_emails
  after insert or update of status, starts_at on public.appointments
  for each row execute function private.enqueue_appointment_client_emails();

-- Reminder emails. For each confirmed appointment, a reminder for `h` is due once now is within
-- h hours of the start, provided the booking (or its latest move) is older than that. Only the
-- smallest due `h` is queued, so a missed tick or a late booking never sends two at once.
create or replace function private.enqueue_client_reminders(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  r       record;
begin
  for r in
    select a, due.h
      from public.appointments a
      join public.settings st on st.salon_id = a.salon_id and st.client_emails_enabled
      join public.clients c on c.id = a.client_id and c.email is not null
      cross join lateral (
        select greatest(a.created_at, coalesce((
                 select max(o.created_at) from public.client_email_outbox o
                  where o.appointment_id = a.id and o.kind in ('confirmation', 'rescheduled')),
                 a.created_at)) as anchor
      ) last_change
      cross join lateral (
        select min(h) as h
          from unnest(st.client_reminder_hours) h
         where p_now >= a.starts_at - make_interval(hours => h)
           and last_change.anchor <= a.starts_at - make_interval(hours => h)
      ) due
     where a.status = 'confirmed'
       and a.starts_at > p_now
       and a.starts_at <= p_now + interval '169 hours'
       and due.h is not null
  loop
    if private.enqueue_client_email(
         r.a, 'reminder',
         'reminder:' || (r.a).id || ':' || r.h || ':' || extract(epoch from (r.a).starts_at)::text,
         r.h) is not null then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

-- Pokes the notifier when a client email is due (same Vault secrets as dispatch_notifications).
create or replace function private.dispatch_client_emails()
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
    select 1 from public.client_email_outbox o
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

create or replace function private.client_emails_tick(p_now timestamptz default now())
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.enqueue_client_reminders(p_now);
  perform private.dispatch_client_emails();
end;
$$;

revoke all on function private.enqueue_client_reminders(timestamptz) from public;
revoke all on function private.dispatch_client_emails() from public;
revoke all on function private.client_emails_tick(timestamptz) from public;

select cron.schedule('client-emails-tick', '* * * * *', 'select private.client_emails_tick()');

-- ---------------------------------------------------------------------------
-- Notifier RPCs (service_role only)
-- ---------------------------------------------------------------------------

-- Claims up to p_limit due emails and returns what the notifier needs to render each one:
-- [{ id, kind, to, reminderHours, salon: { name, slug, timezone }, clientName, startsAt, endsAt,
--    services, manageToken, appointmentId, sequence }].
-- Emails that no longer make sense are skipped first: the appointment moved, was cancelled or has
-- started, the client has no email, or the salon turned client emails off.
create or replace function public.claim_client_emails(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  update public.client_email_outbox o
     set status = 'skipped',
         last_error = case
           when not st.client_emails_enabled then 'client_emails_disabled'
           when c.email is null then 'no_email'
           when o.kind = 'cancellation' then 'appointment_not_cancelled'
           else 'appointment_changed'
         end
    from public.appointments a
    join public.settings st on st.salon_id = a.salon_id
    left join public.clients c on c.id = a.client_id
   where a.id = o.appointment_id
     and o.status in ('pending', 'sending')
     and (not st.client_emails_enabled
          or c.email is null
          or (o.kind = 'cancellation' and a.status <> 'cancelled')
          or (o.kind <> 'cancellation'
              and (a.status <> 'confirmed' or a.starts_at <> o.starts_at or a.starts_at <= now())));

  with due as (
    select o.id
      from public.client_email_outbox o
     where (o.status = 'pending' and o.send_after <= now())
        or (o.status = 'sending' and o.claimed_at < now() - interval '5 minutes')
     order by o.send_after, o.created_at
     limit greatest(1, least(coalesce(p_limit, 50), 200))
     for update of o skip locked
  ), claimed as (
    update public.client_email_outbox o
       set status = 'sending', claimed_at = now(), attempts = o.attempts + 1,
           to_email = (select c.email from public.appointments a
                         join public.clients c on c.id = a.client_id
                        where a.id = o.appointment_id)
      from due
     where o.id = due.id
    returning o.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', cl.id,
           'kind', cl.kind,
           'to', cl.to_email,
           'reminderHours', cl.reminder_hours,
           'appointmentId', a.id,
           'salon', jsonb_build_object('name', s.name, 'slug', s.slug, 'timezone', s.timezone),
           'clientName', c.name,
           'startsAt', a.starts_at,
           'endsAt', a.ends_at,
           'services', private.appointment_services_label(a.services),
           'manageToken', a.manage_token,
           -- iCalendar SEQUENCE: each move or cancellation must outrank the last invite.
           'sequence', (select count(*)::integer from public.client_email_outbox x
                         where x.appointment_id = a.id
                           and x.kind in ('rescheduled', 'cancellation')
                           and x.created_at <= cl.created_at))
           order by cl.send_after), '[]'::jsonb)
    into v_rows
    from claimed cl
    join public.appointments a on a.id = cl.appointment_id
    join public.salons s on s.id = a.salon_id
    left join public.clients c on c.id = a.client_id;
  return v_rows;
end;
$$;

-- p_results: [{ "id", "outcome": "sent" | "skipped" | "retry", "error"?, "providerId"? }].
-- `retry` backs off 2^attempts minutes and gives up (failed) after 5 attempts.
create or replace function public.finish_client_emails(p_results jsonb)
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
           left(e ->> 'error', 1000) as error, left(e ->> 'providerId', 200) as provider_id
      from jsonb_array_elements(p_results) e
     where e ->> 'outcome' in ('sent', 'skipped', 'retry')
  ), done as (
    update public.client_email_outbox o
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
           provider_id = coalesce(r.provider_id, o.provider_id)
      from r
     where o.id = r.id and o.status = 'sending'
    returning 1
  )
  select count(*)::integer into v_count from done;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cancellation policy hook (#12)
-- ---------------------------------------------------------------------------

-- May the client still cancel / reschedule (p_action) this appointment from their link?
-- Returns { allowed, reason?, message?, feeCents }. Today: allowed until it starts, unless the
-- salon turned self-service off. #12 replaces this to add a cutoff window and a late fee.
create or replace function private.client_change_policy(
  p_appointment public.appointments,
  p_action      text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not coalesce((select st.client_self_service_enabled from public.settings st
                    where st.salon_id = p_appointment.salon_id), false) then
    return jsonb_build_object('allowed', false, 'reason', 'disabled', 'feeCents', 0,
      'message', 'Contact the salon to change this appointment.');
  end if;
  if p_appointment.starts_at <= now() then
    return jsonb_build_object('allowed', false, 'reason', 'started', 'feeCents', 0,
      'message', 'This appointment has already started.');
  end if;
  return jsonb_build_object('allowed', true, 'feeCents', 0, 'message', null);
end;
$$;

-- Runs after a client cancels or reschedules from their link, with the policy that allowed it.
-- No-op today; #12 replaces it to charge policy.feeCents (e.g. keep the deposit).
create or replace function private.on_client_change(
  p_appointment public.appointments,
  p_action      text,
  p_policy      jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  return;
end;
$$;

revoke all on function private.client_change_policy(public.appointments, text) from public;
revoke all on function private.on_client_change(public.appointments, text, jsonb) from public;

-- ---------------------------------------------------------------------------
-- Manage link RPCs (service_role only; the manage-booking Edge Function)
-- ---------------------------------------------------------------------------

create or replace function private.appointment_by_manage_token(p_token text)
returns public.appointments
language sql
stable
security definer
set search_path = ''
as $$
  select a.* from public.appointments a
   where p_token ~ '^[0-9a-f]{64}$' and a.manage_token = p_token;
$$;

revoke all on function private.appointment_by_manage_token(text) from public;

-- Only this appointment: salon branding, the client's first name, time, services and what the
-- client may do. salonId/stylistId are for the Edge Function's slot search and are not sent on.
create or replace function public.manage_booking(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_appt   public.appointments;
  v_policy jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only the booking service can read manage links' using errcode = '42501';
  end if;

  v_appt := private.appointment_by_manage_token(p_token);
  if v_appt.id is null then
    return null;
  end if;
  v_policy := private.client_change_policy(v_appt, 'view');

  return (
    select jsonb_build_object(
             'appointmentId', v_appt.id,
             'salonId', v_appt.salon_id,
             'stylistId', v_appt.stylist_id,
             'status', v_appt.status,
             'startsAt', v_appt.starts_at,
             'endsAt', v_appt.ends_at,
             'services', private.appointment_services_label(v_appt.services),
             'clientFirstName', split_part(btrim(c.name), ' ', 1),
             'salon', jsonb_build_object('name', s.name, 'slug', s.slug, 'timezone', s.timezone),
             'canCancel', (v_policy ->> 'allowed')::boolean
                          and v_appt.status in ('held', 'requested', 'confirmed'),
             'canReschedule', (v_policy ->> 'allowed')::boolean
                              and v_appt.status in ('requested', 'confirmed'),
             'policyMessage', v_policy ->> 'message',
             'feeCents', coalesce((v_policy ->> 'feeCents')::integer, 0),
             'segments', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'kind', g.kind, 'label', g.label,
                        'start', lower(g.range), 'end', upper(g.range)) order by g.position)
                 from public.appointment_segments g where g.appointment_id = v_appt.id),
               '[]'::jsonb))
      from public.salons s
      left join public.clients c on c.id = v_appt.client_id
     where s.id = v_appt.salon_id);
end;
$$;

-- Cancels the appointment behind the token. The slot frees at once and the stylist gets the
-- usual "X cancelled" push. Returns { ok: true, status } or { ok: false, reason, message }.
create or replace function public.cancel_booking_by_token(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appt   public.appointments;
  v_policy jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only the booking service can cancel from a link' using errcode = '42501';
  end if;

  v_appt := private.appointment_by_manage_token(p_token);
  if v_appt.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  select * into v_appt from public.appointments where id = v_appt.id for update;
  if v_appt.status = 'cancelled' then
    return jsonb_build_object('ok', true, 'status', 'cancelled', 'alreadyCancelled', true);
  end if;
  if v_appt.status not in ('held', 'requested', 'confirmed') then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed',
      'message', 'This appointment can no longer be cancelled online.');
  end if;

  v_policy := private.client_change_policy(v_appt, 'cancel');
  if not coalesce((v_policy ->> 'allowed')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', coalesce(v_policy ->> 'reason', 'not_allowed'),
      'message', v_policy ->> 'message');
  end if;

  v_appt := public.set_appointment_status(v_appt.id, 'cancelled', 'Cancelled by client');
  perform private.on_client_change(v_appt, 'cancel', v_policy);

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (v_appt.salon_id, null, 'client_self_service.cancelled', 'appointment', v_appt.id::text,
          jsonb_build_object('starts_at', v_appt.starts_at, 'policy', v_policy));

  return jsonb_build_object('ok', true, 'status', v_appt.status,
                            'feeCents', coalesce((v_policy ->> 'feeCents')::integer, 0));
end;
$$;

alter type public.notification_kind add value if not exists 'client_rescheduled';

-- Moves the appointment behind the token to engine-laid-out segments of the same shape (same
-- kinds and durations: a client can't change what was booked). The Edge Function picks the slot
-- with the engine (open hours only); this re-checks the shape, Tentative hours and overlaps.
-- Returns { ok: true, startsAt, endsAt } or { ok: false, reason: 'not_found' | 'not_allowed' |
-- 'disabled' | 'started' | 'invalid' | 'unavailable' | 'conflict', message? }.
create or replace function public.reschedule_booking_by_token(p_token text, p_segments jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appt   public.appointments;
  v_policy jsonb;
  v_from   timestamptz;
  v_tz     text;
  v_shape  jsonb;
  v_new    jsonb;
  v_span   tstzrange;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Only the booking service can reschedule from a link' using errcode = '42501';
  end if;

  v_appt := private.appointment_by_manage_token(p_token);
  if v_appt.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  select * into v_appt from public.appointments where id = v_appt.id for update;
  if v_appt.status not in ('requested', 'confirmed') then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed',
      'message', 'This appointment can no longer be moved online.');
  end if;

  v_policy := private.client_change_policy(v_appt, 'reschedule');
  if not coalesce((v_policy ->> 'allowed')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', coalesce(v_policy ->> 'reason', 'not_allowed'),
      'message', v_policy ->> 'message');
  end if;

  if p_segments is null or jsonb_typeof(p_segments) <> 'array' then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select coalesce(jsonb_agg(jsonb_build_array(g.kind,
                    extract(epoch from upper(g.range) - lower(g.range))::integer) order by g.position),
                  '[]'::jsonb)
    into v_shape
    from public.appointment_segments g where g.appointment_id = v_appt.id;
  begin
    select coalesce(jsonb_agg(jsonb_build_array(e ->> 'kind',
                      extract(epoch from (e ->> 'end')::timestamptz
                                         - (e ->> 'start')::timestamptz)::integer) order by o),
                    '[]'::jsonb)
      into v_new
      from jsonb_array_elements(p_segments) with ordinality as t(e, o);
    v_span := private.appointment_segments_span(p_segments);
  exception when others then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end;
  if v_new <> v_shape then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if lower(v_span) <= now() then
    return jsonb_build_object('ok', false, 'reason', 'unavailable',
      'message', 'Pick a time in the future.');
  end if;
  if private.overlaps_tentative_hours(v_appt.salon_id, lower(v_span), upper(v_span)) then
    return jsonb_build_object('ok', false, 'reason', 'unavailable',
      'message', 'That time needs the salon''s approval. Pick another time or contact them.');
  end if;

  v_from := v_appt.starts_at;
  begin
    v_appt := public.reschedule_appointment(v_appt.id, p_segments);
  exception when exclusion_violation then
    return jsonb_build_object('ok', false, 'reason', 'conflict',
      'message', 'That time was just taken. Pick another time.');
  end;
  perform private.on_client_change(v_appt, 'reschedule', v_policy);

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (v_appt.salon_id, null, 'client_self_service.rescheduled', 'appointment', v_appt.id::text,
          jsonb_build_object('from', v_from, 'to', v_appt.starts_at, 'policy', v_policy));

  -- Tell the stylist (the cancellation push covers cancels; moves need their own).
  select s.timezone into v_tz from public.salons s where s.id = v_appt.salon_id;
  perform private.enqueue_notification(
    v_appt.salon_id, v_appt.stylist_id, 'client_rescheduled', v_appt.id,
    private.appointment_client_name(v_appt.client_id) || ' moved their appointment',
    private.format_local_datetime(v_from, v_tz) || ' → '
      || private.format_local_datetime(v_appt.starts_at, v_tz)
      || coalesce(' · ' || private.appointment_services_label(v_appt.services), ''),
    null,
    jsonb_build_object('type', 'client_rescheduled', 'salonId', v_appt.salon_id,
                       'appointmentId', v_appt.id),
    'client_rescheduled:' || v_appt.id || ':' || extract(epoch from clock_timestamp())::text);

  return jsonb_build_object('ok', true, 'startsAt', v_appt.starts_at, 'endsAt', v_appt.ends_at);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reminder queue (salon members)
-- ---------------------------------------------------------------------------

-- Confirmed appointments on p_day (default: tomorrow in the salon's timezone), for texting each
-- client a reminder from his phone.
create or replace function public.reminder_queue(p_salon_id uuid, p_day date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz  text;
  v_day date;
begin
  if not private.is_salon_member(p_salon_id) then
    raise exception 'Not a member of this salon' using errcode = '42501';
  end if;
  select s.timezone into v_tz from public.salons s where s.id = p_salon_id;
  v_day := coalesce(p_day, (now() at time zone v_tz)::date + 1);

  return jsonb_build_object(
    'day', v_day,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'appointmentId', a.id,
               'clientId', a.client_id,
               'clientName', c.name,
               'phone', c.phone,
               'startsAt', a.starts_at,
               'services', private.appointment_services_label(a.services),
               'manageToken', a.manage_token,
               'textReminderSentAt', a.text_reminder_sent_at) order by a.starts_at)
        from public.appointments a
        left join public.clients c on c.id = a.client_id
       where a.salon_id = p_salon_id
         and a.status = 'confirmed'
         and a.starts_at >= (v_day::timestamp at time zone v_tz)
         and a.starts_at < ((v_day + 1)::timestamp at time zone v_tz)), '[]'::jsonb));
end;
$$;

create or replace function public.mark_text_reminder_sent(
  p_appointment_id uuid,
  p_sent           boolean default true
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_salon uuid;
  v_at    timestamptz;
begin
  select a.salon_id into v_salon from public.appointments a where a.id = p_appointment_id;
  if v_salon is null or not private.is_salon_member(v_salon) then
    raise exception 'Appointment not found' using errcode = 'P0002';
  end if;
  update public.appointments
     set text_reminder_sent_at = case when p_sent then now() end
   where id = p_appointment_id
  returning text_reminder_sent_at into v_at;
  return v_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.claim_client_emails(integer) from public, anon, authenticated;
revoke all on function public.finish_client_emails(jsonb) from public, anon, authenticated;
revoke all on function public.manage_booking(text) from public, anon, authenticated;
revoke all on function public.cancel_booking_by_token(text) from public, anon, authenticated;
revoke all on function public.reschedule_booking_by_token(text, jsonb)
  from public, anon, authenticated;
revoke all on function public.reminder_queue(uuid, date) from public, anon;
revoke all on function public.mark_text_reminder_sent(uuid, boolean) from public, anon;

grant execute on function public.claim_client_emails(integer) to service_role;
grant execute on function public.finish_client_emails(jsonb) to service_role;
grant execute on function public.manage_booking(text) to service_role;
grant execute on function public.cancel_booking_by_token(text) to service_role;
grant execute on function public.reschedule_booking_by_token(text, jsonb) to service_role;
grant execute on function public.reminder_queue(uuid, date) to authenticated, service_role;
grant execute on function public.mark_text_reminder_sent(uuid, boolean)
  to authenticated, service_role;
