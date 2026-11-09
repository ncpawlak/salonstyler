# Checkout and Tap to Pay (#11)

Checkout rings up an appointment at the chair: its service and add-ons, free-form retail or other lines, a tip, minus any deposit, then takes card (Tap to Pay on iPhone), cash or other. Open it from **Today → Checkout** or from an appointment's sheet.

| Table / function | Purpose |
|---|---|
| `checkouts` | One per appointment (or ad hoc): subtotal, tip, deposit, `amount_due_cents`, `status` (`open`/`paid`/`canceled`), `method`, `stripe_payment_intent_id`, and an unguessable `receipt_token`. Members read; written only through the RPCs below |
| `checkout_items` | Lines: `kind` `service`/`addon`/`retail`/`custom`, name, unit price, quantity. Retail lines are free-form until inventory (#17) lands |
| `start_checkout(appointment)` | Opens the checkout (idempotent) with the appointment's service and add-ons, and credits paid deposits |
| `update_checkout(...)` | Replaces lines and tip, then recomputes totals server-side |
| `pay_checkout_offline(...)` | Cash or other: marks it paid and the appointment completed |
| `get_receipt(token)` | Public receipt (granted to `anon`); the app serves it at `/receipt/<token>` |
| `payout_summary(salon, day)` | Today's takings by method, tips and refunds (Settings → Payments) |

Card payments go through the `checkout` Edge Function (JWT required, logic in `packages/payments/src/server/checkout.ts`). It creates `card_present` destination charges on behalf of the salon's connected account. Actions:

- `connection_token`: a Stripe Terminal token for the SDK. It creates a Terminal Location from the connected account's business address on first use, or uses `STRIPE_TERMINAL_LOCATION_ID` if set.
- `create_intent`: a PaymentIntent for the amount due, reused or replaced if the amount changed.
- `complete`: confirms with Stripe and marks the checkout paid. `stripe-webhook` does the same on `payment_intent.succeeded`, as a backstop if the app drops off.
- `simulate` (**test keys only**): charges the intent with Stripe's test card, which is the **test reader** used on web, Android, Expo Go and iOS builds without Tap to Pay.
- `refund` (owner): full or partial refund, shown on Settings → Payments.

Without `STRIPE_SECRET_KEY` card actions return `503 stripe_not_configured`, so cash and other still work. Serve the function locally with the env file from the Payments setup:

```bash
npx supabase functions serve --env-file supabase/functions/.env
```

A push at 8:00 PM salon time sends owners the day's takings (`payout_summary_enabled` in notification settings, on by default). It's skipped on days without checkouts.

App env (`apps/mobile/.env`):

| Name | Value |
|---|---|
| `EXPO_PUBLIC_WEB_URL` | Public origin for receipt links sent from native, e.g. `https://app.chairside.example`. Web uses its own origin |
| `EXPO_PUBLIC_TAP_TO_PAY` | `1` turns on real Tap to Pay in iOS dev/prod builds and adds the entitlement (see below). Leave unset until Apple grants it |

## Tap to Pay on iPhone (manual, on device)

Real Tap to Pay needs Apple's entitlement (#1), a custom build (not Expo Go) and a physical iPhone. Until then every build uses the test reader.

1. **Request the entitlement:** in the Apple Developer account, request *Tap to Pay on iPhone* (https://developer.apple.com/tap-to-pay/). Apple first grants a development entitlement, then reviews the app for distribution.
2. **Enable it on the App ID:** Certificates, Identifiers & Profiles → Identifiers → the app's bundle id → enable **Tap to Pay on iPhone**, then regenerate the provisioning profiles (EAS does this with `eas credentials`).
3. **Device:** iPhone XS or newer on the latest iOS, signed into iCloud, with a passcode. The salon's Stripe account must be in a [supported country](https://docs.stripe.com/terminal/payments/setup-reader/tap-to-pay?platform=ios) and have a business address (the Terminal Location uses it).
4. **Build:** `apps/mobile/app.config.ts` adds the Stripe Terminal config plugin when `@stripe/stripe-terminal-react-native` is installed (an optional dependency), and the `com.apple.developer.proximity-reader.payment.acceptance` entitlement only when `EXPO_PUBLIC_TAP_TO_PAY=1`. Build a dev client with it set, for example `EXPO_PUBLIC_TAP_TO_PAY=1 eas build --profile development --platform ios`.
5. **Test mode first:** with `sk_test_…` keys, take a checkout and tap a physical test card or a real card (test mode doesn't charge it). The first time, iOS shows Apple's Tap to Pay terms; the owner's Apple ID accepts them. Check the receipt and Settings → Payments, and try a refund.
6. **Live:** switch the function secrets to live keys (Payments step 10), build for production with `EXPO_PUBLIC_TAP_TO_PAY=1`, and submit. App Review checks Apple's Tap to Pay [marketing and UX guidelines](https://developer.apple.com/tap-to-pay/marketing-guidelines/).

If the SDK or the flag is missing, `features/checkout/terminal.native.tsx` falls back to the test reader, so a misconfigured build can't charge real cards from the simulator path (`simulate` refuses live keys).
