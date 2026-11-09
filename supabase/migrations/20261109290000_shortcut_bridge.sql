-- iOS Shortcut bridge, part 2 (#6): installable Shortcut versioning, health, auto-reply mode and
-- the station card. See docs/shortcut-bridge.md.
--   • inbox_bridges.auto_reply: when on, /inbox answers with a `reply` the Shortcut texts back
--   • inbox_bridges.phone: the number clients text (station card QR code)
--   • inbox_bridges.last_bridge_version / last_test_at: health + "update your Shortcut" checks
--   • inbox_bridge_for_token(p_token, p_hourly_limit, p_bridge_version): records the version

alter table public.inbox_bridges
  add column auto_reply          boolean not null default false,
  add column phone               text check (phone is null or char_length(btrim(phone)) between 7 and 32),
  add column last_bridge_version text check (last_bridge_version is null or char_length(last_bridge_version) <= 20),
  add column last_test_at        timestamptz;

comment on column public.inbox_bridges.auto_reply is
  'When on, the Shortcut texts the client the reply /inbox returns (help for a bare keyword, "got it" for a request). Bookings still need the stylist''s approval.';
comment on column public.inbox_bridges.phone is
  'The number clients text (the iPhone running the Shortcut). Printed on the station card QR code.';
comment on column public.inbox_bridges.last_bridge_version is
  'bridgeVersion the Shortcut sent with its last request. The app asks the owner to update older Shortcuts.';
comment on column public.inbox_bridges.last_test_at is
  'Last "<keyword> test" text or manual run of the Shortcut (onboarding check). Nothing is captured.';

grant update (auto_reply, phone) on public.inbox_bridges to authenticated;

-- The token lookup now also records the Shortcut version and returns the reply settings.
drop function public.inbox_bridge_for_token(text, integer);

create function public.inbox_bridge_for_token(
  p_token text,
  p_hourly_limit integer default 60,
  p_bridge_version text default null
)
returns table (
  salon_id uuid,
  keyword text,
  timezone text,
  rate_limited boolean,
  auto_reply boolean,
  salon_name text
)
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
           last_received_at = now(),
           last_bridge_version = coalesce(left(nullif(btrim(p_bridge_version), ''), 20),
                                          ib.last_bridge_version)
     where ib.token_hash = private.inbox_token_hash(coalesce(p_token, ''))
    returning ib.salon_id, ib.keyword, ib.window_count, ib.auto_reply
  )
  select b.salon_id, b.keyword, s.timezone, b.window_count > p_hourly_limit, b.auto_reply, s.name
    from b join public.salons s on s.id = b.salon_id;
end;
$$;

revoke all on function public.inbox_bridge_for_token(text, integer, text)
  from public, anon, authenticated;
grant execute on function public.inbox_bridge_for_token(text, integer, text) to service_role;
