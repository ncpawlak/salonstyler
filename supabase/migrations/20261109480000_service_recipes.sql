-- Service recipes (docs/PLAN.md §10), issue #18: what a service uses from the back bar, deducted
-- from stock automatically when the appointment is done.
--
-- * public.service_recipes: per service, the products it uses and how much of each, in the
--   product's unit (e.g. All-over color: 1 tube of 6N + 60 ml developer). Replaced as a whole by
--   set_service_recipe (owners).
-- * When an appointment becomes completed, or its checkout is paid, each booked service's recipe
--   (combos expand to their services) is written to the ledger as `use` movements through
--   private.apply_stock_movement, so low-stock pushes fire as usual. Exactly once per appointment:
--   completing and paying, paying twice or undoing and redoing a completion never deduct again.
-- * stock_movements.appointment_id links those movements to the appointment.

-- ---------------------------------------------------------------------------
-- service_recipes
-- ---------------------------------------------------------------------------

create table public.service_recipes (
  id         uuid primary key default gen_random_uuid(),
  salon_id   uuid not null references public.salons (id) on delete cascade,
  service_id uuid not null,
  product_id uuid not null,
  -- In the product's unit; partial tubes / bottles allowed.
  quantity   numeric(12, 2) not null check (quantity > 0 and quantity < 10000),
  created_at timestamptz not null default now(),
  constraint service_recipes_service_fkey foreign key (salon_id, service_id)
    references public.services (salon_id, id) on delete cascade,
  constraint service_recipes_product_fkey foreign key (salon_id, product_id)
    references public.products (salon_id, id) on delete cascade,
  constraint service_recipes_service_product_key unique (service_id, product_id)
);

comment on table public.service_recipes is
  'Products a service uses (quantity in the product''s unit). Deducted from stock when the appointment is completed or checked out. Write through set_service_recipe.';

create index service_recipes_product_idx on public.service_recipes (product_id);
create index service_recipes_salon_idx on public.service_recipes (salon_id);

alter table public.service_recipes enable row level security;
revoke all on public.service_recipes from anon;
revoke insert, update, delete, truncate on public.service_recipes from authenticated;

create policy "members can read service recipes" on public.service_recipes
  for select to authenticated using (private.is_salon_member(salon_id));

-- ---------------------------------------------------------------------------
-- stock_movements.appointment_id
-- ---------------------------------------------------------------------------

alter table public.stock_movements
  add column appointment_id uuid,
  add constraint stock_movements_appointment_fkey foreign key (salon_id, appointment_id)
    references public.appointments (salon_id, id) on delete set null (appointment_id);

comment on column public.stock_movements.appointment_id is
  'The completed appointment a recipe `use` movement came from (one per product per appointment).';

create unique index stock_movements_appointment_use_key
  on public.stock_movements (appointment_id, product_id)
  where reason = 'use' and appointment_id is not null;

-- ---------------------------------------------------------------------------
-- set_service_recipe
-- ---------------------------------------------------------------------------

-- Replaces a service's recipe. p_lines: [{ "productId": uuid, "quantity": number }], [] clears it.
create or replace function public.set_service_recipe(p_service_id uuid, p_lines jsonb)
returns setof public.service_recipes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_service public.services;
  v_count   integer;
begin
  select * into v_service from public.services where id = p_service_id;
  if not found or not private.is_salon_member(v_service.salon_id) then
    raise exception 'Service not found' using errcode = 'P0002';
  end if;
  if not private.has_salon_role(v_service.salon_id, 'owner') then
    raise exception 'Only the salon owner can edit service recipes' using errcode = '42501';
  end if;
  if v_service.is_combo then
    raise exception 'A combo uses the recipes of its services' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Recipe lines must be an array' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_lines);
  if v_count > 30 then
    raise exception 'A recipe has at most 30 products' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) e
     where jsonb_typeof(e) <> 'object'
        or coalesce(e ->> 'productId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or jsonb_typeof(e -> 'quantity') <> 'number'
        or (e ->> 'quantity')::numeric <= 0
        or (e ->> 'quantity')::numeric >= 10000
        or (e ->> 'quantity')::numeric <> round((e ->> 'quantity')::numeric, 2)
  ) then
    raise exception 'Each line needs a product and a quantity above 0 (up to 2 decimals)'
      using errcode = '22023';
  end if;
  if (select count(distinct lower(e ->> 'productId')) from jsonb_array_elements(p_lines) e)
     <> v_count then
    raise exception 'Each product can only appear once' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) e
     where not exists (select 1 from public.products p
                        where p.id = (e ->> 'productId')::uuid
                          and p.salon_id = v_service.salon_id)
  ) then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;

  delete from public.service_recipes where service_id = v_service.id;
  insert into public.service_recipes (salon_id, service_id, product_id, quantity)
  select v_service.salon_id, v_service.id, (e ->> 'productId')::uuid, (e ->> 'quantity')::numeric
    from jsonb_array_elements(p_lines) e;

  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (v_service.salon_id, auth.uid(), 'service.recipe_set', 'service', v_service.id::text,
          jsonb_build_object('lines', p_lines));

  return query
    select * from public.service_recipes r where r.service_id = v_service.id order by r.created_at, r.id;
