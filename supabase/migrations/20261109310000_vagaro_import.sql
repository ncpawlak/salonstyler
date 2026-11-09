-- =============================================================================
-- Import from Vagaro (issue #15): clients + upcoming appointments.
--
-- The app parses the export deterministically (an LLM only proposes the column mapping) and
-- sends normalized rows here in batches. Both RPCs are idempotent:
-- * import_clients matches each row to an existing client by email, then phone (digits only,
--   `private.phone_key`), then — when the row has neither — by name. Matches only fill empty
--   fields, merge tags and keep the latest last-visit / highest no-show count, so re-importing
--   the same file changes nothing.
-- * import_appointments books through book_appointment (confirmed, source `import`) and stores
--   the export's key in `appointments.import_key`; a key that's already there is skipped. A row
--   that overlaps existing busy time is reported as a conflict (with the clashing appointment)
--   instead of failing the batch.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- clients: fields the export carries that the app had no place for
-- ---------------------------------------------------------------------------

alter table public.clients
  add column birthday                date,
  add column imported_last_visit_on  date,
  add column imported_no_show_count  integer not null default 0
    check (imported_no_show_count between 0 and 10000);

comment on column public.clients.birthday is
  'Date of birth. Year 1604 means the year is unknown (vCard convention).';
comment on column public.clients.imported_last_visit_on is
  'Last visit recorded by the previous booking system (Vagaro import). Feeds client_summaries.';
comment on column public.clients.imported_no_show_count is
  'No-shows recorded by the previous booking system. Added to client_summaries.no_show_count.';

-- Digits of a phone number without a leading US country code; null when too short/long.
-- Mirrors phoneKey() in packages/core/src/import/normalize.ts.
create or replace function private.phone_key(p_phone text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case when length(k) between 7 and 15 then k end
    from (select case when length(d) = 11 and left(d, 1) = '1' then substr(d, 2) else d end as k
            from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d) digits) keyed;
$$;

revoke all on function private.phone_key(text) from public;
grant execute on function private.phone_key(text) to authenticated, service_role;

create index clients_salon_email_idx on public.clients (salon_id, lower(email))
  where email is not null;
create index clients_salon_phone_key_idx on public.clients (salon_id, private.phone_key(phone))
  where phone is not null;

-- ---------------------------------------------------------------------------
-- appointments: stable key from the export, so re-imports never double-book
-- ---------------------------------------------------------------------------

alter table public.appointments
  add column import_key text check (import_key is null or char_length(import_key) between 1 and 200);

comment on column public.appointments.import_key is
  'Key of the row this appointment was imported from (e.g. vagaro:id:123). Unique per salon.';

create unique index appointments_salon_import_key_idx on public.appointments (salon_id, import_key)
  where import_key is not null;

-- ---------------------------------------------------------------------------
-- client_summaries: count what the previous system knew
-- ---------------------------------------------------------------------------

create or replace view public.client_summaries
with (security_invoker = true)
as
select
  c.id as client_id,
  c.salon_id,
  count(a.id) filter (where a.status = 'completed'
                         or (a.status = 'confirmed' and a.ends_at <= now()))::integer as visit_count,
  (count(a.id) filter (where a.status = 'no_show') + c.imported_no_show_count)::integer
    as no_show_count,
  count(a.id) filter (where a.status = 'cancelled')::integer as cancelled_count,
  greatest(
    max(a.starts_at) filter (where a.status in ('completed', 'confirmed') and a.starts_at <= now()),
    (c.imported_last_visit_on + time '12:00')
      at time zone coalesce((select s.timezone from public.salons s where s.id = c.salon_id), 'UTC')
  ) as last_visit_at,
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
  'Per-client visit/no-show counts, last/next visit and net amount paid, including history from '
  'an import. RLS-scoped (security_invoker).';

-- ---------------------------------------------------------------------------
-- import_clients
-- ---------------------------------------------------------------------------
-- p_clients: [{ name, phone?, email?, birthday? (YYYY-MM-DD), tags?: [], lastVisitOn?,
--               noShowCount?, notes? }]   (<= 500 per call)
-- Returns { created, updated, unchanged, invalid,
--           results: [{ index, status: created|updated|unchanged|invalid, clientId?, message? }] }
create or replace function public.import_clients(p_salon_id uuid, p_clients jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item     jsonb;
  v_index    integer;
  v_name     text;
  v_phone    text;
  v_email    text;
  v_birthday date;
  v_tags     text[];
  v_last     date;
  v_noshows  integer;
  v_notes    text;
  v_client   public.clients;
  v_merged   text[];
  v_status   text;
  v_results  jsonb := '[]'::jsonb;
  v_counts   jsonb := '{"created": 0, "updated": 0, "unchanged": 0, "invalid": 0}'::jsonb;
begin
  if not private.is_salon_member(p_salon_id) then
    raise exception 'Not a member of this salon' using errcode = '42501';
  end if;
  if jsonb_typeof(p_clients) <> 'array' or jsonb_array_length(p_clients) > 500 then
    raise exception 'Send 0 to 500 clients per call' using errcode = '22023';
  end if;

  for v_item, v_index in
    select e, (o - 1)::integer from jsonb_array_elements(p_clients) with ordinality t(e, o)
  loop
    begin
      v_name := left(btrim(v_item ->> 'name'), 80);
      if coalesce(v_name, '') = '' then
        raise exception 'No name' using errcode = '22023';
      end if;
      v_phone := nullif(left(btrim(v_item ->> 'phone'), 32), '');
      v_email := nullif(lower(btrim(v_item ->> 'email')), '');
      v_birthday := nullif(v_item ->> 'birthday', '')::date;
      v_last := nullif(v_item ->> 'lastVisitOn', '')::date;
      v_noshows := least(greatest(coalesce((v_item ->> 'noShowCount')::integer, 0), 0), 10000);
      v_notes := nullif(left(btrim(v_item ->> 'notes'), 4000), '');
      v_tags := array(
        select left(btrim(t), 40)
          from jsonb_array_elements_text(
                 case when jsonb_typeof(v_item -> 'tags') = 'array' then v_item -> 'tags'
                      else '[]'::jsonb end) t
         where btrim(t) <> ''
      );

      v_client := null;
      if v_email is not null then
        select * into v_client from public.clients c
         where c.salon_id = p_salon_id and lower(c.email) = v_email
         order by c.created_at limit 1;
      end if;
      if v_client.id is null and private.phone_key(v_phone) is not null then
        select * into v_client from public.clients c
         where c.salon_id = p_salon_id and c.phone is not null
           and private.phone_key(c.phone) = private.phone_key(v_phone)
         order by c.created_at limit 1;
      end if;
      if v_client.id is null and v_email is null and private.phone_key(v_phone) is null then
        select * into v_client from public.clients c
         where c.salon_id = p_salon_id and lower(btrim(c.name)) = lower(v_name)
         order by c.created_at limit 1;
      end if;

      if v_client.id is null then
        insert into public.clients
          (salon_id, name, phone, email, birthday, tags, imported_last_visit_on,
           imported_no_show_count)
        values
          (p_salon_id, v_name, v_phone, v_email, v_birthday, v_tags, v_last, v_noshows)
        returning * into v_client;
        v_status := 'created';
      else
        -- Union of tags (case-insensitive, existing first); keep the old set if it won't fit.
        v_merged := array(
          select t from (
            select distinct on (lower(t)) t, o
              from unnest(v_client.tags || v_tags) with ordinality u(t, o)
             order by lower(t), o
          ) d order by o
        );
        if cardinality(v_merged) > 20 or char_length(array_to_string(v_merged, '')) > 400 then
          v_merged := v_client.tags;
        end if;
        update public.clients c
           set phone = coalesce(c.phone, v_phone),
               email = coalesce(c.email, v_email),
               birthday = coalesce(c.birthday, v_birthday),
               tags = v_merged,
               imported_last_visit_on = greatest(c.imported_last_visit_on, v_last),
               imported_no_show_count = greatest(c.imported_no_show_count, v_noshows)
         where c.id = v_client.id
           and (c.phone, c.email, c.birthday, c.tags, c.imported_last_visit_on,
                c.imported_no_show_count)
               is distinct from
               (coalesce(c.phone, v_phone), coalesce(c.email, v_email),
                coalesce(c.birthday, v_birthday), v_merged,
                greatest(c.imported_last_visit_on, v_last),
                greatest(c.imported_no_show_count, v_noshows));
        v_status := case when found then 'updated' else 'unchanged' end;
      end if;

      if v_notes is not null and not exists (
        select 1 from public.client_notes n
         where n.client_id = v_client.id and btrim(n.body) = v_notes
      ) then
        insert into public.client_notes (salon_id, client_id, body, source)
        values (p_salon_id, v_client.id, v_notes, 'import');
        if v_status = 'unchanged' then v_status := 'updated'; end if;
      end if;

      v_results := v_results || jsonb_build_object(
        'index', v_index, 'status', v_status, 'clientId', v_client.id);
    exception when others then
      v_status := 'invalid';
      v_results := v_results || jsonb_build_object(
        'index', v_index, 'status', v_status, 'message', left(sqlerrm, 200));
    end;
    v_counts := jsonb_set(v_counts, array[v_status], to_jsonb((v_counts ->> v_status)::integer + 1));
  end loop;

  if jsonb_array_length(p_clients) > 0 then
    insert into public.audit_log (salon_id, actor_user_id, action, entity_type, details)
    values (p_salon_id, auth.uid(), 'import.clients', 'client', v_counts);
  end if;

  return v_counts || jsonb_build_object('results', v_results);
end;
$$;

comment on function public.import_clients is
  'Idempotent client import (Vagaro etc.): dedupes on email, phone digits, then name.';

revoke all on function public.import_clients(uuid, jsonb) from public, anon;
grant execute on function public.import_clients(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- import_appointments
-- ---------------------------------------------------------------------------
-- p_appointments: [{ key, clientId?, segments: [{ kind, start, end, label? }], services?: [],
--                    priceCents?, notes? }]   (<= 200 per call)
-- Books each as `confirmed` / source `import` on the caller's calendar.
-- Returns { booked, duplicate, past, conflict, invalid,
--           results: [{ index, status, appointmentId?, message?,
--                       conflict?: { appointmentId, startsAt, clientName } }] }
create or replace function public.import_appointments(p_salon_id uuid, p_appointments jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item     jsonb;
  v_index    integer;
  v_key      text;
  v_existing uuid;
  v_appt     public.appointments;
  v_span     tstzrange;
  v_clash    record;
  v_status   text;
  v_result   jsonb;
  v_results  jsonb := '[]'::jsonb;
  v_counts   jsonb :=
    '{"booked": 0, "duplicate": 0, "past": 0, "conflict": 0, "invalid": 0}'::jsonb;
begin
  if not private.is_salon_member(p_salon_id) then
    raise exception 'Not a member of this salon' using errcode = '42501';
  end if;
  if jsonb_typeof(p_appointments) <> 'array' or jsonb_array_length(p_appointments) > 200 then
    raise exception 'Send 0 to 200 appointments per call' using errcode = '22023';
  end if;

  for v_item, v_index in
    select e, (o - 1)::integer from jsonb_array_elements(p_appointments) with ordinality t(e, o)
  loop
    v_result := jsonb_build_object('index', v_index);
    begin
      v_key := btrim(v_item ->> 'key');
      if coalesce(v_key, '') = '' or char_length(v_key) > 200 then
        raise exception 'Missing import key' using errcode = '22023';
      end if;

      select a.id into v_existing from public.appointments a
       where a.salon_id = p_salon_id and a.import_key = v_key;
      v_span := private.appointment_segments_span(v_item -> 'segments');

      if v_existing is not null then
        v_status := 'duplicate';
        v_result := v_result || jsonb_build_object('appointmentId', v_existing);
      elsif lower(v_span) < now() then
        v_status := 'past';
      else
        v_appt := public.book_appointment(
          p_salon_id,
          nullif(v_item ->> 'clientId', '')::uuid,
          v_item -> 'segments',
          case when jsonb_typeof(v_item -> 'services') = 'array'
               then v_item -> 'services' else '[]'::jsonb end,
          'confirmed',
          'import',
          (v_item ->> 'priceCents')::integer,
          left(v_item ->> 'notes', 2000));
        update public.appointments set import_key = v_key where id = v_appt.id;
        v_status := 'booked';
        v_result := v_result || jsonb_build_object('appointmentId', v_appt.id);
      end if;
    exception
      when exclusion_violation then
        v_status := 'conflict';
        select a.id, a.starts_at, c.name as client_name into v_clash
          from public.appointment_segments s
          join public.appointments a on a.id = s.appointment_id
          left join public.clients c on c.id = a.client_id
         where s.salon_id = p_salon_id
           and s.stylist_id = auth.uid()
           and s.active and s.kind <> 'processing'
           and exists (
             select 1 from jsonb_array_elements(v_item -> 'segments') e
              where e ->> 'kind' <> 'processing'
                and tstzrange((e ->> 'start')::timestamptz, (e ->> 'end')::timestamptz, '[)')
                    && s.range)
         order by a.starts_at
         limit 1;
        v_result := v_result || jsonb_build_object(
          'message', 'Overlaps another appointment',
          'conflict', case when v_clash.id is not null then jsonb_build_object(
            'appointmentId', v_clash.id, 'startsAt', v_clash.starts_at,
            'clientName', v_clash.client_name) end);
      when others then
        v_status := 'invalid';
        v_result := v_result || jsonb_build_object('message', left(sqlerrm, 200));
    end;
    v_results := v_results || (v_result || jsonb_build_object('status', v_status));
    v_counts := jsonb_set(v_counts, array[v_status], to_jsonb((v_counts ->> v_status)::integer + 1));
  end loop;

  if (v_counts ->> 'booked')::integer > 0 then
    insert into public.audit_log (salon_id, actor_user_id, action, entity_type, details)
    values (p_salon_id, auth.uid(), 'import.appointments', 'appointment', v_counts);
  end if;

  return v_counts || jsonb_build_object('results', v_results);
end;
$$;

comment on function public.import_appointments is
  'Idempotent appointment import: books confirmed/import appointments keyed by import_key and '
  'reports overlaps as conflicts instead of failing.';

revoke all on function public.import_appointments(uuid, jsonb) from public, anon;
grant execute on function public.import_appointments(uuid, jsonb) to authenticated;
