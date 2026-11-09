-- Service menu import (#16): the payloads the app builds from a reviewed menu go through the
-- existing save_service RPC (owners only), and replace-mode archiving is owner-only too.
begin;
select plan(8);

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
  ('00000000-0000-4000-b000-0000000016a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@svcimport.test'),
  ('00000000-0000-4000-b000-0000000016a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stylist@svcimport.test');

select pg_temp.login('00000000-0000-4000-b000-0000000016a1');
select public.create_salon('Import Test Salon', 'svc-import-test', 'America/Chicago');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'svc-import-test') as salon;
grant select on ids to authenticated;
create temp table saved (name text primary key, id uuid);
grant select, insert on saved to authenticated;

insert into public.salon_members (salon_id, user_id, role)
  select salon, '00000000-0000-4000-b000-0000000016a2', 'stylist' from ids;

select pg_temp.login('00000000-0000-4000-b000-0000000016a1');

-- "Single Process Color · 1h 45m · $95" with "Processing 35 min" (serviceImportPayload, add).
select lives_ok(
  $$ insert into saved select 'color', public.save_service(salon, '{
       "name": "Single Process Color", "category": "Color", "description": null,
       "priceCents": 9500, "colorTag": "purple",
       "segments": [{"kind": "busy", "minutes": 35, "label": "Apply"},
                    {"kind": "processing", "minutes": 35, "label": "Process"},
                    {"kind": "style", "minutes": 35, "label": "Rinse & style"}],
       "bufferBeforeMinutes": 0, "bufferAfterMinutes": 0, "consultationRequired": false,
       "bookableOnline": true, "newClientsOnly": false, "variants": []}'::jsonb) from ids $$,
  'owner saves an imported service with a processing gap');

select is(
  (select string_agg(left(g.kind::text, 1) || g.minutes, ' ' order by g.position)
   from public.service_segments g join saved s on s.id = g.service_id where s.name = 'color'),
  'b35 p35 s35', 'imported timeline is apply → process → rinse & style');

-- No price shown on the menu ("Price varies").
select lives_ok(
  $$ insert into saved select 'consult', public.save_service(salon, '{
       "name": "Extensions Consultation", "category": "Extensions", "description": null,
       "priceCents": null, "colorTag": "indigo",
       "segments": [{"kind": "busy", "minutes": 20}],
       "bufferBeforeMinutes": 0, "bufferAfterMinutes": 0, "consultationRequired": false,
       "bookableOnline": true, "newClientsOnly": false, "variants": []}'::jsonb) from ids $$,
  'imported service without a price saves');

-- Update: same id, new price and length; the service keeps its own settings.
select lives_ok(
  $$ select public.save_service(salon, jsonb_build_object(
       'id', (select id from saved where name = 'color'),
       'name', 'Single Process Color', 'category', 'Color', 'description', null,
       'priceCents', 10500, 'colorTag', 'purple',
       'segments', '[{"kind": "busy", "minutes": 120}]'::jsonb,
       'bufferBeforeMinutes', 0, 'bufferAfterMinutes', 0, 'consultationRequired', false,
       'bookableOnline', true, 'newClientsOnly', false, 'variants', '[]'::jsonb)) from ids $$,
  'owner updates a matched service from the import');

select is(
  (select price_cents || ':' || (select sum(minutes) from public.service_segments g where g.service_id = s.id)
   from public.services s join saved v on v.id = s.id where v.name = 'color'),
  '10500:120', 'update replaces price and length in place');

select lives_ok(
  $$ update public.services set archived_at = now()
     where id = (select id from saved where name = 'consult') $$,
  'replace mode: owner hides a service the import did not keep');
select pg_temp.logout();

-- Stylists can't import.
select pg_temp.login('00000000-0000-4000-b000-0000000016a2');
select throws_ok(
  $$ select public.save_service(salon, '{
       "name": "Sneaky Cut", "category": "Haircuts", "priceCents": 100, "colorTag": "blue",
       "segments": [{"kind": "busy", "minutes": 30}], "variants": []}'::jsonb) from ids $$,
  '42501', null, 'stylist cannot import services');
select pg_temp.logout();

select is(
  (select archived_at is not null from public.services s join saved v on v.id = s.id where v.name = 'consult'),
  true, 'archived service is kept for history');

select * from finish();
rollback;
