# TestFlight pilot and Vagaro cutover runbook (#19)

Goal: the stylist runs his business on Chairside for two weeks, then cancels Vagaro ([PLAN §16](PLAN.md#16-roadmap), phase 6). Build and release mechanics are in [release.md](release.md).

Work top to bottom. Each step says **(manual)** when a person has to click through a website or an account, or names the `npm run …` command that does it. Run commands from the repo root, in PowerShell or a macOS/Linux terminal (`npm ci` once first). The `hosted:*` scripts read a private `.env.hosted` file, only ever print key names (never values), and are safe to re-run.

## 0. Accounts (one time) (manual)

| Account | Needed for | Notes |
|---|---|---|
| **Apple Developer Program** ($99/yr) | TestFlight, push, Sign in with Apple | Personal is fine for TestFlight; switch to an organization (LLC + D-U-N-S) before a public App Store listing ([PLAN §14b](PLAN.md#14b-publishing-under-your-own-developer-accounts-what-it-means)). Note the **Team ID**. |
| **Expo** (expo.dev) | Builds, OTA updates, push, optionally web hosting | Free tier is enough to start; builds queue longer. |
| **Supabase**, **Pro** plan | Database, auth, Edge Functions | Daily backups and no auto-pause. A free project pauses after a week idle, which would take the stylist's calendar offline. |
| **Stripe** with Connect | Card checkout, deposits | Test mode for the pilot ([payments.md](../supabase/docs/payments.md)). |
| **Resend** (resend.com) + **a domain** you control (DNS access) | Sign-in codes for clients, booking confirmations, reminders, waitlist, marketing, export links | Supabase's built-in mailer only emails members of your Supabase team, so client booking codes would never arrive without it. |
| A **web host** for the domain | Public booking page `/b/<slug>`, pay links, manage links, receipts, the web app | EAS Hosting (same Expo account) or any static host (Cloudflare Pages, Netlify, Vercel…). See section 2. |
| Optional: **Sentry** (React Native project) | Crash reports | |

- [ ] Ask Apple for **Tap to Pay on iPhone** (#1) early; it takes a while. The pilot doesn't wait for it: the app works with cash/other and the Stripe simulated reader until then.

## 1. Bundle ID and EAS project (one time)

1. - [ ] **(manual)** Replace the placeholder `com.chairside.app` in `apps/mobile/app.json` (`ios.bundleIdentifier` and `android.package`) with a reverse-DNS ID you own, e.g. `com.<yourcompany>.chairside`. It can't change after the app is in App Store Connect. Dev and preview builds append `.dev` / `.preview` automatically. Commit it.
2. - [ ] **(manual)** Link the EAS project. From `apps/mobile`:

   ```bash
   npx eas-cli@latest login
   npx eas-cli@latest init
   ```

   `app.config.ts` is dynamic, so `eas init` prints the values instead of writing them. Add them to `apps/mobile/app.json` and commit (they're IDs, not secrets):

   ```json
   "owner": "<expo account or org>",
   "extra": { "eas": { "projectId": "<uuid>" } }
   ```

   That turns on EAS Update and lets push tokens resolve (Settings → Notifications stops saying "no project").

3. - [ ] **(manual)** Create an Expo access token (expo.dev → Account settings → Access tokens; a robot user's token is best) and add it as the **`EXPO_TOKEN`** GitHub repository secret (Settings → Secrets and variables → Actions).

## 2. Pick the web origin (one time) (manual)

The Expo web build is a single-page app (`web.output: "single"`). It serves the public booking page and every link the app emails or texts to clients, so it needs a stable https origin before the Supabase settings in section 3.

- [ ] Choose the origin, e.g. `https://app.yourdomain.com`. This value is `PUBLIC_APP_URL` in `.env.hosted` and `EXPO_PUBLIC_WEB_URL` in EAS.
- [ ] Choose where it's hosted. EAS Hosting: nothing to set up yet (custom domains are in expo.dev → Hosting). Any other static host: point it at the domain and add a "serve `index.html` for every path" fallback (Netlify `_redirects`: `/* /index.html 200`; Cloudflare Pages does this by default). The first deploy is step 3.12, once the Supabase URL and key exist.

## 3. Hosted Supabase

Everything the hosted project needs is listed once in [`scripts/hosted/manifest.mjs`](../scripts/hosted/manifest.mjs) and `supabase/config.toml`; CI (`npm run check:hosted`) fails when a new function, secret or Vault secret isn't listed there, so this list can't silently go stale. Reference tables are at the end of the section.

1. - [ ] **(manual) Create the project** in the Supabase dashboard (Pro plan, region near the salon). Note:
   - the **project ref** (`https://<ref>.supabase.co`),
   - the **database password** you choose,
   - the **Session pooler** connection string (top bar → **Connect** → Session pooler). The direct database host is IPv6-only and most networks can't reach it.
   - a **personal access token** (supabase.com/dashboard/account/tokens).
2. - [ ] **(manual) Fill in `.env.hosted`:**

   ```bash
   cp .env.hosted.example .env.hosted         # PowerShell: Copy-Item .env.hosted.example .env.hosted
   ```

   Edit it. Each key is marked `[required]`, `[recommended]` or `[optional]`. For now fill the four tooling keys (ref, token, DB password, pooler URL with `[YOUR-PASSWORD]` left in place), `NOTIFIER_SECRET` (generate it with the command in the file), `PUBLIC_APP_URL` (section 2) and `EMAIL_FROM`. Stripe and Resend keys come in steps 3.3 and 3.9. Never commit this file or paste it anywhere.
3. - [ ] **(manual) Resend:** add the domain from `EMAIL_FROM` (Resend → Domains), create the DNS records it shows (SPF/DKIM, optionally DMARC) and wait for **Verified**. Create an API key with sending access and put it in `RESEND_API_KEY`.
4. - [ ] **`npm run hosted:deploy -- --dry-run`** shows the pending migrations (`db push --dry-run`) and every function deploy command, without changing anything.
5. - [ ] **`npm run hosted:deploy`** applies all migrations, then deploys all 14 Edge Functions with the right JWT setting. Answer `y` to the CLI prompts (or add `--yes`). Function bundling uses Docker/Podman; if neither is running, add `--use-api`. The migrations enable the extensions and create the storage buckets and pg_cron jobs. If `db push` fails on an extension, enable it in Database → Extensions and re-run.
6. - [ ] **`npm run hosted:secrets`** checks `.env.hosted` (placeholders, formats, missing pairs) and sets every non-empty function secret. `PAYMENTS_RETURN_URL`, `PUBLIC_WEB_URL` and `PUBLIC_FUNCTIONS_URL` are filled from `PUBLIC_APP_URL` / the ref when left empty. Use `-- --dry-run` to see what would be set. Re-run it after every `.env.hosted` change.
7. - [ ] **`npm run hosted:vault -- --apply`** stores `notifier_url` and `notifier_secret` (a copy of `NOTIFIER_SECRET`) in Vault, so the pg_cron jobs can call `notifier`, `waitlist` and `marketing`. Without `--apply` it prints the SQL with the secret masked (`-- --out vault.sql` writes the full SQL to paste into the SQL editor yourself; delete the file afterwards). Re-run it whenever `NOTIFIER_SECRET` changes.
8. - [ ] **`npm run hosted:auth`** (try `-- --dry-run` first) sets Auth through the Management API:
   - Site URL = `PUBLIC_APP_URL`; redirect URLs `chairside://**` and `<PUBLIC_APP_URL>/**` (existing entries are kept);
   - the 6-digit sign-in code email (subject from `supabase/config.toml`, body from `supabase/templates/magic_link.html`), code length 6, expiry 1 h;
   - custom SMTP through Resend (`smtp.resend.com:465`, user `resend`, the API key), sender from `EMAIL_FROM`. With `SMTP_*` set instead, those are used.

   **Sign in with Apple:**
   - (manual) In the Apple Developer portal → Identifiers, make sure the App IDs you build (`<bundle id>`, `<bundle id>.dev`, `<bundle id>.preview`) have **Sign in with Apple** enabled. EAS usually does this on the first build (section 4); check afterwards.
   - **`npm run hosted:auth -- --apple`** enables the Apple provider with those three bundle IDs as Client IDs. Native iOS sign-in needs nothing else. Apple sign-in on the web needs a Services ID and a client-secret JWT that expires every 6 months ([sign-in-with-apple.md](../supabase/docs/sign-in-with-apple.md)); skip it for the pilot, email codes work on the web.
9. - [ ] **(manual) Stripe, test mode** ([payments.md](../supabase/docs/payments.md) steps 1–2 and 9):
   - Turn on Connect and fill in the platform profile.
   - Developers → API keys: copy the **secret key** (`sk_test_…`) into `STRIPE_SECRET_KEY`.
   - Developers → Webhooks: add **two** destinations to `https://<ref>.supabase.co/functions/v1/stripe-webhook`, one for **Your account** and one for **Connected accounts**, each with the six events in the table below. Copy both signing secrets into `STRIPE_WEBHOOK_SECRET`, comma-separated.
   - Run **`npm run hosted:secrets`** again.
10. - [ ] **(manual) Backups:** confirm daily backups (Database → Backups). Consider Point-in-Time Recovery for the cutover weeks. Take a manual dump before each import: `npx supabase db dump --data-only -f backup-<date>.sql --remote="<pooler URL with the password>"` (keep it out of the repo; `backup-*.sql` isn't ignored, so save it outside the checkout).
11. - [ ] **`npm run hosted:verify`** prints a PASS / WARN / FAIL list and exits non-zero on any failure:
    - required function secrets present (names only), the email and Stripe groups complete, no local-only keys, `NOTIFIER_SECRET` matching Vault;
    - extensions, all migrations applied, the 9 pg_cron jobs active and not failing, Vault secrets present and pointing at this project, private buckets;
    - every function deployed, `ACTIVE`, with the right JWT setting and answering (not 404 / 503 `BOOT_ERROR`);
    - Auth site URL, redirect URLs, the code template, SMTP;
    - both Stripe webhook destinations with every event (`-- --skip-stripe` to skip).

    Fix anything red and re-run until it's all green.
12. - [ ] **(manual) Deploy the web app.** From `apps/mobile`, put the production values in `apps/mobile/.env` (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_WEB_URL` = `PUBLIC_APP_URL`; or pull them from EAS once section 4.1 is done: `npx eas-cli@latest env:pull --environment production`), then:

    ```bash
    npx expo export -p web           # writes dist/
    npx eas-cli@latest deploy --prod # EAS Hosting; or upload dist/ to your static host
    ```

    Universal links (optional): serve this at `https://<domain>/.well-known/apple-app-site-association` (no extension, `application/json`), then rebuild the app:

    ```json
    {
      "applinks": { "details": [{ "appIDs": ["<TEAMID>.<bundle id>"], "components": [{ "/": "/b/*" }, { "/": "/receipt/*" }] }] },
      "webcredentials": { "apps": ["<TEAMID>.<bundle id>"] }
    }
    ```

13. - [ ] **(manual) Smoke test** on the web app: sign in with an email code (proves SMTP), create the salon, check Settings → Notifications and Settings → Payments load, start Stripe test onboarding. Open `/b/<slug>` in a private window and book as a client with an outside email address: the code and the confirmation email must arrive.

### Reference: what the hosted project contains

**Edge Functions** (`supabase/config.toml`; `hosted:deploy` deploys all of them):

| JWT verified (signed-in callers) | No JWT check (own auth: shared secret, Stripe signature or a token in the link) |
|---|---|
| `ai`, `ai-assistant`, `payments`, `checkout`, `data-export`, `import-services` | `stripe-webhook`, `notifier`, `inbox`, `public-booking`, `manage-booking`, `waitlist`, `deposits`, `marketing` |

**Function secrets:** every key, with required / recommended / optional, is in [`.env.hosted.example`](../.env.hosted.example). `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_DB_URL` are provided by the platform. AI provider keys are not function secrets: the stylist enters his own in Settings → AI assistant ([ai-providers.md](../supabase/docs/ai-providers.md)).

**Vault secrets:** `notifier_url` and `notifier_secret` (required). `waitlist_url` and `marketing_url` are optional and default to `notifier_url` with the function name swapped.

**pg_cron jobs** (created by the migrations):

| Job | Schedule | Does |
|---|---|---|
| `release-expired-holds` | every minute | Frees unpaid held slots |
| `notifications-tick` | every minute | Calls `notifier` (pushes, client emails) |
| `client-emails-tick` | every minute | Queues reminder / follow-up emails ([client-self-service.md](../supabase/docs/client-self-service.md)) |
| `waitlist-tick` | every minute | Calls `waitlist` to offer freed slots ([waitlist.md](../supabase/docs/waitlist.md)) |
| `marketing-tick` | every minute | Calls `marketing` to send campaigns ([marketing.md](../supabase/docs/marketing.md)) |
| `payout-summary-tick` | every 15 min | Stripe payout summaries ([payments.md](../supabase/docs/payments.md)) |
| `finances-tick` | every 15 min | Expense reminders ([finances.md](../supabase/docs/finances.md)) |
| `rate-limits-purge` | hourly at :17 | Cleans old rate-limit rows |
| `marketing-nudge-scan` | hourly at :17 | Finds clients due a nudge |

**Extensions:** `pg_cron`, `pg_net`, `supabase_vault`, `btree_gist`, `pg_trgm`, `fuzzystrmatch`.

**Storage buckets** (all private): `client-photos`, `receipts`, `data-exports` ([data-export.md](../supabase/docs/data-export.md)).

**Stripe webhook events** (both destinations): `account.updated`, `payment_intent.processing`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`. Deposits arrive as `payment_intent.succeeded` with `metadata.purpose = deposit` ([deposits.md](../supabase/docs/deposits.md)).

**What the scripts don't do:** create accounts or projects, verify domains, configure Stripe or Apple, change backup settings, or deploy the web app. Those are the (manual) steps above.

## 4. First TestFlight build

1. - [ ] **(manual) EAS environment variables** for `production` (and `development` / `preview` if you build those): see the table in [release.md](release.md#environment-variables). At minimum `EXPO_PUBLIC_SUPABASE_URL` (`https://<ref>.supabase.co`), `EXPO_PUBLIC_SUPABASE_ANON_KEY` (Project Settings → API keys, the anon / publishable key, never the service role key) and `EXPO_PUBLIC_WEB_URL` (`PUBLIC_APP_URL`). In expo.dev → Project → Environment variables, or from `apps/mobile`: `npx eas-cli@latest env:create --environment production --name EXPO_PUBLIC_SUPABASE_URL --value https://<ref>.supabase.co --visibility plaintext`.
2. - [ ] **(manual) App Store Connect** → Apps → **+** → New App: iOS, name "Chairside" (must be unique on the store; add a suffix if taken), the production bundle ID, SKU anything. Note the **Apple ID** (numeric `ascAppId`).
3. - [ ] **(manual) Build and submit.** Either push a tag (`git tag v0.1.0 && git push origin v0.1.0`) or run locally from `apps/mobile`:

   ```bash
   npx eas-cli@latest build -p ios --profile production --auto-submit
   ```

   The first run is interactive if done locally: log in with the Apple ID, let EAS create the **distribution certificate**, **provisioning profile**, **APNs key** (say yes to push notifications), the App Groups for the share extension and widgets, and an **App Store Connect API key** for submissions. After that, CI builds run non-interactively. If CI runs first and fails on missing credentials, do this one local run, then use CI.
   Optionally put the numeric ID in `eas.json` → `submit.production.ios.ascAppId` so submits never prompt.
4. - [ ] Wait for processing (App Store Connect → TestFlight). Export compliance is pre-answered (`ITSAppUsesNonExemptEncryption = false`).
5. - [ ] **(manual)** TestFlight → **Internal Testing** → add the stylist (he must be a user on the App Store Connect team, role "Customer Support" or higher; internal testers skip Beta App Review). He installs **TestFlight** from the App Store and accepts the invite.
6. - [ ] On his iPhone: install, sign in (Apple or email code), allow notifications. Settings → Notifications shows **This device: On**. Then `npm run hosted:verify` once more.

## 5. Pilot readiness checklist

Do these with him, on his phone, before the overlap starts.

- [ ] **Services:** his menu is in Chairside with correct durations, processing segments and prices. Import them with Settings → Import services (his Vagaro booking page link, a menu screenshot or pasted text; [import-vagaro-services.md](../supabase/docs/import-vagaro-services.md)), then fix anything off in the service builder.
- [ ] **Hours:** weekly template plus known days off (Open / Tentative / Closed).
- [ ] **Clients + future appointments imported** (section 6, first import).
- [ ] **Shortcut bridge working** ([shortcut-bridge.md](shortcut-bridge.md)): Settings → Text bridge shows healthy; a test text containing "Chairside" from another phone creates a request and a push.
- [ ] **Push:** a request push arrives on the lock screen and Approve works without opening the app ([push-notifications.md](../supabase/docs/push-notifications.md#manual-on-device-test)).
- [ ] **Stripe live:** Connect onboarding finished with his real bank account, then switch to live keys: put `sk_live_…` and the two **live** webhook signing secrets in `.env.hosted`, register the live webhook destinations ([payments.md](../supabase/docs/payments.md) step 10), run `npm run hosted:secrets` and `npm run hosted:verify`. Run one real small charge and refund it. Tap to Pay only if #1 is granted (rebuild with `EXPO_PUBLIC_TAP_TO_PAY=1`); otherwise card payments wait and he uses cash/other or Vagaro's reader during overlap.
- [ ] **Public booking page** on (Settings → Booking page) if he'll share the link.
- [ ] **AI key** set (Settings → AI assistant) if he uses the inbox agent / Ask Chairside.
- [ ] Sentry receives a test event (optional).

## 6. Vagaro cutover plan

The importer (#15) is safe to re-run: clients match by email, then phone, then name, and only fill empty fields; appointments carry an `import_key`, so re-importing the same export reports `duplicate` instead of double booking. Past and cancelled rows are skipped. Clashes are listed (`conflict`) instead of booked. Details: [import-vagaro.md](../supabase/docs/import-vagaro.md).

| When | Step |
|---|---|
| **Day −1** | Back up (section 3, step 10). In Vagaro, export **Customers** and **Appointments Summary** (date range: today → 6 months out). Also download everything you'll want after cancelling (customer list, full appointment history, transactions, forms/formulas) and store it privately; it isn't imported. |
| **Day 0 (overlap starts)** | Settings → Import from Vagaro: clients first, then appointments. Fix any `conflict` / `invalid` rows by hand. Spot-check 5 clients and the next 2 weeks of the calendar against Vagaro. |
| **Days 1–14 (overlap)** | **Chairside is the calendar he works from**; Vagaro stays live only so existing clients' links and reminders keep working. Each evening (or every few days): new Vagaro export → import again (only new bookings are added). **Cancellations and reschedules made in Vagaro don't sync**: apply them in Chairside by hand (the import doesn't remove anything). Log every bug or friction point (section 7). |
| **Freeze day (~day 7)** | Turn off **online booking** in Vagaro, point every booking link (Instagram bio, Google Business profile, website, text signature) to `https://<web>/b/<slug>`, and text upcoming clients if reminders will now come from Chairside. Run a final export → import. From here new bookings only arrive in Chairside. |
| **Day 14 (go/no-go)** | Go if: no missed or double bookings for a week, payments reconciled with Stripe, pushes reliable, no open P0/P1 bugs, he's comfortable. Then cancel Vagaro (check its notice period and any payment-processing contract first). |

## 7. Feedback loop and bug triage

- He reports from the phone: TestFlight's **screenshot → Share Beta Feedback** (lands in App Store Connect → TestFlight → Feedback, with device info), or a text to the developer. Crashes show in TestFlight and in Sentry.
- Log each item as a GitHub issue labelled `pilot`, with a priority:
  - **P0** — booking lost/doubled, can't take payment, data wrong, app unusable. Fix the same day (OTA update if JS-only), and fall back to Vagaro for that function until fixed.
  - **P1** — workaround exists but painful. Fix within the week.
  - **P2** — polish. After cutover.
- Daily during week 1, then twice a week: review Sentry, TestFlight feedback and the `pilot` issues; ship fixes as OTA updates ([release.md](release.md#release-strategy)).

## 8. Rollback

| What broke | Do this |
|---|---|
| A JS update | `npx eas-cli@latest update:rollback` on the `production` channel, or republish the last good commit. He relaunches the app twice. |
| A binary | Expire it in TestFlight; he installs the previous build from TestFlight → Previous Builds. |
| An Edge Function | Redeploy it from the last good commit: in a scratch branch `git checkout <sha> -- supabase/functions/<name>`, then `npm run hosted:deploy -- --skip-db --only <name>`. |
| Data (bad import, bad migration) | Restore the pre-import dump or a Supabase backup / PITR to a point before the change. Re-run the import afterwards if needed. |
| The pilot itself (go back to Vagaro) | Before day 14 Vagaro is still paid for. Turn its online booking back on and restore the old booking links. List what was booked in Chairside after the freeze and re-enter it in Vagaro (SQL editor, set the salon's timezone):<br>`select a.starts_at at time zone 'America/Chicago' as starts, c.name, c.phone, c.email, a.services->0->>'name' as service, a.status from appointments a left join clients c on c.id = a.client_id where a.starts_at > now() and a.status in ('confirmed','requested') and a.source <> 'import' order by a.starts_at;`<br>Card payments already taken stay in his Stripe account. |
