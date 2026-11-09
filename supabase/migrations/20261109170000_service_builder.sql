-- Service builder (docs/PLAN.md §3, Appendix A; issue #4).
--
-- A service is an ordered list of segments (busy / processing / style) plus buffers before/after.
-- Hair-length variants add minutes to the hands-on segments; add-ons insert extra segments; combos
-- chain other services. Resolution into a bookable segment list lives in
-- packages/core/src/services (pure, unit-tested); the DB stores the definitions.
--
-- Writes go through public.save_service() / public.save_service_addon() so a service and its
-- segments/variants/combo items are replaced atomically. New salons are seeded with the Appendix A
-- starter menu by a trigger on public.salons (private.starter_menu() mirrors
-- packages/core/src/services/starter-menu.ts; a core unit test keeps them in sync).

create type public.segment_kind as enum ('busy', 'processing', 'style');
create type public.addon_placement as enum ('before_finish', 'end');

comment on type public.segment_kind is
  'busy = hands-on; processing = client processing, stylist free; style = finishing (hands-on).';
comment on type public.addon_placement is
  'before_finish = before the trailing style segments; end = after the last segment.';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.services (
  id                    uuid primary key default gen_random_uuid(),
  salon_id              uuid not null references public.salons (id) on delete cascade,
  name                  text not null check (char_length(btrim(name)) between 1 and 80),
  category              text not null default 'Other' check (char_length(btrim(category)) between 1 and 40),
  description           text check (char_length(description) <= 500),
  price_cents           integer check (price_cents between 0 and 10000000),
  color_tag             text not null default 'gray' check (color_tag in (
                          'gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink')),
  buffer_before_minutes integer not null default 0 check (buffer_before_minutes between 0 and 240),
  buffer_after_minutes  integer not null default 0 check (buffer_after_minutes between 0 and 240),
  consultation_required boolean not null default false,
  bookable_online       boolean not null default true,
  new_clients_only      boolean not null default false,
  is_combo              boolean not null default false,
  position              integer not null default 0,
  archived_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint services_salon_id_id_key unique (salon_id, id)
);

comment on table public.services is
  'Bookable services. Non-combos own service_segments; combos (is_combo) own service_combo_items.';
comment on column public.services.price_cents is 'Price in the salon currency (settings.currency); null = not set.';
comment on column public.services.archived_at is 'Hidden from booking; kept for history.';

create index services_salon_position_idx on public.services (salon_id, position);

create trigger services_set_updated_at
  before update on public.services
  for each row execute function private.set_updated_at();

create table public.service_addons (
  id              uuid primary key default gen_random_uuid(),
  salon_id        uuid not null references public.salons (id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 80),
  price_cents     integer check (price_cents between 0 and 10000000),
  placement       public.addon_placement not null default 'before_finish',
  bookable_online boolean not null default true,
  position        integer not null default 0,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint service_addons_salon_id_id_key unique (salon_id, id)
);

comment on table public.service_addons is 'Salon-wide add-ons (toner, deep conditioning, ...) that insert extra segments.';

create index service_addons_salon_position_idx on public.service_addons (salon_id, position);

create trigger service_addons_set_updated_at
  before update on public.service_addons
  for each row execute function private.set_updated_at();

create table public.service_segments (
  id         uuid primary key default gen_random_uuid(),
  salon_id   uuid not null references public.salons (id) on delete cascade,
  service_id uuid,
  addon_id   uuid,
  position   integer not null check (position >= 0),
  kind       public.segment_kind not null,
  minutes    integer not null check (minutes between 1 and 720),
  label      text check (char_length(label) <= 40),
  created_at timestamptz not null default now(),
  constraint service_segments_one_owner check (num_nonnulls(service_id, addon_id) = 1),
  constraint service_segments_service_fkey foreign key (salon_id, service_id)
    references public.services (salon_id, id) on delete cascade,
  constraint service_segments_addon_fkey foreign key (salon_id, addon_id)
    references public.service_addons (salon_id, id) on delete cascade,
  constraint service_segments_service_position_key unique (service_id, position),
  constraint service_segments_addon_position_key unique (addon_id, position)
);

comment on table public.service_segments is
  'Ordered segments of a service or an add-on (exactly one owner). Composite FKs pin salon_id to the owner.';

create table public.service_variants (
  id            uuid primary key default gen_random_uuid(),
  salon_id      uuid not null references public.salons (id) on delete cascade,
  service_id    uuid not null,
  name          text not null check (char_length(btrim(name)) between 1 and 40),
  delta_minutes integer not null default 0 check (delta_minutes between -240 and 240),
  position      integer not null default 0 check (position >= 0),
  created_at    timestamptz not null default now(),
  constraint service_variants_service_fkey foreign key (salon_id, service_id)
    references public.services (salon_id, id) on delete cascade,
  constraint service_variants_service_position_key unique (service_id, position)
    deferrable initially deferred
);

comment on table public.service_variants is
  'E.g. hair length Short +0 / Medium +15 / Long +30: minutes spread over the busy/style segments.';

create table public.service_combo_items (
  salon_id                 uuid not null references public.salons (id) on delete cascade,
  combo_id                 uuid not null,
  position                 integer not null check (position >= 0),
  service_id               uuid not null,
  replaces_previous_finish boolean not null default false,
  primary key (combo_id, position),
  constraint service_combo_items_combo_fkey foreign key (salon_id, combo_id)
    references public.services (salon_id, id) on delete cascade,
  constraint service_combo_items_service_fkey foreign key (salon_id, service_id)
    references public.services (salon_id, id) on delete restrict
);

comment on table public.service_combo_items is
  'Services of a combo, in order. replaces_previous_finish drops the style segments built so far.';
comment on column public.service_combo_items.replaces_previous_finish is
  'E.g. Balayage + Women''s cut: the cut replaces the balayage rinse/style.';

create index service_combo_items_service_idx on public.service_combo_items (service_id);

create or replace function private.check_combo_item()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.services s where s.id = new.combo_id and s.is_combo) then
    raise exception 'combo_id must reference a combo service' using errcode = '23514';
  end if;
  if exists (select 1 from public.services s where s.id = new.service_id and s.is_combo) then
    raise exception 'A combo cannot contain another combo' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger service_combo_items_check
  before insert or update on public.service_combo_items
  for each row execute function private.check_combo_item();

