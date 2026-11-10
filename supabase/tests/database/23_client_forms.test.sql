-- Intake & consent forms (#45): templates and their validation, starters, which forms an
-- appointment needs (services, combos, new clients, how long a signature counts), the signed-out
-- forms link, the forms_request email, and the Today list of appointments missing forms.
begin;
select plan(47);

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
                    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
$$;

create function pg_temp.as_anon() returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
$$;

create function pg_temp.logout() returns void language sql as $$
  reset role;
  select set_config('request.jwt.claims', '', true);
$$;

create function pg_temp.segs(p_start timestamptz, p_minutes integer default 60) returns jsonb
language sql immutable as $$
  select jsonb_build_array(jsonb_build_object(
    'kind', 'busy', 'label', 'Color', 'start', p_start, 'end', p_start + make_interval(mins => p_minutes)));
$$;
grant execute on function pg_temp.segs(timestamptz, integer) to authenticated, anon;

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('00000000-0000-4000-f300-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-a@forms.test', now()),
  ('00000000-0000-4000-f300-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-b@forms.test', now());

select pg_temp.login('00000000-0000-4000-f300-00000000000a');
select public.create_salon('Forms A', 'forms-a', 'America/Chicago');
select pg_temp.logout();
select pg_temp.login('00000000-0000-4000-f300-00000000000b');
select public.create_salon('Forms B', 'forms-b', 'America/Chicago');
select pg_temp.logout();

create temp table ids as
  select (select id from public.salons where slug = 'forms-a') as a,
         (select id from public.salons where slug = 'forms-b') as b,
         '00000000-0000-4000-f300-00000000000a'::uuid as owner_a,
         '00000000-0000-4000-f300-00000000000b'::uuid as owner_b,
         date_trunc('hour', now()) + interval '10 days' as d10,
         date_trunc('hour', now()) + interval '11 days' as d11,
         date_trunc('hour', now()) + interval '12 days' as d12,
         date_trunc('hour', now()) + interval '13 days' as d13,
         date_trunc('hour', now()) + interval '14 days' as d14,
         date_trunc('hour', now()) + interval '15 days' as d15,
         date_trunc('hour', now()) + interval '16 days' as d16,
         date_trunc('hour', now()) + interval '200 days' as d200,
         date_trunc('hour', now()) - interval '30 days' as past;
grant select on ids to authenticated, anon;
create temp table t (name text primary key, val jsonb);
grant select, insert, update on t to authenticated, anon;

delete from public.work_hours_template where salon_id in (select a from ids union select b from ids);

insert into public.clients (salon_id, name, phone, email)
  select a, 'Karina Lopez', '+15550300101', 'karina@forms.test' from ids;
insert into public.clients (salon_id, name, phone)
  select a, 'Maria Regular', '+15550300202' from ids;

insert into public.services (salon_id, name) select a, 'All-over Color' from ids;
insert into public.services (salon_id, name) select a, 'Haircut' from ids;
insert into public.services (salon_id, name, is_combo) select a, 'Cut & Color', true from ids;
insert into public.service_combo_items (salon_id, combo_id, position, service_id)
  select a, (select id from public.services where name = 'Cut & Color' and salon_id = (select a from ids)), 0,
         (select id from public.services where name = 'Haircut' and salon_id = (select a from ids)) from ids;
insert into public.service_combo_items (salon_id, combo_id, position, service_id)
  select a, (select id from public.services where name = 'Cut & Color' and salon_id = (select a from ids)), 1,
         (select id from public.services where name = 'All-over Color' and salon_id = (select a from ids)) from ids;

create temp view c as
  select (select id from public.clients where name = 'Karina Lopez' and salon_id = (select a from ids)) as karina,
         (select id from public.clients where name = 'Maria Regular' and salon_id = (select a from ids)) as maria,
         (select id from public.services where name = 'All-over Color' and salon_id = (select a from ids)) as color,
         (select id from public.services where name = 'Haircut' and salon_id = (select a from ids)) as cut,
         (select id from public.services where name = 'Cut & Color' and salon_id = (select a from ids)) as combo,
         (select id from public.form_templates
           where starter_key = 'color_consent' and salon_id = (select a from ids)) as consent,
         (select id from public.form_templates
           where starter_key = 'new_client_intake' and salon_id = (select a from ids)) as intake;
grant select on c to authenticated, anon;

create function pg_temp.svc(p_service uuid, p_name text) returns jsonb language sql stable as $$
  select jsonb_build_array(jsonb_build_object('serviceId', p_service, 'name', p_name));
$$;
grant execute on function pg_temp.svc(uuid, text) to authenticated, anon;

create function pg_temp.token(p_name text) returns text language sql stable as $$
  select val ->> 'manage_token' from t where name = p_name;
$$;
grant execute on function pg_temp.token(text) to authenticated, anon;

create function pg_temp.appt(p_name text) returns uuid language sql stable as $$
  select (val ->> 'id')::uuid from t where name = p_name;
$$;
grant execute on function pg_temp.appt(text) to authenticated, anon;

create function pg_temp.consent_answers() returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'previous_reaction', 'No',
    'patch_test', 'I had a patch test at least 48 hours before this appointment',
    'understand_risks', true,
    'understand_results', true,
    'signature', 'M10 10L20 25L30 12L44 30');
