-- Intake & consent forms (docs/PLAN.md §11b, issue #45).
--
--   * form_templates: the salon's forms, built from text, choice, checkbox and signature fields.
--     Every salon starts with two starters (New Client Intake, Color Consent / Patch Test), both
--     off until he links them to services or turns on "Ask new clients".
--   * service_form_requirements: "this service requires this form" (combos inherit their parts).
--   * form_submissions: what a client filled out and signed, with a snapshot of the form as they
--     saw it and a timestamp. Stored on the client; members read, nobody edits.
--   * The client fills forms at /f/<manage_token> (the appointment's #10 manage token), signed out.
--     public_appointment_forms / submit_public_form only ever touch the one appointment behind
--     the token. A `forms_request` client email with the link goes out when an appointment that
--     needs forms is confirmed (the #10 outbox and notifier send it).
--   * appointment_forms / appointments_missing_forms flag missing forms on the appointment and
--     on Today.
-- See supabase/docs/client-forms.md.

-- ---------------------------------------------------------------------------
-- Field and answer validation (mirrors packages/core/src/forms)
-- ---------------------------------------------------------------------------

-- [{ id, kind: text|choice|checkbox|signature, label, required?, help?, multiline?, options? }]
create or replace function private.valid_form_fields(p_fields jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  f    jsonb;
  ids  text[] := '{}';
  kind text;
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'array'
     or jsonb_array_length(p_fields) not between 1 and 40 then
    return false;
  end if;
  for f in select e from jsonb_array_elements(p_fields) e loop
    if jsonb_typeof(f) <> 'object' then
      return false;
    end if;
    if coalesce(f ->> 'id', '') !~ '^[a-z0-9_]{1,40}$' or (f ->> 'id') = any (ids) then
      return false;
    end if;
    ids := ids || (f ->> 'id');
    kind := f ->> 'kind';
    if kind is null or kind not in ('text', 'choice', 'checkbox', 'signature') then
      return false;
    end if;
    if jsonb_typeof(f -> 'label') is distinct from 'string'
       or char_length(btrim(f ->> 'label')) not between 1 and 300 then
      return false;
    end if;
    if f ? 'required' and jsonb_typeof(f -> 'required') <> 'boolean' then
      return false;
    end if;
    if f ? 'multiline' and jsonb_typeof(f -> 'multiline') <> 'boolean' then
      return false;
    end if;
    if f ? 'help' and (jsonb_typeof(f -> 'help') <> 'string' or char_length(f ->> 'help') > 500) then
      return false;
    end if;
    if kind = 'choice' then
      if jsonb_typeof(f -> 'options') is distinct from 'array'
         or jsonb_array_length(f -> 'options') not between 2 and 20 then
        return false;
      end if;
      if exists (select 1 from jsonb_array_elements(f -> 'options') o
                  where jsonb_typeof(o) <> 'string'
                     or char_length(btrim(o #>> '{}')) not between 1 and 200) then
        return false;
      end if;
      if (select count(distinct o #>> '{}') from jsonb_array_elements(f -> 'options') o)
         <> jsonb_array_length(f -> 'options') then
        return false;
      end if;
    elsif f ? 'options' then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- Signatures are SVG path data drawn on the client's phone ("M10 20L11 22...").
create or replace function private.valid_signature(p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_value) = 'string'
     and char_length(p_value #>> '{}') between 4 and 40000
     and (p_value #>> '{}') ~ '^M[-0-9MLml .,]+$';
$$;

-- Null when p_answers fits p_fields; otherwise a message for the client.
create or replace function private.form_answers_error(p_fields jsonb, p_answers jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  f        jsonb;
  v        jsonb;
  required boolean;
  label    text;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    return 'Answers are missing.';
  end if;
  if exists (select 1 from jsonb_object_keys(p_answers) k
              where not exists (select 1 from jsonb_array_elements(p_fields) e where e ->> 'id' = k)) then
    return 'This form has changed. Reload the page and try again.';
  end if;

  for f in select e from jsonb_array_elements(p_fields) e loop
    v := p_answers -> (f ->> 'id');
    if v = 'null'::jsonb then
      v := null;
    end if;
    required := coalesce((f ->> 'required')::boolean, false);
    label := f ->> 'label';

    case f ->> 'kind'
      when 'text' then
        if v is not null and (jsonb_typeof(v) <> 'string' or char_length(v #>> '{}') > 4000) then
          return 'Check your answer to: ' || label;
        end if;
        if required and coalesce(btrim(v #>> '{}'), '') = '' then
          return 'Please answer: ' || label;
        end if;
      when 'choice' then
        if v is not null and (jsonb_typeof(v) <> 'string' or not (f -> 'options') @> jsonb_build_array(v)) then
          return 'Check your answer to: ' || label;
        end if;
        if required and v is null then
          return 'Please answer: ' || label;
        end if;
      when 'checkbox' then
        if v is not null and jsonb_typeof(v) <> 'boolean' then
          return 'Check your answer to: ' || label;
        end if;
        if required and v is distinct from 'true'::jsonb then
          return 'Please tick: ' || label;
        end if;
      when 'signature' then
        if v is not null and not private.valid_signature(v) then
          return 'Please sign again: ' || label;
        end if;
        if required and v is null then
          return 'Please sign: ' || label;
        end if;
    end case;
  end loop;
  return null;
end;
$$;

revoke all on function private.valid_form_fields(jsonb) from public;
revoke all on function private.valid_signature(jsonb) from public;
revoke all on function private.form_answers_error(jsonb, jsonb) from public;
grant execute on function private.valid_form_fields(jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.form_templates (
  id              uuid primary key default gen_random_uuid(),
  salon_id        uuid not null references public.salons (id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 80),
  description     text check (description is null or char_length(description) <= 1000),
  fields          jsonb not null check (private.valid_form_fields(fields)),
  -- Required on a client's appointments until they've had a completed visit.
  ask_new_clients boolean not null default false,
  -- How long a signature counts: null = once, 0 = every visit, N = N days.
  valid_days      integer check (valid_days is null or valid_days between 0 and 3650),
  -- Set for the built-in starters so they're only ever added once.
  starter_key     text check (starter_key is null or starter_key ~ '^[a-z0-9_]{1,40}$'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (salon_id, starter_key),
  unique (salon_id, id)
);

comment on table public.form_templates is
  'Intake and consent forms the salon asks clients to fill out and sign (#45).';
comment on column public.form_templates.ask_new_clients is
  'Ask clients who have no completed visit yet, whatever they book.';
comment on column public.form_templates.valid_days is
  'How long a signed form counts: null once, 0 every visit, otherwise this many days.';

create trigger form_templates_set_updated_at
  before update on public.form_templates
  for each row execute function private.set_updated_at();

create table public.service_form_requirements (
  salon_id    uuid not null,
  service_id  uuid not null,
  template_id uuid not null,
  created_at  timestamptz not null default now(),
  primary key (service_id, template_id),
  foreign key (salon_id, service_id) references public.services (salon_id, id) on delete cascade,
  foreign key (salon_id, template_id) references public.form_templates (salon_id, id)
    on delete cascade
);

comment on table public.service_form_requirements is
  'Booking this service (or a combo containing it) requires this form.';

create index service_form_requirements_template_idx
  on public.service_form_requirements (template_id);

create table public.form_submissions (
  id             uuid primary key default gen_random_uuid(),
  salon_id       uuid not null references public.salons (id) on delete cascade,
  client_id      uuid not null references public.clients (id) on delete cascade,
  template_id    uuid references public.form_templates (id) on delete set null,
  appointment_id uuid references public.appointments (id) on delete set null,
  -- The form exactly as the client saw it, so later edits never change what they signed.
  template_name  text not null check (char_length(template_name) between 1 and 80),
  fields         jsonb not null check (private.valid_form_fields(fields)),
  answers        jsonb not null check (jsonb_typeof(answers) = 'object'),
  submitted_at   timestamptz not null default now()
);

comment on table public.form_submissions is
  'Forms a client filled out and signed, with a snapshot of the form and the time they signed.';

create index form_submissions_client_idx on public.form_submissions (client_id, submitted_at desc);
create index form_submissions_template_client_idx
  on public.form_submissions (template_id, client_id, submitted_at desc);
create index form_submissions_appointment_idx on public.form_submissions (appointment_id);

-- ---------------------------------------------------------------------------
-- RLS: members read; owners manage forms; submissions only come in through the link.
-- ---------------------------------------------------------------------------

alter table public.form_templates enable row level security;
alter table public.service_form_requirements enable row level security;
alter table public.form_submissions enable row level security;

revoke all on public.form_templates from anon;
revoke all on public.service_form_requirements from anon;
revoke all on public.form_submissions from anon;
revoke insert, update, delete, truncate on public.form_submissions from authenticated;

create policy "members read forms" on public.form_templates
  for select to authenticated using (private.is_salon_member(salon_id));
create policy "owners manage forms" on public.form_templates
  for all to authenticated
  using (private.has_salon_role(salon_id, 'owner'))
  with check (private.has_salon_role(salon_id, 'owner'));

create policy "members read form requirements" on public.service_form_requirements
  for select to authenticated using (private.is_salon_member(salon_id));
create policy "owners manage form requirements" on public.service_form_requirements
  for all to authenticated
  using (private.has_salon_role(salon_id, 'owner'))
  with check (private.has_salon_role(salon_id, 'owner'));

create policy "members read signed forms" on public.form_submissions
  for select to authenticated using (private.is_salon_member(salon_id));

-- ---------------------------------------------------------------------------
-- Starter templates
-- ---------------------------------------------------------------------------

create or replace function private.install_starter_forms(p_salon_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.form_templates
    (salon_id, starter_key, name, description, fields, ask_new_clients, valid_days)
  values
    (p_salon_id, 'new_client_intake', 'New Client Intake',
     'A few questions before your first visit so we can take good care of your hair.',
     '[
        {"id":"allergies","kind":"text","required":true,
         "label":"Any allergies or sensitivities? (hair products, latex, fragrance, nickel)",
         "help":"Write \"None\" if you have none."},
        {"id":"health","kind":"text","multiline":true,
         "label":"Anything else we should know? (pregnancy, scalp or skin conditions, medications)"},
        {"id":"last_color","kind":"choice","required":true,
         "label":"When did you last color or lighten your hair?",
         "options":["Never","In the last 3 months","3 to 12 months ago","Over a year ago"]},
        {"id":"hair_history","kind":"text","multiline":true,
         "label":"Hair history: color, relaxers, keratin, perms or box dye in the last 2 years"},
        {"id":"goals","kind":"text","multiline":true,
         "label":"What would you like from your visit?"},
        {"id":"photos_ok","kind":"checkbox",
         "label":"OK to take before and after photos for my client record"},
        {"id":"signature","kind":"signature","required":true,"label":"Signature"}
      ]'::jsonb,
     false, null),
    (p_salon_id, 'color_consent', 'Color Consent / Patch Test',
     'Hair color can cause allergic reactions. Please read and sign before your color service.',
     '[
        {"id":"previous_reaction","kind":"choice","required":true,
         "label":"Have you ever reacted to hair dye, henna or a \"black henna\" tattoo?",
         "options":["No","Yes","Not sure"]},
        {"id":"reaction_details","kind":"text","multiline":true,
         "label":"If yes or not sure, what happened?"},
        {"id":"patch_test","kind":"choice","required":true,
         "label":"Patch test",
         "options":["I had a patch test at least 48 hours before this appointment",
                    "I have had color here in the last 6 months with no reaction",
                    "I decline a patch test"]},
        {"id":"understand_risks","kind":"checkbox","required":true,
         "label":"I understand hair color can cause an allergic reaction even if I have used it before, and I will tell my stylist right away about any itching, burning or swelling."},
        {"id":"understand_results","kind":"checkbox","required":true,
         "label":"I understand results depend on my hair''s history and condition and can''t be guaranteed."},
        {"id":"signature","kind":"signature","required":true,"label":"Signature"}
      ]'::jsonb,
     false, 182)
  on conflict (salon_id, starter_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function private.install_starter_forms(uuid) from public;

-- Owners can put back a starter they deleted.
create or replace function public.install_starter_forms(p_salon_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_salon_role(p_salon_id, 'owner') then
    raise exception 'Only the salon owner can add forms' using errcode = '42501';
  end if;
  return private.install_starter_forms(p_salon_id);
end;
$$;

create or replace function private.salons_install_starter_forms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.install_starter_forms(new.id);
  return null;
end;
$$;

revoke all on function private.salons_install_starter_forms() from public;

create trigger salons_install_starter_forms
  after insert on public.salons
  for each row execute function private.salons_install_starter_forms();

select private.install_starter_forms(s.id) from public.salons s;

-- ---------------------------------------------------------------------------
-- Which forms an appointment needs
-- ---------------------------------------------------------------------------

-- [{ templateId, name, done, submittedAt, submissionId }] for the appointment's client: forms
-- linked to its services (or their combo parts), plus "ask new clients" forms while the client
-- has no completed visit before this one. Done = a signature that still counts for this visit.
create or replace function private.appointment_form_status(p_appt public.appointments)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with svc as (
    select (e ->> 'serviceId')::uuid as id
      from jsonb_array_elements(coalesce(p_appt.services, '[]'::jsonb)) e
     where jsonb_typeof(e) = 'object'
       and e ->> 'serviceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ), svc_all as (
    select id from svc
    union
    select ci.service_id from public.service_combo_items ci join svc on ci.combo_id = svc.id
  ), needed as (
    select t.id, t.name, t.valid_days, t.created_at
      from public.form_templates t
     where p_appt.client_id is not null
       and t.salon_id = p_appt.salon_id
       and (exists (select 1 from public.service_form_requirements r
                     join svc_all on svc_all.id = r.service_id
                    where r.template_id = t.id)
            or (t.ask_new_clients
                and not exists (select 1 from public.appointments x
                                 where x.client_id = p_appt.client_id
                                   and x.id <> p_appt.id
                                   and x.status in ('completed', 'confirmed')
                                   and x.starts_at < p_appt.starts_at
                                   and x.starts_at <= now())))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'templateId', n.id,
           'name', n.name,
           'done', s.id is not null,
           'submittedAt', s.submitted_at,
           'submissionId', s.id) order by n.created_at, n.id), '[]'::jsonb)
    from needed n
    left join lateral (
      select fs.id, fs.submitted_at
        from public.form_submissions fs
       where fs.template_id = n.id
         and fs.client_id = p_appt.client_id
         and case
               when n.valid_days is null then true
               when n.valid_days = 0 then fs.appointment_id = p_appt.id
               else fs.submitted_at >= p_appt.starts_at - make_interval(days => n.valid_days)
             end
       order by fs.submitted_at desc
       limit 1
    ) s on true;
$$;

revoke all on function private.appointment_form_status(public.appointments) from public;

create or replace function private.appointment_missing_forms(p_appt public.appointments)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from jsonb_array_elements(private.appointment_form_status(p_appt)) e
                  where not (e ->> 'done')::boolean);
$$;

revoke all on function private.appointment_missing_forms(public.appointments) from public;

-- Members: the forms one appointment needs and whether each is signed.
create or replace function public.appointment_forms(p_appointment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_appt public.appointments;
begin
  select * into v_appt from public.appointments a where a.id = p_appointment_id;
  if v_appt.id is null or not private.is_salon_member(v_appt.salon_id) then
    raise exception 'Appointment not found' using errcode = 'P0002';
  end if;
  return private.appointment_form_status(v_appt);
end;
$$;

-- Members: upcoming appointments between p_from and p_to (at most 31 days) still missing a
-- required form, for the Today flag.
create or replace function public.appointments_missing_forms(
  p_salon_id uuid,
  p_from     timestamptz,
  p_to       timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_salon_member(p_salon_id) then
    raise exception 'Not a member of this salon' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '31 days' then
    raise exception 'Pick a range of up to 31 days' using errcode = '22023';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'appointmentId', a.id,
             'clientId', a.client_id,
             'clientName', c.name,
             'phone', c.phone,
             'email', c.email,
             'startsAt', a.starts_at,
             'status', a.status,
             'services', private.appointment_services_label(a.services),
             'manageToken', a.manage_token,
             'missing', (select jsonb_agg(e ->> 'name')
                           from jsonb_array_elements(st.forms) e
                          where not (e ->> 'done')::boolean)) order by a.starts_at)
      from public.appointments a
      join public.clients c on c.id = a.client_id
      cross join lateral (select private.appointment_form_status(a) as forms) st
     where a.salon_id = p_salon_id
       and a.status in ('held', 'requested', 'confirmed')
       and a.starts_at >= p_from
       and a.starts_at < p_to
       and exists (select 1 from jsonb_array_elements(st.forms) e where not (e ->> 'done')::boolean)),
    '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- The client's forms link (/f/<manage_token>, signed out)
-- ---------------------------------------------------------------------------

-- The forms this appointment needs, with their fields, or null when the link is wrong or the
-- appointment is cancelled. Nothing the client already answered is sent back.
create or replace function public.public_appointment_forms(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_appt public.appointments;
begin
  v_appt := private.appointment_by_manage_token(p_token);
  if v_appt.id is null or v_appt.status in ('cancelled', 'no_show') then
    return null;
  end if;

  return (
    select jsonb_build_object(
             'salon', jsonb_build_object('name', s.name, 'slug', s.slug, 'timezone', s.timezone),
             'clientFirstName', split_part(btrim(c.name), ' ', 1),
             'startsAt', v_appt.starts_at,
             'services', private.appointment_services_label(v_appt.services),
             'forms', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'templateId', t.id,
                        'name', t.name,
                        'description', t.description,
                        'fields', t.fields,
                        'done', (e ->> 'done')::boolean,
                        'submittedAt', e -> 'submittedAt') order by o)
                 from jsonb_array_elements(private.appointment_form_status(v_appt))
                        with ordinality as x(e, o)
                 join public.form_templates t on t.id = (e ->> 'templateId')::uuid),
               '[]'::jsonb))
      from public.salons s
      left join public.clients c on c.id = v_appt.client_id
     where s.id = v_appt.salon_id);
end;
$$;

-- Saves one signed form for the appointment's client. Returns { ok: true, submittedAt } or
-- { ok: false, reason: 'not_found' | 'not_required' | 'invalid' | 'limit', message? }.
-- Counts tries per link in private.rate_limits (public.hit_rate_limit is for the booking
-- Edge Function's service role; the forms link calls in as anon).
create or replace function private.forms_rate_limit_ok(p_token text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into private.rate_limits as r (key_hash, window_started_at, window_count)
  values (encode(pg_catalog.sha256(convert_to('forms:' || p_token, 'UTF8')), 'hex'), now(), 1)
  on conflict (key_hash) do update
     set window_started_at = case when r.window_started_at <= now() - interval '1 hour'
                                  then now() else r.window_started_at end,
         window_count = case when r.window_started_at <= now() - interval '1 hour'
                             then 1 else r.window_count + 1 end
  returning window_count into v_count;
  return v_count <= 30;
end;
$$;

revoke all on function private.forms_rate_limit_ok(text) from public;
create or replace function public.submit_public_form(
  p_token       text,
  p_template_id uuid,
  p_answers     jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appt   public.appointments;
  v_form   public.form_templates;
  v_status jsonb;
  v_error  text;
  v_id     uuid;
  v_at     timestamptz;
begin
  v_appt := private.appointment_by_manage_token(p_token);
  if v_appt.id is null or v_appt.status in ('cancelled', 'no_show') or v_appt.client_id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if not private.forms_rate_limit_ok(p_token) then
    return jsonb_build_object('ok', false, 'reason', 'limit',
      'message', 'Too many tries. Please wait a little and try again.');
  end if;

  select e into v_status
    from jsonb_array_elements(private.appointment_form_status(v_appt)) e
   where e ->> 'templateId' = p_template_id::text;
  if v_status is null then
    return jsonb_build_object('ok', false, 'reason', 'not_required',
      'message', 'This form isn''t needed for your appointment.');
  end if;
  if (v_status ->> 'done')::boolean then
    return jsonb_build_object('ok', true, 'alreadyDone', true,
      'submittedAt', v_status -> 'submittedAt');
  end if;

  select * into v_form from public.form_templates t where t.id = p_template_id;
  v_error := private.form_answers_error(v_form.fields, p_answers);
  if v_error is not null then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'message', v_error);
  end if;

  insert into public.form_submissions
    (salon_id, client_id, template_id, appointment_id, template_name, fields, answers)
  values
    (v_appt.salon_id, v_appt.client_id, v_form.id, v_appt.id, v_form.name, v_form.fields,
     jsonb_strip_nulls(p_answers))
  returning id, submitted_at into v_id, v_at;

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (v_appt.salon_id, null, 'client_forms.submitted', 'form_submission', v_id::text,
          jsonb_build_object('appointment_id', v_appt.id, 'client_id', v_appt.client_id,
                             'template_id', v_form.id, 'template_name', v_form.name));

  return jsonb_build_object('ok', true, 'submissionId', v_id, 'submittedAt', v_at);
end;
$$;

-- ---------------------------------------------------------------------------
-- Email the link with the booking confirmation
-- ---------------------------------------------------------------------------

alter type public.client_email_kind add value if not exists 'forms_request';

-- Same moment as the confirmation email (#10): when an appointment becomes confirmed (imports
-- excluded) and still needs a form.
create or replace function private.enqueue_forms_request_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'confirmed'
     and (tg_op = 'INSERT' or old.status in ('held', 'requested'))
     and new.source <> 'import'
     and private.appointment_missing_forms(new)
  then
    perform private.enqueue_client_email(new, 'forms_request', 'forms_request:' || new.id);
  end if;
  return null;
end;
$$;

revoke all on function private.enqueue_forms_request_email() from public;

create trigger appointments_enqueue_forms_request
  after insert or update of status on public.appointments
  for each row execute function private.enqueue_forms_request_email();

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.install_starter_forms(uuid) from public, anon;
revoke all on function public.appointment_forms(uuid) from public, anon;
revoke all on function public.appointments_missing_forms(uuid, timestamptz, timestamptz)
  from public, anon;
revoke all on function public.public_appointment_forms(text) from public;
revoke all on function public.submit_public_form(text, uuid, jsonb) from public;

grant execute on function public.install_starter_forms(uuid) to authenticated, service_role;
grant execute on function public.appointment_forms(uuid) to authenticated, service_role;
grant execute on function public.appointments_missing_forms(uuid, timestamptz, timestamptz)
  to authenticated, service_role;
-- The token is the only credential, as with get_receipt.
grant execute on function public.public_appointment_forms(text) to anon, authenticated, service_role;
grant execute on function public.submit_public_form(text, uuid, jsonb)
  to anon, authenticated, service_role;
