-- Today screen + global search (docs/PLAN.md §5b, issue #38).
--
-- * `search_salon` powers the global search sheet: clients (partial name, typo-tolerant, or any
--   run of 3+ phone digits), appointments (by client or service name) and services. It is
--   SECURITY INVOKER, so RLS scopes it to the caller's salons. Products (#17) slot in as another
--   `kind` branch.
-- * Appointments and clients are added to the `supabase_realtime` publication so Today, the
--   calendar and the Inbox badge update live (Realtime applies the same RLS).

create extension if not exists pg_trgm with schema extensions;
create extension if not exists fuzzystrmatch with schema extensions;

-- Typo tolerance per word, 0..1. Averages the edit distance between the query and the start of
-- each word with the same distance over sorted letters, so swapped letters ("karnia" -> Karina)
-- cost less than missing ones (Kara). Trigrams alone score those two the same.
create or replace function private.search_typo_score(p_query text, p_text text)
returns real
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(max(
    1 - (
      extensions.levenshtein(p_query, p)
      + extensions.levenshtein(
          array_to_string(array(select regexp_split_to_table(p_query, '') order by 1), ''),
          array_to_string(array(select regexp_split_to_table(p, '') order by 1), ''))
    )::real / (2 * greatest(char_length(p_query), 1))
  ), 0)::real
  from regexp_split_to_table(lower(coalesce(p_text, '')), '\s+') w,
       left(w, char_length(p_query)) p
  where w <> '';
$$;

revoke all on function private.search_typo_score(text, text) from public;
grant execute on function private.search_typo_score(text, text) to authenticated;

-- Trigram indexes keep `like '%term%'` fast as a salon's client list grows.
create index clients_name_trgm_idx on public.clients
  using gin (lower(name) extensions.gin_trgm_ops);
create index clients_phone_digits_trgm_idx on public.clients
  using gin (regexp_replace(coalesce(phone, ''), '\D', '', 'g') extensions.gin_trgm_ops);
create index services_name_trgm_idx on public.services
  using gin (lower(name) extensions.gin_trgm_ops);

create or replace function public.search_salon(
  p_salon_id uuid,
  p_query    text,
  p_limit    integer default 6
)
returns table (
  kind      text,
  id        uuid,
  title     text,
  subtitle  text,
  starts_at timestamptz,
  status    public.appointment_status,
  color_tag text,
  score     real
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_q      text := left(lower(btrim(coalesce(p_query, ''))), 80);
  v_digits text := regexp_replace(coalesce(p_query, ''), '\D', '', 'g');
  v_limit  integer := least(greatest(coalesce(p_limit, 6), 1), 25);
  v_esc    text;
  v_any    text;
  v_word   text;
  v_fuzzy  boolean;
begin
  if v_q = '' then
    return;
  end if;
  -- LIKE wildcards in the query are literal.
  v_esc := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');
  v_any := '%' || v_esc || '%';
  v_word := '% ' || v_esc || '%';
  -- Typo tolerance only once there is enough to compare; phone matching needs 3+ digits.
  v_fuzzy := char_length(v_q) >= 3;
  if char_length(v_digits) < 3 then
    v_digits := null;
  end if;

  return query
  with matched_clients as (
    select c.id, c.name, c.phone, c.email,
           greatest(
             case
               when lower(c.name) like v_esc || '%' then 1.0
               when lower(c.name) like v_word then 0.9
               when lower(c.name) like v_any then 0.7
               else 0
             end,
             case when v_digits is not null
                       and regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') like '%' || v_digits || '%'
                  then 0.95 else 0 end,
             case when lower(coalesce(c.email, '')) like v_any then 0.6 else 0 end,
             case when v_fuzzy then greatest(
               extensions.word_similarity(v_q, lower(c.name)) * 0.85,
               private.search_typo_score(v_q, c.name) * 0.7
             ) else 0 end
           )::real as score
      from public.clients c
     where c.salon_id = p_salon_id
  ),
  clients_hit as (
    select 'client'::text, m.id, m.name, coalesce(m.phone, m.email), null::timestamptz,
           null::public.appointment_status, null::text, m.score
      from matched_clients m
     where m.score >= 0.35
     order by m.score desc, m.name
     limit v_limit
  ),
  appointments_hit as (
    select 'appointment'::text, a.id, coalesce(c.name, 'Walk-in'),
           nullif(array_to_string(array(
             select s ->> 'name' from jsonb_array_elements(a.services) s
           ), ' + '), ''),
           a.starts_at, a.status, (a.services -> 0 ->> 'colorTag'),
           greatest(
             coalesce(m.score, 0),
             case when exists (
               select 1 from jsonb_array_elements(a.services) s
                where lower(s ->> 'name') like v_any
             ) then 0.6 else 0 end
           )::real
      from public.appointments a
      left join public.clients c on c.id = a.client_id
      left join matched_clients m on m.id = a.client_id
     where a.salon_id = p_salon_id
       and a.status <> 'cancelled'
       and a.starts_at >= now() - interval '60 days'
       and (
         coalesce(m.score, 0) >= 0.35
         or exists (
           select 1 from jsonb_array_elements(a.services) s
            where lower(s ->> 'name') like v_any
         )
       )
     -- Upcoming first (soonest), then the most recent past visits.
     order by (a.starts_at < now()), case when a.starts_at >= now() then a.starts_at end,
              a.starts_at desc
     limit v_limit
  ),
  services_hit as (
    select 'service'::text, s.id, s.name, s.category, null::timestamptz,
           null::public.appointment_status, s.color_tag,
           greatest(
             case
               when lower(s.name) like v_esc || '%' then 1.0
               when lower(s.name) like v_word then 0.9
               when lower(s.name) like v_any then 0.7
               when lower(s.category) like v_any then 0.5
               else 0
             end,
             case when v_fuzzy then greatest(
               extensions.word_similarity(v_q, lower(s.name)) * 0.85,
               private.search_typo_score(v_q, s.name) * 0.7
             ) else 0 end
           )::real as score
      from public.services s
     where s.salon_id = p_salon_id
       and s.archived_at is null
  )
  select * from clients_hit
  union all
  select * from appointments_hit
  union all
  (select * from services_hit sh where sh.score >= 0.35 order by sh.score desc, sh.name limit v_limit);
end;
$$;

comment on function public.search_salon is
  'Global search (clients, appointments, services) for a salon; RLS-scoped. Kinds are stable ids.';

revoke all on function public.search_salon(uuid, text, integer) from public, anon;
grant execute on function public.search_salon(uuid, text, integer) to authenticated;

-- Realtime ---------------------------------------------------------------------------------------

-- Idempotent per table: the Calendar views (#31) add `appointments` to the same publication.
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['appointments', 'clients'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
