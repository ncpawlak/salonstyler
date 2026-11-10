-- Full data export (no lock-in), issue #46.
--
-- An owner can export everything their salon owns as one JSON document
-- (`public.export_salon_data`) and restore it into a fresh salon (`public.import_salon_data`,
-- a thin wrapper over `private.import_salon_data`). The `data-export` Edge Function turns the
-- JSON into a zip (data.json + one CSV per table + photos), stores it in the private
-- `data-exports` bucket, and emails a short-lived signed link.
--
-- Which tables are exported is decided by a registry, `private.data_export_tables`. A feature
-- that adds a salon-owned table registers it in its own migration with one line:
--
--   select private.register_data_export('my_table');                      -- exported
--   select private.register_data_export('my_table', array['secret_col']); -- minus a secret
--   select private.exclude_from_data_export('my_queue', 'transient queue'); -- deliberately not
--
-- `supabase/tests/database/29_data_export.test.sql` fails when a public table with a
-- `salon_id` column is in neither list, so a new table can't silently fall out of exports.
-- Insert order on import is derived from foreign keys, so nothing else needs editing.

-- ---------------------------------------------------------------------------
-- Registry
-- ---------------------------------------------------------------------------

create table private.data_export_tables (
  table_name     text primary key,
  included       boolean not null,
  -- Columns left out of the export (bearer tokens). They must have a default so the
  -- import can regenerate them.
  secret_columns text[] not null default '{}',
  note           text,
  registered_at  timestamptz not null default now()
);

create or replace function private.register_data_export(
  p_table          text,
  p_secret_columns text[] default '{}',
  p_note           text default null
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if to_regclass(format('public.%I', p_table)) is null then
    raise exception 'public.% does not exist', p_table;
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = p_table and column_name = 'salon_id'
  ) then
    raise exception 'public.% has no salon_id column, so it is not salon-owned', p_table;
  end if;
  if exists (
    select 1
      from unnest(coalesce(p_secret_columns, '{}')) s(col)
      left join information_schema.columns c
        on c.table_schema = 'public' and c.table_name = p_table and c.column_name = s.col
     where c.column_name is null or (c.column_default is null and c.is_nullable = 'NO')
  ) then
    raise exception 'secret columns of public.% must exist and have a default or be nullable',
      p_table;
  end if;

  insert into private.data_export_tables (table_name, included, secret_columns, note)
  values (p_table, true, coalesce(p_secret_columns, '{}'), p_note)
  on conflict (table_name) do update
    set included = true, secret_columns = excluded.secret_columns, note = excluded.note;
end;
$$;

