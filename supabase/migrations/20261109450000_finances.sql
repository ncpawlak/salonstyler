-- Booth-renter finances (docs/PLAN.md §11b), issue #44: booth rent, expenses, tips, a quarterly
-- estimated-tax helper and an export for the accountant. Owners only: it's his business, not
-- the salon's shared data.
--
-- * public.recurring_expenses: booth rent (weekly / monthly) and anything else that repeats. On
--   each due date a cron tick posts one row into public.expenses (backfilling from starts_on the
--   first time, at most ~13 months), and owners get a push N days before (kind expense_due).
-- * public.expenses: dated expenses by category (booth_rent, products, tools, education,
--   other) with an optional receipt photo (private `receipts` bucket, `{salon_id}/{file}`) and an
--   optional link to the inventory restock (#17 stock_movements, reason receive) it paid for.
--   Amount / vendor / date can be read off the receipt photo by the `ai` Edge Function
--   (action read_receipt); the model only extracts, the owner confirms before saving.
-- * public.finance_report(salon, from, to): income straight from private.sales_report (#43:
--   services + retail + other + tips + kept deposits - refunds, the same money the Reports
--   screen shows), expenses by category, profit, and a set-aside at settings.tax_set_aside_percent
--   (a rough savings rule, not tax advice), in total and per month.

-- ---------------------------------------------------------------------------
-- Settings + notification kind
-- ---------------------------------------------------------------------------

alter type public.notification_kind add value if not exists 'expense_due';

alter table public.settings
  add column tax_set_aside_percent numeric(4, 1) not null default 25
    check (tax_set_aside_percent between 0 and 60);

comment on column public.settings.tax_set_aside_percent is
  'Share of profit the finances screen suggests setting aside for estimated taxes. Not tax advice.';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create type public.expense_category as enum ('booth_rent', 'products', 'tools', 'education', 'other');
create type public.expense_frequency as enum ('weekly', 'monthly');

create table public.recurring_expenses (
  id                 uuid primary key default gen_random_uuid(),
  salon_id           uuid not null references public.salons (id) on delete cascade,
  category           public.expense_category not null default 'booth_rent',
  label              text not null default 'Booth rent'
                       check (char_length(btrim(label)) between 1 and 80),
  -- Who gets paid (the salon owner he rents from).
  vendor             text check (vendor is null or char_length(btrim(vendor)) between 1 and 120),
  amount_cents       integer not null check (amount_cents between 1 and 10000000),
  frequency          public.expense_frequency not null default 'monthly',
  -- First due date. Weekly: every 7 days from it. Monthly: the same day each month (the last
  -- day in shorter months).
  starts_on          date not null,
  remind             boolean not null default true,
  remind_days_before integer not null default 1 check (remind_days_before between 0 and 7),
  active             boolean not null default true,
  -- Due dates up to here have been posted to expenses (salon-local). Maintained by the tick.
  posted_through     date,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint recurring_expenses_salon_id_id_key unique (salon_id, id)
);

comment on table public.recurring_expenses is
  'Booth rent and other repeating expenses; posted into expenses on each due date, with a reminder push.';

create index recurring_expenses_salon_idx on public.recurring_expenses (salon_id);

create table public.expenses (
  id                   uuid primary key default gen_random_uuid(),
  salon_id             uuid not null references public.salons (id) on delete cascade,
  -- Salon-local day it was paid.
  spent_on             date not null,
  category             public.expense_category not null,
  amount_cents         integer not null check (amount_cents between 1 and 10000000),
  vendor               text check (vendor is null or char_length(btrim(vendor)) between 1 and 120),
  note                 text check (note is null or char_length(note) <= 500),
  -- Object name in the `receipts` bucket: `{salon_id}/{file}`.
  receipt_path         text check (receipt_path is null or (
                         starts_with(receipt_path, salon_id::text || '/')
                         and receipt_path !~ '\.\.'
                         and char_length(receipt_path) <= 200)),
  -- The inventory restock (stock_movements, reason receive) this purchase paid for.
  stock_movement_id    uuid unique references public.stock_movements (id) on delete set null,
  -- Set when the tick posted it from a recurring expense.
  recurring_expense_id uuid,
  created_by           uuid default auth.uid() references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint expenses_recurring_fkey foreign key (salon_id, recurring_expense_id)
    references public.recurring_expenses (salon_id, id) on delete set null (recurring_expense_id),
  constraint expenses_recurring_due_key unique (recurring_expense_id, spent_on)
);

comment on table public.expenses is
  'Business expenses for the finances screen (booth rent, product purchases, tools, education, other).';

create index expenses_salon_day_idx on public.expenses (salon_id, spent_on desc);

create trigger recurring_expenses_set_updated_at
  before update on public.recurring_expenses
  for each row execute function private.set_updated_at();
create trigger expenses_set_updated_at
  before update on public.expenses
  for each row execute function private.set_updated_at();

-- A linked restock must be a receive movement in the same salon.
create or replace function private.check_expense_restock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.stock_movement_id is not null and not exists (
       select 1 from public.stock_movements sm
        where sm.id = new.stock_movement_id and sm.salon_id = new.salon_id
          and sm.reason = 'receive') then
    raise exception 'Link a restock (received stock) from this salon' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.check_expense_restock() from public;

create trigger expenses_check_restock
  before insert or update of stock_movement_id, salon_id on public.expenses
  for each row execute function private.check_expense_restock();

-- ---------------------------------------------------------------------------
-- Access: owners only
-- ---------------------------------------------------------------------------

alter table public.recurring_expenses enable row level security;
alter table public.expenses           enable row level security;

revoke all on public.recurring_expenses, public.expenses from anon;
revoke insert, update, delete, truncate on public.recurring_expenses, public.expenses
  from authenticated;
grant insert (salon_id, category, label, vendor, amount_cents, frequency, starts_on, remind,
              remind_days_before, active)
  on public.recurring_expenses to authenticated;
grant update (category, label, vendor, amount_cents, frequency, starts_on, remind,
              remind_days_before, active)
  on public.recurring_expenses to authenticated;
grant delete on public.recurring_expenses to authenticated;
grant insert (salon_id, spent_on, category, amount_cents, vendor, note, receipt_path,
              stock_movement_id)
  on public.expenses to authenticated;
grant update (spent_on, category, amount_cents, vendor, note, receipt_path, stock_movement_id)
  on public.expenses to authenticated;
grant delete on public.expenses to authenticated;

create policy "owners manage recurring expenses" on public.recurring_expenses
  for all to authenticated
  using (private.has_salon_role(salon_id, 'owner'))
  with check (private.has_salon_role(salon_id, 'owner'));
create policy "owners manage expenses" on public.expenses
  for all to authenticated
  using (private.has_salon_role(salon_id, 'owner'))
  with check (private.has_salon_role(salon_id, 'owner'));

-- ---------------------------------------------------------------------------
-- Receipt photos (private `receipts` bucket)
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The salon that owns a `receipts` object (its first folder), or null for anything else.
create or replace function private.receipt_salon_id(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when p_name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[^/]+$'
    then split_part(p_name, '/', 1)::uuid
  end;
$$;

revoke all on function private.receipt_salon_id(text) from public;
grant execute on function private.receipt_salon_id(text) to authenticated, service_role;

create policy "owners can read receipts" on storage.objects
  for select to authenticated
  using (bucket_id = 'receipts'
         and private.has_salon_role(private.receipt_salon_id(name), 'owner'));
create policy "owners can upload receipts" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'receipts'
              and private.has_salon_role(private.receipt_salon_id(name), 'owner'));
create policy "owners can delete receipts" on storage.objects
  for delete to authenticated
  using (bucket_id = 'receipts'
         and private.has_salon_role(private.receipt_salon_id(name), 'owner'));

-- ---------------------------------------------------------------------------
-- Restocks an expense can link to
-- ---------------------------------------------------------------------------

create view public.restock_purchases
with (security_invoker = true) as
select sm.id,
       sm.salon_id,
       sm.product_id,
       sm.delta as quantity,
       sm.note,
       sm.created_at,
       p.name,
       p.brand,
       p.unit,
       p.supplier,
       p.cost_cents,
       case when p.cost_cents is not null then round(p.cost_cents * sm.delta)::bigint end
         as estimated_cents,
       e.id as expense_id
  from public.stock_movements sm
  join public.products p on p.id = sm.product_id
  left join public.expenses e on e.stock_movement_id = sm.id
 where sm.reason = 'receive';

comment on view public.restock_purchases is
  'Received stock (inventory restocks), with an estimated cost and the expense that paid for it, if any.';

revoke all on public.restock_purchases from anon;
grant select on public.restock_purchases to authenticated;

-- ---------------------------------------------------------------------------
-- Due dates, posting and reminders
-- ---------------------------------------------------------------------------

-- Due dates of a schedule between p_from and p_to (inclusive), in order.
create or replace function private.expense_due_dates(
  p_frequency public.expense_frequency,
  p_starts_on date,
  p_from      date,
  p_to        date
)
returns setof date
language sql
immutable
set search_path = ''
as $$
  select due from (
    select d::date as due
      from generate_series(
             p_starts_on::timestamp
               + ((greatest(p_from - p_starts_on, 0) + 6) / 7) * interval '7 days',
             p_to::timestamp, interval '7 days') d
     where p_frequency = 'weekly'
    union all
    select (m + (least(extract(day from p_starts_on)::integer,
                       extract(day from m + interval '1 month - 1 day')::integer) - 1)
                * interval '1 day')::date
      from generate_series(date_trunc('month', greatest(p_from, p_starts_on)::timestamp),
                           p_to::timestamp, interval '1 month') m
     where p_frequency = 'monthly'
  ) x
  where due >= p_starts_on and due between p_from and p_to
  order by due;
$$;

revoke all on function private.expense_due_dates(public.expense_frequency, date, date, date)
  from public;
grant execute on function private.expense_due_dates(public.expense_frequency, date, date, date)
  to authenticated, service_role;

-- Posts every due date up to today (salon-local) that hasn't been posted yet, for all active
-- recurring expenses or just one. Backfills at most 400 days. Idempotent.
create or replace function private.post_recurring_expenses(
  p_now          timestamptz default now(),
  p_recurring_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r       record;
  v_today date;
  v_from  date;
  v_rows  integer;
  v_count integer := 0;
begin
  for r in
    select re.*, s.timezone
      from public.recurring_expenses re
      join public.salons s on s.id = re.salon_id
     where re.active and (p_recurring_id is null or re.id = p_recurring_id)
       for update of re
  loop
    v_today := (p_now at time zone r.timezone)::date;
    if r.posted_through is not null and r.posted_through >= v_today then
      continue;
    end if;
    v_from := greatest(r.starts_on, coalesce(r.posted_through + 1, r.starts_on), v_today - 400);
    if v_from <= v_today then
      insert into public.expenses
        (salon_id, spent_on, category, amount_cents, vendor, note, recurring_expense_id, created_by)
      select r.salon_id, d, r.category, r.amount_cents, r.vendor, r.label, r.id, null
        from private.expense_due_dates(r.frequency, r.starts_on, v_from, v_today) d
      on conflict (recurring_expense_id, spent_on) do nothing;
      get diagnostics v_rows = row_count;
      v_count := v_count + v_rows;
    end if;
    update public.recurring_expenses set posted_through = v_today where id = r.id;
  end loop;
  return v_count;
end;
$$;

revoke all on function private.post_recurring_expenses(timestamptz, uuid) from public;

-- Moving the start earlier backfills from the new start (rows already posted are kept).
create or replace function private.recurring_expense_reschedule()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.starts_on < old.starts_on and new.posted_through is not null then
    new.posted_through := least(new.posted_through, new.starts_on - 1);
  end if;
  return new;
end;
$$;

-- Saving a schedule posts what's already due, so the finances screen is right straight away.
create or replace function private.recurring_expense_post_now()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.post_recurring_expenses(now(), new.id);
  return null;
end;
$$;

revoke all on function private.recurring_expense_reschedule() from public;
revoke all on function private.recurring_expense_post_now() from public;

create trigger recurring_expenses_reschedule
  before update of starts_on on public.recurring_expenses
  for each row execute function private.recurring_expense_reschedule();
create trigger recurring_expenses_post_now
  after insert or update of starts_on, frequency, active on public.recurring_expenses
  for each row when (new.active)
  execute function private.recurring_expense_post_now();

-- Pushes owners remind_days_before a due date, from 9am salon time (so a missed tick still sends
-- it that day). plpgsql so the expense_due enum value is only resolved at run time.
create or replace function private.enqueue_expense_reminders(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r       record;
  v_today date;
  v_due   date;
  v_count integer := 0;
begin
  for r in
    select re.*, s.timezone, m.user_id, coalesce(lower(st.currency), 'usd') as currency
      from public.recurring_expenses re
      join public.salons s on s.id = re.salon_id
      join public.salon_members m on m.salon_id = re.salon_id and m.role = 'owner'
      left join public.settings st on st.salon_id = re.salon_id
     where re.active and re.remind
       and (p_now at time zone s.timezone)::time >= time '09:00'
  loop
    v_today := (p_now at time zone r.timezone)::date;
    v_due := v_today + r.remind_days_before;
    if not exists (select 1 from private.expense_due_dates(r.frequency, r.starts_on, v_due, v_due)) then
      continue;
    end if;
    if private.enqueue_notification(
         r.salon_id, r.user_id, 'expense_due', null,
         btrim(r.label) || ' due ' || case r.remind_days_before
           when 0 then 'today'
           when 1 then 'tomorrow'
           else to_char(v_due, 'FMDay, Mon FMDD') end,
         private.format_money(r.amount_cents, r.currency)
           || coalesce(' to ' || btrim(r.vendor), '')
           || '. It goes into your expenses on the day.',
         null,
         jsonb_build_object('type', 'expense_due', 'salonId', r.salon_id,
                            'recurringExpenseId', r.id, 'date', v_due),
         'expense_due:' || r.id || ':' || v_due || ':' || r.user_id) is not null then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

create or replace function private.finances_tick(p_now timestamptz default now())
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.post_recurring_expenses(p_now);
  if private.enqueue_expense_reminders(p_now) > 0 then
    perform private.dispatch_notifications();
  end if;
end;
$$;

revoke all on function private.enqueue_expense_reminders(timestamptz) from public;
revoke all on function private.finances_tick(timestamptz) from public;

select cron.schedule('finances-tick', '*/15 * * * *', 'select private.finances_tick()');

-- ---------------------------------------------------------------------------
-- Finance report
-- ---------------------------------------------------------------------------

-- Income (from the Reports RPC), expenses, profit and the tax set-aside for one date range.
create or replace function private.finance_period(
  p_salon_id uuid,
  p_from     date,
  p_to       date,
  p_percent  numeric
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with sales as (
    select private.sales_report(p_salon_id, p_from, p_to) as r
  ), income as (
    select (r ->> 'servicesCents')::bigint as services,
           (r ->> 'retailCents')::bigint as retail,
           (r ->> 'otherSalesCents')::bigint as other,
           (r ->> 'tipsCents')::bigint as tips,
           (r ->> 'keptDepositsCents')::bigint as kept,
           (r ->> 'refundedCents')::bigint as refunded,
           (r ->> 'salesCents')::bigint + (r ->> 'tipsCents')::bigint
             + (r ->> 'keptDepositsCents')::bigint - (r ->> 'refundedCents')::bigint as total,
           r ->> 'currency' as currency
      from sales
  ), spent as (
    select e.category, sum(e.amount_cents)::bigint as cents, count(*)::integer as n
      from public.expenses e
     where e.salon_id = p_salon_id and e.spent_on between p_from and p_to
     group by e.category
  ), totals as (
    select coalesce(sum(cents), 0)::bigint as cents, coalesce(sum(n), 0)::integer as n from spent
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'currency', i.currency,
    'income', jsonb_build_object(
      'servicesCents', i.services,
      'retailCents', i.retail,
      'otherSalesCents', i.other,
      'tipsCents', i.tips,
      'keptDepositsCents', i.kept,
      'refundedCents', i.refunded,
      'totalCents', i.total),
    'expenses', jsonb_build_object(
      'totalCents', t.cents,
      'count', t.n,
      'byCategory', (select jsonb_object_agg(c::text, coalesce(s.cents, 0))
                       from unnest(enum_range(null::public.expense_category)) c
                       left join spent s on s.category = c)),
    'profitCents', i.total - t.cents,
    'taxSetAsideCents', round(greatest(i.total - t.cents, 0) * p_percent / 100)::bigint
  )
  from income i, totals t;
$$;

create or replace function public.finance_report(
  p_salon_id uuid,
  p_from     date default null,
  p_to       date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz      text;
  v_to      date;
  v_from    date;
  v_percent numeric;
  v_months  jsonb;
begin
  if not private.has_salon_role(p_salon_id, 'owner') then
    raise exception 'Only the salon owner can see finances' using errcode = '42501';
  end if;
  select s.timezone, coalesce(st.tax_set_aside_percent, 25)
    into v_tz, v_percent
    from public.salons s left join public.settings st on st.salon_id = s.id
   where s.id = p_salon_id;
  v_to   := coalesce(p_to, (now() at time zone v_tz)::date);
  v_from := coalesce(p_from, date_trunc('month', v_to)::date);
  if v_from > v_to then
    raise exception 'p_from must not be after p_to' using errcode = '22023';
  end if;
  if v_to - v_from > 366 then
    raise exception 'Reports cover at most a year' using errcode = '22023';
  end if;

  select jsonb_agg(
           private.finance_period(p_salon_id, greatest(m::date, v_from),
                                  least((m + interval '1 month - 1 day')::date, v_to), v_percent)
             || jsonb_build_object('month', to_char(m, 'YYYY-MM'))
           order by m)
    into v_months
    from generate_series(date_trunc('month', v_from::timestamp), v_to::timestamp,
                         interval '1 month') m;

  return private.finance_period(p_salon_id, v_from, v_to, v_percent)
         || jsonb_build_object('timeZone', v_tz,
                               'taxSetAsidePercent', v_percent,
                               'months', coalesce(v_months, '[]'::jsonb));
end;
$$;

comment on function public.finance_report is
  'Income (services, retail, tips from sales_report), expenses by category, profit and tax set-aside for a salon-local date range, in total and per month. Owners only.';

revoke all on function private.finance_period(uuid, date, date, numeric) from public;
revoke all on function public.finance_report(uuid, date, date) from public, anon;
grant execute on function public.finance_report(uuid, date, date) to authenticated, service_role;