$$;
grant execute on function pg_temp.consent_answers() to authenticated, anon;

-- Schema & privileges --------------------------------------------------------------
select ok(
  has_function_privilege('anon', 'public.public_appointment_forms(text)', 'execute')
  and has_function_privilege('anon', 'public.submit_public_form(text,uuid,jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.appointment_forms(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.appointments_missing_forms(uuid,timestamptz,timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.install_starter_forms(uuid)', 'execute'),
  'signed-out callers only get the forms-link RPCs');
select ok(
  not has_table_privilege('anon', 'public.form_templates', 'select')
  and not has_table_privilege('anon', 'public.form_submissions', 'select')
  and not has_table_privilege('anon', 'public.service_form_requirements', 'select')
  and not has_table_privilege('authenticated', 'public.form_submissions', 'insert')
  and not has_table_privilege('authenticated', 'public.form_submissions', 'update'),
  'signed-out callers can''t read forms, and nobody writes signed forms directly');

-- Starters & validation --------------------------------------------------------------
select is((select count(*)::integer from public.form_templates where salon_id = (select a from ids)),
  2, 'a new salon starts with the two starter forms');
select ok((select not ask_new_clients and valid_days is null from public.form_templates
            where id = (select intake from c))
          and (select valid_days = 182 from public.form_templates where id = (select consent from c)),
  'starters are off by default; color consent lasts six months');

select pg_temp.login((select owner_a from ids));
select is(public.install_starter_forms((select a from ids)), 0, 'starters are only added once');
select throws_ok(
  $$ insert into public.form_templates (salon_id, name, fields) select a, 'Dupes',
       '[{"id":"x","kind":"text","label":"A"},{"id":"x","kind":"text","label":"B"}]' from ids $$,
  '23514', null, 'field ids must be unique');
select throws_ok(
  $$ insert into public.form_templates (salon_id, name, fields) select a, 'One option',
       '[{"id":"x","kind":"choice","label":"Pick","options":["Only"]}]' from ids $$,
  '23514', null, 'a choice needs at least two options');
select throws_ok(
  $$ insert into public.form_templates (salon_id, name, fields) select a, 'Bad kind',
       '[{"id":"x","kind":"date","label":"When"}]' from ids $$,
  '23514', null, 'only text, choice, checkbox and signature fields');
select pg_temp.logout();

select pg_temp.login((select owner_b from ids));
select is((select count(*)::integer from public.form_templates where salon_id = (select a from ids)),
  0, 'another salon can''t see our forms');
