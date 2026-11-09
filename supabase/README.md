# Supabase (backend)

Multi-tenant Postgres for Chairside. Every tenant row carries `salon_id`, and RLS scopes access by `salon_members` (see [`docs/PLAN.md` §13](../docs/PLAN.md#13-data-model-all-rows-carry-salon_id-rls-by-membership)).

## Local development

Requires Docker (or Podman with its Docker-compatible socket).

```bash
npx supabase start          # Postgres, Auth, REST, Mailpit; applies migrations + seed.sql
npx supabase status         # URLs and keys (copy into .env, see ../.env.example)
npx supabase db reset       # rebuild the DB from migrations + seed
npx supabase test db        # pgTAP tests in supabase/tests/database
npx supabase db lint        # plpgsql/schema lint
npx supabase stop
```

Local sign-in emails (magic link + 6-digit code) land in **Mailpit**: http://127.0.0.1:54324.

Quick end-to-end check of the first-run flow (sign in → create salon → list salons, plus cross-salon isolation over REST):

```bash
npm install   # from the repo root (npm workspaces)
SUPABASE_ANON_KEY=<publishable/anon key from `npx supabase status`> npm run smoke --workspace @chairside/db
```

## Schema (foundation)

| Table | Purpose | Access (authenticated) |
|---|---|---|
| `salons` | Tenant root: name, unique `slug`, IANA `timezone` | Members read; owners update/delete. Created **only** via `create_salon()` |
| `salon_members` | `(salon_id, user_id, role)`; role = `owner` \| `stylist` | Members read co-members; owners manage; anyone can leave. A salon always keeps ≥ 1 owner |
| `settings` | 1:1 per salon: autonomy (`draft`), booking rules (`booking_window_days` 60, `min_notice_minutes` 120, `slot_grid_minutes` 15), hold expiry / follow-up nudge (24h) | Members read; owners update |
| `work_hours_template` | `(salon_id, weekday 0=Sun..6)`: `blocks` (`{start,end,type: open\|tentative}`) + `breaks`, `HH:MM` salon-local | Members read; owners manage |
| `work_hours_override` | Date or date range (`start_date..end_date`) with `kind` = `custom` (own blocks/breaks) \| `day_off` \| `vacation`. Beats the template; narrower/newer overrides win | Members read; owners manage |
| `audit_log` | Append-only event log | Members read and append as themselves; no update/delete |
| `push_tokens` | Expo push tokens per user per salon | Users manage only their own tokens |

`anon` has no table access; the public booking page will go through Edge Functions.

RPCs (authenticated only):
- `create_salon(p_name, p_slug, p_timezone)`: creates the salon, makes the caller `owner`, creates default `settings`, writes `audit_log`.
- `is_salon_slug_available(p_slug)`: boolean check for the create-salon form.

Helpers in the non-exposed `private` schema: `is_salon_member(salon_id)`, `has_salon_role(salon_id, role)`.

## Schema (service builder, #4)

| Table | Purpose | Access (authenticated) |
|---|---|---|
| `services` | Menu item: name, category, price, `color_tag`, buffers, flags (`consultation_required`, `bookable_online`, `new_clients_only`), `is_combo`, `archived_at` | Members read; owners manage |
| `service_segments` | Ordered `busy` / `processing` / `style` segments of a service **or** an add-on (exactly one of `service_id` / `addon_id`) | Members read; owners manage |
| `service_variants` | e.g. hair length: `delta_minutes` added to busy/style time | Members read; owners manage |
| `service_addons` | Toner, deep conditioning…: own segments, `placement` = `before_finish` \| `end` | Members read; owners manage |
| `service_combo_items` | Ordered services in a combo (`replaces_previous_finish`); no nested combos | Members read; owners manage |

RPCs (authenticated, owners only; write `audit_log`):
- `save_service(p_salon_id, p_service jsonb)`: creates (no `id`) or replaces a service/combo with its segments, variants and items atomically. Uses the `ServiceDefinition` shape from `@chairside/core`. Validates segments the same way the availability engine does.
- `save_service_addon(p_salon_id, p_addon jsonb)`: the same for add-ons.

New salons get the Appendix A starter menu (an `after insert` trigger on `salons` → `private.seed_starter_menu`). Salons that already have services are left alone. Resolution (variants, add-ons, combos) is done in `@chairside/core` (`resolveService` / `resolveCombo`); `@chairside/db` has `listServiceMenu` / `saveService`.

### Adding a tenant table

1. Add a new migration: `npx supabase migration new <name>`.
2. Include `salon_id uuid not null references public.salons(id) on delete cascade`.
3. `enable row level security` and write policies with `private.is_salon_member(salon_id)` / `private.has_salon_role(salon_id, 'owner')`.
4. Regenerate types: `npm run gen:types` in `packages/db`.

`tests/database/00_tenancy.test.sql` fails if any `public` table lacks RLS, lacks a NOT NULL `salon_id`, or is readable by `anon`.

## AI providers (bring your own key)

Owners pick OpenAI, Anthropic or Gemini in **Settings → AI assistant** (`apps/mobile/src/app/settings/ai.tsx`) and paste an API key. The LLM only interprets requests; slot math stays in `packages/core`.

| Object | Purpose | Access (authenticated) |
|---|---|---|
| `ai_provider_config` | 1:1 per salon: provider, model, `monthly_token_budget` (0 = AI off), masked `key_hint` | Members read; written **only** via the RPCs below |
| `ai_usage` | One row per LLM call: provider, model, purpose, input/output tokens | Members read; inserted only by the `ai` Edge Function (service role) |
| `private.ai_provider_secrets` | `salon_id → vault.secrets.id`. The key itself is encrypted in Supabase Vault | No access |

RPCs:
- `save_ai_provider_config(p_salon_id, p_provider, p_model, p_monthly_token_budget, p_api_key?)`: owner only. Writes the key to Vault and returns the public row (never the key). A key is required on first save and when switching provider; omit it to keep the saved key.
- `delete_ai_provider_config(p_salon_id)`: owner only. Also destroys the Vault secret.
- `ai_tokens_used_this_month(p_salon_id)`: members; calendar month in the salon's timezone.
- `get_ai_provider_secret(p_salon_id)`: **service role only** (the Edge Function). Returns the decrypted key.

All LLM calls go through the `ai` Edge Function (`functions/ai`), which verifies the user's JWT, checks membership, enforces the monthly budget, loads the key server-side, calls the provider via `@chairside/ai`, and records usage. Provider errors are returned with the key redacted. Actions: `test` (owner; tests the saved key, or a pasted key before saving) and `chat` (any member).

```bash
npx supabase functions serve ai   # local; uses the local stack's URL and keys automatically
```

Deploy: `npx supabase functions deploy ai`. The function imports `packages/ai/src` through `functions/ai/deno.json`, so deploy from the repo root. `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided by the platform; provider keys are **not** function secrets, they come from Vault per salon.

Provider contract tests replay fixtures in `packages/ai/fixtures` (no network in CI). To re-record against the live APIs: `OPENAI_API_KEY=… ANTHROPIC_API_KEY=… GEMINI_API_KEY=… npm run record:fixtures --workspace @chairside/ai` (keys are redacted from fixtures; review the diff before committing).

### Ask Chairside (`functions/ai-assistant`)

The owner's chat assistant. It uses the same JWT, membership, Vault-key and budget wiring as `ai` (shared in `functions/_shared/ai-deps.ts`) and runs the tool-calling loop from `@chairside/ai/assistant` server-side. Tools read and write through the **caller's JWT**, so RLS scopes them to their salon. The model only interprets the request and calls tools: `find_client`, `list_services`, `find_slots` (the `packages/core` engine on the requested day and the days around it), `get_day_summary`, `propose_booking` (a `held` appointment with notes `Drafted by Ask Chairside`) and `cancel_draft`. Confirming is **not** a model tool; the app calls it when the owner taps Confirm. Every tool call is written to `audit_log` (`entity_type = 'ai_assistant'`).

Actions: `status`, `message` (`{history, text}`; the app resends the returned `messages` as history, so nothing is stored server-side), `propose`, `confirm`, `discard`, `create_client`, `draft_running_late` (#37) and `draft_reply` (#7, below). With no key, `message` returns `409 not_configured` and the app links to Settings → AI assistant.

```bash
npx supabase functions serve                     # serves ai + ai-assistant
# Local demo without a key: a scripted, rule-based provider (never in production; it only turns on
# when SUPABASE_URL is a local stack). Put CHAIRSIDE_AI_DEMO=1 in an env file outside the repo:
npx supabase functions serve --env-file /tmp/chairside-demo.env
SUPABASE_ANON_KEY=… npm run smoke:assistant --workspace @chairside/ai   # end-to-end check
```

Deploy: `npx supabase functions deploy ai-assistant` (from the repo root, like `ai`).

### Inbox agent (`functions/inbox`, #34)

The endpoint the salon's iOS Shortcut forwards keyword texts to (see [`docs/shortcut-bridge.md`](../docs/shortcut-bridge.md) and the spike in `docs/spikes/ios-shortcut-keyword-bridge.md`). It has no user JWT (`verify_jwt = false`). The `X-Bridge-Token` header identifies the salon, and the body is never used for that. The owner generates the token in Settings → Text bridge (`rotate_inbox_bridge_token`). Only its SHA-256 is stored in `inbox_bridges`, and the plain token is shown once. Each token is limited to 60 texts per hour.

```http
POST /functions/v1/inbox
X-Bridge-Token: csb_…
{ "sender": "Karina M.", "senderPhone": "+1 555 010 0101", "text": "Chairside can I get color + trim fri afternoon?",
  "receivedAt": "2026-12-01T14:03:22-05:00", "bridgeVersion": "3" }
→ 200 { "ok": true, "status": "captured" | "duplicate" | "ignored" | "test" | "confirmed", "requestId": "…", "reply": "…",
        "replies": [{ "id": "…", "to": "+1555…", "text": "Hi Karina! You're booked…" }] }

POST /functions/v1/inbox   (same header)
{ "action": "outbox" }
→ 200 { "ok": true, "status": "outbox", "replies": [ … ] }
```

Request flow (`@chairside/ai/inbox`):

1. The function strips the keyword.
2. The salon's model fills one forced `submit_request` tool call with intent, services from the menu, a date, time of day and the client's name. It does no slot math, and usage is metered as `purpose = 'inbox'` against the salon budget.
3. The client is matched by phone, then by one confident name. An unknown sender gets a `pending` client.
4. The `packages/core` engine picks the closest slot, preferring the time of day the client asked for.
5. `capture_inbox_request` (service role) stores a `captured_requests` row and holds the slot as a `requested` appointment (`source = 'inbox'`). That appointment gets the request push and hold expiry from #62.

**Bridge health (#6):** every authenticated call stamps `last_received_at` and, when sent, `last_bridge_version`. An empty `text` (the Shortcut run by hand) or "Chairside test" stamps `last_test_at`, returns `status: "test"` and captures nothing. Setup polls for it, and the app flags a bridge silent for 7 days or a Shortcut older than `BRIDGE_SHORTCUT_VERSION`.

**Auto-reply (#6, off by default):** with `inbox_bridges.auto_reply` on, the response carries a `reply` for the Shortcut to text back: "got it" for a captured request, a how-to for a keyword-only text, and a "connected" note for a test text. Duplicates never reply.

**Draft-then-approve:** besides those acknowledgements, nothing is sent to the client without the stylist (see Client replies below). The stylist approves or declines the held slot in the Inbox tab. A trigger then marks the request approved, declined or expired, keeps the new client on confirm, and cancels the old appointment for an approved reschedule. Cancel requests have a **Cancel appointment** action (`resolve_captured_request`). Duplicates are matched on sender, text and `receivedAt`. Non-requests ("thanks!") store nothing.

Local check without a key: serve with `CHAIRSIDE_AI_DEMO=1` (same env file as above). The function then uses a rule-based parser and needs no AI provider.

```bash
curl -X POST http://127.0.0.1:54321/functions/v1/inbox -H "X-Bridge-Token: csb_…" \
  -H 'Content-Type: application/json' \
  -d '{"sender":"Dana","senderPhone":"+13125550199","text":"Chairside cut fri afternoon?","bridgeVersion":"1"}'
```

Deploy: `npx supabase functions deploy inbox --no-verify-jwt`.

### Client replies (#7)

The model only **drafts** replies; it never decides who, when or what. `draft_reply` on `ai-assistant` (`{kind: confirm | offer | decline | cancelled | other, requestId?, appointmentId?, clientId?}`) reads the client, appointment and services from the database, asks the salon's model for the wording (`purpose = 'reply'`), and appends the booking link (if `settings.reply_include_booking_link`) and, for offers, `Reply "<keyword> yes" to confirm.` in code. Without a key or budget it returns a template. Tone examples (`settings.reply_tone_examples`) steer the style only.

In the app the editor opens after Approve, Decline or Cancel appointment in the Inbox, from **Offer** on a held request, and for each running-late text. **Send** opens the Messages composer prefilled (`expo-sms`, else an `sms:` link); on web it copies. `record_client_reply` then stores a `client_replies` row (`channel = messages | copy`, `source = ai | template | edited`), cancels any queued auto-send reply for the same request, and writes `reply.sent` to `audit_log`. Members can read `client_replies` (Realtime refreshes the Inbox); only RPCs and the service role write it.

**Auto-send** (`settings.auto_send_replies`, off by default, owner opt-in in Settings → Client replies) needs the text bridge. It is separate from the bridge's auto-reply above, which only acknowledges. When a texted request is approved, the `captured_requests_queue_auto_reply` trigger queues a `bridge` reply (`confirm`, or `cancelled` for an approved cancel). The next `inbox` call from a v3+ Shortcut (a new text, or `{"action":"outbox"}` from an optional second automation) claims up to 10 queued replies, drafts them (`purpose = 'auto_reply'`, template fallback) and returns them in `replies`; the Shortcut sends each with **Send Message**. Older Shortcuts (`bridgeVersion` < 3, see `OUTBOX_BRIDGE_VERSION`) get no `replies`, so nothing is marked sent that they would drop. Handing a reply to the Shortcut marks it sent (at most once). Stale claims are retried after 2 minutes.

**"Yes" to an offer:** if a known number replies affirmatively (`"<keyword> yes"`, "sounds good", 👍 …) within 7 days of an offer for a still-held slot, `inbox` confirms that appointment instead of capturing a new request (`status: "confirmed"`). This works with auto-send off, since the stylist made the offer.

## Payments (Stripe Connect)

Each salon gets a **Stripe Connect Express** account (the platform is Chairside's Stripe account). Owners connect it in **Settings → Payments** (`apps/mobile/src/app/settings/payments.tsx`), which opens Stripe's hosted onboarding (business details, ID, bank account). Stripe pays out to the salon's bank; Chairside never handles bank details. See [`docs/PLAN.md` §9](../docs/PLAN.md).

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

### Manual setup (test mode)

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

## Checkout and Tap to Pay (#11)

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

### Tap to Pay on iPhone (manual, on device)

Real Tap to Pay needs Apple's entitlement (#1), a custom build (not Expo Go) and a physical iPhone. Until then every build uses the test reader.

1. **Request the entitlement:** in the Apple Developer account, request *Tap to Pay on iPhone* (https://developer.apple.com/tap-to-pay/). Apple first grants a development entitlement, then reviews the app for distribution.
2. **Enable it on the App ID:** Certificates, Identifiers & Profiles → Identifiers → the app's bundle id → enable **Tap to Pay on iPhone**, then regenerate the provisioning profiles (EAS does this with `eas credentials`).
3. **Device:** iPhone XS or newer on the latest iOS, signed into iCloud, with a passcode. The salon's Stripe account must be in a [supported country](https://docs.stripe.com/terminal/payments/setup-reader/tap-to-pay?platform=ios) and have a business address (the Terminal Location uses it).
4. **Build:** `apps/mobile/app.config.ts` adds the Stripe Terminal config plugin when `@stripe/stripe-terminal-react-native` is installed (an optional dependency), and the `com.apple.developer.proximity-reader.payment.acceptance` entitlement only when `EXPO_PUBLIC_TAP_TO_PAY=1`. Build a dev client with it set, for example `EXPO_PUBLIC_TAP_TO_PAY=1 eas build --profile development --platform ios`.
5. **Test mode first:** with `sk_test_…` keys, take a checkout and tap a physical test card or a real card (test mode doesn't charge it). The first time, iOS shows Apple's Tap to Pay terms; the owner's Apple ID accepts them. Check the receipt and Settings → Payments, and try a refund.
6. **Live:** switch the function secrets to live keys (Payments step 10), build for production with `EXPO_PUBLIC_TAP_TO_PAY=1`, and submit. App Review checks Apple's Tap to Pay [marketing and UX guidelines](https://developer.apple.com/tap-to-pay/marketing-guidelines/).

If the SDK or the flag is missing, `features/checkout/terminal.native.tsx` falls back to the test reader, so a misconfigured build can't charge real cards from the simulator path (`simulate` refuses live keys).

## Push notifications (#8)

Migration `20261109210000_notifications.sql`, function `functions/notifier`, shared logic in `packages/notifications`.

| Object | Purpose |
|---|---|
| `push_tokens` | Expo push tokens per member and device. The app registers on sign-in via `register_push_token(p_salon_id, p_token, p_platform)` and deletes its row on sign-out |
| `notifications_outbox` | One row per push (`request`, `request_nudge`, `cancellation`, `daily_agenda`). `dedupe_key` is unique, so cron ticks and retries are safe. Recipients read their own rows; only triggers, cron and the service role write |
| `settings.followup_nudge_hours` | "You haven't responded" nudge delay (default 24h, Settings → Notifications) |
| `settings.hold_expiry_hours` | Shared with Work hours. Unanswered requests are released `nudge + hold_expiry` after they were requested (or once their start time passes) |
| `settings.quiet_hours_*` | Wall-clock window in the salon timezone. Pushes due inside it stay pending until it ends |
| `settings.daily_agenda_enabled` | 8am (salon time) agenda, sent only on days with appointments or requests |

Flow:
- Triggers on `appointments` enqueue a `request` push when a booking becomes `requested`, and a `cancellation` push when a confirmed or requested booking is cancelled by someone other than the stylist (including requests released unanswered). Ignoring a request (`reason = 'ignored'`) sends nothing.
- A non-member booking that touches **Tentative** hours is always stored as `requested`, never `confirmed`.
- pg_cron job `notifications-tick` (every minute) runs `private.notifications_tick()`: enqueue nudges, release unanswered requests, enqueue agendas, then `pg_net` POSTs to the notifier.
- The `notifier` Edge Function claims due rows (`claim_notifications`, which skips rows in quiet hours), sends them through the Expo Push API in batches of 100, and records results (`finish_notifications`). `DeviceNotRegistered` tokens are deleted. Failed sends retry with backoff, up to 5 attempts.
- iOS categories: `appointmentRequest` (Approve / Other time / Decline) and `requestNudge` (Respond / Ignore). Approve, Decline and Ignore run in the background via `set_appointment_status`; Other time and Respond open `/requests/<id>`.

Setup (hosted):

```bash
npx supabase functions deploy notifier --no-verify-jwt
npx supabase secrets set NOTIFIER_SECRET=<random> EXPO_ACCESS_TOKEN=<optional, Expo "enhanced security" token>
```

Then in the SQL editor, so pg_cron can reach the function:

```sql
select vault.create_secret('https://<ref>.supabase.co/functions/v1/notifier', 'notifier_url');
select vault.create_secret('<same random as NOTIFIER_SECRET>', 'notifier_secret');
```

Without those secrets, rows still queue (and nudges/expiry still run) but nothing is sent. Locally: `NOTIFIER_SECRET=dev npx supabase functions serve notifier` and use `http://host.docker.internal:54321/functions/v1/notifier` as `notifier_url`.

### Manual on-device test

Real pushes need a physical device and an EAS build (Expo Go on SDK 53+ has no remote push).

1. `npx eas init` in `apps/mobile` (adds `extra.eas.projectId` to app config), then `npx eas build --profile development --platform ios` and install it on an iPhone. Configure push credentials when EAS prompts (APNs key).
2. Point the build at a Supabase project with the notifier set up as above. Sign in. Allow notifications; Settings → Notifications should show **This device: On**, and a `push_tokens` row should exist.
3. **Lock-screen approve:** lock the phone and create a request as a client (e.g. `book_appointment` as a non-member, or a booking in Tentative hours). Within about a minute a "New request from <client>" push arrives. Long-press it and tap **Approve** from the lock screen (Face ID confirms it; the app stays closed). The appointment becomes `confirmed` and shows as confirmed in Calendar. Repeat with **Decline** (cancelled, reason `declined`) and **Other time** (opens the request screen to move and approve).
4. **Nudge:** set "Remind me after" to 1h, create a request and don't respond. After 1h a "You haven't responded to <client>'s request" push arrives with **Respond** / **Ignore**. **Ignore** releases the hold (cancelled, reason `ignored`). To test faster, backdate it: `update appointments set requested_at = now() - interval '2 hours' where id = '<id>';`.
5. **Expiry:** leave a request unanswered for nudge + hold expiry. It becomes cancelled (`request_expired`) and a "<client>'s request expired" push arrives.
6. **Quiet hours:** enable them around the current time and create a request. No push arrives (the row stays `pending`). Turn them off and it is delivered on the next tick.
7. **Agenda:** with appointments today, set `daily_agenda_enabled` on and check the 8am salon-time push. To test now, delete today's `daily_agenda` row and temporarily change the salon timezone so it's between 08:00 and 12:00 there.
8. **Cancellation:** cancel a confirmed booking as a client (not the stylist). A "<client> cancelled" push arrives.
9. Sign out. The device's `push_tokens` row is deleted.

## Hosted project setup (manual)

1. Create a project at https://supabase.com/dashboard (region near the salon). Note the project ref.
2. `npx supabase login` then `npx supabase link --project-ref <ref>`.
3. `npx supabase db push` to apply migrations.
4. **Auth → URL configuration:** set Site URL and add redirect URLs `chairside://**` (plus the web URL once deployed).
5. **Auth → Email templates → Magic link:** paste `supabase/templates/magic_link.html` (must include `{{ .Token }}` for the in-app code).
6. **Auth → SMTP:** configure a real sender (e.g. Resend); the built-in sender is heavily rate limited.
7. Put the project URL + anon/publishable key in the app's `.env` (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`). Never ship the service role key.
8. Deploy the AI gateway: `npx supabase functions deploy ai` (see "AI providers" above). Vault is enabled by the migration.
9. Payments: deploy `payments` and `stripe-webhook` and set the Stripe secrets (see "Payments (Stripe Connect)" below).

## Sign in with Apple (manual)

Native iOS sign-in uses `expo-apple-authentication` and `supabase.auth.signInWithIdToken({ provider: 'apple', token })`, so no secret is needed for the iOS app itself.

1. Apple Developer → Identifiers: enable **Sign in with Apple** on the app's bundle ID.
2. (Web/public page only) Create a **Services ID** + a Sign in with Apple **key**, then generate the client secret JWT (it expires every 6 months).
3. Supabase dashboard → Auth → Providers → Apple: enable; **Client IDs** = `<bundle id>,<services id>`; secret = the JWT from step 2 (web only).
4. Locally: set `SUPABASE_AUTH_EXTERNAL_APPLE_CLIENT_ID` / `SUPABASE_AUTH_EXTERNAL_APPLE_SECRET` in `.env` and flip `[auth.external.apple] enabled = true` in `config.toml`.

App Store rule: if the app offers any third-party sign-in, it must also offer Sign in with Apple.