create or replace function private.exclude_from_data_export(p_table text, p_reason text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if to_regclass(format('public.%I', p_table)) is null then
    raise exception 'public.% does not exist', p_table;
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Say why public.% is not exported', p_table;
  end if;
  insert into private.data_export_tables (table_name, included, note)
  values (p_table, false, p_reason)
  on conflict (table_name) do update set included = false, secret_columns = '{}', note = excluded.note;
end;
$$;

-- Exported tables in foreign-key order (parents first). Kahn's algorithm over the FKs
-- between registered tables; raises if they form a cycle.
create or replace function private.data_export_order()
returns text[]
language plpgsql
stable
set search_path = ''
as $$
declare
  v_order text[] := '{}';
  v_next  text[];
  v_left  text[];
begin
  select coalesce(array_agg(table_name order by table_name), '{}') into v_left
    from private.data_export_tables where included;

  while cardinality(v_left) > 0 loop
    select coalesce(array_agg(t order by t), '{}') into v_next
      from unnest(v_left) t
     where not exists (
       select 1
         from pg_catalog.pg_constraint c
         join pg_catalog.pg_class child on child.oid = c.conrelid
         join pg_catalog.pg_class parent on parent.oid = c.confrelid
         join pg_catalog.pg_namespace pn on pn.oid = parent.relnamespace
        where c.contype = 'f'
          and child.relnamespace = 'public'::regnamespace
          and child.relname = t
          and pn.nspname = 'public'
          and parent.relname <> t
          and parent.relname = any (v_left)
     );
    if cardinality(v_next) = 0 then
      raise exception 'Foreign keys between exported tables form a cycle: %', v_left;
    end if;
    v_order := v_order || v_next;
    select coalesce(array_agg(t order by t), '{}') into v_left
      from unnest(v_left) t where t <> all (v_next);
  end loop;
  return v_order;
end;
$$;

-- Columns written to the export, in table order: everything except identity columns
-- (the target assigns its own) and registered secrets. Generated columns are exported
-- for readability and skipped on import.
create or replace function private.data_export_columns(p_table text)
returns text[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(a.attname::text order by a.attnum), '{}')
    from pg_catalog.pg_attribute a
    join private.data_export_tables r on r.table_name = p_table
   where a.attrelid = format('public.%I', p_table)::regclass
     and a.attnum > 0 and not a.attisdropped
     and a.attidentity = ''
     and a.attname::text <> all (r.secret_columns);
$$;

-- ---------------------------------------------------------------------------
-- Registrations for every salon-owned table that exists today
-- ---------------------------------------------------------------------------

select private.register_data_export('settings');
select private.register_data_export('work_hours_template');
select private.register_data_export('work_hours_override');
select private.register_data_export('services');
select private.register_data_export('service_addons');
select private.register_data_export('service_segments');
select private.register_data_export('service_variants');
select private.register_data_export('service_combo_items');
select private.register_data_export('clients');
select private.register_data_export('client_service_overrides');
select private.register_data_export('client_formulas');
select private.register_data_export('client_notes');
select private.register_data_export('client_photos', '{}', 'Photo files are zipped under photos/');
select private.register_data_export('appointments', array['manage_token'],
  'Client manage links are bearer tokens; the import issues new ones');
select private.register_data_export('appointment_segments');
select private.register_data_export('payments');
select private.register_data_export('checkouts', array['receipt_token'],
  'Receipt links are bearer tokens; the import issues new ones');
select private.register_data_export('checkout_items');
select private.register_data_export('appointment_deposits', array['pay_token'],
  'Deposit pay links are bearer tokens; the import issues new ones');
select private.register_data_export('captured_requests');
select private.register_data_export('client_replies');
select private.register_data_export('form_templates');
select private.register_data_export('service_form_requirements');
select private.register_data_export('form_submissions', '{}', 'Signatures live in answers');
select private.register_data_export('products');
select private.register_data_export('stock_movements');
select private.register_data_export('waitlist_entries', array['token'],
  'Waitlist links are bearer tokens; the import issues new ones');
select private.register_data_export('waitlist_openings');
select private.register_data_export('waitlist_offers');
select private.register_data_export('recurring_expenses');
select private.register_data_export('expenses', '{}', 'Receipt images are zipped under receipts/');
select private.register_data_export('audit_log');

select private.exclude_from_data_export('salons', 'Exported as the header (name, slug, timezone)');
select private.exclude_from_data_export('salon_members',
  'Exported as the header; logins are per deployment, staff re-invite');
select private.exclude_from_data_export('push_tokens', 'Device tokens are per install');
select private.exclude_from_data_export('ai_provider_config',
  'The API key is a secret in Vault; re-enter it after moving');
select private.exclude_from_data_export('ai_usage', 'Metering for the current deployment');
select private.exclude_from_data_export('stripe_accounts',
  'Stripe Connect links are per platform; reconnect Stripe after moving');
select private.exclude_from_data_export('inbox_bridges', 'Holds a hashed device token');
select private.exclude_from_data_export('notifications_outbox', 'Delivery queue');
select private.exclude_from_data_export('client_email_outbox', 'Delivery queue');

-- ---------------------------------------------------------------------------
-- UUID remapping (shared by import and the round-trip diff)
-- ---------------------------------------------------------------------------

-- Replaces every UUID in p_text that is a key of p_map. One linear pass: split on the
-- UUID pattern and stitch the pieces back together with the mapped values.
create or replace function private.data_export_remap_text(p_text text, p_map jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_re    constant text := '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
  v_out   text;
begin
  if p_text is null then
    return null;
  end if;
  with parts as (
    select part, ord from unnest(regexp_split_to_array(p_text, v_re)) with ordinality p(part, ord)
  ),
  hits as (
    select m[1] as hit, ord
      from regexp_matches(p_text, '(' || v_re || ')', 'g') with ordinality h(m, ord)
  )
  select string_agg(parts.part || coalesce(p_map ->> lower(hits.hit), hits.hit, ''), ''
                    order by parts.ord)
    into v_out
    from parts left join hits on hits.ord = parts.ord;
  return coalesce(v_out, '');
end;
$$;

-- Every distinct UUID in p_text, lower-cased.
create or replace function private.data_export_uuids(p_text text)
returns setof text
language sql
immutable
set search_path = ''
as $$
  select distinct lower(m[1])
    from regexp_matches(
      coalesce(p_text, ''),
      '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', 'g') m;
$$;

-- Columns of p_table that reference auth.users (stylist_id, created_by, ...), with nullability.
create or replace function private.data_export_user_columns(p_table text)
returns table (column_name text, not_null boolean)
language sql
stable
set search_path = ''
as $$
  select a.attname::text, a.attnotnull
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
   where c.contype = 'f'
     and c.conrelid = format('public.%I', p_table)::regclass
     and c.confrelid = 'auth.users'::regclass
     and cardinality(c.conkey) = 1;
$$;

-- ---------------------------------------------------------------------------
-- Export
-- ---------------------------------------------------------------------------

create or replace function public.export_salon_data(p_salon_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_salon   public.salons%rowtype;
  v_tables  jsonb := '{}';
  v_table   text;
  v_reg     private.data_export_tables%rowtype;
  v_rows    jsonb;
  v_pk      text;
  v_members jsonb;
  v_counts  jsonb := '{}';
begin
  if auth.uid() is null or not private.has_salon_role(p_salon_id, 'owner') then
    raise exception 'Only the salon owner can export its data' using errcode = '42501';
  end if;
  select * into v_salon from public.salons where id = p_salon_id;

  foreach v_table in array private.data_export_order() loop
    select * into v_reg from private.data_export_tables where table_name = v_table;

    select string_agg(format('t.%I', a.attname), ', ' order by array_position(i.indkey, a.attnum))
      into v_pk
      from pg_catalog.pg_index i
      join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
     where i.indrelid = format('public.%I', v_table)::regclass and i.indisprimary;

    execute format(
      'select coalesce(jsonb_agg((to_jsonb(t) - $2) order by %s), ''[]'')
         from public.%I t where t.salon_id = $1',
      coalesce(v_pk, 'to_jsonb(t)::text'), v_table)
      into v_rows
      using p_salon_id,
            v_reg.secret_columns || coalesce((
              select array_agg(a.attname::text)
                from pg_catalog.pg_attribute a
               where a.attrelid = format('public.%I', v_table)::regclass
                 and a.attnum > 0 and a.attidentity <> ''), '{}');

    v_tables := v_tables || jsonb_build_object(v_table, jsonb_build_object(
      'columns', to_jsonb(private.data_export_columns(v_table)),
      'rows', v_rows));
    v_counts := v_counts || jsonb_build_object(v_table, jsonb_array_length(v_rows));
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role,
                                               'email', u.email)
                            order by m.created_at, m.user_id), '[]')
    into v_members
    from public.salon_members m
    left join auth.users u on u.id = m.user_id
   where m.salon_id = p_salon_id;

  -- Logged after the snapshot so the export doesn't contain its own audit row.
  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (p_salon_id, auth.uid(), 'data.exported', 'salon', p_salon_id::text,
          jsonb_build_object('counts', v_counts));

  return jsonb_build_object(
    'format', 'chairside-export',
    'version', 1,
    'exported_at', now(),
    'salon', jsonb_build_object('id', v_salon.id, 'name', v_salon.name, 'slug', v_salon.slug,
                                'timezone', v_salon.timezone),
    'members', v_members,
    'tables', v_tables);