select throws_ok(
  $$ insert into public.service_form_requirements (salon_id, service_id, template_id)
       select a, (select color from c), (select consent from c) from ids $$,
  '42501', null, 'another salon can''t change our services'' forms');
select pg_temp.logout();

-- Which forms an appointment needs ---------------------------------------------------
select pg_temp.login((select owner_a from ids));
insert into public.service_form_requirements (salon_id, service_id, template_id)
  select a, (select color from c), (select consent from c) from ids;

insert into t select 'color', to_jsonb(public.book_appointment(
  (select a from ids), (select karina from c), pg_temp.segs((select d10 from ids)),
  pg_temp.svc((select color from c), 'All-over Color')));
insert into t select 'cut', to_jsonb(public.book_appointment(
  (select a from ids), (select karina from c), pg_temp.segs((select d11 from ids)),
  pg_temp.svc((select cut from c), 'Haircut')));
insert into t select 'combo', to_jsonb(public.book_appointment(
  (select a from ids), (select karina from c), pg_temp.segs((select d12 from ids)),
  pg_temp.svc((select combo from c), 'Cut & Color')));

select is(public.appointment_forms(pg_temp.appt('color')),
  jsonb_build_array(jsonb_build_object('templateId', (select consent from c),
    'name', 'Color Consent / Patch Test', 'done', false, 'submittedAt', null, 'submissionId', null)),
  'booking a color service needs the color consent');
select is(public.appointment_forms(pg_temp.appt('cut')), '[]'::jsonb, 'a haircut needs no forms');
select is(jsonb_array_length(public.appointment_forms(pg_temp.appt('combo'))), 1,
  'a combo needs the forms of the services in it');
select pg_temp.logout();

select is((select count(*)::integer from public.client_email_outbox
            where appointment_id = pg_temp.appt('color') and kind = 'forms_request'), 1,
  'confirming an appointment that needs a form emails the forms link');
select is((select count(*)::integer from public.client_email_outbox
            where appointment_id = pg_temp.appt('cut') and kind = 'forms_request'), 0,
  'no forms email when nothing is needed');

select pg_temp.login((select owner_b from ids));
select throws_ok(format('select public.appointment_forms(%L)', pg_temp.appt('color')),
  'P0002', null, 'another salon can''t check our appointment''s forms');
select pg_temp.logout();

-- The client's forms link -------------------------------------------------------------
select pg_temp.as_anon();
insert into t select 'page', public.public_appointment_forms(pg_temp.token('color'));
select pg_temp.logout();
select ok((select val #>> '{salon,name}' = 'Forms A' and val ->> 'clientFirstName' = 'Karina'
             and val ->> 'services' = 'All-over Color' from t where name = 'page'),
  'the forms link shows the salon, the client''s first name and the services');