-- ---------------------------------------------------------------------------
-- Row level security: members read, owners write.
-- ---------------------------------------------------------------------------

alter table public.services            enable row level security;
alter table public.service_addons      enable row level security;
alter table public.service_segments    enable row level security;
alter table public.service_variants    enable row level security;
alter table public.service_combo_items enable row level security;

revoke all on public.services, public.service_addons, public.service_segments,
              public.service_variants, public.service_combo_items from anon;

create policy "members can read services" on public.services
  for select to authenticated using (private.is_salon_member(salon_id));
create policy "owners manage services" on public.services
  for all to authenticated
  using (private.has_salon_role(salon_id, 'owner'))
  with check (private.has_salon_role(salon_id, 'owner'));

create policy "members can read add-ons" on public.service_addons
  for select to authenticated using (private.is_salon_member(salon_id));
create policy "owners manage add-ons" on public.service_addons
  for all to authenticated
  using (private.has_salon_role(salon_id, 'owner'))
  with check (private.has_salon_role(salon_id, 'owner'));

create policy "members can read service segments" on public.service_segments
  for select to authenticated using (private.is_salon_member(salon_id));
create policy "owners manage service segments" on public.service_segments
  for all to authenticated
  using (private.has_salon_role(salon_id, 'owner'))
  with check (private.has_salon_role(salon_id, 'owner'));

create policy "members can read service variants" on public.service_variants
  for select to authenticated using (private.is_salon_member(salon_id));
create policy "owners manage service variants" on public.service_variants
  for all to authenticated
  using (private.has_salon_role(salon_id, 'owner'))
  with check (private.has_salon_role(salon_id, 'owner'));

create policy "members can read combo items" on public.service_combo_items
  for select to authenticated using (private.is_salon_member(salon_id));
create policy "owners manage combo items" on public.service_combo_items
  for all to authenticated
  using (private.has_salon_role(salon_id, 'owner'))
  with check (private.has_salon_role(salon_id, 'owner'));

-- ---------------------------------------------------------------------------
-- Validation + upsert helpers (private; JSON shape = packages/core ServiceDefinition)
-- ---------------------------------------------------------------------------