end;
$$;

-- ---------------------------------------------------------------------------
-- Import (restore into a fresh salon)
-- ---------------------------------------------------------------------------

-- Rows are written with user and FK triggers off (`set local session_replication_role =
-- replica`, which Supabase's supautils allows when the current role is `postgres`, i.e.
-- inside this owner-defined function) so restored history doesn't fire reminders, stock
-- recounts or status rules. Foreign keys are then checked by hand, scoped to the target
-- salon. `public.import_salon_data` is the API entry point; this takes the user explicitly
-- so tests can drive it.
create or replace function private.import_salon_data(p_salon_id uuid, p_user_id uuid, p_export jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_me        uuid := p_user_id;
  v_old_salon text;
  v_order     text[];
  v_table     text;
  v_map       jsonb;
  v_tables    jsonb;
  v_users     text[] := '{}';
  v_stylists  text[] := '{}';
  v_cols      text[];
  v_select    text;
  v_rows      jsonb;
  v_counts    jsonb := '{}';
  v_col       record;
  v_fk        record;
  v_bad       bigint;
  v_n         bigint;
begin
  if v_me is null or not exists (
    select 1 from public.salon_members
     where salon_id = p_salon_id and user_id = v_me and role = 'owner'
  ) then
    raise exception 'Only the salon owner can restore data into it' using errcode = '42501';
  end if;
  if p_export ->> 'format' is distinct from 'chairside-export'
     or jsonb_typeof(p_export -> 'tables') is distinct from 'object' then
    raise exception 'That file is not a Chairside export' using errcode = '22023';
  end if;
  if (p_export ->> 'version')::int is distinct from 1 then
    raise exception 'This export was made by a newer Chairside (version %); update first',
      p_export ->> 'version' using errcode = '22023';
  end if;
  v_old_salon := lower(p_export #>> '{salon,id}');
  if v_old_salon is null then
    raise exception 'The export is missing its salon' using errcode = '22023';
  end if;
  if exists (select 1 from public.clients where salon_id = p_salon_id)
     or exists (select 1 from public.appointments where salon_id = p_salon_id)
     or exists (select 1 from public.checkouts where salon_id = p_salon_id)
     or exists (select 1 from public.payments where salon_id = p_salon_id)
     or exists (select 1 from public.products where salon_id = p_salon_id)
     or exists (select 1 from public.client_formulas where salon_id = p_salon_id) then
    raise exception 'Restore only works into a new, empty salon' using errcode = '55000';
  end if;

  v_order := private.data_export_order();
  v_tables := p_export -> 'tables';
  if exists (select 1 from jsonb_object_keys(v_tables) k where k <> all (v_order)) then
    raise exception 'The export has tables this salon does not know: %',
      (select string_agg(k, ', ') from jsonb_object_keys(v_tables) k where k <> all (v_order))
      using errcode = '22023';
  end if;

  -- Who the export's user ids become. Staff are matched to a member of this salon by
  -- email, otherwise they become the importer. Anyone else who appears in a user column
  -- (a client's login, a former stylist) becomes the importer when the column is
  -- required (stylist_id) and is dropped when it is optional.
  foreach v_table in array v_order loop
    for v_col in select * from private.data_export_user_columns(v_table) loop
      select v_users || coalesce(array_agg(distinct lower(r ->> v_col.column_name)), '{}')
        into v_users
        from jsonb_array_elements(coalesce(v_tables #> array[v_table, 'rows'], '[]')) r
       where r ->> v_col.column_name is not null;
      if v_col.not_null then
        select v_stylists || coalesce(array_agg(distinct lower(r ->> v_col.column_name)), '{}')
          into v_stylists
          from jsonb_array_elements(coalesce(v_tables #> array[v_table, 'rows'], '[]')) r
         where r ->> v_col.column_name is not null;
      end if;
    end loop;
  end loop;

  with members as (
    select lower(m ->> 'user_id') as old_id, lower(m ->> 'email') as email
      from jsonb_array_elements(coalesce(p_export -> 'members', '[]')) m
  ),
  ids as (
    select u from private.data_export_uuids(v_tables::text) u
  )
  select jsonb_object_agg(ids.u, case
           when ids.u = v_old_salon then p_salon_id
           when ids.u in (select old_id from members) then coalesce((
             select sm.user_id
               from public.salon_members sm join auth.users au on au.id = sm.user_id
              where sm.salon_id = p_salon_id
                and lower(au.email) = (select email from members where old_id = ids.u)
              limit 1), v_me)
           when ids.u = any (v_stylists) then v_me
           else gen_random_uuid()
         end)
    into v_map
    from ids;
  v_map := coalesce(v_map, '{}') || jsonb_build_object(v_old_salon, p_salon_id);
  v_tables := private.data_export_remap_text(v_tables::text, v_map)::jsonb;

  -- Rows go in exactly as exported: keep ids, timestamps and statuses and don't fire
  -- triggers. Foreign keys are checked by hand below, scoped to this salon.
  set local session_replication_role = replica;

  for i in reverse cardinality(v_order) .. 1 loop
    execute format('delete from public.%I where salon_id = $1', v_order[i]) using p_salon_id;
  end loop;

  foreach v_table in array v_order loop
    v_rows := coalesce(v_tables #> array[v_table, 'rows'], '[]');
    if jsonb_typeof(v_rows) <> 'array' then
      raise exception 'Table % in the export is malformed', v_table using errcode = '22023';
    end if;
    continue when jsonb_array_length(v_rows) = 0;

    select array_agg(a.attname::text order by a.attnum)
      into v_cols
      from pg_catalog.pg_attribute a
      join private.data_export_tables r on r.table_name = v_table
     where a.attrelid = format('public.%I', v_table)::regclass
       and a.attnum > 0 and not a.attisdropped
       and a.attidentity = '' and a.attgenerated = ''
       and a.attname::text <> all (r.secret_columns)
       and (a.attname = 'salon_id' or exists (
             select 1 from jsonb_array_elements_text(v_tables #> array[v_table, 'columns']) c
              where c = a.attname::text));

    select string_agg(case
             when c = 'salon_id' then '$2'
             when u.column_name is not null then format(
               'case when exists (select 1 from public.salon_members m
                                   where m.salon_id = $2 and m.user_id = r.%1$I)
                     then r.%1$I else %2$s end', c, case when u.not_null then '$3' else 'null' end)
             else format('r.%I', c)
           end, ', ' order by o)
      into v_select
      from unnest(v_cols) with ordinality x(c, o)
      left join private.data_export_user_columns(v_table) u on u.column_name = c;

    begin
      execute format('insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1) r',
                     v_table,
                     (select string_agg(format('%I', c), ', ' order by o)
                        from unnest(v_cols) with ordinality x(c, o)),
                     v_select, v_table)
        using v_rows, p_salon_id, v_me;
    exception when unique_violation then
      raise exception 'Some % in this export already exist in another salon here (%). Restore into a different Chairside, or delete the original salon first.',
        replace(v_table, '_', ' '), sqlerrm using errcode = '23505';
    end;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object(v_table, v_n);
  end loop;

  set local session_replication_role = origin;

  -- Every foreign key from an exported table must resolve, and resolve inside this salon.
  for v_fk in
    select c.conname, child.relname as child, c.confrelid::regclass as parent,
           (select array_agg(a.attname::text order by k.o)
              from unnest(c.conkey) with ordinality k(n, o)
              join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n) as cols,
           (select array_agg(a.attname::text order by k.o)
              from unnest(c.confkey) with ordinality k(n, o)
              join pg_catalog.pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n) as refs,
           exists (select 1 from pg_catalog.pg_attribute a
                    where a.attrelid = c.confrelid and a.attname = 'salon_id'
                      and not a.attisdropped) as parent_has_salon
      from pg_catalog.pg_constraint c
      join pg_catalog.pg_class child on child.oid = c.conrelid
     where c.contype = 'f'
       and child.relnamespace = 'public'::regnamespace
       and child.relname::text = any (v_order)
  loop
    execute format(
      'select count(*) from public.%I c where c.salon_id = $1 and %s and not exists (
         select 1 from %s p where %s%s)',
      v_fk.child,
      (select string_agg(format('c.%I is not null', x), ' and ') from unnest(v_fk.cols) x),
      v_fk.parent,
      (select string_agg(format('p.%I = c.%I', v_fk.refs[o], x), ' and ')
         from unnest(v_fk.cols) with ordinality y(x, o)),
      case when v_fk.parent_has_salon then ' and p.salon_id = $1' else '' end)
      into v_bad using p_salon_id;
    if v_bad > 0 then
      raise exception 'The export is inconsistent: % % row(s) point at missing %',
        v_bad, v_fk.child, v_fk.parent using errcode = '23503';
    end if;
  end loop;

  update public.salons
     set name = coalesce(nullif(btrim(p_export #>> '{salon,name}'), ''), name),
         timezone = coalesce((select name from pg_catalog.pg_timezone_names
                               where name = p_export #>> '{salon,timezone}' limit 1), timezone)
   where id = p_salon_id;

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (p_salon_id, v_me, 'data.imported', 'salon', p_salon_id::text,
          jsonb_build_object('from_salon', v_old_salon,
                             'exported_at', p_export ->> 'exported_at',
                             'counts', v_counts));

  return jsonb_build_object('ids', v_map, 'counts', v_counts);
end;
$$;

create or replace function public.import_salon_data(p_salon_id uuid, p_export jsonb)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.import_salon_data(p_salon_id, auth.uid(), p_export);
$$;

-- ---------------------------------------------------------------------------
-- Round-trip comparison (used by pgTAP; reusable by any feature's tests)
-- ---------------------------------------------------------------------------

-- Rows that differ between two exports after mapping b's ids back through the inverse of
-- p_ids (the `ids` returned by import_salon_data). Audit rows about exporting or
-- importing are ignored because they describe the round trip itself.
create or replace function private.data_export_diff(p_a jsonb, p_b jsonb, p_ids jsonb)
returns table (table_name text, side text, row_data jsonb)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_inverse jsonb;
  v_b       jsonb;
  v_table   text;
begin
  select coalesce(jsonb_object_agg(lower(value), key), '{}') into v_inverse
    from jsonb_each_text(p_ids);
  v_b := private.data_export_remap_text((p_b -> 'tables')::text, v_inverse)::jsonb;

  for v_table in
    select k from jsonb_object_keys(p_a -> 'tables') k
    union select k from jsonb_object_keys(v_b) k
  loop
    return query
      with a as (
        select r from jsonb_array_elements(coalesce(p_a #> array['tables', v_table, 'rows'], '[]')) r
         where v_table <> 'audit_log' or r ->> 'action' not in ('data.exported', 'data.imported')
      ),
      b as (
        select r from jsonb_array_elements(coalesce(v_b #> array[v_table, 'rows'], '[]')) r
         where v_table <> 'audit_log' or r ->> 'action' not in ('data.exported', 'data.imported')
      ),
      only_a as (select r from a except all select r from b),
      only_b as (select r from b except all select r from a)
      select v_table, 'only_in_a', r from only_a
      union all
      select v_table, 'only_in_b', r from only_b;
  end loop;
end;
$$;

revoke all on function private.register_data_export(text, text[], text) from public;
revoke all on function private.exclude_from_data_export(text, text) from public;
revoke all on function private.data_export_order() from public;
revoke all on function private.data_export_columns(text) from public;
revoke all on function private.data_export_remap_text(text, jsonb) from public;
revoke all on function private.data_export_uuids(text) from public;
revoke all on function private.data_export_user_columns(text) from public;
revoke all on function private.data_export_diff(jsonb, jsonb, jsonb) from public;

revoke all on function private.import_salon_data(uuid, uuid, jsonb) from public;
revoke all on function public.export_salon_data(uuid) from public, anon;
revoke all on function public.import_salon_data(uuid, jsonb) from public, anon;
grant execute on function public.export_salon_data(uuid) to authenticated;
grant execute on function public.import_salon_data(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: generated exports and uploaded restores, private, owner-only
-- ---------------------------------------------------------------------------
-- Paths are `{salon_id}/{file}.zip` (written by the Edge Function with the service role)
-- and `{salon_id}/uploads/{file}` (an owner uploading an export to restore).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('data-exports', 'data-exports', false, 524288000,
        array['application/zip', 'application/json', 'application/octet-stream'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create or replace function private.data_export_salon_id(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(p_name, '/', 1) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then split_part(p_name, '/', 1)::uuid
  end;
$$;

create policy "owners can read data exports" on storage.objects
  for select to authenticated
  using (bucket_id = 'data-exports'
         and private.has_salon_role(private.data_export_salon_id(name), 'owner'));
create policy "owners can upload restores" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'data-exports'
              and split_part(name, '/', 2) = 'uploads'
              and private.has_salon_role(private.data_export_salon_id(name), 'owner'));
create policy "owners can delete data exports" on storage.objects
  for delete to authenticated
  using (bucket_id = 'data-exports'
         and private.has_salon_role(private.data_export_salon_id(name), 'owner'));
