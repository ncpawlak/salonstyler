# Payments (Stripe Connect)

Each salon gets a **Stripe Connect Express** account (the platform is Chairside's Stripe account). Owners connect it in **Settings → Payments** (`apps/mobile/src/app/(app)/settings/payments.tsx`), which opens Stripe's hosted onboarding (business details, ID, bank account). Stripe pays out to the salon's bank; Chairside never handles bank details. See [`docs/PLAN.md` §9](../../docs/PLAN.md).

| Table | Purpose | Access (authenticated) |
|---|---|---|
| `stripe_accounts` | 1:1 per salon: `stripe_account_id` (`acct_…`), `details_submitted`, `charges_enabled`, `payouts_enabled`, `requirements_due`, `disabled_reason` | Members read; written **only** by the Edge Functions (service role) |
| `payments` | One row per Stripe PaymentIntent: amount/refunded (minor units), currency, `status` (`pending` … `refunded`), nullable `appointment_id` | Members read; written **only** by `stripe-webhook` (service role) |

`payments.appointment_id` optionally links a payment to an appointment in the same salon (composite FK; set to null if the appointment is deleted). The app shows **Payments enabled** when both `charges_enabled` and `payouts_enabled` are true.

Edge Functions (logic lives in `packages/payments` and is unit tested with a mocked Stripe client and signed fixture events):

- `payments` (JWT required). Actions: `status` (any member; re-syncs the account from Stripe), `onboard` (owner; creates the Express account once, idempotently, and returns a hosted onboarding link), `dashboard` (owner; Express dashboard login link). Without `STRIPE_SECRET_KEY` it returns `503 stripe_not_configured`, which the app shows as-is.
- `stripe-webhook` (`verify_jwt = false`; every request must carry a valid `Stripe-Signature`). Handles `account.updated`, `payment_intent.processing|succeeded|payment_failed|canceled` and `charge.refunded`; other events are acknowledged and ignored. Writes are idempotent upserts, and errors return 5xx so Stripe retries.

Secrets (function secrets, never committed or stored in the database):

| Name | Required | Value |
|---|---|---|
| `STRIPE_SECRET_KEY` | yes | Platform secret key, `sk_test_…` in test mode (a restricted key with Connect + PaymentIntents write also works) |
| `STRIPE_WEBHOOK_SECRET` | yes | Signing secret(s) of the webhook destination(s), `whsec_…`; comma-separate several |
| `PAYMENTS_RETURN_URL` | for native | `https://…` page Stripe returns to after onboarding on iOS/Android (Stripe requires http(s)). The web app sends its own URL. The app re-checks status when it comes back to the foreground |
| `STRIPE_CONNECT_COUNTRY` | no | Two-letter country for new accounts (default `US`) |

## Manual setup (test mode)

1. **Create a Stripe account** at https://dashboard.stripe.com/register and stay in **Test mode** (toggle top right).
2. **Enable Connect:** Dashboard → **Connect** → Get started. Choose **Platform or marketplace**, and pick **Express** accounts where the onboarding asks for the account type. Fill in the platform profile (Chairside, a salon booking app; card payments for salon services).
3. **Branding:** Settings → Connect → Branding: name, icon and color (shown on the hosted onboarding pages).
4. **API key:** Developers → API keys → reveal the **Secret key** (`sk_test_…`).
5. **Local secrets:** create `supabase/functions/.env` (git-ignored):
   ```bash
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_WEBHOOK_SECRET=whsec_...   # printed by `stripe listen` in step 6
   ```
   then `npx supabase functions serve --env-file supabase/functions/.env`.
6. **Forward webhooks locally** with the [Stripe CLI](https://docs.stripe.com/stripe-cli): `stripe login`, then
   ```bash
   stripe listen \
     --forward-to http://127.0.0.1:54321/functions/v1/stripe-webhook \
     --forward-connect-to http://127.0.0.1:54321/functions/v1/stripe-webhook
   ```
   Copy the `whsec_…` it prints into `STRIPE_WEBHOOK_SECRET` and restart `functions serve`. `--forward-connect-to` is what delivers the connected accounts' `account.updated` events. Try it with `stripe trigger payment_intent.succeeded`.
7. **Onboard in the app:** Settings → Payments → **Connect with Stripe**. In test mode use Stripe's test data: phone `000 000 0000`, SMS code `000-000`, SSN `000-00-0000`, address line `address_full_match`, routing `110000000`, account `000123456789`. After returning, the screen shows **Payments enabled** (it re-syncs from Stripe even if the webhook hasn't arrived).
8. **Hosted project:**
   ```bash
   npx supabase functions deploy payments
   npx supabase functions deploy stripe-webhook --no-verify-jwt
   npx supabase secrets set STRIPE_SECRET_KEY=sk_test_... PAYMENTS_RETURN_URL=https://...
   ```
9. **Register the webhook endpoint:** Developers → Webhooks → **Add destination**. Endpoint URL `https://<project-ref>.supabase.co/functions/v1/stripe-webhook`. Add **two** destinations with the same URL, one for **Your account** events and one for **Connected accounts** events, each with `account.updated`, `payment_intent.processing`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled` and `charge.refunded`. Each destination has its own signing secret; set both, comma-separated: `npx supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_connect...,whsec_platform...`.
10. **Going live** repeats steps 2–9 in live mode with `sk_live_…` and a live webhook secret.
