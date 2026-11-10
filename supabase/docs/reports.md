# Reports (#43)

**Settings → Reports** (`/reports`) shows how the salon did over a week, month, quarter, year or a custom range of up to a year. Ask Chairside answers "How did I do last month?" from the same numbers.

## What's on the screen

| Card | Source |
|---|---|
| Revenue, tips, avg ticket, checkouts | `sales_report`, each compared with the previous period (the previous week / month / quarter / year, or the same number of days before a custom range) |
| Revenue chart and split | Daily sales with tips stacked on top, bucketed by day (≤ 31 days), week (≤ 98 days) or month. Then services (service and add-on lines), retail lines and other (custom lines) |
| Utilization | Computed in the app by the calendar's engine (`rangeUtilization` in `@chairside/core`) from work hours and appointments, up to today. Bars use the calendar heatmap tints. Ranges over 62 days are computed in chunks |
| Top services | The five service lines with the most revenue |
| Clients | New vs returning clients served, and the rebook rate from `rebook_stats` (#42) |
| Appointments | Appointments starting in the range: booked (confirmed, completed, no-show or cancelled), completed, no-shows, cancellations |
| Takings | Card / cash / other collected at checkout, deposits applied, kept deposits, refunds |

Range helpers (presets, comparison periods, chunking, bucketing) are in `packages/core/src/reports` (`@chairside/core/reports`). The app code is in `apps/mobile/src/features/reports`.

## `sales_report(salon, from, to)`

Returns one jsonb object for salon-local dates `from`–`to` (inclusive; default the last 30 days; at most 367 days, so any calendar year fits). Salon members only (`42501` otherwise). `22023` for a reversed or too-long range. Typed as `SalesReport` in `@chairside/db/reports` (`getSalesReport`).

Money rules match the daily payout summary (`payout_summary`), so a report reconciles with payments:

- **Sales** are paid checkouts by the day they were paid (`paid_at` in the salon time zone), counted before tip: `salesCents = servicesCents + retailCents + otherSalesCents`, the checkouts' subtotals.
- **Collected** is what was taken at checkout (`amount_due`), split by method. `salesCents + tipsCents = collectedCents + depositsAppliedCents`, because deposits paid earlier are credited against the checkout.
- **Card** takings equal the Stripe `payments` recorded for those checkouts.
- **Refunded** is refunds recorded on `payments` during the range, as in the payout summary.
- **Kept deposits** are no-show / late-cancellation deposits kept (#12) and resolved in the range. They are not part of sales.
- **Retail** is whatever was rung up as retail lines at checkout. It doesn't depend on inventory (#17).
- A client is **new** if their first completed visit or paid checkout ever falls in the range, and **returning** otherwise.

A month's report equals the sum of that month's daily payout summaries. `supabase/tests/database/24_reports.test.sql` checks this, along with card takings vs `payments`, deposits, the time zone month boundary and access.

## Ask Chairside

The `get_sales_report` tool (`packages/ai/src/assistant/tools/get-sales-report.ts`) takes a named period (`last_month`, `this_quarter`, …), resolved against today in the salon's time zone, or explicit `from`/`to` dates. It returns formatted amounts for the model to summarize.
