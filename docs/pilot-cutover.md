# TestFlight pilot and Vagaro cutover runbook (#19)

Goal: the stylist runs his business on Chairside for two weeks, then cancels Vagaro ([PLAN §16](PLAN.md#16-roadmap), phase 6). Build and release mechanics are in [release.md](release.md). Sections marked (manual) need a person with the account; nothing here can be automated from the repo.

## 0. Accounts (one time) (manual)

- [ ] **Apple Developer Program** ($99/yr). Personal is fine for TestFlight; switch to an organization (LLC + D-U-N-S) before a public App Store listing ([PLAN §14b](PLAN.md#14b-publishing-under-your-own-developer-accounts-what-it-means)). Note the **Team ID**.
- [ ] **Expo account** at expo.dev (free tier is enough to start; builds queue longer).
- [ ] **Supabase** project on a paid plan (Pro) for daily backups and no auto-pause. Free projects pause after a week idle, which would take the stylist's calendar offline.
- [ ] **Stripe** account with Connect ([payments.md](../supabase/docs/payments.md)).
- [ ] Optional: **Sentry** project (React Native), **Resend** (email), a domain for the web booking page.
- [ ] Ask for **Tap to Pay on iPhone** (#1) early; Apple takes a while. The pilot doesn't wait for it: the app works with cash/other and the Stripe test reader until then.

## 1. Pick the bundle ID (one time, permanent) (manual)

Replace the placeholder `com.chairside.app` in `apps/mobile/app.json` (`ios.bundleIdentifier` and `android.package`) with a reverse-DNS ID you own, e.g. `com.<yourcompany>.chairside`. It can't change after the app is in App Store Connect. Dev and preview builds append `.dev` / `.preview` automatically. Commit it.

## 2. Link the EAS project (one time) (manual)

From `apps/mobile`:

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

Then:

- [ ] Create the EAS environment variables for `production` (and `development`/`preview` if you use them): see the table in [release.md](release.md#environment-variables). At minimum `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` from the hosted project (section 3).
- [ ] Create an Expo access token and add it as the **`EXPO_TOKEN`** GitHub repository secret (Settings → Secrets and variables → Actions).

## 3. Hosted Supabase checklist (manual)

Follows [hosted-setup.md](../supabase/docs/hosted-setup.md); this is the full ordered list for the pilot. Run commands from the repo root.

1. - [ ] Create the project (region near the salon). Note the **ref**, **anon key** and DB password.
2. - [ ] `npx supabase login` → `npx supabase link --project-ref <ref>`.
3. - [ ] **Extensions.** The migrations run `create extension if not exists` for `pg_cron`, `btree_gist`, `pg_net`, `supabase_vault`, `pg_trgm` and `fuzzystrmatch`. On hosted projects check Database → Extensions afterwards: **pg_cron**, **btree_gist** and **pg_net** must show as enabled (enable them there first if `db push` fails on them).
4. - [ ] `npx supabase db push` (dry run first: `npx supabase db push --dry-run`). Confirm pg_cron jobs exist: `select jobname, schedule from cron.job;` should list `release-expired-holds`, `notifications-tick`, `payout-summary-tick` and `rate-limits-purge`.
5. - [ ] **Auth:** Site URL and redirect URLs `chairside://**` plus the web origin; magic-link template from `supabase/templates/magic_link.html`; custom SMTP (Resend). See hosted-setup.md steps 4–6.
6. - [ ] **Sign in with Apple:** enable the App ID capability on every bundle ID you build (`<base>`, `<base>.dev`, `<base>.preview`) and list them all in Supabase → Auth → Providers → Apple → Client IDs, comma-separated ([sign-in-with-apple.md](../supabase/docs/sign-in-with-apple.md)).
7. - [ ] **Function secrets** (`npx supabase secrets set ...`): `NOTIFIER_SECRET=<random>`, optional `EXPO_ACCESS_TOKEN`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (two, comma-separated), `PAYMENTS_RETURN_URL`. Never put these in the app or the repo.
8. - [ ] **Deploy functions:**

   ```bash
   npx supabase functions deploy ai
   npx supabase functions deploy ai-assistant
   npx supabase functions deploy payments
   npx supabase functions deploy checkout
   npx supabase functions deploy stripe-webhook --no-verify-jwt
   npx supabase functions deploy notifier --no-verify-jwt
   npx supabase functions deploy inbox --no-verify-jwt
   npx supabase functions deploy public-booking --no-verify-jwt
   ```

9. - [ ] **Vault secrets** (SQL editor) so pg_cron can call the notifier ([push-notifications.md](../supabase/docs/push-notifications.md)):

   ```sql
   select vault.create_secret('https://<ref>.supabase.co/functions/v1/notifier', 'notifier_url');
   select vault.create_secret('<same value as NOTIFIER_SECRET>', 'notifier_secret');
   ```

10. - [ ] **Stripe webhooks**: two destinations to `https://<ref>.supabase.co/functions/v1/stripe-webhook` ([payments.md](../supabase/docs/payments.md) step 9). Stay on **test** keys until the pilot's go-live step.
11. - [ ] **Backups:** confirm daily backups (Database → Backups). Consider Point-in-Time Recovery for the cutover weeks. Take a manual dump before each import: `npx supabase db dump --data-only -f backup-<date>.sql` (keep it out of the repo).
12. - [ ] Smoke check: sign in on the web build against the hosted project, create the salon, check Settings → Notifications and Settings → Payments load.

## 4. First TestFlight build (manual)

1. - [ ] **App Store Connect** → Apps → **+** → New App: iOS, name "Chairside" (must be unique on the store; add a suffix if taken), the production bundle ID, SKU anything. Note the **Apple ID** (numeric `ascAppId`).
2. - [ ] Build and submit. Either push a tag (`git tag v0.1.0 && git push origin v0.1.0`) or run locally from `apps/mobile`:

   ```bash
   npx eas-cli@latest build -p ios --profile production --auto-submit
   ```

   The first run is interactive if done locally: log in with the Apple ID, let EAS create the **distribution certificate**, **provisioning profile** and **APNs key** (say yes to push notifications), and an **App Store Connect API key** for submissions. After that, CI builds run non-interactively. If CI runs first and fails on missing credentials, do this one local run, then use CI.
   Optionally put the numeric ID in `eas.json` → `submit.production.ios.ascAppId` so submits never prompt.
3. - [ ] Wait for processing (App Store Connect → TestFlight). Export compliance is pre-answered (`ITSAppUsesNonExemptEncryption = false`).
4. - [ ] TestFlight → **Internal Testing** → add the stylist (he must be a user on the App Store Connect team, role "Customer Support" or higher; internal testers skip Beta App Review). He installs **TestFlight** from the App Store and accepts the invite.
5. - [ ] On his iPhone: install, sign in (Apple or email code), allow notifications. Settings → Notifications shows **This device: On**.
6. - [ ] Universal links (optional, needs `EXPO_PUBLIC_WEB_URL` on a domain you control): serve this at `https://<domain>/.well-known/apple-app-site-association` (no extension, `application/json`), then rebuild:

   ```json
   {
     "applinks": { "details": [{ "appIDs": ["<TEAMID>.<bundle id>"], "components": [{ "/": "/b/*" }, { "/": "/receipt/*" }] }] },
     "webcredentials": { "apps": ["<TEAMID>.<bundle id>"] }
   }
   ```

## 5. Pilot readiness checklist

Do these with him, on his phone, before the overlap starts.

- [ ] **Services:** his menu is in Chairside with correct durations, processing segments and prices. Import from his Vagaro booking page/screenshot when #16 lands; until then enter them in the service builder (start from the starter menu).
- [ ] **Hours:** weekly template plus known days off (Open / Tentative / Closed).
- [ ] **Clients + future appointments imported** (section 6, first import).
- [ ] **Shortcut bridge working** ([shortcut-bridge.md](shortcut-bridge.md)): Settings → Text bridge shows healthy; a test text containing "Chairside" from another phone creates a request and a push.
- [ ] **Push:** a request push arrives on the lock screen and Approve works without opening the app ([push-notifications.md](../supabase/docs/push-notifications.md#manual-on-device-test)).
- [ ] **Stripe live:** Connect onboarding finished with his real bank account, then switch function secrets to live keys (payments.md step 10) and register live webhooks. Run one real small charge and refund it. Tap to Pay only if #1 is granted (rebuild with `EXPO_PUBLIC_TAP_TO_PAY=1`); otherwise card payments wait and he uses cash/other or Vagaro's reader during overlap.
- [ ] **Public booking page** on (Settings → Booking page) if he'll share the link.
- [ ] **AI key** set (Settings → AI assistant) if he uses the inbox agent / Ask Chairside.
- [ ] Sentry receives a test event (optional).

## 6. Vagaro cutover plan

The importer (#15) is safe to re-run: clients match by email, then phone, then name, and only fill empty fields; appointments carry an `import_key`, so re-importing the same export reports `duplicate` instead of double booking. Past and cancelled rows are skipped. Clashes are listed (`conflict`) instead of booked. Details: [import-vagaro.md](../supabase/docs/import-vagaro.md).

| When | Step |
|---|---|
| **Day −1** | Back up (section 3.11). In Vagaro, export **Customers** and **Appointments Summary** (date range: today → 6 months out). Also download everything you'll want after cancelling (customer list, full appointment history, transactions, forms/formulas) and store it privately; it isn't imported. |
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
| An Edge Function | Redeploy it from the last good commit (`git checkout <sha> -- supabase/functions/<name>` in a scratch branch, then `functions deploy`). |
| Data (bad import, bad migration) | Restore the pre-import dump or a Supabase backup / PITR to a point before the change. Re-run the import afterwards if needed. |
| The pilot itself (go back to Vagaro) | Before day 14 Vagaro is still paid for. Turn its online booking back on and restore the old booking links. List what was booked in Chairside after the freeze and re-enter it in Vagaro (SQL editor, set the salon's timezone):<br>`select a.starts_at at time zone 'America/Chicago' as starts, c.name, c.phone, c.email, a.services->0->>'name' as service, a.status from appointments a left join clients c on c.id = a.client_id where a.starts_at > now() and a.status in ('confirmed','requested') and a.source <> 'import' order by a.starts_at;`<br>Card payments already taken stay in his Stripe account. |
