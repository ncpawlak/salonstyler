-- Chairside foundation: multi-tenant core (docs/PLAN.md §13).
--
-- Tenancy rules (apply to EVERY future tenant table):
--   1. Carry `salon_id uuid not null references public.salons(id) on delete cascade`.
--   2. `alter table ... enable row level security`.
--   3. Policies scope rows via `private.is_salon_member(salon_id)` /
--      `private.has_salon_role(salon_id, 'owner')`.
-- supabase/tests/database/00_tenancy.test.sql enforces 1 and 2 automatically.

-- Helpers live in a schema that is NOT exposed through the Data API.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

create type public.salon_role as enum ('owner', 'stylist');
create type public.push_platform as enum ('ios', 'android', 'web');

-- ---------------------------------------------------------------------------
-- Utility functions
-- ---------------------------------------------------------------------------

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.is_valid_timezone(tz text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select exists (select 1 from pg_catalog.pg_timezone_names where name = tz);
$$;

create or replace function private.is_valid_salon_slug(p_slug text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'
     and p_slug not in ('admin', 'api', 'app', 'auth', 'book', 'chairside',
                        'help', 'login', 'settings', 'signup', 'support', 'www');
$$;

grant execute on function private.is_valid_timezone(text) to authenticated, service_role;
grant execute on function private.is_valid_salon_slug(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- salons
-- ---------------------------------------------------------------------------

create table public.salons (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(btrim(name)) between 1 and 80),
  slug       text not null unique check (private.is_valid_salon_slug(slug)),
  timezone   text not null check (private.is_valid_timezone(timezone)),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.salons is 'Tenant root. Every tenant table references salons(id).';
comment on column public.salons.slug is 'Public booking page slug: lowercase a-z, 0-9, hyphen; 3-40 chars.';
comment on column public.salons.timezone is 'IANA timezone, e.g. America/Chicago.';

create trigger salons_set_updated_at
  before update on public.salons
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- salon_members
-- ---------------------------------------------------------------------------

create table public.salon_members (
  salon_id   uuid not null references public.salons (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.salon_role not null default 'stylist',
  created_at timestamptz not null default now(),
  primary key (salon_id, user_id)
);

create index salon_members_user_id_idx on public.salon_members (user_id);

-- ---------------------------------------------------------------------------
-- Membership helpers (security definer => no RLS recursion on salon_members)
-- ---------------------------------------------------------------------------

create or replace function private.is_salon_member(p_salon_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.salon_members m
    where m.salon_id = p_salon_id and m.user_id = (select auth.uid())
  );
$$;

create or replace function private.has_salon_role(p_salon_id uuid, p_role public.salon_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.salon_members m
    where m.salon_id = p_salon_id
      and m.user_id = (select auth.uid())
      and m.role = p_role
  );
$$;

revoke all on function private.is_salon_member(uuid) from public;
revoke all on function private.has_salon_role(uuid, public.salon_role) from public;
grant execute on function private.is_salon_member(uuid) to authenticated, service_role;
grant execute on function private.has_salon_role(uuid, public.salon_role) to authenticated, service_role;

-- A salon must always keep at least one owner (transfer ownership or delete the salon first).
create or replace function private.ensure_salon_has_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner')
     and exists (select 1 from public.salons s where s.id = old.salon_id)
     and not exists (
       select 1 from public.salon_members m
       where m.salon_id = old.salon_id and m.role = 'owner' and m.user_id <> old.user_id
     )
  then
    raise exception 'A salon must have at least one owner' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger salon_members_keep_owner
  after update or delete on public.salon_members
  for each row execute function private.ensure_salon_has_owner();

-- ---------------------------------------------------------------------------
-- settings (1:1 with salons)
-- ---------------------------------------------------------------------------

create table public.settings (
  salon_id             uuid primary key references public.salons (id) on delete cascade,
  autonomy             text not null default 'draft' check (autonomy in ('draft', 'auto')),
  booking_window_days  integer not null default 60 check (booking_window_days between 1 and 730),
  hold_expiry_hours    integer not null default 24 check (hold_expiry_hours between 1 and 720),
  followup_nudge_hours integer not null default 24 check (followup_nudge_hours between 1 and 720),
  currency             text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  preferences          jsonb not null default '{}'::jsonb check (jsonb_typeof(preferences) = 'object'),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.settings is 'Per-salon settings. Defaults follow docs/PLAN.md §1 and §17.';

create trigger settings_set_updated_at
  before update on public.settings
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- audit_log (append-only)
-- ---------------------------------------------------------------------------

create table public.audit_log (
  id            bigint generated always as identity primary key,
  salon_id      uuid not null references public.salons (id) on delete cascade,
  actor_user_id uuid default auth.uid() references auth.users (id) on delete set null,
  action        text not null check (char_length(action) between 1 and 100),
  entity_type   text,
  entity_id     text,
  details       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index audit_log_salon_created_idx on public.audit_log (salon_id, created_at desc);

-- ---------------------------------------------------------------------------
-- push_tokens
-- ---------------------------------------------------------------------------

create table public.push_tokens (
  id           uuid primary key default gen_random_uuid(),
  salon_id     uuid not null references public.salons (id) on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  token        text not null,
  platform     public.push_platform not null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (salon_id, token)
);

create index push_tokens_user_id_idx on public.push_tokens (user_id);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.salons        enable row level security;
alter table public.salon_members enable row level security;
alter table public.settings      enable row level security;
alter table public.audit_log     enable row level security;
alter table public.push_tokens   enable row level security;

-- Tenant data is never readable anonymously (public booking goes through Edge Functions).
revoke all on public.salons, public.salon_members, public.settings,
              public.audit_log, public.push_tokens from anon;

-- salons: created only through public.create_salon(); members read, owners update/delete.
create policy "members can read their salons" on public.salons
  for select to authenticated using (private.is_salon_member(id));
create policy "owners can update their salon" on public.salons
  for update to authenticated
  using (private.has_salon_role(id, 'owner'))
  with check (private.has_salon_role(id, 'owner'));
create policy "owners can delete their salon" on public.salons
  for delete to authenticated using (private.has_salon_role(id, 'owner'));

-- salon_members: members see co-members; owners manage membership; anyone may leave.
create policy "members can read co-members" on public.salon_members
  for select to authenticated using (private.is_salon_member(salon_id));
create policy "owners can add members" on public.salon_members
  for insert to authenticated with check (private.has_salon_role(salon_id, 'owner'));
create policy "owners can change member roles" on public.salon_members
  for update to authenticated
  using (private.has_salon_role(salon_id, 'owner'))
  with check (private.has_salon_role(salon_id, 'owner'));
create policy "owners remove members, members can leave" on public.salon_members
  for delete to authenticated
  using (private.has_salon_role(salon_id, 'owner') or user_id = (select auth.uid()));

-- settings: rows are created by create_salon(); members read, owners update.
create policy "members can read settings" on public.settings
  for select to authenticated using (private.is_salon_member(salon_id));
create policy "owners can update settings" on public.settings
  for update to authenticated
  using (private.has_salon_role(salon_id, 'owner'))
  with check (private.has_salon_role(salon_id, 'owner'));

-- audit_log: members read and append as themselves; never update/delete.
create policy "members can read audit log" on public.audit_log
  for select to authenticated using (private.is_salon_member(salon_id));
create policy "members can append audit log" on public.audit_log
  for insert to authenticated
  with check (private.is_salon_member(salon_id) and actor_user_id = (select auth.uid()));
revoke update, delete, truncate on public.audit_log from authenticated;

-- push_tokens: a user manages only their own tokens, within salons they belong to.
create policy "users read own push tokens" on public.push_tokens
  for select to authenticated
  using (user_id = (select auth.uid()) and private.is_salon_member(salon_id));
create policy "users register own push tokens" on public.push_tokens
  for insert to authenticated
  with check (user_id = (select auth.uid()) and private.is_salon_member(salon_id));
create policy "users update own push tokens" on public.push_tokens
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and private.is_salon_member(salon_id));
create policy "users delete own push tokens" on public.push_tokens
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- RPC: first-run salon creation
-- ---------------------------------------------------------------------------

create or replace function public.create_salon(p_name text, p_slug text, p_timezone text)
returns public.salons
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_salon   public.salons;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  insert into public.salons (name, slug, timezone, created_by)
  values (btrim(p_name), lower(btrim(p_slug)), p_timezone, v_user_id)
  returning * into v_salon;

  insert into public.salon_members (salon_id, user_id, role)
  values (v_salon.id, v_user_id, 'owner');

  insert into public.settings (salon_id) values (v_salon.id);

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (v_salon.id, v_user_id, 'salon.created', 'salon', v_salon.id::text,
          jsonb_build_object('name', v_salon.name, 'slug', v_salon.slug, 'timezone', v_salon.timezone));

  return v_salon;
end;
$$;

comment on function public.create_salon(text, text, text) is
  'First-run: creates a salon, makes the caller its owner, and seeds default settings.';

revoke all on function public.create_salon(text, text, text) from public, anon;
grant execute on function public.create_salon(text, text, text) to authenticated;

-- RPC: slug availability for the create-salon form (returns only a boolean).
create or replace function public.is_salon_slug_available(p_slug text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_valid_salon_slug(lower(btrim(p_slug)))
     and not exists (select 1 from public.salons s where s.slug = lower(btrim(p_slug)));
$$;

revoke all on function public.is_salon_slug_available(text) from public, anon;
grant execute on function public.is_salon_slug_available(text) to authenticated;
