-- Guards the tenancy rules from supabase/migrations/*_foundation.sql for every
-- current AND future table in the public schema.
begin;
select plan(4);

select is(
  array(
    select c.relname::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
    order by 1
  ),
  array[]::text[],
  'every public table has row level security enabled'
);

select is(
  array(
    select c.relname::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and c.relname <> 'salons'
      and not exists (
        select 1 from pg_attribute a
        where a.attrelid = c.oid and a.attname = 'salon_id' and a.attnotnull and not a.attisdropped
      )
    order by 1
  ),
  array[]::text[],
  'every tenant table has a NOT NULL salon_id column'
);

select is(
  array(
    select c.relname::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and has_table_privilege('anon', c.oid, 'SELECT')
    order by 1
  ),
  array[]::text[],
  'anon cannot select from any public table'
);

select is(
  array(
    select t from unnest(array['salons', 'salon_members', 'settings', 'audit_log', 'push_tokens']) t
    where to_regclass('public.' || t) is null
  ),
  array[]::text[],
  'foundation tables exist'
);

select * from finish();
rollback;
