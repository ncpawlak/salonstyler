-- Calendar views (issue #31): stream appointment changes so the day/week/month views update live
-- when a booking is created, moved or cancelled elsewhere. Realtime applies the table's RLS, so a
-- subscriber only receives rows from salons they belong to. Every booking change (create,
-- reschedule, status) writes the `appointments` row, so segments don't need their own stream.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'appointments'
  ) then
    alter publication supabase_realtime add table public.appointments;
  end if;
end;
$$;
