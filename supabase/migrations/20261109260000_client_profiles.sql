-- Client profiles (docs/PLAN.md §11 and §13, issue #13).
--
-- * `clients` gains tags, marketing opt-in and preferred services.
-- * `client_service_overrides`: per-client, per-service duration changes ("Karina's color +20m").
--   The app and Ask Chairside pass them to the core resolvers (`ResolveOptions.clientAdjustment`),
--   so every booking applies them automatically.
-- * `client_formulas`: color formulas per visit, searchable (trigram).
-- * `client_notes`: a dated note timeline (owner, Ask Chairside or imported).
-- * `client_photos`: before/after photos. Files live in the private `client-photos` Storage bucket
--   under `{salon_id}/{client_id}/…`; Storage RLS checks salon membership from the first folder.
-- * `client_summaries`: visits, no-shows, last/next visit and amount paid per client (RLS-scoped).

-- ---------------------------------------------------------------------------
-- clients: profile fields
-- ---------------------------------------------------------------------------

alter table public.clients
  add column tags                  text[] not null default '{}',
  add column marketing_opt_in      boolean not null default false,
  add column preferred_service_ids uuid[] not null default '{}',
  add constraint clients_tags_check check (
    cardinality(tags) <= 20
    and array_position(tags, null) is null
    and char_length(array_to_string(tags, '')) <= 400
  ),
  add constraint clients_preferred_services_check check (
    cardinality(preferred_service_ids) <= 20 and array_position(preferred_service_ids, null) is null
  );

comment on column public.clients.tags is 'Free-form labels, e.g. {VIP, blonde, sensitive scalp}.';
comment on column public.clients.marketing_opt_in is
  'Client agreed to marketing messages. Reminders and confirmations are not marketing.';
comment on column public.clients.preferred_service_ids is
  'services.id values the client usually books, in order of preference.';

-- ---------------------------------------------------------------------------
-- client_service_overrides
-- ---------------------------------------------------------------------------

create table public.client_service_overrides (
  id            uuid primary key default gen_random_uuid(),
  salon_id      uuid not null references public.salons (id) on delete cascade,
  client_id     uuid not null,
  service_id    uuid not null,
  -- Mirrors MAX_OVERRIDE_MINUTES in packages/core/src/clients/overrides.ts.
  delta_minutes integer not null check (delta_minutes between -240 and 240 and delta_minutes <> 0),
  -- Null spreads the minutes over the hands-on segments; otherwise one segment of the service.
  segment_index integer check (segment_index between 0 and 49),
  note          text check (note is null or char_length(note) <= 200),
  source        text not null default 'manual' check (source in ('manual', 'suggested', 'ai')),
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint client_service_overrides_client_fkey foreign key (salon_id, client_id)
    references public.clients (salon_id, id) on delete cascade,
  constraint client_service_overrides_service_fkey foreign key (salon_id, service_id)
    references public.services (salon_id, id) on delete cascade,
  constraint client_service_overrides_client_service_key unique (client_id, service_id)
);

comment on table public.client_service_overrides is
  'Per-client duration change for one service or combo, applied automatically when booking.';

create index client_service_overrides_service_idx on public.client_service_overrides (service_id);

create trigger client_service_overrides_set_updated_at
  before update on public.client_service_overrides
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- client_formulas
-- ---------------------------------------------------------------------------

create table public.client_formulas (
  id             uuid primary key default gen_random_uuid(),
  salon_id       uuid not null references public.salons (id) on delete cascade,
  client_id      uuid not null,
  appointment_id uuid,
  visit_date     date not null default current_date,
  -- e.g. "Root touch-up"; free text so formulas survive menu edits.
  service_name   text check (service_name is null or char_length(service_name) <= 80),
  formula        text not null check (char_length(btrim(formula)) between 1 and 2000),
  notes          text check (notes is null or char_length(notes) <= 2000),
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint client_formulas_client_fkey foreign key (salon_id, client_id)
    references public.clients (salon_id, id) on delete cascade,
  constraint client_formulas_appointment_fkey foreign key (salon_id, appointment_id)
    references public.appointments (salon_id, id) on delete set null (appointment_id)
);

comment on table public.client_formulas is 'Color formulas per visit. Searchable by formula text.';

create index client_formulas_client_idx on public.client_formulas (client_id, visit_date desc);
create index client_formulas_formula_trgm_idx on public.client_formulas
  using gin (lower(formula) extensions.gin_trgm_ops);

create trigger client_formulas_set_updated_at
  before update on public.client_formulas
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- client_notes
-- ---------------------------------------------------------------------------

create table public.client_notes (
  id         uuid primary key default gen_random_uuid(),
  salon_id   uuid not null references public.salons (id) on delete cascade,
  client_id  uuid not null,
  body       text not null check (char_length(btrim(body)) between 1 and 4000),
  -- owner: typed in the app; ai: attached by Ask Chairside from pasted text; import: Vagaro etc.
  source     text not null default 'owner' check (source in ('owner', 'ai', 'import')),
  pinned     boolean not null default false,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_notes_client_fkey foreign key (salon_id, client_id)
    references public.clients (salon_id, id) on delete cascade
);

create index client_notes_client_idx on public.client_notes (client_id, created_at desc);

create trigger client_notes_set_updated_at
  before update on public.client_notes
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- client_photos (+ Storage bucket)
-- ---------------------------------------------------------------------------

create table public.client_photos (
  id             uuid primary key default gen_random_uuid(),
  salon_id       uuid not null references public.salons (id) on delete cascade,
  client_id      uuid not null,
  appointment_id uuid,
  -- Object name in the `client-photos` bucket: `{salon_id}/{client_id}/{file}`.
  storage_path   text not null unique,
  kind           text not null default 'after' check (kind in ('before', 'after', 'other')),
  caption        text check (caption is null or char_length(caption) <= 200),
  taken_at       timestamptz not null default now(),
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint client_photos_client_fkey foreign key (salon_id, client_id)
    references public.clients (salon_id, id) on delete cascade,
  constraint client_photos_appointment_fkey foreign key (salon_id, appointment_id)
    references public.appointments (salon_id, id) on delete set null (appointment_id),
  constraint client_photos_path_in_client_folder check (
    starts_with(storage_path, salon_id::text || '/' || client_id::text || '/')
    and storage_path !~ '\.\.'
    and char_length(storage_path) <= 300
  )
);

create index client_photos_client_idx on public.client_photos (client_id, taken_at desc);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('client-photos', 'client-photos', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The salon that owns a `client-photos` object (its first folder), or null for anything else.
create or replace function private.client_photo_salon_id(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when p_name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F-]{36}/[^/]+$'
    then split_part(p_name, '/', 1)::uuid
  end;
$$;

revoke all on function private.client_photo_salon_id(text) from public;
grant execute on function private.client_photo_salon_id(text) to authenticated, service_role;

create policy "members can read client photos" on storage.objects
  for select to authenticated
  using (bucket_id = 'client-photos'
         and private.is_salon_member(private.client_photo_salon_id(name)));
create policy "members can upload client photos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'client-photos'
              and private.is_salon_member(private.client_photo_salon_id(name)));
create policy "members can delete client photos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'client-photos'
         and private.is_salon_member(private.client_photo_salon_id(name)));

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.client_service_overrides enable row level security;
alter table public.client_formulas          enable row level security;
alter table public.client_notes             enable row level security;
alter table public.client_photos            enable row level security;

