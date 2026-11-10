-- Inventory (docs/PLAN.md §10), issue #17: products, barcode scanning, stock movements, retail
-- sales at checkout and low-stock pushes. Service recipes and AI inventory commands are #18.
--
-- * public.products: the salon's catalog of retail and back-bar products. Members edit the
--   descriptive columns directly; on_hand only changes through a stock movement.
-- * public.stock_movements: append-only ledger. Every change to on_hand writes one row
--   (receive, sale, adjust, count, use, return) with the resulting on_hand.
-- * adjust_stock / count_stock: the app's RPCs (scanner, product screen).
-- * Retail lines at checkout whose source_id is a product decrement stock when the checkout is
--   paid (trigger on public.checkouts, idempotent per line).
-- * Low stock: when a movement takes on_hand from above the reorder point to at or below it,
--   salon owners get a push (notification kind low_stock), unless settings.low_stock_alerts_enabled
--   is off. public.reorder_list is the exportable list of products at or below their point.

-- ---------------------------------------------------------------------------
-- Settings + notification kind
-- ---------------------------------------------------------------------------

alter type public.notification_kind add value if not exists 'low_stock';

alter table public.settings
  add column low_stock_alerts_enabled boolean not null default true;

comment on column public.settings.low_stock_alerts_enabled is
  'Push owners when a product drops to or below its reorder point.';

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------

create type public.stock_movement_reason as enum
  ('receive', 'sale', 'adjust', 'count', 'use', 'return');

create table public.products (
  id                 uuid primary key default gen_random_uuid(),
  salon_id           uuid not null references public.salons (id) on delete cascade,
  name               text not null check (char_length(btrim(name)) between 1 and 120),
  brand              text check (brand is null or char_length(btrim(brand)) between 1 and 80),
  category           text check (category is null or char_length(btrim(category)) between 1 and 60),
  sku                text check (sku is null or char_length(btrim(sku)) between 1 and 64),
  -- As read by the scanner (EAN-13, UPC-A, Code 128, ...).
  barcode            text check (barcode is null or barcode ~ '^[!-~]{1,64}$'),
  unit               text not null default 'each' check (char_length(btrim(unit)) between 1 and 20),
  on_hand            numeric(12, 2) not null default 0,
  reorder_point      numeric(12, 2) not null default 0 check (reorder_point >= 0),
  -- How many to order when it runs low; null = suggest topping up to twice the reorder point.
  reorder_quantity   numeric(12, 2) check (reorder_quantity is null or reorder_quantity > 0),
  cost_cents         integer check (cost_cents is null or cost_cents between 0 and 10000000),
  -- Null = not sold at retail (back-bar / professional only).
  retail_price_cents integer check (retail_price_cents is null
                                    or retail_price_cents between 0 and 10000000),
  supplier           text check (supplier is null or char_length(btrim(supplier)) between 1 and 120),
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint products_salon_id_id_key unique (salon_id, id)
);

comment on table public.products is
  'Salon products (retail and back-bar). on_hand changes only through adjust_stock / count_stock / paid checkouts.';
comment on column public.products.reorder_point is
  'Owners get a low-stock push when on_hand drops to or below this.';

create unique index products_barcode_key on public.products (salon_id, barcode)
  where barcode is not null;
create unique index products_sku_key on public.products (salon_id, lower(sku))
  where sku is not null;
create index products_salon_name_idx on public.products (salon_id, lower(name));

create trigger products_set_updated_at
  before update on public.products
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- stock_movements
-- ---------------------------------------------------------------------------

create table public.stock_movements (
  id               uuid primary key default gen_random_uuid(),
  salon_id         uuid not null references public.salons (id) on delete cascade,
  product_id       uuid not null,
  reason           public.stock_movement_reason not null,
  delta            numeric(12, 2) not null,
  on_hand_after    numeric(12, 2) not null,
  note             text check (note is null or char_length(note) <= 200),
  checkout_id      uuid,
  -- The paid retail line a sale came from (one sale movement per line).
  checkout_item_id uuid,
  created_by       uuid default auth.uid() references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  constraint stock_movements_product_fkey foreign key (salon_id, product_id)
    references public.products (salon_id, id) on delete cascade,
  constraint stock_movements_checkout_fkey foreign key (salon_id, checkout_id)
    references public.checkouts (salon_id, id) on delete set null (checkout_id),
  constraint stock_movements_delta check (delta <> 0 or reason = 'count')
);

comment on table public.stock_movements is
  'Append-only stock ledger. Written by adjust_stock / count_stock and by paid checkouts.';

create index stock_movements_product_idx on public.stock_movements (product_id, created_at desc);
create unique index stock_movements_sale_item_key on public.stock_movements (checkout_item_id)
  where reason = 'sale';

-- ---------------------------------------------------------------------------
-- Access: members read both; members edit product details (not on_hand); the ledger is
-- written only by the functions below.
-- ---------------------------------------------------------------------------