select ok((select jsonb_array_length(val -> 'forms') = 1
             and val #>> '{forms,0,name}' = 'Color Consent / Patch Test'
             and jsonb_array_length(val #> '{forms,0,fields}') = 6
             and not (val #>> '{forms,0,done}')::boolean from t where name = 'page'),
  'and the forms still to sign, with their fields');

select pg_temp.as_anon();
select is(public.public_appointment_forms(repeat('0', 64)), null, 'a wrong link shows nothing');
select is(public.submit_public_form(repeat('0', 64), (select consent from c), pg_temp.consent_answers())
            ->> 'reason', 'not_found', 'a wrong link can''t sign anything');
select is(public.submit_public_form(pg_temp.token('color'), (select consent from c),
            pg_temp.consent_answers() - 'signature') ->> 'reason',
  'invalid', 'a required signature is required');
select is(public.submit_public_form(pg_temp.token('color'), (select consent from c),
            pg_temp.consent_answers() || '{"signature":"<script>"}') ->> 'reason',
  'invalid', 'a signature must be drawn path data');
select is(public.submit_public_form(pg_temp.token('color'), (select consent from c),
            pg_temp.consent_answers() || '{"understand_risks":false}') ->> 'message',
  'Please tick: I understand hair color can cause an allergic reaction even if I have used it before, and I will tell my stylist right away about any itching, burning or swelling.',
  'required checkboxes must be ticked');
select is(public.submit_public_form(pg_temp.token('color'), (select consent from c),
            pg_temp.consent_answers() || '{"patch_test":"Maybe"}') ->> 'reason',
  'invalid', 'a choice must be one of the options');
select is(public.submit_public_form(pg_temp.token('color'), (select consent from c),
            pg_temp.consent_answers() || '{"extra":"x"}') ->> 'reason',
  'invalid', 'answers to fields the form doesn''t have are rejected');
select is(public.submit_public_form(pg_temp.token('color'), (select intake from c),
            '{"allergies":"None"}') ->> 'reason',
  'not_required', 'only forms this appointment needs can be signed');
insert into t select 'signed', public.submit_public_form(pg_temp.token('color'),
  (select consent from c), pg_temp.consent_answers());
select ok((select (val ->> 'ok')::boolean from t where name = 'signed'),
  'the client signs the color consent');
select is(public.submit_public_form(pg_temp.token('color'), (select consent from c),
            pg_temp.consent_answers()) ->> 'alreadyDone', 'true', 'signing twice is a no-op');
select is(jsonb_array_length(public.public_appointment_forms(pg_temp.token('color')) -> 'forms'), 1,
  'the link still lists the form');
select ok((public.public_appointment_forms(pg_temp.token('color')) #>> '{forms,0,done}')::boolean,
  'marked as signed');
select pg_temp.logout();

-- On the client's profile -------------------------------------------------------------
select pg_temp.login((select owner_a from ids));
select ok((select fs.client_id = (select karina from c) and fs.appointment_id = pg_temp.appt('color')
             and fs.template_name = 'Color Consent / Patch Test'
             and fs.answers ->> 'signature' = 'M10 10L20 25L30 12L44 30'
             and fs.submitted_at is not null
             from public.form_submissions fs
            where fs.id = (select (val ->> 'submissionId')::uuid from t where name = 'signed')),
  'the signed form is stored on the client with a timestamp');
select ok((public.appointment_forms(pg_temp.appt('color')) #>> '{0,done}')::boolean,
  'the appointment shows the form as signed');
select ok((public.appointment_forms(pg_temp.appt('combo')) #>> '{0,done}')::boolean,
  'a signed consent covers her other color appointments within six months');
insert into t select 'later', to_jsonb(public.book_appointment(
  (select a from ids), (select karina from c), pg_temp.segs((select d200 from ids)),
  pg_temp.svc((select color from c), 'All-over Color')));
select ok(not (public.appointment_forms(pg_temp.appt('later')) #>> '{0,done}')::boolean,
  'but not after it runs out');
update public.form_templates set fields = '[{"id":"ok","kind":"checkbox","label":"OK"}]'
 where id = (select consent from c);
select is((select jsonb_array_length(fields) from public.form_submissions
            where id = (select (val ->> 'submissionId')::uuid from t where name = 'signed')), 6,
  'editing a form never changes what was signed');
update public.form_templates set valid_days = 0 where id = (select consent from c);
select ok((public.appointment_forms(pg_temp.appt('color')) #>> '{0,done}')::boolean
          and not (public.appointment_forms(pg_temp.appt('combo')) #>> '{0,done}')::boolean,
  '"every visit" only counts a form signed for that appointment');
select is((select count(*)::integer from public.audit_log
            where action = 'client_forms.submitted' and salon_id = (select a from ids)), 1,
  'signing is audited');
select pg_temp.logout();

select pg_temp.login((select owner_b from ids));
select is((select count(*)::integer from public.form_submissions), 0,
  'another salon can''t read our signed forms');
select pg_temp.logout();

-- New clients ----------------------------------------------------------------------------
select pg_temp.login((select owner_a from ids));
update public.form_templates set ask_new_clients = true where id = (select intake from c);
insert into t select 'maria_past', to_jsonb(public.book_appointment(
  (select a from ids), (select maria from c), pg_temp.segs((select past from ids)),
  pg_temp.svc((select cut from c), 'Haircut'), 'confirmed', 'import'));
select public.set_appointment_status(pg_temp.appt('maria_past'), 'completed');
insert into t select 'maria', to_jsonb(public.book_appointment(
  (select a from ids), (select maria from c), pg_temp.segs((select d13 from ids)),
  pg_temp.svc((select cut from c), 'Haircut')));
select ok(public.appointment_forms(pg_temp.appt('cut')) @> jsonb_build_array(
            jsonb_build_object('templateId', (select intake from c), 'done', false)),
  '"ask new clients" forms are needed before a client''s first visit');
select is(public.appointment_forms(pg_temp.appt('maria')), '[]'::jsonb,
  'but not from returning clients');
select pg_temp.logout();

-- Today: appointments missing forms -------------------------------------------------------
select pg_temp.login((select owner_a from ids));
insert into t select 'missing', public.appointments_missing_forms(
  (select a from ids), now(), now() + interval '31 days');
select is((select jsonb_agg(e ->> 'appointmentId' order by e ->> 'startsAt')
             from t, jsonb_array_elements(val) e where name = 'missing'),
  jsonb_build_array(pg_temp.appt('color'), pg_temp.appt('cut'), pg_temp.appt('combo')),
  'Today lists upcoming appointments still missing a form');
select ok((select e -> 'missing' = '["New Client Intake"]'::jsonb
                  and e ->> 'manageToken' = pg_temp.token('cut')
             from t, jsonb_array_elements(val) e
            where name = 'missing' and e ->> 'appointmentId' = pg_temp.appt('cut')::text),
  'with the missing form names and the link token');
select throws_ok(
  $$ select public.appointments_missing_forms((select a from ids), now(), now() + interval '40 days') $$,
  '22023', null, 'at most 31 days at a time');
select pg_temp.logout();
select pg_temp.login((select owner_b from ids));
select throws_ok(
  $$ select public.appointments_missing_forms((select a from ids), now(), now() + interval '7 days') $$,
  '42501', null, 'another salon can''t list our appointments');
select pg_temp.logout();

-- Requested → confirmed, imports, cancellations, rate limit ------------------------------------
select pg_temp.login((select owner_a from ids));
update public.form_templates set ask_new_clients = false where id = (select intake from c);
insert into t select 'requested', to_jsonb(public.book_appointment(
  (select a from ids), (select karina from c), pg_temp.segs((select d14 from ids)),
  pg_temp.svc((select color from c), 'All-over Color'), 'requested'));
select public.set_appointment_status(pg_temp.appt('requested'), 'confirmed');
insert into t select 'imported', to_jsonb(public.book_appointment(
  (select a from ids), (select karina from c), pg_temp.segs((select d15 from ids)),
  pg_temp.svc((select color from c), 'All-over Color'), 'confirmed', 'import'));
select public.set_appointment_status(pg_temp.appt('combo'), 'cancelled');
select pg_temp.logout();

select is((select array_agg(appointment_id order by starts_at) from public.client_email_outbox
            where kind = 'forms_request' and appointment_id in
              (pg_temp.appt('requested'), pg_temp.appt('imported'))),
  array[pg_temp.appt('requested')],
  'the forms email goes out when a request is approved, not for imports');

select pg_temp.as_anon();
select is(public.public_appointment_forms(pg_temp.token('combo')), null,
  'a cancelled appointment''s link shows nothing');
select is((select count(*)::integer from generate_series(1, 31) i
            where public.submit_public_form(pg_temp.token('later'), (select consent from c),
                    '{}') ->> 'reason' = 'limit'), 1,
  'too many tries on one link are rate limited');
select pg_temp.logout();

select * from finish();
rollback;
