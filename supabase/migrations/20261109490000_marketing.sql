-- Marketing (#27): "Time for a touch-up?" rebook nudges, email campaigns to opted-in clients and
-- post-visit review requests. Everything is a row in marketing_messages: drafted for the stylist
-- to approve (or queued straight away with the per-feature auto-send toggle), then claimed and
-- delivered by the `marketing` Edge Function through a channel (email today; SMS plugs in with
-- the Twilio line, #22). Only clients with clients.marketing_opt_in get marketing; every message
-- carries a one-click unsubscribe link (clients.marketing_token). Transactional client emails
-- (#10) are untouched. See supabase/docs/marketing.md.

-- ---------------------------------------------------------------------------
-- Settings & consent
-- ---------------------------------------------------------------------------

alter table public.settings
  add column marketing_nudges_enabled      boolean not null default true,
  add column marketing_nudges_auto_send    boolean not null default false,
  add column marketing_nudge_lead_days     integer not null default 3
    check (marketing_nudge_lead_days between 0 and 21),
  add column marketing_reviews_enabled     boolean not null default true,
  add column marketing_reviews_auto_send   boolean not null default false,
  add column marketing_review_url          text
    check (marketing_review_url is null
           or (char_length(marketing_review_url) <= 500 and marketing_review_url ~ '^https://[^\s]+$')),
  add column marketing_review_delay_hours  integer not null default 2
    check (marketing_review_delay_hours between 0 and 72);

comment on column public.settings.marketing_nudges_enabled is
  'Draft a "time for a touch-up?" email when an opted-in client is due back and has nothing booked.';
comment on column public.settings.marketing_nudges_auto_send is
  'Send rebook nudges without the stylist approving each one.';
comment on column public.settings.marketing_nudge_lead_days is
  'Nudge this many days before the client''s usual rebook date.';
comment on column public.settings.marketing_reviews_enabled is
  'Ask opted-in clients for a review after a completed visit (needs marketing_review_url).';
comment on column public.settings.marketing_reviews_auto_send is
  'Send review requests without the stylist approving each one.';
comment on column public.settings.marketing_review_url is
  'The salon''s review page (e.g. its Google review link).';
comment on column public.settings.marketing_review_delay_hours is
  'Hours after checkout before the review request goes out.';

alter table public.clients
  add column marketing_token text not null unique
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
    check (marketing_token ~ '^[0-9a-f]{64}$'),
  add column marketing_opted_out_at timestamptz;

comment on column public.clients.marketing_token is
  'Unlocks the client''s one-click unsubscribe link (/u/{token}) in marketing emails.';
comment on column public.clients.marketing_opted_out_at is
  'When the client unsubscribed from their link. Cleared when they (or the salon) opt back in.';

-- Opting back in clears the unsubscribe stamp.
create or replace function private.clients_marketing_consent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.marketing_opt_in and not old.marketing_opt_in then
    new.marketing_opted_out_at := null;
  end if;
  return new;
end;
$$;

revoke all on function private.clients_marketing_consent() from public;

create trigger clients_marketing_consent
  before update of marketing_opt_in on public.clients
  for each row execute function private.clients_marketing_consent();

-- ---------------------------------------------------------------------------
-- Campaigns & messages
-- ---------------------------------------------------------------------------

create type public.marketing_message_kind as enum ('rebook_nudge', 'review_request', 'campaign');
create type public.marketing_channel as enum ('email', 'sms');
create type public.marketing_message_status as enum
  ('draft', 'queued', 'sending', 'sent', 'skipped', 'failed', 'dismissed');
create type public.marketing_campaign_status as enum ('draft', 'scheduled', 'sent', 'cancelled');

create table public.marketing_campaigns (
  id              uuid primary key default gen_random_uuid(),
  salon_id        uuid not null references public.salons (id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 80),
  subject         text not null check (char_length(btrim(subject)) between 1 and 150),
  body            text not null check (char_length(btrim(body)) between 1 and 5000),
  channel         public.marketing_channel not null default 'email',
  -- { tags?: string[], lastVisitWithinDays?: int, noVisitForDays?: int }
  audience        jsonb not null default '{}'::jsonb check (jsonb_typeof(audience) = 'object'),
  status          public.marketing_campaign_status not null default 'draft',
  send_at         timestamptz,
  sent_at         timestamptz,
  recipient_count integer not null default 0 check (recipient_count >= 0),
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.marketing_campaigns is
  'One-off promos and announcements (holiday openings…) to opted-in clients.';

create index marketing_campaigns_salon_idx on public.marketing_campaigns (salon_id, created_at desc);

create trigger marketing_campaigns_set_updated_at
  before update on public.marketing_campaigns
  for each row execute function private.set_updated_at();

create table public.marketing_messages (
  id             uuid primary key default gen_random_uuid(),
  salon_id       uuid not null references public.salons (id) on delete cascade,
  client_id      uuid not null references public.clients (id) on delete cascade,
  kind           public.marketing_message_kind not null,
  channel        public.marketing_channel not null default 'email',
  campaign_id    uuid references public.marketing_campaigns (id) on delete cascade,
  -- The visit a nudge or review request is about.
  appointment_id uuid references public.appointments (id) on delete set null,
  -- May contain {firstName}, {salonName}, {bookingLink}, {reviewLink}; filled in when sent.
  subject        text not null check (char_length(btrim(subject)) between 1 and 150),
  body           text not null check (char_length(btrim(body)) between 1 and 5000),
  status         public.marketing_message_status not null default 'draft',
  due_at         timestamptz not null default now(),
  -- Recipient, stamped when claimed.
  to_address     text check (to_address is null or char_length(to_address) <= 254),
  dedupe_key     text not null unique check (char_length(dedupe_key) between 1 and 300),
  attempts       integer not null default 0 check (attempts >= 0),
  claimed_at     timestamptz,
  sent_at        timestamptz,
  last_error     text check (last_error is null or char_length(last_error) <= 1000),
  provider_id    text check (provider_id is null or char_length(provider_id) <= 200),
  meta           jsonb not null default '{}'::jsonb check (jsonb_typeof(meta) = 'object'),
  approved_by    uuid references auth.users (id) on delete set null,
  approved_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.marketing_messages is
  'Marketing to one client: drafts for the stylist, the send queue and the history.';

create index marketing_messages_salon_idx on public.marketing_messages (salon_id, status, created_at desc);
create index marketing_messages_due_idx on public.marketing_messages (due_at)
  where status in ('queued', 'sending');
create index marketing_messages_client_idx on public.marketing_messages (client_id, kind, created_at desc);
create index marketing_messages_campaign_idx on public.marketing_messages (campaign_id)
  where campaign_id is not null;
create index marketing_messages_appointment_idx on public.marketing_messages (appointment_id)
  where appointment_id is not null;

create trigger marketing_messages_set_updated_at
  before update on public.marketing_messages
  for each row execute function private.set_updated_at();

alter table public.marketing_campaigns enable row level security;
alter table public.marketing_messages enable row level security;
revoke all on public.marketing_campaigns, public.marketing_messages from anon;
revoke insert, update, delete, truncate on public.marketing_campaigns, public.marketing_messages
  from authenticated;
grant select on public.marketing_campaigns, public.marketing_messages to authenticated;

create policy "members read their salon's campaigns" on public.marketing_campaigns
  for select to authenticated using (private.is_salon_member(salon_id));
create policy "members read their salon's marketing messages" on public.marketing_messages
  for select to authenticated using (private.is_salon_member(salon_id));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Has the client got a visit coming up (held, requested or confirmed, in the future)?
create or replace function private.client_has_future_booking(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.appointments a
     where a.client_id = p_client_id
       and a.status in ('held', 'requested', 'confirmed')
       and a.starts_at > now());
$$;

-- Pokes the marketing Edge Function: 'send' (deliver queued messages) or 'scan' (draft nudges).
-- Same Vault secrets as the notifier; `marketing_url` overrides the derived URL.
create or replace function private.dispatch_marketing(p_action text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
begin
  select d.decrypted_secret into v_url from vault.decrypted_secrets d where d.name = 'marketing_url';
  if v_url is null then
    select regexp_replace(d.decrypted_secret, '/notifier/?$', '/marketing') into v_url
      from vault.decrypted_secrets d where d.name = 'notifier_url';
  end if;
  select d.decrypted_secret into v_secret
    from vault.decrypted_secrets d where d.name = 'notifier_secret';
  if v_url is null or v_secret is null then
    return null;
  end if;

  return net.http_post(
    url := v_url,
    body := jsonb_build_object('action', p_action),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notifier-secret', v_secret),
    timeout_milliseconds := 30000);
end;
$$;

-- Validates a campaign audience: { tags?: string[] (≤ 10), lastVisitWithinDays?, noVisitForDays? }.
create or replace function private.valid_marketing_audience(p_audience jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_audience) = 'object'
     and not exists (select 1 from jsonb_object_keys(p_audience) k
                      where k not in ('tags', 'lastVisitWithinDays', 'noVisitForDays'))
     and (not p_audience ? 'tags'
          or (jsonb_typeof(p_audience -> 'tags') = 'array'
              and jsonb_array_length(p_audience -> 'tags') <= 10
              and not exists (select 1 from jsonb_array_elements(p_audience -> 'tags') t
                               where jsonb_typeof(t) <> 'string'
                                  or char_length(t #>> '{}') not between 1 and 40)))
     and (not p_audience ? 'lastVisitWithinDays'
          or (jsonb_typeof(p_audience -> 'lastVisitWithinDays') = 'number'
              and (p_audience ->> 'lastVisitWithinDays')::numeric between 1 and 3650))
     and (not p_audience ? 'noVisitForDays'
          or (jsonb_typeof(p_audience -> 'noVisitForDays') = 'number'
              and (p_audience ->> 'noVisitForDays')::numeric between 1 and 3650));
$$;

-- The opted-in clients with an email a campaign audience reaches. A client matches `tags` if
-- they have any of them; last visit = latest completed visit (or the imported one).
create or replace function private.marketing_audience(p_salon_id uuid, p_audience jsonb)
returns table (client_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with c as (
    select c.id, c.tags,
           greatest(
             (select max(a.starts_at)::date from public.appointments a
               where a.client_id = c.id and a.status = 'completed'),
             c.imported_last_visit_on) as last_visit
      from public.clients c
     where c.salon_id = p_salon_id
       and c.marketing_opt_in
       and c.email is not null
       and not c.pending
  )
  select c.id
    from c
   where (coalesce(jsonb_array_length(p_audience -> 'tags'), 0) = 0
          or exists (select 1 from jsonb_array_elements_text(p_audience -> 'tags') t
                      where lower(t) in (select lower(x) from unnest(c.tags) x)))
     and (p_audience -> 'lastVisitWithinDays' is null
          or c.last_visit >= current_date - (p_audience ->> 'lastVisitWithinDays')::integer)
     and (p_audience -> 'noVisitForDays' is null
          or c.last_visit is null
          or c.last_visit < current_date - (p_audience ->> 'noVisitForDays')::integer);
$$;

revoke all on function private.client_has_future_booking(uuid) from public;
revoke all on function private.dispatch_marketing(text) from public;
revoke all on function private.valid_marketing_audience(jsonb) from public;
revoke all on function private.marketing_audience(uuid, jsonb) from public;
grant execute on function private.valid_marketing_audience(jsonb) to authenticated, service_role;

alter table public.marketing_campaigns
  add constraint marketing_campaigns_audience_valid check (private.valid_marketing_audience(audience));

-- ---------------------------------------------------------------------------
-- Review requests: drafted (or queued) when a visit is completed at checkout
-- ---------------------------------------------------------------------------

create or replace function private.marketing_on_completed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.settings;
begin
  if new.client_id is null or new.status <> 'completed' or old.status = 'completed' then
    return null;
  end if;
  select * into v_settings from public.settings st where st.salon_id = new.salon_id;
  if not found or not v_settings.marketing_reviews_enabled
     or v_settings.marketing_review_url is null then
    return null;
  end if;
  if not exists (select 1 from public.clients c
                  where c.id = new.client_id and c.marketing_opt_in and c.email is not null) then
    return null;
  end if;
  -- One ask per client every six months is plenty.
  if exists (select 1 from public.marketing_messages m
              where m.client_id = new.client_id and m.kind = 'review_request'
                and m.status not in ('skipped', 'dismissed', 'failed')
                and m.created_at > now() - interval '180 days') then
    return null;
  end if;

  insert into public.marketing_messages
    (salon_id, client_id, kind, appointment_id, subject, body, status, due_at, dedupe_key,
     approved_at)
  values
    (new.salon_id, new.client_id, 'review_request', new.id,
     'Thanks for visiting {salonName}!',
     E'Hi {firstName},\n\nThanks for coming in! If you have a minute, a quick review would mean a lot to us:\n{reviewLink}\n\nSee you next time!',
     case when v_settings.marketing_reviews_auto_send then 'queued' else 'draft' end
       ::public.marketing_message_status,
     now() + make_interval(hours => v_settings.marketing_review_delay_hours),
     'review_request:' || new.id,
     case when v_settings.marketing_reviews_auto_send then now() end)
  on conflict (dedupe_key) do nothing;
  return null;
end;
$$;

revoke all on function private.marketing_on_completed() from public;

create trigger appointments_marketing_on_completed
  after update of status on public.appointments
  for each row execute function private.marketing_on_completed();

-- ---------------------------------------------------------------------------
-- Member RPCs
-- ---------------------------------------------------------------------------

-- Approves a draft (optionally edited): it goes out now, or at its due time if that's later.
create or replace function public.approve_marketing_message(
  p_message_id uuid,
  p_subject    text default null,
  p_body       text default null
)
returns public.marketing_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msg public.marketing_messages;
begin
  select * into v_msg from public.marketing_messages m where m.id = p_message_id for update;
  if v_msg.id is null or not private.is_salon_member(v_msg.salon_id) then
    raise exception 'Message not found' using errcode = 'P0002';
  end if;
  if v_msg.status <> 'draft' then
    raise exception 'This message was already handled' using errcode = '55000';
  end if;
  if not exists (select 1 from public.clients c
                  where c.id = v_msg.client_id and c.marketing_opt_in) then
    raise exception 'This client has opted out of marketing' using errcode = '55000';
  end if;

  update public.marketing_messages m
     set status = 'queued',
         subject = coalesce(nullif(btrim(p_subject), ''), m.subject),
         body = coalesce(nullif(btrim(p_body), ''), m.body),
         due_at = greatest(m.due_at, now()),
         approved_by = auth.uid(),
         approved_at = now()
   where m.id = p_message_id
  returning * into v_msg;

  if v_msg.due_at <= now() then
    perform private.dispatch_marketing('send');
  end if;
  return v_msg;
end;
$$;

create or replace function public.dismiss_marketing_message(p_message_id uuid)
returns public.marketing_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msg public.marketing_messages;
begin
  select * into v_msg from public.marketing_messages m where m.id = p_message_id for update;
  if v_msg.id is null or not private.is_salon_member(v_msg.salon_id) then
    raise exception 'Message not found' using errcode = 'P0002';
  end if;
  if v_msg.status not in ('draft', 'queued') then
    raise exception 'This message was already handled' using errcode = '55000';
  end if;
  update public.marketing_messages m set status = 'dismissed'
   where m.id = p_message_id
  returning * into v_msg;
  return v_msg;
end;
$$;

-- How many clients a campaign audience reaches right now.
create or replace function public.marketing_audience_count(p_salon_id uuid, p_audience jsonb)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_salon_member(p_salon_id) then
    raise exception 'Not a member of this salon' using errcode = '42501';
  end if;
  if not private.valid_marketing_audience(coalesce(p_audience, '{}'::jsonb)) then
    raise exception 'Invalid audience' using errcode = '22023';
  end if;
  return (select count(*)::integer
            from private.marketing_audience(p_salon_id, coalesce(p_audience, '{}'::jsonb)));
end;
$$;

-- Creates (p_campaign_id null) or edits a draft campaign.
create or replace function public.save_marketing_campaign(
  p_salon_id    uuid,
  p_campaign_id uuid,
  p_name        text,
  p_subject     text,
  p_body        text,
  p_audience    jsonb default '{}'::jsonb
)
returns public.marketing_campaigns
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.marketing_campaigns;
begin
  if not private.is_salon_member(p_salon_id) then
    raise exception 'Not a member of this salon' using errcode = '42501';
  end if;
  if not private.valid_marketing_audience(coalesce(p_audience, '{}'::jsonb)) then
    raise exception 'Invalid audience' using errcode = '22023';
  end if;

  if p_campaign_id is null then
    insert into public.marketing_campaigns (salon_id, name, subject, body, audience, created_by)
    values (p_salon_id, btrim(p_name), btrim(p_subject), btrim(p_body),
            coalesce(p_audience, '{}'::jsonb), auth.uid())
    returning * into v_row;
  else
    update public.marketing_campaigns c
       set name = btrim(p_name), subject = btrim(p_subject), body = btrim(p_body),
           audience = coalesce(p_audience, '{}'::jsonb)
     where c.id = p_campaign_id and c.salon_id = p_salon_id and c.status = 'draft'
    returning * into v_row;
    if v_row.id is null then
      raise exception 'Only draft campaigns can be edited' using errcode = '55000';
    end if;
  end if;
  return v_row;
end;
$$;

-- Approving a campaign: one queued message per client in the audience, sent now or at p_send_at.
create or replace function public.send_marketing_campaign(
  p_campaign_id uuid,
  p_send_at     timestamptz default null
)
returns public.marketing_campaigns
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row   public.marketing_campaigns;
  v_due   timestamptz := greatest(coalesce(p_send_at, now()), now());
  v_count integer;
begin
  select * into v_row from public.marketing_campaigns c where c.id = p_campaign_id for update;
  if v_row.id is null or not private.is_salon_member(v_row.salon_id) then
    raise exception 'Campaign not found' using errcode = 'P0002';
  end if;
  if v_row.status <> 'draft' then
    raise exception 'This campaign was already sent' using errcode = '55000';
  end if;
  if p_send_at is not null and p_send_at > now() + interval '90 days' then
    raise exception 'Schedule within 90 days' using errcode = '22023';
  end if;

  insert into public.marketing_messages
    (salon_id, client_id, kind, channel, campaign_id, subject, body, status, due_at, dedupe_key,
     approved_by, approved_at)
  select v_row.salon_id, a.client_id, 'campaign', v_row.channel, v_row.id, v_row.subject,
         v_row.body, 'queued', v_due, 'campaign:' || v_row.id || ':' || a.client_id,
         auth.uid(), now()
    from private.marketing_audience(v_row.salon_id, v_row.audience) a
  on conflict (dedupe_key) do nothing;
  get diagnostics v_count = row_count;

  update public.marketing_campaigns c
     set status = case when v_due > now() + interval '1 minute' then 'scheduled' else 'sent' end
                    ::public.marketing_campaign_status,
         send_at = v_due,
         sent_at = case when v_due > now() + interval '1 minute' then null else now() end,
         recipient_count = v_count
   where c.id = v_row.id
  returning * into v_row;

  if v_row.status = 'sent' then
    perform private.dispatch_marketing('send');
  end if;
  return v_row;
end;
$$;

-- Deletes a draft, or cancels a scheduled campaign (its unsent messages are dismissed).
create or replace function public.cancel_marketing_campaign(p_campaign_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.marketing_campaigns;
begin
  select * into v_row from public.marketing_campaigns c where c.id = p_campaign_id for update;
  if v_row.id is null or not private.is_salon_member(v_row.salon_id) then
    raise exception 'Campaign not found' using errcode = 'P0002';
  end if;
  if v_row.status = 'draft' then
    delete from public.marketing_campaigns c where c.id = v_row.id;
  elsif v_row.status = 'scheduled' then
    update public.marketing_messages m set status = 'dismissed'
     where m.campaign_id = v_row.id and m.status = 'queued';
    update public.marketing_campaigns c set status = 'cancelled' where c.id = v_row.id;
  else
    raise exception 'This campaign was already sent' using errcode = '55000';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function RPCs (service_role only)
-- ---------------------------------------------------------------------------

-- Opted-in clients with an email, nothing booked, nudges on, and a completed visit 1-400 days ago
-- that hasn't been nudged yet (nor the client in the last 3 weeks), most recent visit first, one
-- page at a time (pass the last row's visit startsAt and clientId as p_before_*). The function
-- works out each client's rebook date with @chairside/core and saves the ones that are due.
-- [{ salonId, timeZone, leadDays, clientId, clientName,
--    visit: { appointmentId, startsAt, serviceIds }, history: [{ startsAt, serviceIds }],
--    services: [{ id, name, category, rebookIntervalDays }] }]
create or replace function public.marketing_nudge_candidates(
  p_limit         integer default 200,
  p_before_at     timestamptz default null,
  p_before_client uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service role only' using errcode = '42501';
  end if;

  with last_visit as (
    select distinct on (a.client_id) a.client_id, a.id, a.salon_id, a.starts_at, a.services
      from public.appointments a
     where a.status = 'completed' and a.client_id is not null
       and a.starts_at > now() - interval '400 days'
     order by a.client_id, a.starts_at desc
  ), candidates as (
    select lv.*, c.name as client_name, s.timezone, st.marketing_nudge_lead_days as lead_days
      from last_visit lv
      join public.clients c on c.id = lv.client_id
      join public.salons s on s.id = lv.salon_id
      join public.settings st on st.salon_id = lv.salon_id and st.marketing_nudges_enabled
     where lv.starts_at < now() - interval '1 day'
       and (p_before_at is null
            or (lv.starts_at, lv.client_id)
               < (p_before_at, coalesce(p_before_client, 'ffffffff-ffff-ffff-ffff-ffffffffffff')))
       and c.marketing_opt_in and c.email is not null and not c.pending
       and not private.client_has_future_booking(c.id)
       and not exists (select 1 from public.marketing_messages m
                        where m.kind = 'rebook_nudge'
                          and (m.appointment_id = lv.id
                               or (m.client_id = c.id
                                   and m.created_at > now() - interval '21 days')))
     order by lv.starts_at desc, lv.client_id desc
     limit greatest(1, least(coalesce(p_limit, 200), 1000))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'salonId', cd.salon_id,
           'timeZone', cd.timezone,
           'leadDays', cd.lead_days,
           'clientId', cd.client_id,
           'clientName', cd.client_name,
           'visit', jsonb_build_object(
             'appointmentId', cd.id, 'startsAt', cd.starts_at,
             'serviceIds', coalesce((select jsonb_agg(e ->> 'serviceId')
                                       from jsonb_array_elements(cd.services) e
                                      where e ->> 'serviceId' is not null), '[]'::jsonb)),
           'history', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'startsAt', h.starts_at,
                      'serviceIds', coalesce((select jsonb_agg(e ->> 'serviceId')
                                                from jsonb_array_elements(h.services) e
                                               where e ->> 'serviceId' is not null), '[]'::jsonb))
                      order by h.starts_at)
               from (select a.starts_at, a.services from public.appointments a
                      where a.client_id = cd.client_id and a.status = 'completed'
                      order by a.starts_at desc limit 12) h), '[]'::jsonb),
           'services', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id', sv.id, 'name', sv.name, 'category', sv.category,
                      'rebookIntervalDays', sv.rebook_interval_days))
               from public.services sv
              where sv.salon_id = cd.salon_id
                and sv.id::text in (select e ->> 'serviceId'
                                      from jsonb_array_elements(cd.services) e)), '[]'::jsonb))
           order by cd.starts_at desc, cd.client_id desc), '[]'::jsonb)
    into v_rows
    from candidates cd;
  return v_rows;
end;
$$;

-- p_nudges: [{ clientId, appointmentId, subject, body, meta? }] → drafts, or queued when the
-- salon auto-sends nudges. Returns { saved, queued }.
create or replace function public.save_rebook_nudges(p_nudges jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_saved  integer := 0;
  v_queued integer := 0;
  r        record;
  v_id     uuid;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service role only' using errcode = '42501';
  end if;
  if p_nudges is null or jsonb_typeof(p_nudges) <> 'array' then
    raise exception 'p_nudges must be an array' using errcode = '22023';
  end if;

  for r in
    select a.id as appointment_id, a.salon_id, c.id as client_id, st.marketing_nudges_auto_send,
           left(btrim(e ->> 'subject'), 150) as subject, left(btrim(e ->> 'body'), 5000) as body,
           case when jsonb_typeof(e -> 'meta') = 'object' then e -> 'meta' else '{}'::jsonb end
             as meta
      from jsonb_array_elements(p_nudges) e
      join public.appointments a on a.id = (e ->> 'appointmentId')::uuid
      join public.clients c on c.id = (e ->> 'clientId')::uuid and c.id = a.client_id
      join public.settings st on st.salon_id = a.salon_id and st.marketing_nudges_enabled
     where c.marketing_opt_in and c.email is not null
       and not private.client_has_future_booking(c.id)
       and coalesce(btrim(e ->> 'subject'), '') <> '' and coalesce(btrim(e ->> 'body'), '') <> ''
  loop
    insert into public.marketing_messages
      (salon_id, client_id, kind, appointment_id, subject, body, status, dedupe_key, meta,
       approved_at)
    values
      (r.salon_id, r.client_id, 'rebook_nudge', r.appointment_id, r.subject, r.body,
       case when r.marketing_nudges_auto_send then 'queued' else 'draft' end
         ::public.marketing_message_status,
       'rebook_nudge:' || r.appointment_id, r.meta,
       case when r.marketing_nudges_auto_send then now() end)
    on conflict (dedupe_key) do nothing
    returning id into v_id;
    if v_id is not null then
      v_saved := v_saved + 1;
      if r.marketing_nudges_auto_send then v_queued := v_queued + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('saved', v_saved, 'queued', v_queued);
end;
$$;

-- Claims due queued messages on the channels the function can deliver (p_channels), after
-- skipping the ones that no longer make sense: the client opted out or has no address, a nudged
-- client has booked, or the salon turned the feature off.
-- [{ id, kind, channel, to, subject, body, clientName, unsubscribeToken, reviewUrl,
--    salon: { name, slug, timezone } }]
create or replace function public.claim_marketing_messages(
  p_channels text[] default array['email'],
  p_limit    integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service role only' using errcode = '42501';
  end if;

  update public.marketing_messages m
     set status = 'skipped',
         last_error = case
           when not c.marketing_opt_in then 'opted_out'
           when m.channel = 'email' and c.email is null then 'no_email'
           when m.channel = 'sms' and c.phone is null then 'no_phone'
           when m.kind = 'rebook_nudge' and not st.marketing_nudges_enabled then 'disabled'
           when m.kind = 'review_request'
                and (not st.marketing_reviews_enabled or st.marketing_review_url is null)
             then 'disabled'
           else 'already_booked'
         end
    from public.clients c, public.settings st
   where c.id = m.client_id and st.salon_id = m.salon_id
     and m.status = 'queued'
     and m.channel::text = any (coalesce(p_channels, array['email']))
     and (not c.marketing_opt_in
          or (m.channel = 'email' and c.email is null)
          or (m.channel = 'sms' and c.phone is null)
          or (m.kind = 'rebook_nudge'
              and (not st.marketing_nudges_enabled or private.client_has_future_booking(c.id)))
          or (m.kind = 'review_request'
              and (not st.marketing_reviews_enabled or st.marketing_review_url is null)));

  with due as (
    select m.id
      from public.marketing_messages m
     where m.channel::text = any (coalesce(p_channels, array['email']))
       and ((m.status = 'queued' and m.due_at <= now())
            or (m.status = 'sending' and m.claimed_at < now() - interval '5 minutes'))
     order by m.due_at, m.created_at
     limit greatest(1, least(coalesce(p_limit, 50), 200))
     for update of m skip locked
  ), claimed as (
    update public.marketing_messages m
       set status = 'sending', claimed_at = now(), attempts = m.attempts + 1,
           to_address = (select case when m.channel = 'sms' then c.phone else c.email end
                           from public.clients c where c.id = m.client_id)
      from due
     where m.id = due.id
    returning m.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', cl.id,
           'kind', cl.kind,
           'channel', cl.channel,
           'to', cl.to_address,
           'subject', cl.subject,
           'body', cl.body,
           'clientName', c.name,
           'unsubscribeToken', c.marketing_token,
           'reviewUrl', st.marketing_review_url,
           'salon', jsonb_build_object('name', s.name, 'slug', s.slug, 'timezone', s.timezone))
           order by cl.due_at), '[]'::jsonb)
    into v_rows
    from claimed cl
    join public.clients c on c.id = cl.client_id
    join public.salons s on s.id = cl.salon_id
    join public.settings st on st.salon_id = cl.salon_id;
  return v_rows;
end;
$$;

-- p_results: [{ id, outcome: 'sent' | 'skipped' | 'retry', error?, providerId? }].
-- `retry` backs off 2^attempts minutes and gives up (failed) after 5 attempts.
create or replace function public.finish_marketing_messages(p_results jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service role only' using errcode = '42501';
  end if;
  if p_results is null or jsonb_typeof(p_results) <> 'array' then
    raise exception 'p_results must be an array' using errcode = '22023';
  end if;

  with r as (
    select (e ->> 'id')::uuid as id, e ->> 'outcome' as outcome,
           left(e ->> 'error', 1000) as error, left(e ->> 'providerId', 200) as provider_id
      from jsonb_array_elements(p_results) e
     where e ->> 'outcome' in ('sent', 'skipped', 'retry')
  ), done as (
    update public.marketing_messages m
       set status = case
                      when r.outcome = 'sent' then 'sent'
                      when r.outcome = 'skipped' then 'skipped'
                      when m.attempts >= 5 then 'failed'
                      else 'queued'
                    end::public.marketing_message_status,
           sent_at = case when r.outcome = 'sent' then now() end,
           due_at = case
                      when r.outcome = 'retry'
                      then now() + make_interval(mins => power(2, least(m.attempts, 10))::integer)
                      else m.due_at
                    end,
           last_error = r.error,
           provider_id = coalesce(r.provider_id, m.provider_id)
      from r
     where m.id = r.id and m.status = 'sending'
    returning 1
  )
  select count(*)::integer into v_count from done;
  return v_count;
end;
$$;

-- The unsubscribe link: { salonName, clientFirstName, subscribed } or null.
create or replace function public.marketing_subscription_by_token(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service role only' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object(
             'salonName', s.name,
             'clientFirstName', nullif(split_part(btrim(c.name), ' ', 1), ''),
             'subscribed', c.marketing_opt_in)
      from public.clients c
      join public.salons s on s.id = c.salon_id
     where c.marketing_token = p_token);
end;
$$;

-- One click from the email: unsubscribes (pending drafts and queued marketing are skipped), or
-- opts back in. Transactional emails are unaffected. Returns the same view as above, or null.
create or replace function public.set_marketing_subscription_by_token(
  p_token      text,
  p_subscribed boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client_id uuid;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Service role only' using errcode = '42501';
  end if;
  select c.id into v_client_id from public.clients c where c.marketing_token = p_token for update;
  if v_client_id is null then
    return null;
  end if;

  if p_subscribed then
    update public.clients c set marketing_opt_in = true
     where c.id = v_client_id and not c.marketing_opt_in;
  else
    update public.clients c set marketing_opt_in = false, marketing_opted_out_at = now()
     where c.id = v_client_id and c.marketing_opt_in;
    update public.marketing_messages m set status = 'skipped', last_error = 'opted_out'
     where m.client_id = v_client_id and m.status in ('draft', 'queued');
  end if;
  return public.marketing_subscription_by_token(p_token);
end;
$$;

-- ---------------------------------------------------------------------------
-- Housekeeping (pg_cron)
-- ---------------------------------------------------------------------------

-- Every minute: drafts and queued nudges for clients who have booked since are skipped, drafts
-- nobody approved for 30 days go stale, scheduled campaigns flip to sent, then the function is
-- poked if anything is due.
create or replace function private.marketing_tick(p_now timestamptz default now())
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.marketing_messages m set status = 'skipped', last_error = 'already_booked'
   where m.kind = 'rebook_nudge' and m.status in ('draft', 'queued')
     and private.client_has_future_booking(m.client_id);
  update public.marketing_messages m set status = 'skipped', last_error = 'stale'
   where m.status = 'draft' and m.created_at < p_now - interval '30 days';
  update public.marketing_campaigns c set status = 'sent', sent_at = c.send_at
   where c.status = 'scheduled' and c.send_at <= p_now;

  if exists (select 1 from public.marketing_messages m
              where m.status = 'queued' and m.due_at <= p_now) then
    perform private.dispatch_marketing('send');
  end if;
end;
$$;

revoke all on function private.marketing_tick(timestamptz) from public;

revoke all on function public.approve_marketing_message(uuid, text, text) from public, anon;
revoke all on function public.dismiss_marketing_message(uuid) from public, anon;
revoke all on function public.marketing_audience_count(uuid, jsonb) from public, anon;
revoke all on function public.save_marketing_campaign(uuid, uuid, text, text, text, jsonb) from public, anon;
revoke all on function public.send_marketing_campaign(uuid, timestamptz) from public, anon;
revoke all on function public.cancel_marketing_campaign(uuid) from public, anon;
grant execute on function public.approve_marketing_message(uuid, text, text) to authenticated, service_role;
grant execute on function public.dismiss_marketing_message(uuid) to authenticated, service_role;
grant execute on function public.marketing_audience_count(uuid, jsonb) to authenticated, service_role;
grant execute on function public.save_marketing_campaign(uuid, uuid, text, text, text, jsonb)
  to authenticated, service_role;
grant execute on function public.send_marketing_campaign(uuid, timestamptz) to authenticated, service_role;
grant execute on function public.cancel_marketing_campaign(uuid) to authenticated, service_role;

revoke all on function public.marketing_nudge_candidates(integer, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.save_rebook_nudges(jsonb) from public, anon, authenticated;
revoke all on function public.claim_marketing_messages(text[], integer) from public, anon, authenticated;
revoke all on function public.finish_marketing_messages(jsonb) from public, anon, authenticated;
revoke all on function public.marketing_subscription_by_token(text) from public, anon, authenticated;
revoke all on function public.set_marketing_subscription_by_token(text, boolean)
  from public, anon, authenticated;
grant execute on function public.marketing_nudge_candidates(integer, timestamptz, uuid) to service_role;
grant execute on function public.save_rebook_nudges(jsonb) to service_role;
grant execute on function public.claim_marketing_messages(text[], integer) to service_role;
grant execute on function public.finish_marketing_messages(jsonb) to service_role;
grant execute on function public.marketing_subscription_by_token(text) to service_role;
grant execute on function public.set_marketing_subscription_by_token(text, boolean) to service_role;

select cron.schedule('marketing-tick', '* * * * *', 'select private.marketing_tick()');
select cron.schedule('marketing-nudge-scan', '17 * * * *',
  $$select private.dispatch_marketing('scan')$$);