alter table public.products        enable row level security;
alter table public.stock_movements enable row level security;

revoke all on public.products, public.stock_movements from anon;
revoke insert, update, delete, truncate on public.products, public.stock_movements
  from authenticated;
grant insert (salon_id, name, brand, category, sku, barcode, unit, reorder_point,
              reorder_quantity, cost_cents, retail_price_cents, supplier, active)
  on public.products to authenticated;
grant update (name, brand, category, sku, barcode, unit, reorder_point, reorder_quantity,
              cost_cents, retail_price_cents, supplier, active)
  on public.products to authenticated;
grant delete on public.products to authenticated;

create policy "members can read products" on public.products
  for select to authenticated using (private.is_salon_member(salon_id));
create policy "members can add products" on public.products
  for insert to authenticated with check (private.is_salon_member(salon_id));
create policy "members can edit products" on public.products
  for update to authenticated
  using (private.is_salon_member(salon_id)) with check (private.is_salon_member(salon_id));
create policy "members can delete products" on public.products
  for delete to authenticated using (private.is_salon_member(salon_id));

create policy "members can read stock movements" on public.stock_movements
  for select to authenticated using (private.is_salon_member(salon_id));

-- ---------------------------------------------------------------------------
-- Stock movements + low-stock push
-- ---------------------------------------------------------------------------

-- "2" / "2.5" with the unit unless it's "each": "2 left", "2.5 tubes left".
create or replace function private.format_stock(p_quantity numeric, p_unit text)
returns text
language sql
immutable
set search_path = ''
as $$
  select trim_scale(p_quantity)::text
         || case when p_unit is null or lower(btrim(p_unit)) = 'each' then ''
                 else ' ' || btrim(p_unit) end;
$$;

-- Applies one movement: p_delta, or p_set_to for a stock count. Pushes owners when on_hand
-- crosses from above the reorder point to at or below it. plpgsql so the low_stock enum value
-- is only resolved at run time.
create or replace function private.apply_stock_movement(
  p_product_id       uuid,
  p_reason           public.stock_movement_reason,
  p_delta            numeric,
  p_set_to           numeric default null,
  p_note             text default null,
  p_checkout_id      uuid default null,
  p_checkout_item_id uuid default null,
  p_allow_negative   boolean default false
)
returns public.stock_movements
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product  public.products;
  v_after    numeric(12, 2);
  v_movement public.stock_movements;
  v_owner    uuid;
begin
  select * into v_product from public.products where id = p_product_id for update;
  if not found then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;

  v_after := coalesce(p_set_to, v_product.on_hand + p_delta);
  if v_after < 0 and not p_allow_negative then
    raise exception 'Only % on hand', private.format_stock(v_product.on_hand, v_product.unit)
      using errcode = '22023';
  end if;
  if abs(v_after) >= 10000000000 then
    raise exception 'That quantity is too large' using errcode = '22023';
  end if;

  update public.products set on_hand = v_after where id = p_product_id;

  insert into public.stock_movements
    (salon_id, product_id, reason, delta, on_hand_after, note, checkout_id, checkout_item_id)
  values
    (v_product.salon_id, p_product_id, p_reason, v_after - v_product.on_hand, v_after,
     nullif(left(btrim(p_note), 200), ''), p_checkout_id, p_checkout_item_id)
  returning * into v_movement;

  if v_product.active
     and v_product.on_hand > v_product.reorder_point
     and v_after <= v_product.reorder_point
     and coalesce((select st.low_stock_alerts_enabled from public.settings st
                    where st.salon_id = v_product.salon_id), true)
  then
    for v_owner in
      select m.user_id from public.salon_members m
       where m.salon_id = v_product.salon_id and m.role = 'owner'
    loop
      perform private.enqueue_notification(
        v_product.salon_id, v_owner, 'low_stock', null,
        case when v_after <= 0 then 'Out of stock · ' else 'Low stock · ' end
          || left(concat_ws(' ', v_product.brand, v_product.name), 160),
        private.format_stock(greatest(v_after, 0), v_product.unit) || ' left (reorder at '
          || private.format_stock(v_product.reorder_point, v_product.unit)
          || '). Tap for your reorder list.',
        null,
        jsonb_build_object('type', 'low_stock', 'salonId', v_product.salon_id,
                           'productId', v_product.id),
        'low_stock:' || v_movement.id || ':' || v_owner);
    end loop;
  end if;

  return v_movement;
end;
$$;

revoke all on function private.format_stock(numeric, text) from public;
revoke all on function private.apply_stock_movement(uuid, public.stock_movement_reason, numeric,
  numeric, text, uuid, uuid, boolean) from public;

-- ---------------------------------------------------------------------------
-- App RPCs
-- ---------------------------------------------------------------------------