revoke all on public.client_service_overrides, public.client_formulas, public.client_notes,
  public.client_photos from anon;

do $$
declare
  t text;
begin
  foreach t in array array['client_service_overrides', 'client_formulas', 'client_notes',
                           'client_photos'] loop
    execute format(
      'create policy "members can read %1$s" on public.%1$I
         for select to authenticated using (private.is_salon_member(salon_id))', t);
    execute format(
      'create policy "members can add %1$s" on public.%1$I
         for insert to authenticated with check (private.is_salon_member(salon_id))', t);
    execute format(
      'create policy "members can update %1$s" on public.%1$I
         for update to authenticated
         using (private.is_salon_member(salon_id))
         with check (private.is_salon_member(salon_id))', t);
    execute format(
      'create policy "members can delete %1$s" on public.%1$I
         for delete to authenticated using (private.is_salon_member(salon_id))', t);
  end loop;
end;
$$;

-- Photos are immutable apart from caption/kind; the file path never moves.
revoke update on public.client_photos from authenticated;
grant update (kind, caption, taken_at, appointment_id) on public.client_photos to authenticated;

-- ---------------------------------------------------------------------------
-- client_summaries: visit history roll-up (security_invoker => RLS of the caller)
-- ---------------------------------------------------------------------------

create view public.client_summaries
with (security_invoker = true)
as
select
  c.id as client_id,
  c.salon_id,
  count(a.id) filter (where a.status = 'completed'
                         or (a.status = 'confirmed' and a.ends_at <= now()))::integer as visit_count,
  count(a.id) filter (where a.status = 'no_show')::integer as no_show_count,
  count(a.id) filter (where a.status = 'cancelled')::integer as cancelled_count,
  max(a.starts_at) filter (where a.status in ('completed', 'confirmed') and a.starts_at <= now())
    as last_visit_at,
  min(a.starts_at) filter (where a.status in ('held', 'requested', 'confirmed')
                             and a.starts_at > now()) as next_visit_at,
  coalesce((
    select sum(p.amount_cents - p.amount_refunded_cents)
      from public.payments p
      join public.appointments pa on pa.id = p.appointment_id
     where pa.client_id = c.id
       and p.status in ('succeeded', 'partially_refunded')
  ), 0)::bigint as paid_cents
from public.clients c
left join public.appointments a on a.client_id = c.id
group by c.id, c.salon_id;

comment on view public.client_summaries is
  'Per-client visit/no-show counts, last/next visit and net amount paid. RLS-scoped (security_invoker).';

revoke all on public.client_summaries from anon;
grant select on public.client_summaries to authenticated;
