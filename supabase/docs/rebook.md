# Rebook at checkout (#42)

After a checkout is paid, the **Paid** screen suggests the client's next visit and books it in one tap. A booked or held rebook offers a prefilled text or email confirmation sent from the stylist's own phone or mail.

## How the suggestion works

All logic is in `packages/core/src/rebook` (`@chairside/core/rebook`), which uses the availability engine (`findSlots`).

1. **Interval.** Each service on the visit gets an interval, in this order:
   1. The client's own rhythm: the median gap between their last few completed visits that included the service (7 to 365 days).
   2. The owner's setting, `services.rebook_interval_days` (**Services → a service → Rebook every**).
   3. A typical interval for that kind of service, such as 3 weeks for a men's cut or 12 weeks for balayage. Consultations and special-occasion styles return none.

   The visit follows the longest of these, so a color and cut comes back on the color's rhythm. With nothing known it uses 6 weeks.
2. **Target date.** The interval is added to the visit date. Intervals of 2 weeks or more round to whole weeks, so the suggestion lands on the same weekday.
3. **Slots.** `findSlots` searches ±3 days around the target and prefers times within an hour of the visit's start. The card shows up to three spread across days, preferring the client's usual time. If the target week is full, it tries up to three later weeks. Lead time and the booking window don't apply, because the stylist is booking on the client's behalf.

The card is hidden for walk-ins without a client. If the client already has an upcoming visit, it shows that visit instead.

## Database

| Column / function | Purpose |
|---|---|
| `services.rebook_interval_days` | Optional owner setting, 1 to 365 days. Null means automatic |
| `checkouts.rebook_appointment_id` | The appointment booked from this checkout. Unique; set to null if that appointment is deleted |
| `checkouts.rebook_declined_at` | When the stylist tapped **Not now** |
| `rebook_from_checkout(checkout, segments, services, status, price)` | Books through `book_appointment` (same conflict checks; `23P01` on overlap) for the same stylist and client as `held` or `confirmed`, then links it to the checkout. The checkout must be paid and have a client. Fails if an active rebook already exists. Audited as `checkout.rebooked` |
| `skip_rebook(checkout)` | Records the decline on a paid checkout |
| `rebook_stats(salon, from, to)` | `{from, to, checkouts, rebooked, declined, rate}` for paid client checkouts in the date range (salon time zone, default last 30 days). Rebooks later cancelled or marked no-show don't count. Members only |

App helpers are in `@chairside/db/rebook`. The app code is in `apps/mobile/src/features/rebook`. pgTAP tests are in `supabase/tests/database/19_rebook.test.sql`.