end;
$$;

revoke all on function public.set_service_recipe(uuid, jsonb) from public, anon;
grant execute on function public.set_service_recipe(uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Deduction
-- ---------------------------------------------------------------------------

-- Writes one `use` movement per product for the appointment's services (combos expand to their
-- services; archived products are skipped). Idempotent: does nothing once the appointment has any
-- recipe movement. Returns how many movements it wrote.
create or replace function private.deduct_appointment_recipes(p_appointment_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appt     public.appointments;
  v_movement public.stock_movements;
  v_count    integer := 0;
  r          record;
begin
  -- Serialises a completion and a checkout landing at the same time.
  select * into v_appt from public.appointments where id = p_appointment_id for update;
  if not found then
    return 0;
  end if;
  if exists (select 1 from public.stock_movements sm
              where sm.appointment_id = v_appt.id and sm.reason = 'use') then
    return 0;
  end if;

  for r in
    with booked as (
      select (e.svc ->> 'serviceId')::uuid as service_id
        from jsonb_array_elements(v_appt.services) e(svc)
       where jsonb_typeof(e.svc) = 'object'
         and coalesce(e.svc ->> 'serviceId', '')
             ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ),
    expanded as (
      select s.id as service_id
        from booked b
        join public.services s on s.salon_id = v_appt.salon_id and s.id = b.service_id
       where not s.is_combo
      union all
      select ci.service_id
        from booked b
        join public.service_combo_items ci
          on ci.salon_id = v_appt.salon_id and ci.combo_id = b.service_id
    )
    select sr.product_id,
           sum(sr.quantity) as quantity,
           string_agg(distinct s.name, ', ') as services
      from expanded x
      join public.service_recipes sr on sr.salon_id = v_appt.salon_id and sr.service_id = x.service_id
      join public.services s on s.id = x.service_id
      join public.products p on p.id = sr.product_id and p.active
     group by sr.product_id
     order by sr.product_id
  loop
    -- The product was used, so this may take on_hand below zero (recount later).
    v_movement := private.apply_stock_movement(
      r.product_id, 'use', -r.quantity, null, left('Used for ' || r.services, 200),
      null, null, true);
    update public.stock_movements set appointment_id = v_appt.id where id = v_movement.id;
    v_count := v_count + 1;
  end loop;

  if v_count > 0 then
    insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
    values (v_appt.salon_id, auth.uid(), 'stock.recipe_used', 'appointment', v_appt.id::text,
            jsonb_build_object('movements', v_count));
  end if;
  return v_count;
end;
$$;

revoke all on function private.deduct_appointment_recipes(uuid) from public;

create or replace function private.appointment_completed_deduct_recipes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.deduct_appointment_recipes(new.id);
  return null;
end;
$$;

create or replace function private.checkout_paid_deduct_recipes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.appointment_id is not null then
    perform private.deduct_appointment_recipes(new.appointment_id);
  end if;
  return null;
end;
$$;

revoke all on function private.appointment_completed_deduct_recipes() from public;
revoke all on function private.checkout_paid_deduct_recipes() from public;

create trigger appointments_deduct_recipes
  after update of status on public.appointments
  for each row
  when (new.status = 'completed' and old.status is distinct from 'completed')
  execute function private.appointment_completed_deduct_recipes();

create trigger checkouts_deduct_recipes
  after update of status on public.checkouts
  for each row
  when (new.status = 'paid' and old.status is distinct from 'paid')
  execute function private.checkout_paid_deduct_recipes();
