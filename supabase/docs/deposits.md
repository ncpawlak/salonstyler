# Deposits and cancellation policy (#12)

Deposits are **optional and off by default**. Normal payment still happens after the service, at checkout ([checkout.md](checkout.md)), and a paid deposit is taken off that bill automatically.

Migration: `migrations/20261109340000_deposits.sql`. Tests: `tests/database/20_deposits.test.sql`. Edge Function: `functions/deposits`. Shared logic: `@chairside/core/deposits`, `@chairside/db/deposits`, and `@chairside/payments/server` (`handleDepositsRequest`, `refundDeposit`).

## When a deposit is asked for

All of these must be true. Otherwise booking works exactly as before.

- **Settings → Deposits & cancellations → Ask for deposits** is on (`settings.deposits_enabled`, owner only).
- A booked service has a deposit: `services.deposit_kind` is `flat` (`deposit_value` in cents) or `percent` (`deposit_value` 1–100 of the service price). Set it in the service editor under **Deposit**.
- The total is at least 0.50, Stripe's card minimum.
- The salon's Stripe account has `charges_enabled` ([payments.md](payments.md)).

## Lifecycle

```
public page /b/<slug> ── book_public_appointment ──▶ appointment `held` 45 min + deposit `pending`
text request ── stylist approves ──▶ appointment `held` (settings.hold_expiry_hours) + deposit `pending`
client pays at /pay/<token> (Stripe Checkout, card saved)
  ──▶ mark_deposit_paid (deposits fn `status`, or stripe-webhook checkout.session.completed)
  ──▶ deposit `paid`, appointment → `confirmed` (or `requested` when the salon reviews bookings)
checkout ──▶ the deposit's payments row (appointment_id) is credited against the bill
```

- The public booking response has `booking.status = 'held'` and `booking.deposit { amountCents, currency, payToken, holdExpiresAt }`. The booking page sends the client to `/pay/<payToken>`.
- No "new booking" notification goes out until the deposit is paid.
- If the hold expires unpaid, the slot is released and the deposit is `canceled`. A payment that lands after the release becomes `refund_due`.
- In the appointment sheet the salon sees the deposit status, can **Text pay link** for a pending deposit, and can **Refund** a `refund_due` one. Confirming a held appointment manually waives the deposit; it stays `pending`.

| Status | Meaning |
| --- | --- |
| `pending` | Waiting for the client to pay. |
| `paid` | Paid. Credited at checkout. |
| `refund_due` | Must be refunded. The app refunds right away; if Stripe fails the sheet offers **Refund** again. |
| `refunded` | Refunded through Stripe (`refunded_cents`). |
| `kept` | Kept as the cancellation / no-show fee. |
| `canceled` | Never paid, and the appointment was cancelled or the hold lapsed. |

## Cancellation policy

Cancellation is free until `settings.cancellation_window_hours` (default 24, 0–336) before the start.

| What happened | Paid deposit |
| --- | --- |
| Client cancels before the window | `refund_due` → refunded |
| Client cancels inside the window | `kept` |
| No-show | `kept` (undoing the no-show puts it back to `paid`) |
| Salon cancels (plain status change) or declines | `refund_due` → refunded |
| Salon cancels from the sheet | Salon chooses **Cancel & refund** or **Cancel & keep deposit**; the sheet shows what the policy says |

Charging a no-show fee beyond the deposit is a follow-up. The card is saved on the Stripe customer (`stripe_customer_id`, `stripe_payment_method_id`) for it.

## Reusable entry points (for the client manage link, #10)

- `public.cancellation_quote(appointment_id)` → `{ freeUntil, late, depositStatus, depositCents, outcome: 'free' | 'refund' | 'keep', … }`. TS: `getCancellationQuote` in `@chairside/db/deposits`. Pure version: `cancellationOutcome` in `@chairside/core/deposits`.
- `public.cancel_appointment_with_policy(appointment_id, reason?, deposit?)` cancels and settles the deposit by the policy. Members may override with `deposit => 'refund' | 'keep'`; service-role callers always get the policy. TS: `cancelAppointmentWithPolicy`.
- A `refund_due` deposit is refunded through Stripe by the `deposits` Edge Function, `{ action: 'refund', depositId }`, called with a member JWT or the service-role key, or directly with `refundDeposit` from `@chairside/payments/server`.

So the #10 flow is: show the quote, call `cancel_appointment_with_policy` as the service role, then refund if `deposit.status = 'refund_due'`.

## `functions/deposits`

`verify_jwt = false`. The pay token is the credential for the public actions.

| Action | Who | Does |
| --- | --- | --- |
| `page { token }` | anyone | Pay page data + `stripeReady` |
| `start { token, returnUrl }` | anyone | Creates a Stripe Checkout Session on the connected account and returns its `url` |
| `status { token }` | anyone | Asks Stripe about the session and marks the deposit paid if it is, so the page doesn't wait for the webhook |
| `refund { depositId, amountCents? }` | salon member or service role | Refunds a paid / `refund_due` deposit |

Environment:

- `STRIPE_SECRET_KEY`: without it the pay page says the salon can't take card payments online.
- `PUBLIC_WEB_URL` (optional): when set, Checkout may only return to this origin.
- The `stripe-webhook` function records `checkout.session.completed` for deposits. Subscribe the Connect webhook to that event.

## Testing with Stripe test mode

1. Set `STRIPE_SECRET_KEY=sk_test_…` and `STRIPE_WEBHOOK_SECRET` in `supabase/functions/.env` (never commit them), then serve the functions.
2. Settings → Payments: finish Stripe test onboarding so the account shows charges enabled.
3. Settings → Deposits & cancellations: turn on **Ask for deposits** and set the window, e.g. 24 hours.
4. Services → pick a service → **Deposit**: Amount $20, then **Save deposit**.
5. Open `/b/<slug>`, book that service, and check you land on `/pay/<token>` showing "Pay $20.00 to book".
6. Pay with `4242 4242 4242 4242`, any future date and CVC. On return the page says "You're booked" and the appointment is confirmed in the calendar.
7. In the Stripe dashboard (connected account) the payment shows with `metadata.purpose = deposit`.
8. Check out the appointment. The $20 deposit is taken off the amount due.
9. Book again and pay, then cancel from the appointment sheet more than 24 h ahead. It offers **Cancel & refund**, and the Stripe payment shows refunded.
10. Book within 24 h, pay, then cancel. The sheet says it's a late cancellation; **Cancel & keep deposit** marks it `kept`.
11. Webhook path: `stripe listen --forward-connect-to http://127.0.0.1:54321/functions/v1/stripe-webhook`, pay, and close the tab before returning. The deposit still becomes `paid`.
12. Turn deposits off and book again: no pay page, booking is unchanged.
