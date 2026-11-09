-- Local development seed (runs after migrations on `supabase db reset`).
--
-- Intentionally empty: sign in locally with a magic link (emails land in
-- Mailpit at http://127.0.0.1:54324) and create a salon from the app, which
-- exercises the real first-run flow (public.create_salon).
--
-- Do not create appointment tables/data here; they are owned by later migrations.
select 1;
