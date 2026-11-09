-- Calendar views stream appointment changes over Realtime (issue #31).
begin;
select plan(2);

select ok(
  exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'appointments'
  ),
  'appointments are published to supabase_realtime'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.appointments'::regclass),
  'appointments keep RLS, so Realtime only delivers rows the subscriber can read'
);

select * from finish();
rollback;