-- Mirrors validateSegments() / validateAddonSegments() in packages/core.
create or replace function private.assert_valid_segments(p_segments jsonb, p_is_addon boolean default false)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_segments is null or jsonb_typeof(p_segments) <> 'array' or jsonb_array_length(p_segments) = 0 then
    raise exception 'At least one segment is required' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_segments) e,
         lateral (select case when jsonb_typeof(e -> 'minutes') = 'number'
                              then (e ->> 'minutes')::numeric end as m) x
    where jsonb_typeof(e) <> 'object'
       or coalesce(e ->> 'kind', '') not in ('busy', 'processing', 'style')
       or x.m is null or x.m <> trunc(x.m) or x.m not between 1 and 720
  ) then
    raise exception 'Invalid segment: kind must be busy, processing or style and minutes a whole number from 1 to 720'
      using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_segments);
  if not p_is_addon
     and (p_segments -> 0 ->> 'kind' = 'processing' or p_segments -> (v_n - 1) ->> 'kind' = 'processing') then
    raise exception 'A service cannot start or end with a processing segment' using errcode = '22023';
  end if;
end;
$$;

create or replace function private.upsert_service(p_salon_id uuid, p_service jsonb, p_position integer default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id       uuid;
  v_is_combo boolean;
  v_segments jsonb;
  v_variants jsonb;
  v_items    jsonb;
begin
  if jsonb_typeof(p_service) is distinct from 'object' then
    raise exception 'Service must be a JSON object' using errcode = '22023';
  end if;
  v_id       := nullif(p_service ->> 'id', '')::uuid;
  v_is_combo := coalesce((p_service ->> 'isCombo')::boolean, false);
  v_segments := coalesce(p_service -> 'segments', '[]'::jsonb);
  v_variants := coalesce(p_service -> 'variants', '[]'::jsonb);
  v_items    := coalesce(p_service -> 'items', '[]'::jsonb);

  if jsonb_typeof(v_variants) <> 'array' or jsonb_typeof(v_items) <> 'array'
     or jsonb_typeof(v_segments) <> 'array' then
    raise exception 'segments, variants and items must be arrays' using errcode = '22023';
  end if;
  if v_is_combo then
    if jsonb_array_length(v_segments) > 0 then
      raise exception 'A combo has no segments of its own; it is built from its services' using errcode = '22023';
    end if;
    if jsonb_array_length(v_items) = 0 then
      raise exception 'A combo needs at least one service' using errcode = '22023';
    end if;
  else
    perform private.assert_valid_segments(v_segments);
    if jsonb_array_length(v_items) > 0 then
      raise exception 'Only combos have items' using errcode = '22023';
    end if;
  end if;

  if v_id is null then
    insert into public.services (
      salon_id, name, category, description, price_cents, color_tag,
      buffer_before_minutes, buffer_after_minutes,
      consultation_required, bookable_online, new_clients_only, is_combo, position)
    values (
      p_salon_id,
      btrim(p_service ->> 'name'),
      coalesce(nullif(btrim(p_service ->> 'category'), ''), 'Other'),
      nullif(btrim(p_service ->> 'description'), ''),
      (p_service ->> 'priceCents')::integer,
      coalesce(p_service ->> 'colorTag', 'gray'),
      coalesce((p_service ->> 'bufferBeforeMinutes')::integer, 0),
      coalesce((p_service ->> 'bufferAfterMinutes')::integer, 0),
      coalesce((p_service ->> 'consultationRequired')::boolean, false),
      coalesce((p_service ->> 'bookableOnline')::boolean, true),
      coalesce((p_service ->> 'newClientsOnly')::boolean, false),
      v_is_combo,
      coalesce(p_position,
               (select coalesce(max(s.position) + 1, 0) from public.services s where s.salon_id = p_salon_id)))
    returning id into v_id;
  else
    update public.services s set
      name                  = btrim(p_service ->> 'name'),
      category              = coalesce(nullif(btrim(p_service ->> 'category'), ''), 'Other'),
      description           = nullif(btrim(p_service ->> 'description'), ''),
      price_cents           = (p_service ->> 'priceCents')::integer,
      color_tag             = coalesce(p_service ->> 'colorTag', 'gray'),
      buffer_before_minutes = coalesce((p_service ->> 'bufferBeforeMinutes')::integer, 0),
      buffer_after_minutes  = coalesce((p_service ->> 'bufferAfterMinutes')::integer, 0),
      consultation_required = coalesce((p_service ->> 'consultationRequired')::boolean, false),
      bookable_online       = coalesce((p_service ->> 'bookableOnline')::boolean, true),
      new_clients_only      = coalesce((p_service ->> 'newClientsOnly')::boolean, false),
      position              = coalesce(p_position, s.position)
    where s.id = v_id and s.salon_id = p_salon_id and s.is_combo = v_is_combo;
    if not found then
      raise exception 'Service not found' using errcode = 'P0002';
    end if;
  end if;

  delete from public.service_segments where service_id = v_id;
  insert into public.service_segments (salon_id, service_id, position, kind, minutes, label)
  select p_salon_id, v_id, (t.o - 1)::integer, (t.e ->> 'kind')::public.segment_kind,
         (t.e ->> 'minutes')::integer, nullif(btrim(t.e ->> 'label'), '')
  from jsonb_array_elements(v_segments) with ordinality as t(e, o);

  -- Variants keep their ids (future appointments may reference them).
  delete from public.service_variants v
  where v.service_id = v_id
    and v.id not in (select (e ->> 'id')::uuid from jsonb_array_elements(v_variants) e
                     where nullif(e ->> 'id', '') is not null);
  update public.service_variants v set
    name          = btrim(t.e ->> 'name'),
    delta_minutes = coalesce((t.e ->> 'deltaMinutes')::integer, 0),
    position      = (t.o - 1)::integer
  from jsonb_array_elements(v_variants) with ordinality as t(e, o)
  where nullif(t.e ->> 'id', '') is not null and v.id = (t.e ->> 'id')::uuid and v.service_id = v_id;
  insert into public.service_variants (salon_id, service_id, name, delta_minutes, position)
  select p_salon_id, v_id, btrim(t.e ->> 'name'), coalesce((t.e ->> 'deltaMinutes')::integer, 0), (t.o - 1)::integer
  from jsonb_array_elements(v_variants) with ordinality as t(e, o)
  where nullif(t.e ->> 'id', '') is null;

  delete from public.service_combo_items where combo_id = v_id;
  insert into public.service_combo_items (salon_id, combo_id, position, service_id, replaces_previous_finish)
  select p_salon_id, v_id, (t.o - 1)::integer, (t.e ->> 'serviceId')::uuid,
         coalesce((t.e ->> 'replacesPreviousFinish')::boolean, false)
  from jsonb_array_elements(v_items) with ordinality as t(e, o);

  return v_id;
end;
$$;

create or replace function private.upsert_service_addon(p_salon_id uuid, p_addon jsonb, p_position integer default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if jsonb_typeof(p_addon) is distinct from 'object' then
    raise exception 'Add-on must be a JSON object' using errcode = '22023';
  end if;
  v_id := nullif(p_addon ->> 'id', '')::uuid;
  perform private.assert_valid_segments(p_addon -> 'segments', true);

  if v_id is null then
    insert into public.service_addons (salon_id, name, price_cents, placement, bookable_online, position)
    values (
      p_salon_id,
      btrim(p_addon ->> 'name'),
      (p_addon ->> 'priceCents')::integer,
      coalesce((p_addon ->> 'placement')::public.addon_placement, 'before_finish'),
      coalesce((p_addon ->> 'bookableOnline')::boolean, true),
      coalesce(p_position,
               (select coalesce(max(a.position) + 1, 0) from public.service_addons a where a.salon_id = p_salon_id)))
    returning id into v_id;
  else
    update public.service_addons a set
      name            = btrim(p_addon ->> 'name'),
      price_cents     = (p_addon ->> 'priceCents')::integer,
      placement       = coalesce((p_addon ->> 'placement')::public.addon_placement, 'before_finish'),
      bookable_online = coalesce((p_addon ->> 'bookableOnline')::boolean, true),
      position        = coalesce(p_position, a.position)
    where a.id = v_id and a.salon_id = p_salon_id;
    if not found then
      raise exception 'Add-on not found' using errcode = 'P0002';
    end if;
  end if;

  delete from public.service_segments where addon_id = v_id;
  insert into public.service_segments (salon_id, addon_id, position, kind, minutes, label)
  select p_salon_id, v_id, (t.o - 1)::integer, (t.e ->> 'kind')::public.segment_kind,
         (t.e ->> 'minutes')::integer, nullif(btrim(t.e ->> 'label'), '')
  from jsonb_array_elements(p_addon -> 'segments') with ordinality as t(e, o);

  return v_id;
end;
$$;

revoke all on function private.assert_valid_segments(jsonb, boolean) from public;
revoke all on function private.upsert_service(uuid, jsonb, integer) from public;
revoke all on function private.upsert_service_addon(uuid, jsonb, integer) from public;

-- ---------------------------------------------------------------------------
-- RPCs (owners only)
-- ---------------------------------------------------------------------------

create or replace function public.save_service(p_salon_id uuid, p_service jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not private.has_salon_role(p_salon_id, 'owner') then
    raise exception 'Only salon owners can edit services' using errcode = '42501';
  end if;
  v_id := private.upsert_service(p_salon_id, p_service);
  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (p_salon_id, auth.uid(), 'service.saved', 'service', v_id::text,
          jsonb_build_object('name', p_service ->> 'name', 'created', nullif(p_service ->> 'id', '') is null));
  return v_id;
end;
$$;

comment on function public.save_service(uuid, jsonb) is
  'Creates (no id) or replaces a service with its segments, variants and combo items, atomically. '
  'JSON keys follow packages/core ServiceDefinition (+ isCombo, items[{serviceId, replacesPreviousFinish}]).';

create or replace function public.save_service_addon(p_salon_id uuid, p_addon jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not private.has_salon_role(p_salon_id, 'owner') then
    raise exception 'Only salon owners can edit add-ons' using errcode = '42501';
  end if;
  v_id := private.upsert_service_addon(p_salon_id, p_addon);
  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (p_salon_id, auth.uid(), 'service_addon.saved', 'service_addon', v_id::text,
          jsonb_build_object('name', p_addon ->> 'name', 'created', nullif(p_addon ->> 'id', '') is null));
  return v_id;
end;
$$;

comment on function public.save_service_addon(uuid, jsonb) is
  'Creates (no id) or replaces an add-on with its segments. JSON keys follow packages/core ServiceAddon.';

revoke all on function public.save_service(uuid, jsonb) from public, anon;
revoke all on function public.save_service_addon(uuid, jsonb) from public, anon;
grant execute on function public.save_service(uuid, jsonb) to authenticated;
grant execute on function public.save_service_addon(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Starter menu (Appendix A). Keep in sync with packages/core/src/services/starter-menu.ts.
-- ---------------------------------------------------------------------------

create or replace function private.starter_menu()
returns jsonb
language sql
immutable
set search_path = ''
as $fn$
  select $json$
{
  "services": [
    {"name":"Women's cut & style","category":"Cuts","description":null,"priceCents":4500,"colorTag":"blue","segments":[{"kind":"busy","minutes":45,"label":"Cut & style"}],"bufferBeforeMinutes":0,"bufferAfterMinutes":0,"consultationRequired":false,"bookableOnline":true,"newClientsOnly":false,"variants":[{"name":"Short","deltaMinutes":0},{"name":"Medium","deltaMinutes":15},{"name":"Long/thick","deltaMinutes":30}]},
    {"name":"Men's cut","category":"Cuts","description":null,"priceCents":2500,"colorTag":"blue","segments":[{"kind":"busy","minutes":30,"label":"Cut"}],"bufferBeforeMinutes":0,"bufferAfterMinutes":0,"consultationRequired":false,"bookableOnline":true,"newClientsOnly":false,"variants":[]},
    {"name":"Kids' cut (≤12)","category":"Cuts","description":null,"priceCents":2000,"colorTag":"blue","segments":[{"kind":"busy","minutes":20,"label":"Cut"}],"bufferBeforeMinutes":0,"bufferAfterMinutes":0,"consultationRequired":false,"bookableOnline":true,"newClientsOnly":false,"variants":[]},
    {"name":"Bang/fringe trim","category":"Cuts","description":null,"priceCents":1000,"colorTag":"blue","segments":[{"kind":"busy","minutes":10,"label":"Trim"}],"bufferBeforeMinutes":0,"bufferAfterMinutes":0,"consultationRequired":false,"bookableOnline":true,"newClientsOnly":false,"variants":[]},
    {"name":"Beard trim","category":"Cuts","description":null,"priceCents":1500,"colorTag":"blue","segments":[{"kind":"busy","minutes":15,"label":"Trim"}],"bufferBeforeMinutes":0,"bufferAfterMinutes":0,"consultationRequired":false,"bookableOnline":true,"newClientsOnly":false,"variants":[]},
    {"name":"Blowout","category":"Styling","description":null,"priceCents":4000,"colorTag":"pink","segments":[{"kind":"busy","minutes":45,"label":"Blowout"}],"bufferBeforeMinutes":0,"bufferAfterMinutes":0,"consultationRequired":false,"bookableOnline":true,"newClientsOnly":false,"variants":[{"name":"Short","deltaMinutes":0},{"name":"Medium","deltaMinutes":15},{"name":"Long/thick","deltaMinutes":30}]},
    {"name":"Updo / special occasion","category":"Styling","description":null,"priceCents":7500,"colorTag":"pink","segments":[{"kind":"busy","minutes":60,"label":"Style"}],"bufferBeforeMinutes":0,"bufferAfterMinutes":0,"consultationRequired":false,"bookableOnline":true,"newClientsOnly":false,"variants":[{"name":"Short","deltaMinutes":0},{"name":"Medium","deltaMinutes":15},{"name":"Long/thick","deltaMinutes":30}]},
    {"name":"Bridal trial","category":"Styling","description":null,"priceCents":10000,"colorTag":"pink","segments":[{"kind":"busy","minutes":90,"label":"Style"}],"bufferBeforeMinutes":0,"bufferAfterMinutes":0,"consultationRequired":false,"bookableOnline":true,"newClientsOnly":false,"variants":[{"name":"Short","deltaMinutes":0},{"name":"Medium","deltaMinutes":15},{"name":"Long/thick","deltaMinutes":30}]},
    {"name":"Root touch-up","category":"Color","description":null,"priceCents":6500,"colorTag":"purple","segments":[{"kind":"busy","minutes":30,"label":"Apply"},{"kind":"processing","minutes":35,"label":"Process"},{"kind":"style","minutes":30,"label":"Rinse & style"}],"bufferBeforeMinutes":0,"bufferAfterMinutes":10,"consultationRequired":false,"bookableOnline":true,"newClientsOnly":false,"variants":[{"name":"Short","deltaMinutes":0},{"name":"Medium","deltaMinutes":15},{"name":"Long/thick","deltaMinutes":30}]},
    {"name":"All-over color","category":"Color","description":null,"priceCents":8500,"colorTag":"purple","segments":[{"kind":"busy","minutes":40,"label":"Apply"},{"kind":"processing","minutes":35,"label":"Process"},{"kind":"style","minutes":30,"label":"Rinse & style"}],"bufferBeforeMinutes":0,"bufferAfterMinutes":10,"consultationRequired":false,"bookableOnline":true,"newClientsOnly":false,"variants":[{"name":"Short","deltaMinutes":0},{"name":"Medium","deltaMinutes":15},{"name":"Long/thick","deltaMinutes":30}]},
    {"name":"Toner / gloss","category":"Color","description":null,"priceCents":3500,"colorTag":"purple","segments":[{"kind":"busy","minutes":10,"label":"Apply"},{"kind":"processing","minutes":20,"label":"Process"},{"kind":"style","minutes":15,"label":"Rinse & style"}],"bufferBeforeMinutes":0,"bufferAfterMinutes":10,"consultationRequired":false,"bookableOnline":true,"newClientsOnly":false,"variants":[{"name":"Short","deltaMinutes":0},{"name":"Medium","deltaMinutes":15},{"name":"Long/thick","deltaMinutes":30}]},
    {"name":"Partial highlights","category":"Color","description":null,"priceCents":11000,"colorTag":"purple","segments":[{"kind":"busy","minutes":60,"label":"Foils"},{"kind":"processing","minutes":30,"label":"Process"},{"kind":"busy","minutes":15,"label":"Tone"},{"kind":"style","minutes":30,"label":"Rinse & style"}],"bufferBeforeMinutes":0,"bufferAfterMinutes":10,"consultationRequired":false,"bookableOnline":true,"newClientsOnly":false,"variants":[{"name":"Short","deltaMinutes":0},{"name":"Medium","deltaMinutes":15},{"name":"Long/thick","deltaMinutes":30}]},
    {"name":"Full highlights","category":"Color","description":null,"priceCents":15000,"colorTag":"purple","segments":[{"kind":"busy","minutes":90,"label":"Foils"},{"kind":"processing","minutes":30,"label":"Process"},{"kind":"busy","minutes":15,"label":"Tone"},{"kind":"style","minutes":30,"label":"Rinse & style"}],"bufferBeforeMinutes":0,"bufferAfterMinutes":10,"consultationRequired":false,"bookableOnline":true,"newClientsOnly":false,"variants":[{"name":"Short","deltaMinutes":0},{"name":"Medium","deltaMinutes":15},{"name":"Long/thick","deltaMinutes":30}]},
    {"name":"Balayage","category":"Color","description":null,"priceCents":18000,"colorTag":"purple","segments":[{"kind":"busy","minutes":75,"label":"Paint"},{"kind":"processing","minutes":40,"label":"Process"},{"kind":"busy","minutes":20,"label":"Tone"},{"kind":"style","minutes":35,"label":"Rinse & style"}],"bufferBeforeMinutes":0,"bufferAfterMinutes":10,"consultationRequired":false,"bookableOnline":true,"newClientsOnly":false,"variants":[{"name":"Short","deltaMinutes":0},{"name":"Medium","deltaMinutes":15},{"name":"Long/thick","deltaMinutes":30}]},
    {"name":"Color correction","category":"Color","description":"Consultation required. Set the time per booking (typically 3–6h).","priceCents":25000,"colorTag":"purple","segments":[{"kind":"busy","minutes":60,"label":"Apply"},{"kind":"processing","minutes":30,"label":"Process"},{"kind":"busy","minutes":60,"label":"Correct"},{"kind":"style","minutes":30,"label":"Rinse & style"}],"bufferBeforeMinutes":0,"bufferAfterMinutes":10,"consultationRequired":true,"bookableOnline":false,"newClientsOnly":false,"variants":[]},
    {"name":"Deep conditioning","category":"Treatments","description":null,"priceCents":2000,"colorTag":"green","segments":[{"kind":"busy","minutes":5,"label":"Apply"},{"kind":"processing","minutes":15,"label":"Process"},{"kind":"busy","minutes":5,"label":"Rinse"}],"bufferBeforeMinutes":0,"bufferAfterMinutes":0,"consultationRequired":false,"bookableOnline":true,"newClientsOnly":false,"variants":[]},
    {"name":"Keratin / smoothing","category":"Treatments","description":null,"priceCents":20000,"colorTag":"green","segments":[{"kind":"busy","minutes":60,"label":"Apply"},{"kind":"processing","minutes":30,"label":"Process"},{"kind":"busy","minutes":60,"label":"Blow-dry & flat iron"}],"bufferBeforeMinutes":0,"bufferAfterMinutes":10,"consultationRequired":false,"bookableOnline":true,"newClientsOnly":false,"variants":[{"name":"Short","deltaMinutes":0},{"name":"Medium","deltaMinutes":15},{"name":"Long/thick","deltaMinutes":30}]},
    {"name":"Perm","category":"Treatments","description":null,"priceCents":9000,"colorTag":"green","segments":[{"kind":"busy","minutes":45,"label":"Wrap"},{"kind":"processing","minutes":30,"label":"Process"},{"kind":"style","minutes":30,"label":"Rinse & style"}],"bufferBeforeMinutes":0,"bufferAfterMinutes":10,"consultationRequired":false,"bookableOnline":true,"newClientsOnly":false,"variants":[{"name":"Short","deltaMinutes":0},{"name":"Medium","deltaMinutes":15},{"name":"Long/thick","deltaMinutes":30}]},
    {"name":"Consultation","category":"Other","description":null,"priceCents":0,"colorTag":"gray","segments":[{"kind":"busy","minutes":15,"label":"Consult"}],"bufferBeforeMinutes":0,"bufferAfterMinutes":0,"consultationRequired":false,"bookableOnline":true,"newClientsOnly":false,"variants":[]},
    {"name":"Extensions","category":"Other","description":"Consultation required first. Typically 2–4h.","priceCents":30000,"colorTag":"gray","segments":[{"kind":"busy","minutes":120,"label":"Install"},{"kind":"style","minutes":30,"label":"Blend & style"}],"bufferBeforeMinutes":0,"bufferAfterMinutes":0,"consultationRequired":true,"bookableOnline":false,"newClientsOnly":false,"variants":[]}
  ],
  "addons": [
    {"name":"Toner","segments":[{"kind":"busy","minutes":5,"label":"Apply toner"},{"kind":"processing","minutes":15,"label":"Process"}],"placement":"before_finish","priceCents":3500},
    {"name":"Deep conditioning","segments":[{"kind":"busy","minutes":5,"label":"Apply treatment"},{"kind":"processing","minutes":15,"label":"Process"},{"kind":"busy","minutes":5,"label":"Rinse"}],"placement":"before_finish","priceCents":2000},
    {"name":"Bond treatment (Olaplex)","segments":[{"kind":"busy","minutes":5,"label":"Apply bond treatment"},{"kind":"processing","minutes":10,"label":"Process"}],"placement":"before_finish","priceCents":3000},
    {"name":"Blowout finish","segments":[{"kind":"style","minutes":15,"label":"Blowout"}],"placement":"end","priceCents":2000}
  ],
  "combos": [
    {"name":"Balayage + Women's cut","category":"Color","description":"Balayage, then the cut replaces the rinse & style.","priceCents":null,"colorTag":"purple","bufferBeforeMinutes":0,"bufferAfterMinutes":0,"consultationRequired":false,"bookableOnline":true,"newClientsOnly":false,"variants":[{"name":"Short","deltaMinutes":0},{"name":"Medium","deltaMinutes":15},{"name":"Long/thick","deltaMinutes":30}],"items":[{"service":"Balayage","replacesPreviousFinish":false},{"service":"Women's cut & style","replacesPreviousFinish":true}]}
  ]
}
$json$::jsonb;
$fn$;

create or replace function private.seed_starter_menu(p_salon_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_menu  jsonb := private.starter_menu();
  v_ids   jsonb := '{}'::jsonb;
  v_n     integer := jsonb_array_length(v_menu -> 'services');
  v_e     jsonb;
  v_o     bigint;
begin
  -- Only seed an empty menu (idempotent; never clobbers his edits).
  if exists (select 1 from public.services s where s.salon_id = p_salon_id)
     or exists (select 1 from public.service_addons a where a.salon_id = p_salon_id) then
    return;
  end if;

  for v_e, v_o in select t.e, t.o from jsonb_array_elements(v_menu -> 'services') with ordinality as t(e, o) loop
    v_ids := v_ids || jsonb_build_object(
      v_e ->> 'name', private.upsert_service(p_salon_id, v_e, (v_o - 1)::integer));
  end loop;

  for v_e, v_o in select t.e, t.o from jsonb_array_elements(v_menu -> 'addons') with ordinality as t(e, o) loop
    perform private.upsert_service_addon(p_salon_id, v_e, (v_o - 1)::integer);
  end loop;

  for v_e, v_o in select t.e, t.o from jsonb_array_elements(v_menu -> 'combos') with ordinality as t(e, o) loop
    perform private.upsert_service(
      p_salon_id,
      (v_e - 'items') || jsonb_build_object(
        'isCombo', true,
        'items', (select jsonb_agg(jsonb_build_object(
                           'serviceId', v_ids ->> (i.e ->> 'service'),
                           'replacesPreviousFinish', i.e -> 'replacesPreviousFinish') order by i.o)
                  from jsonb_array_elements(v_e -> 'items') with ordinality as i(e, o))),
      (v_n + v_o - 1)::integer);
  end loop;
end;
$$;

create or replace function private.seed_new_salon_services()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.seed_starter_menu(new.id);
  return null;
end;
$$;

revoke all on function private.starter_menu() from public;
revoke all on function private.seed_starter_menu(uuid) from public;
revoke all on function private.seed_new_salon_services() from public;

create trigger salons_seed_starter_menu
  after insert on public.salons
  for each row execute function private.seed_new_salon_services();

-- Backfill salons created before this migration.
select private.seed_starter_menu(s.id) from public.salons s;
