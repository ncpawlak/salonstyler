-- AI provider settings (docs/PLAN.md §12, §13 `ai_provider_config`), issue #32.
--
-- * public.ai_provider_config: provider, model, monthly token budget, and a key *hint* only.
-- * The API key itself lives in Supabase Vault (encrypted at rest). The Vault secret id is kept in
--   private.ai_provider_secrets, which is not exposed through the Data API.
-- * Owners save settings with public.save_ai_provider_config(); the key is write-only.
-- * Only the service role (the `ai` Edge Function) can read the decrypted key, via
--   public.get_ai_provider_secret().
-- * public.ai_usage meters every LLM call per salon (BYO key today, AI-included tier later).

create extension if not exists supabase_vault with schema vault;

create type public.ai_provider as enum ('openai', 'anthropic', 'gemini');

-- ---------------------------------------------------------------------------
-- ai_provider_config (1:1 with salons, optional)
-- ---------------------------------------------------------------------------

create table public.ai_provider_config (
  salon_id             uuid primary key references public.salons (id) on delete cascade,
  provider             public.ai_provider not null,
  model                text not null check (char_length(btrim(model)) between 1 and 100),
  monthly_token_budget bigint not null default 1000000 check (monthly_token_budget between 0 and 1000000000),
  key_hint             text not null,
  key_updated_at       timestamptz not null default now(),
  updated_by           uuid default auth.uid() references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.ai_provider_config is
  'Per-salon LLM settings. The API key is stored in Vault and is never readable here; key_hint is e.g. "sk-…AbCd".';
comment on column public.ai_provider_config.monthly_token_budget is
  'Input + output tokens allowed per calendar month (salon timezone). 0 disables AI calls.';

create trigger ai_provider_config_set_updated_at
  before update on public.ai_provider_config
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- private.ai_provider_secrets: salon -> Vault secret id (not exposed via the API)
-- ---------------------------------------------------------------------------

create table private.ai_provider_secrets (
  salon_id        uuid primary key references public.salons (id) on delete cascade,
  vault_secret_id uuid not null unique
);

revoke all on private.ai_provider_secrets from public, anon, authenticated;

-- Removing the mapping (explicitly or via salon delete cascade) also destroys the Vault secret.
create or replace function private.delete_ai_vault_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.vault_secret_id;
  return old;
end;
$$;

revoke all on function private.delete_ai_vault_secret() from public;

create trigger ai_provider_secrets_delete_vault
  after delete on private.ai_provider_secrets
  for each row execute function private.delete_ai_vault_secret();

-- ---------------------------------------------------------------------------
-- ai_usage (append-only metering)
-- ---------------------------------------------------------------------------

create table public.ai_usage (
  id            bigint generated always as identity primary key,
  salon_id      uuid not null references public.salons (id) on delete cascade,
  user_id       uuid references auth.users (id) on delete set null,
  provider      public.ai_provider not null,
  model         text not null,
  purpose       text not null default 'chat' check (char_length(purpose) between 1 and 40),
  input_tokens  integer not null check (input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  total_tokens  integer generated always as (input_tokens + output_tokens) stored,
  created_at    timestamptz not null default now()
);

create index ai_usage_salon_created_idx on public.ai_usage (salon_id, created_at desc);

comment on table public.ai_usage is
  'One row per LLM call, written by the ai Edge Function (service role). Members can read their salon''s usage.';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.ai_provider_config enable row level security;
alter table public.ai_usage           enable row level security;
alter table private.ai_provider_secrets enable row level security;

revoke all on public.ai_provider_config, public.ai_usage from anon;
-- Writes only go through the RPCs below (config) or the service role (usage).
revoke insert, update, delete, truncate on public.ai_provider_config, public.ai_usage from authenticated;

create policy "members can read ai config" on public.ai_provider_config
  for select to authenticated using (private.is_salon_member(salon_id));

create policy "members can read ai usage" on public.ai_usage
  for select to authenticated using (private.is_salon_member(salon_id));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- "sk-proj-abc...wxyz" -> "sk-…wxyz"; "AIzaSy...wxyz" -> "AI…wxyz".
create or replace function private.ai_key_hint(p_key text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(substring(p_key from '^[A-Za-z]+-'), left(p_key, 2)) || '…' || right(p_key, 4);
$$;

-- ---------------------------------------------------------------------------
-- RPC: owners save settings (key is write-only)
-- ---------------------------------------------------------------------------

create or replace function public.save_ai_provider_config(
  p_salon_id uuid,
  p_provider public.ai_provider,
  p_model text,
  p_monthly_token_budget bigint,
  p_api_key text default null
)
returns public.ai_provider_config
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing  public.ai_provider_config;
  v_secret_id uuid;
  v_key       text := nullif(btrim(p_api_key), '');
  v_config    public.ai_provider_config;
begin
  if not private.has_salon_role(p_salon_id, 'owner') then
    raise exception 'Only salon owners can change AI settings' using errcode = '42501';
  end if;
  if v_key is not null and char_length(v_key) not between 20 and 500 then
    raise exception 'That does not look like an API key' using errcode = '22023';
  end if;

  select * into v_existing from public.ai_provider_config where salon_id = p_salon_id;

  if v_key is null and v_existing.salon_id is null then
    raise exception 'An API key is required' using errcode = '22023';
  end if;
  -- A key belongs to one provider: switching providers needs a new key.
  if v_key is null and v_existing.provider <> p_provider then
    raise exception 'Paste a % API key to switch providers', p_provider using errcode = '22023';
  end if;

  if v_key is not null then
    select vault_secret_id into v_secret_id from private.ai_provider_secrets where salon_id = p_salon_id;
    if v_secret_id is null then
      v_secret_id := vault.create_secret(
        v_key, 'ai_api_key:' || p_salon_id::text, 'Chairside AI provider key for salon ' || p_salon_id::text);
      insert into private.ai_provider_secrets (salon_id, vault_secret_id) values (p_salon_id, v_secret_id);
    else
      perform vault.update_secret(v_secret_id, v_key);
    end if;
  end if;

  insert into public.ai_provider_config as c
    (salon_id, provider, model, monthly_token_budget, key_hint, key_updated_at, updated_by)
  values
    (p_salon_id, p_provider, btrim(p_model), p_monthly_token_budget,
     coalesce(private.ai_key_hint(v_key), v_existing.key_hint),
     case when v_key is null then v_existing.key_updated_at else now() end,
     auth.uid())
  on conflict (salon_id) do update set
    provider             = excluded.provider,
    model                = excluded.model,
    monthly_token_budget = excluded.monthly_token_budget,
    key_hint             = excluded.key_hint,
    key_updated_at       = excluded.key_updated_at,
    updated_by           = excluded.updated_by
  returning * into v_config;

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (p_salon_id, auth.uid(), 'ai.config_saved', 'ai_provider_config', p_salon_id::text,
          jsonb_build_object('provider', v_config.provider, 'model', v_config.model,
                             'monthly_token_budget', v_config.monthly_token_budget,
                             'key_changed', v_key is not null));

  return v_config;
end;
$$;

comment on function public.save_ai_provider_config(uuid, public.ai_provider, text, bigint, text) is
  'Owner-only. Upserts AI settings; when p_api_key is given it is written to Vault and never returned.';

revoke all on function public.save_ai_provider_config(uuid, public.ai_provider, text, bigint, text) from public, anon;
grant execute on function public.save_ai_provider_config(uuid, public.ai_provider, text, bigint, text) to authenticated;

-- RPC: owners remove AI settings and the stored key.
create or replace function public.delete_ai_provider_config(p_salon_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_salon_role(p_salon_id, 'owner') then
    raise exception 'Only salon owners can change AI settings' using errcode = '42501';
  end if;
  delete from private.ai_provider_secrets where salon_id = p_salon_id;
  delete from public.ai_provider_config where salon_id = p_salon_id;
  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id)
  values (p_salon_id, auth.uid(), 'ai.config_deleted', 'ai_provider_config', p_salon_id::text);
end;
$$;

revoke all on function public.delete_ai_provider_config(uuid) from public, anon;
grant execute on function public.delete_ai_provider_config(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: service role only. The ai Edge Function reads the decrypted key here.
-- ---------------------------------------------------------------------------

create or replace function public.get_ai_provider_secret(p_salon_id uuid)
returns table (provider public.ai_provider, model text, api_key text, monthly_token_budget bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select c.provider, c.model, d.decrypted_secret, c.monthly_token_budget
  from public.ai_provider_config c
  join private.ai_provider_secrets s on s.salon_id = c.salon_id
  join vault.decrypted_secrets d on d.id = s.vault_secret_id
  where c.salon_id = p_salon_id;
$$;

comment on function public.get_ai_provider_secret(uuid) is
  'Service role only (ai Edge Function). Returns the decrypted provider key. Never grant to authenticated.';

revoke all on function public.get_ai_provider_secret(uuid) from public, anon, authenticated;
grant execute on function public.get_ai_provider_secret(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- RPC: tokens used this calendar month (salon timezone). RLS applies to callers.
-- ---------------------------------------------------------------------------

create or replace function public.ai_tokens_used_this_month(p_salon_id uuid)
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(sum(u.total_tokens), 0)::bigint
  from public.ai_usage u
  join public.salons s on s.id = u.salon_id
  where u.salon_id = p_salon_id
    and u.created_at >= (date_trunc('month', now() at time zone s.timezone) at time zone s.timezone);
$$;

revoke all on function public.ai_tokens_used_this_month(uuid) from public, anon;
grant execute on function public.ai_tokens_used_this_month(uuid) to authenticated, service_role;
