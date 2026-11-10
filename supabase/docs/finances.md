# Finances (#44)

**Settings → Finances** (`/finances`) is for a booth renter: what came in, what went out, and what's left. He can see profit after booth rent and expenses for any month, quarter, year or custom range (up to a year) and export it for his accountant. Owners only.

## What's on the screen

| Card | Source |
|---|---|
| Profit | `finance_report`: income − expenses |
| Export CSV / PDF | Built in the app from the same report plus the expense log (`apps/mobile/src/features/finances/export.ts`). CSV downloads on web and goes through the share sheet on iOS / Android. PDF is printable HTML: Print → Save as PDF on web, `expo-print` on device |
| Income | Services, retail, tips (plus other sales, kept deposits and refunds when non-zero), straight from `sales_report` (#43), so it reconciles with Reports and the payout summary |
| Expenses | Totals by category: booth rent, products, tools, education, other |
| Tax set-aside | Profit × the owner's percent (default 25%, 0–60). Also the current IRS estimated-tax period (Jan–Mar, Apr–May, Jun–Aug, Sep–Dec) with the amount set aside so far and the payment due date. Labelled **not tax advice** everywhere it appears, including the exports |
| Booth rent & recurring | Weekly or monthly schedules (`recurring_expenses`) |
| By month | Shown when the range spans more than one month |
| Expense log | Every expense in the range, newest first |

Pure helpers (categories, due dates, IRS periods, set-aside math) are in `packages/core/src/finances` (`@chairside/core/finances`). The client API is `@chairside/db/finances`.

## Tables

- **`expenses`**: `spent_on` (salon-local date), `category` (`expense_category`), `amount_cents`, `vendor`, `note`, `receipt_path`, and two optional links:
  - `stock_movement_id`: the inventory restock (#17) a product purchase paid for. It must be a `receive` movement in the same salon (`private.check_expense_restock`, `22023` otherwise). A restock can only be linked to one expense. The `restock_purchases` view lists restocks with their estimated cost (`cost_cents` × quantity) and the linked `expense_id`, which the expense form offers as choices.
  - `recurring_expense_id`: set by the database when a schedule posts the expense. Not writable by clients.
- **`recurring_expenses`**: booth rent or anything else on a `weekly` or `monthly` (`expense_frequency`) schedule from `starts_on`. Monthly dates past the end of a short month fall on its last day. `remind` / `remind_days_before` (0–7) control the push. `posted_through` is bookkeeping and not writable by clients.
- **`settings.tax_set_aside_percent`**: numeric(4,1), 0–60, default 25.

RLS: owners only (`private.has_salon_role(salon_id, 'owner')`) for select, insert, update and delete. Stylists and other salons see nothing.

## Posting recurring expenses

`private.post_recurring_expenses(now, id)` inserts an expense for each due date from the last posting (or `starts_on`, back at most 400 days) through today in the salon's time zone, once per date (`unique (recurring_expense_id, spent_on)`). It runs:

- right away when a schedule is created, re-activated, or its date or frequency changes, so booth rent since the start date shows up as soon as it's saved;
- every 15 minutes from the `finances-tick` cron job (`private.finances_tick()`).

Moving `starts_on` earlier backfills the new dates. Deleting a posted expense doesn't bring it back. Deleting a schedule keeps the expenses it posted.

## Reminders

`private.enqueue_expense_reminders(now)` (also in `finances_tick`) queues a push to each owner from 09:00 salon time, `remind_days_before` days before a due date: "Booth rent due tomorrow", "$900.00 to Studio Nine. It goes into your expenses on the day." It goes through `notifications_outbox` like every other push (#8), with kind `expense_due`, data `{ type: 'expense_due', salonId, recurringExpenseId, date }` and dedupe key `expense_due:<schedule>:<due date>:<user>`. Tapping it opens `/finances` (`packages/notifications/src/intent.ts`).

## `finance_report(salon, from, to)`

Returns one jsonb object for salon-local dates `from`–`to` (inclusive; default this month; at most 367 days). Owners only (`42501`). `22023` for a reversed or too-long range. Typed as `FinanceReport` in `@chairside/db/finances` (`getFinanceReport`).

- `income` comes from `private.sales_report` (#43): `servicesCents`, `retailCents`, `otherSalesCents`, `tipsCents`, `keptDepositsCents`, `refundedCents`, and `totalCents` = sales + tips + kept deposits − refunds.
- `expenses`: `totalCents`, `count`, `byCategory`.
- `profitCents` = income − expenses. `taxSetAsideCents` = profit × percent, and 0 on a loss.
- `months`: the same numbers for each calendar month the range touches, clipped to the range. The months add up to the total.

## Receipt photos

Photos go to the private `receipts` Storage bucket (10 MB, JPEG / PNG / WebP / HEIC / HEIF) at `<salon_id>/<uuid>.<ext>`. Only owners of that salon can read, upload or delete them. The app shows them through short-lived signed URLs. Deleting an expense deletes its photo.

Scanning a receipt in the expense form uploads the photo and, in parallel, calls the `ai` Edge Function with `{ action: 'read_receipt', salonId, image, today }` (owners only). The model only extracts the total, currency, store, date and a suggested category through a forced tool call (`packages/ai/src/finances/receipt.ts`). Totals become cents and future dates are dropped. The owner checks the filled-in form before saving, and nothing is saved by the AI. Usage is recorded with purpose `receipt`. Without an AI key it fails with `not_configured` and the photo is still attached. Local demo mode (`CHAIRSIDE_AI_DEMO=1`) returns a fixed sample receipt.

Recorded provider responses are in `packages/ai/fixtures/<provider>/finances_receipt_read.json` and replayed in `packages/ai/src/finances/receipt.test.ts`.

## Tests

`supabase/tests/database/27_finances.test.sql` covers access (owner, stylist, other salon), the restock link rules, receipt Storage policies, recurring posting (month-end clamp, leap years, weekly, backfill, idempotency), reminders (9am, once) and the report (income is Reports sales plus tips, profit after booth rent and expenses, set-aside, months clipped to the range, losses, the one-year limit).