-- Adds (positive) or removes (negative) stock: receiving a delivery, a scan, breakage, using a
-- retail bottle at the backbar. Sales come from checkout; counts use count_stock.
create or replace function public.adjust_stock(
  p_product_id uuid,
  p_delta      numeric,
  p_reason     public.stock_movement_reason default 'adjust',
  p_note       text default null
)
returns public.stock_movements
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_salon_id uuid;
  v_movement public.stock_movements;
begin
  select salon_id into v_salon_id from public.products where id = p_product_id;
  if not found or not private.can_book_for_salon(v_salon_id) then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;
  if p_reason is null or p_reason in ('sale', 'count') then
    raise exception 'Sales come from checkout and counts from count_stock' using errcode = '22023';
  end if;
  if p_delta is null or p_delta = 0 or p_delta <> round(p_delta, 2) then
    raise exception 'Enter a quantity other than 0 (up to 2 decimals)' using errcode = '22023';
  end if;
  if p_reason in ('receive', 'return') and p_delta < 0 then
    raise exception 'Received and returned stock must be positive' using errcode = '22023';
  end if;
  if p_reason = 'use' and p_delta > 0 then
    raise exception 'Used stock must be negative' using errcode = '22023';
  end if;

  v_movement := private.apply_stock_movement(p_product_id, p_reason, p_delta, null, p_note);
  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (v_salon_id, auth.uid(), 'stock.' || p_reason, 'product', p_product_id::text,
          jsonb_build_object('delta', v_movement.delta, 'on_hand', v_movement.on_hand_after));
  return v_movement;
end;
$$;

-- A stock count: sets on_hand to what's on the shelf and records the difference.
create or replace function public.count_stock(
  p_product_id uuid,
  p_on_hand    numeric,
  p_note       text default null
)
returns public.stock_movements
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_salon_id uuid;
  v_movement public.stock_movements;
begin
  select salon_id into v_salon_id from public.products where id = p_product_id;
  if not found or not private.can_book_for_salon(v_salon_id) then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;
  if p_on_hand is null or p_on_hand < 0 or p_on_hand <> round(p_on_hand, 2) then
    raise exception 'Enter a count of 0 or more (up to 2 decimals)' using errcode = '22023';
  end if;

  v_movement := private.apply_stock_movement(p_product_id, 'count', 0, p_on_hand, p_note);
  insert into public.audit_log (salon_id, actor_user_id, action, entity_type, entity_id, details)
  values (v_salon_id, auth.uid(), 'stock.count', 'product', p_product_id::text,
          jsonb_build_object('delta', v_movement.delta, 'on_hand', v_movement.on_hand_after));
  return v_movement;
end;
$$;

revoke all on function public.adjust_stock(uuid, numeric, public.stock_movement_reason, text)
  from public, anon;
revoke all on function public.count_stock(uuid, numeric, text) from public, anon;
grant execute on function public.adjust_stock(uuid, numeric, public.stock_movement_reason, text)
  to authenticated, service_role;
grant execute on function public.count_stock(uuid, numeric, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Retail sales: paid checkouts decrement stock (lines whose source_id is a product)
-- ---------------------------------------------------------------------------

create or replace function private.checkout_paid_decrement_stock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select i.id, i.quantity, p.id as product_id
      from public.checkout_items i
      join public.products p on p.salon_id = i.salon_id and p.id = i.source_id
     where i.checkout_id = new.id and i.kind = 'retail'
     order by i.position
  loop
    if not exists (select 1 from public.stock_movements sm
                    where sm.checkout_item_id = r.id and sm.reason = 'sale') then
      -- Selling what was never counted is allowed; on_hand just goes negative.
      perform private.apply_stock_movement(r.product_id, 'sale', -r.quantity, null, null,
                                           new.id, r.id, true);
    end if;
  end loop;
  return null;
end;
$$;

revoke all on function private.checkout_paid_decrement_stock() from public;

create trigger checkouts_decrement_stock
  after update of status on public.checkouts
  for each row
  when (new.status = 'paid' and old.status is distinct from 'paid')
  execute function private.checkout_paid_decrement_stock();

-- ---------------------------------------------------------------------------
-- Reorder list (exported as CSV from the app)
-- ---------------------------------------------------------------------------

create view public.reorder_list
with (security_invoker = true) as
select p.id,
       p.salon_id,
       p.name,
       p.brand,
       p.category,
       p.sku,
       p.barcode,
       p.unit,
       p.on_hand,
       p.reorder_point,
       p.reorder_quantity,
       coalesce(p.reorder_quantity,
                greatest(ceil(p.reorder_point * 2 - p.on_hand), 1))::numeric(12, 2)
         as suggested_quantity,
       p.cost_cents,
       p.supplier
  from public.products p
 where p.active and p.on_hand <= p.reorder_point;

comment on view public.reorder_list is
  'Active products at or below their reorder point, with a suggested order quantity.';

revoke all on public.reorder_list from anon;
grant select on public.reorder_list to authenticated;
