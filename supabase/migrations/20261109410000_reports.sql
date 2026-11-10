-- Reports dashboard (docs/PLAN.md §11b), issue #43: what a salon took and how busy it was over a
-- date range (salon time zone), for the Reports screen and Ask Chairside ("How did I do last
-- month?").
--
-- * public.sales_report(salon, from, to): one read-only jsonb with revenue (services vs retail),
--   tips, takings by method, refunds, kept deposits, average ticket, top services, a daily
--   series, new vs returning clients, no-shows / cancellations and the rebook rate (#42).
--
-- Money comes from paid checkouts (public.checkouts / checkout_items), the same rows the daily
-- payout summary adds up, so a month's report equals the sum of that month's payout summaries
-- and card takings equal the Stripe payments recorded for those checkouts. Retail is the
-- checkout's retail lines; inventory (#17) can add product detail later without changing this.
-- Utilization is computed in the app from work hours and appointments (packages/core), like the
-- calendar's rings and heatmap.

create or replace function private.sales_report(p_salon_id uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select (p_from::timestamp at time zone s.timezone) as from_at,
           ((p_to + 1)::timestamp at time zone s.timezone) as to_at,
           s.timezone as tz,
           coalesce(lower(st.currency), 'usd') as currency
      from public.salons s left join public.settings st on st.salon_id = s.id
     where s.id = p_salon_id
  ), paid as (
    select c.* from public.checkouts c, bounds b
     where c.salon_id = p_salon_id and c.status = 'paid'
       and c.paid_at >= b.from_at and c.paid_at < b.to_at
  ), items as (
    select i.* from public.checkout_items i join paid c on c.id = i.checkout_id
  ), refunds as (
    -- Same rule as the daily payout summary: refunds recorded on payments during the range.
    select coalesce(sum(p.amount_refunded_cents), 0)::bigint as cents
      from public.payments p, bounds b
     where p.salon_id = p_salon_id and p.amount_refunded_cents > 0
       and p.updated_at >= b.from_at and p.updated_at < b.to_at
  ), kept as (
    -- Deposits kept as a late-cancellation / no-show fee (#12); they never reach a checkout.
    select coalesce(sum(d.amount_cents - d.refunded_cents), 0)::bigint as cents,
           count(*)::integer as n
      from public.appointment_deposits d, bounds b
     where d.salon_id = p_salon_id and d.status = 'kept'
       and coalesce(d.resolved_at, d.updated_at) >= b.from_at
       and coalesce(d.resolved_at, d.updated_at) < b.to_at
  ), top_services as (
    select max(i.name) as name, sum(i.quantity)::integer as count,
           sum(i.amount_cents)::bigint as cents
      from items i
     where i.kind = 'service'
     group by coalesce(i.source_id::text, lower(btrim(i.name)))
  ), days as (
    select d::date as day
      from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
  ), daily as (
    select (c.paid_at at time zone b.tz)::date as day,
           sum(c.subtotal_cents)::bigint as sales,
           sum(c.tip_cents)::bigint as tips,
           count(*)::integer as n
      from paid c, bounds b
     group by 1
  ), appts as (
    select a.* from public.appointments a, bounds b
     where a.salon_id = p_salon_id
       and a.starts_at >= b.from_at and a.starts_at < b.to_at
       and a.status in ('confirmed', 'completed', 'no_show', 'cancelled')
  ), served as (
    select a.client_id from appts a where a.status = 'completed' and a.client_id is not null
    union
    select c.client_id from paid c where c.client_id is not null
  ), first_visit as (
    select s.client_id,
           least((select min(a.starts_at) from public.appointments a
                   where a.salon_id = p_salon_id and a.client_id = s.client_id
                     and a.status = 'completed'),
                 (select min(c.paid_at) from public.checkouts c
                   where c.salon_id = p_salon_id and c.client_id = s.client_id
                     and c.status = 'paid')) as first_at
      from served s
  ), sums as (
    select count(*)::integer as checkouts,
           coalesce(sum(subtotal_cents), 0)::bigint as sales,
           coalesce(sum(tip_cents), 0)::bigint as tips,
           coalesce(sum(deposit_cents), 0)::bigint as deposits,
           coalesce(sum(amount_due_cents), 0)::bigint as collected,
           coalesce(sum(amount_due_cents) filter (where method = 'card'), 0)::bigint as card,
           coalesce(sum(amount_due_cents) filter (where method = 'cash'), 0)::bigint as cash,
           coalesce(sum(amount_due_cents) filter (where method = 'other'), 0)::bigint as other
      from paid
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'timeZone', (select tz from bounds),
    'currency', coalesce((select max(currency) from paid), (select currency from bounds)),
    'checkouts', s.checkouts,
    'salesCents', s.sales,
    'servicesCents', (select coalesce(sum(amount_cents), 0)::bigint from items
                       where kind in ('service', 'addon')),
    'retailCents', (select coalesce(sum(amount_cents), 0)::bigint from items where kind = 'retail'),
    'otherSalesCents', (select coalesce(sum(amount_cents), 0)::bigint from items where kind = 'custom'),
    'retailItems', (select coalesce(sum(quantity), 0)::integer from items where kind = 'retail'),
    'tipsCents', s.tips,
    'depositsAppliedCents', s.deposits,
    'collectedCents', s.collected,
    'cardCents', s.card,
    'cashCents', s.cash,
    'otherCents', s.other,
    'refundedCents', (select cents from refunds),
    'keptDepositsCents', (select cents from kept),
    'keptDeposits', (select n from kept),
    'avgTicketCents', case when s.checkouts > 0 then round(s.sales::numeric / s.checkouts)::bigint end,
    'topServices', coalesce((
      select jsonb_agg(jsonb_build_object('name', t.name, 'count', t.count, 'cents', t.cents)
                       order by t.cents desc, t.count desc, t.name)
        from (select * from top_services order by cents desc, count desc, name limit 5) t), '[]'::jsonb),
    'daily', (
      select jsonb_agg(jsonb_build_object('date', d.day,
                                          'salesCents', coalesce(x.sales, 0),
                                          'tipsCents', coalesce(x.tips, 0),
                                          'checkouts', coalesce(x.n, 0))
                       order by d.day)
        from days d left join daily x on x.day = d.day),
    'clients', jsonb_build_object(
      'served', (select count(*)::integer from served),
      'new', (select count(*)::integer from first_visit f, bounds b where f.first_at >= b.from_at),
      'returning', (select count(*)::integer from first_visit f, bounds b where f.first_at < b.from_at)),
    'appointments', jsonb_build_object(
      'booked', (select count(*)::integer from appts),
      'completed', (select count(*)::integer from appts where status = 'completed'),
      'noShows', (select count(*)::integer from appts where status = 'no_show'),
      'cancelled', (select count(*)::integer from appts where status = 'cancelled'))
  )
  from sums s;
$$;

create or replace function public.sales_report(
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
  v_tz   text;
  v_to   date;
  v_from date;
begin
  if not private.is_salon_member(p_salon_id) then
    raise exception 'Not a member of this salon' using errcode = '42501';
  end if;
  select s.timezone into v_tz from public.salons s where s.id = p_salon_id;
  v_to   := coalesce(p_to, (now() at time zone v_tz)::date);
  v_from := coalesce(p_from, v_to - 29);
  if v_from > v_to then
    raise exception 'p_from must not be after p_to' using errcode = '22023';
  end if;
  if v_to - v_from > 366 then
    raise exception 'Reports cover at most a year' using errcode = '22023';
  end if;
  return private.sales_report(p_salon_id, v_from, v_to)
         || jsonb_build_object('rebook', public.rebook_stats(p_salon_id, v_from, v_to));
end;
$$;

comment on function public.sales_report is
  'Revenue (services vs retail), tips, takings, top services, clients, no-shows and rebook rate for a salon-local date range.';

revoke all on function private.sales_report(uuid, date, date) from public;
revoke all on function public.sales_report(uuid, date, date) from public, anon;
grant execute on function public.sales_report(uuid, date, date) to authenticated, service_role;
