-- Reply editor + one-tap send (#7, docs/PLAN.md §4 "Outbound on Approve").
--
-- The LLM only drafts the text. By default the stylist edits it and taps Send, which opens
-- Messages prefilled to the client (expo-sms; copy on web); the app then records the reply here.
--
-- Auto-send is an explicit, owner-only opt-in (settings.auto_send_replies, off by default). When it is on
-- and the text bridge is set up, approving a request queues a reply. The inbox Edge Function drafts
-- it and hands it to the salon's iOS Shortcut the next time the Shortcut calls in, and the Shortcut
-- sends it from his number.
--
-- A client answering an offer with "Chairside yes" (via the bridge) confirms the held slot.

-- ---------------------------------------------------------------------------
-- Reply preferences (per salon; members read, owners update via the existing settings policies).
-- ---------------------------------------------------------------------------

alter table public.settings
  add column auto_send_replies boolean not null default false,
  add column reply_tone_examples text
    check (reply_tone_examples is null or char_length(reply_tone_examples) <= 1500),
  add column booking_link text
    check (booking_link is null
           or (booking_link ~* '^https://[^[:space:]]+$' and char_length(booking_link) <= 300)),
  add column reply_include_booking_link boolean not null default false;

comment on column public.settings.auto_send_replies is
  'Opt-in. When on, approved requests queue a reply the text bridge Shortcut sends automatically.';
comment on column public.settings.reply_tone_examples is
  'Sample texts in the stylist''s own voice, used only as style examples when drafting replies.';
comment on column public.settings.booking_link is
  'Public booking page URL (https). Added to drafted replies when reply_include_booking_link.';

-- Lets client_replies reference a request of the same salon.
alter table public.captured_requests
  add constraint captured_requests_salon_id_id_key unique (salon_id, id);

-- ---------------------------------------------------------------------------
-- client_replies: texts sent (or queued to send) to clients.
-- ---------------------------------------------------------------------------

create table public.client_replies (
  id                  uuid primary key default gen_random_uuid(),
  salon_id            uuid not null references public.salons (id) on delete cascade,
  captured_request_id uuid,
  appointment_id      uuid,
  client_id           uuid,
  -- confirm: "you're booked" · offer: "want Fri 1:30?" · decline · cancelled · running_late · other
  kind                text not null
                      check (kind in ('confirm', 'offer', 'decline', 'cancelled', 'running_late',
                                      'other')),
  to_phone            text check (to_phone is null or char_length(to_phone) between 3 and 32),
  -- Null only while queued: the inbox function drafts it right before handing it to the bridge.
  body                text check (body is null or char_length(body) between 1 and 1000),
  -- queued → sending (claimed by the bridge) → sent; or cancelled.
  status              text not null default 'sent'
                      check (status in ('queued', 'sending', 'sent', 'cancelled')),
  -- messages: Messages composer · copy: clipboard (web) · bridge: the iOS Shortcut sent it.
  channel             text not null check (channel in ('messages', 'copy', 'bridge')),
  source              text check (source is null or source in ('ai', 'template', 'edited')),
  created_by          uuid default auth.uid() references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  claimed_at          timestamptz,
  sent_at             timestamptz,
  constraint client_replies_sent_at check ((status = 'sent') = (sent_at is not null)),
  constraint client_replies_sent_body check (status <> 'sent' or body is not null),
  constraint client_replies_request_fkey foreign key (salon_id, captured_request_id)
    references public.captured_requests (salon_id, id) on delete set null (captured_request_id),
  constraint client_replies_appointment_fkey foreign key (salon_id, appointment_id)
    references public.appointments (salon_id, id) on delete set null (appointment_id),
  constraint client_replies_client_fkey foreign key (salon_id, client_id)
    references public.clients (salon_id, id) on delete set null (client_id)
);

comment on table public.client_replies is
  'Texts to clients: sent from the reply editor (recorded by the app) or queued for the bridge.';

create index client_replies_salon_created_idx on public.client_replies (salon_id, created_at desc);
create index client_replies_request_idx on public.client_replies (captured_request_id)
  where captured_request_id is not null;
create index client_replies_queued_idx on public.client_replies (salon_id)
  where status in ('queued', 'sending');

alter table public.client_replies enable row level security;
revoke all on public.client_replies from anon;
revoke insert, update, delete, truncate on public.client_replies from authenticated;

create policy "members can read client replies" on public.client_replies
  for select to authenticated using (private.is_salon_member(salon_id));

-- ---------------------------------------------------------------------------
-- record_client_reply: the app sent (or copied) a reply. Members only.
--   p_reply: { kind, body, channel: messages | copy, source?, toPhone?,
--              capturedRequestId?, appointmentId?, clientId? }
-- Recording a reply for a request cancels any reply still queued for it, so the bridge doesn't
-- send a second text.
-- ---------------------------------------------------------------------------

create or replace function public.record_client_reply(p_salon_id uuid, p_reply jsonb)
returns public.client_replies
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req     public.captured_requests;
  v_request uuid := nullif(p_reply ->> 'capturedRequestId', '')::uuid;
  v_appt    uuid := nullif(p_reply ->> 'appointmentId', '')::uuid;
  v_client  uuid := nullif(p_reply ->> 'clientId', '')::uuid;
  v_body    text := btrim(coalesce(p_reply ->> 'body', ''));
  v_channel text := coalesce(nullif(p_reply ->> 'channel', ''), 'messages');
  v_reply   public.client_replies;
begin
  if not private.is_salon_member(p_salon_id) then
    raise exception 'Not a member of this salon' using errcode = '42501';
  end if;
  if char_length(v_body) not between 1 and 1000 then
    raise exception 'The reply must be 1 to 1000 characters' using errcode = '22023';
  end if;
  if v_channel not in ('messages', 'copy') then
    raise exception 'Unknown channel %', v_channel using errcode = '22023';
  end if;

  if v_request is not null then
    select * into v_req from public.captured_requests c
     where c.id = v_request and c.salon_id = p_salon_id;
    if not found then
      raise exception 'Request not found' using errcode = 'P0002';
    end if;
    v_appt := coalesce(v_appt, v_req.appointment_id, v_req.target_appointment_id);
    v_client := coalesce(v_client, v_req.client_id);
  end if;
  if v_appt is not null then
    if not exists (select 1 from public.appointments a
                    where a.id = v_appt and a.salon_id = p_salon_id) then
      raise exception 'Appointment not found' using errcode = 'P0002';
    end if;
    v_client := coalesce(v_client,
                         (select a.client_id from public.appointments a where a.id = v_appt));
  end if;
  if v_client is not null and not exists (
    select 1 from public.clients c where c.id = v_client and c.salon_id = p_salon_id
  ) then
    raise exception 'Client not found' using errcode = 'P0002';
  end if;

  insert into public.client_replies
    (salon_id, captured_request_id, appointment_id, client_id, kind, to_phone, body, status,
     channel, source, created_by, sent_at)
  values
    (p_salon_id, v_request, v_appt, v_client, coalesce(p_reply ->> 'kind', 'other'),
     nullif(left(btrim(p_reply ->> 'toPhone'), 32), ''), v_body, 'sent', v_channel,
     nullif(p_reply ->> 'source', ''), auth.uid(), now())
  returning * into v_reply;

  if v_request is not null then
    update public.client_replies r
       set status = 'cancelled'
     where r.captured_request_id = v_request and r.status = 'queued';
  end if;

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (p_salon_id, auth.uid(), 'reply.sent', 'client_reply', v_reply.id::text,
          jsonb_build_object('kind', v_reply.kind, 'channel', v_reply.channel,
                             'source', v_reply.source, 'captured_request_id', v_request,
                             'appointment_id', v_appt));
  return v_reply;
end;
$$;

revoke all on function public.record_client_reply(uuid, jsonb) from public, anon;
grant execute on function public.record_client_reply(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Auto-send: approving a request queues its reply for the bridge (only when opted in).
-- ---------------------------------------------------------------------------

create or replace function private.queue_auto_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text;
  v_kind  text := case when new.intent = 'cancel' then 'cancelled' else 'confirm' end;
begin
  if new.status <> 'approved' or old.status <> 'pending' then
    return null;
  end if;
  if not exists (select 1 from public.settings s where s.salon_id = new.salon_id and s.auto_send_replies)
     or not exists (select 1 from public.inbox_bridges b where b.salon_id = new.salon_id) then
    return null;
  end if;
  v_phone := coalesce((select c.phone from public.clients c where c.id = new.client_id),
                      new.sender_phone);
  if v_phone is null then
    return null;
  end if;
  if exists (select 1 from public.client_replies r
              where r.captured_request_id = new.id and r.kind = v_kind
                and r.status <> 'cancelled') then
    return null;
  end if;

  insert into public.client_replies
    (salon_id, captured_request_id, appointment_id, client_id, kind, to_phone, status, channel,
     created_by)
  values
    (new.salon_id, new.id,
     case when new.intent = 'cancel' then new.target_appointment_id else new.appointment_id end,
     new.client_id, v_kind, left(v_phone, 32), 'queued', 'bridge', auth.uid());
  return null;
end;
$$;

revoke all on function private.queue_auto_reply() from public;

create trigger captured_requests_queue_auto_reply
  after update of status on public.captured_requests
  for each row when (old.status is distinct from new.status)
  execute function private.queue_auto_reply();

-- ---------------------------------------------------------------------------
-- Realtime: the request card shows "Offer sent" / "Reply sent" live.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'client_replies'
  ) then
    alter publication supabase_realtime add table public.client_replies;
  end if;
end;
$$;
