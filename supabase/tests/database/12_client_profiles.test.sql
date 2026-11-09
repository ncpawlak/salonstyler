-- Client profiles (#13): overrides, formulas, notes, photos (+ Storage RLS) and visit summaries.
begin;
select plan(27);

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
                    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
$$;

create function pg_temp.logout() returns void language sql as $$
  reset role;
  select set_config('request.jwt.claims', '', true);
$$;

insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-4000-c100-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-a@profiles.test'),
  ('00000000-0000-4000-c100-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-b@profiles.test');

select pg_temp.login('00000000-0000-4000-c100-00000000000a');
select public.create_salon('Profiles A', 'profiles-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-c100-00000000000b');
select public.create_salon('Profiles B', 'profiles-b', 'America/Chicago');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'profiles-a') as a,
         (select id from public.salons where slug = 'profiles-b') as b;
insert into public.clients (salon_id, name) select a, 'Karina Lopez' from ids;
insert into public.clients (salon_id, name) select b, 'Other Salon Client' from ids;
insert into public.services (salon_id, name) select a, 'All-over color' from ids;
insert into public.services (salon_id, name) select b, 'B color' from ids;
alter table ids add column karina uuid, add column color uuid, add column other uuid, add column b_color uuid;
update ids set karina = (select id from public.clients c where c.salon_id = ids.a),
               other = (select id from public.clients c where c.salon_id = ids.b),
               color = (select id from public.services s where s.salon_id = ids.a and s.name = 'All-over color' order by created_at desc limit 1),
               b_color = (select id from public.services s where s.salon_id = ids.b and s.name = 'B color');
grant select on ids to authenticated;

-- Karina's history: 2 completed, 1 past confirmed (counts as a visit), 1 no-show, 1 cancelled,
-- 1 upcoming. One completed visit was paid ($120, $20 refunded).
insert into public.appointments (salon_id, client_id, stylist_id, status, starts_at, ends_at)
select a, karina, '00000000-0000-4000-c100-00000000000a', s::public.appointment_status,
       now() + d * interval '1 day', now() + d * interval '1 day' + interval '2 hours'
  from ids, (values ('completed', -60), ('completed', -30), ('confirmed', -10), ('no_show', -20),
                    ('cancelled', -5), ('confirmed', 7)) v(s, d);
insert into public.payments
  (salon_id, appointment_id, stripe_payment_intent_id, stripe_account_id, amount_cents,
   amount_refunded_cents, currency, status)
select a, (select id from public.appointments where client_id = karina and status = 'completed'
            order by starts_at limit 1),
       'pi_3Profiles0001', 'acct_1Profiles', 12000, 2000, 'usd', 'partially_refunded'
  from ids;

-- Schema ---------------------------------------------------------------------------------------
select has_column('public', 'clients', 'tags', 'clients.tags exists');
select has_column('public', 'clients', 'marketing_opt_in', 'clients.marketing_opt_in exists');
select has_table('public', 'client_service_overrides', 'overrides table exists');
select has_view('public', 'client_summaries', 'client_summaries view exists');
select is((select public from storage.buckets where id = 'client-photos'), false,
          'client-photos bucket is private');

-- Owner A manages Karina's profile -------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-c100-00000000000a');

select lives_ok(
  $$ update public.clients set tags = '{VIP,blonde}', marketing_opt_in = true from ids
      where clients.id = ids.karina $$,
  'member can tag a client');
select lives_ok(
  $$ insert into public.client_service_overrides (salon_id, client_id, service_id, delta_minutes, note)
     select a, karina, color, 20, 'thick hair' from ids $$,
  'member can add a duration override');
select throws_ok(
  $$ insert into public.client_service_overrides (salon_id, client_id, service_id, delta_minutes)
     select a, karina, color, 10 from ids $$,
  '23505', null, 'one override per client and service');
select throws_ok(
  $$ update public.client_service_overrides set delta_minutes = 0 $$,
  '23514', null, 'zero-minute override is rejected');
select throws_ok(
  $$ update public.client_service_overrides set delta_minutes = 241 $$,
  '23514', null, 'override is capped at 4 hours');
select throws_ok(
  $$ insert into public.client_service_overrides (salon_id, client_id, service_id, delta_minutes)
     select a, karina, b_color, 10 from ids $$,
  '23503', null, 'cannot override another salon''s service');
select lives_ok(
  $$ insert into public.client_formulas (salon_id, client_id, formula, service_name)
     select a, karina, '7N + 7G 1:1, 20vol, 35 min', 'All-over color' from ids $$,
  'member can add a formula');
select lives_ok(
  $$ insert into public.client_notes (salon_id, client_id, body, source)
     select a, karina, 'Prefers quiet appointments', 'ai' from ids $$,
  'member can add a note');
select throws_ok(
  $$ insert into public.client_notes (salon_id, client_id, body) select a, karina, '   ' from ids $$,
  '23514', null, 'blank note is rejected');
select lives_ok(
  $$ insert into public.client_photos (salon_id, client_id, storage_path, kind)
     select a, karina, a || '/' || karina || '/after-1.jpg', 'after' from ids $$,
  'member can record a photo in the client folder');
select throws_ok(
  $$ insert into public.client_photos (salon_id, client_id, storage_path)
     select a, karina, b || '/' || karina || '/x.jpg' from ids $$,
  '23514', null, 'photo path must be inside the client''s folder');
select throws_ok(
  $$ update public.client_photos set storage_path = 'elsewhere.jpg' $$,
  '42501', null, 'photo path cannot be changed');

-- Storage: A can upload into its own salon folder only.
select lives_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     select 'client-photos', a || '/' || karina || '/after-1.jpg', auth.uid() from ids $$,
  'member can upload a photo to their salon folder');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     select 'client-photos', b || '/' || other || '/x.jpg', auth.uid() from ids $$,
  '42501', null, 'cannot upload into another salon''s folder');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     values ('client-photos', 'not-a-uuid/x.jpg', auth.uid()) $$,
  '42501', null, 'malformed photo paths are rejected (not errors)');

select results_eq(
  $$ select visit_count, no_show_count, cancelled_count, paid_cents, next_visit_at > now()
       from public.client_summaries, ids where client_id = karina $$,
  $$ values (3, 1, 1, 10000::bigint, true) $$,
  'summary counts visits, no-shows, cancellations, net paid and the next visit');
select pg_temp.logout();

-- Owner B sees none of it ----------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-c100-00000000000b');
select is_empty($$ select 1 from public.client_service_overrides $$, 'B cannot read A''s overrides');
select is_empty($$ select 1 from public.client_formulas union all select 1 from public.client_notes
                   union all select 1 from public.client_photos $$,
                'B cannot read A''s formulas, notes or photos');
select is_empty($$ select 1 from storage.objects where bucket_id = 'client-photos' $$,
                'B cannot list A''s photo files');
select is((select count(*)::integer from public.client_summaries), 1,
          'B only sees summaries for its own clients');
select throws_ok(
  $$ insert into public.client_notes (salon_id, client_id, body) select a, karina, 'pwn' from ids $$,
  '42501', null, 'B cannot add notes to A''s client');
select pg_temp.logout();

-- Deleting the client removes the profile rows.
delete from public.clients using ids where clients.id = ids.karina;
select is_empty(
  $$ select 1 from public.client_service_overrides union all select 1 from public.client_formulas
     union all select 1 from public.client_notes union all select 1 from public.client_photos $$,
  'profile rows are deleted with the client');

select * from finish();
rollback;
