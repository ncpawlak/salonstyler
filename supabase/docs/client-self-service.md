# Client self-service (#10)

Migration `20261109350000_client_self_service.sql`, functions `functions/manage-booking` and `functions/notifier`, shared logic in `packages/ai/src/manage-booking` and `packages/notifications/src/server/{client-email,ics,smtp}.ts`, app route `/m/<token>`.

| Object | Purpose |
|---|---|
| `appointments.manage_token` | 64-hex (256-bit) token per appointment, the only credential for the client's manage link `/m/<token>` |
| `appointments.text_reminder_sent_at` | Set when he texts the client from the reminder queue on Today |
| `settings.client_emails_enabled` | Email clients (default on). Settings → Client emails |
| `settings.client_reminder_hours` | Reminder lead times in hours, up to 3, each 1–168 (default `{48,2}`). Empty = no reminder emails |
| `settings.client_self_service_enabled` | Clients may cancel or move from their link (default on). Off: the link shows the appointment and "Contact the salon" |
| `client_email_outbox` | One row per email (`confirmation`, `reminder`, `rescheduled`, `cancellation`). `dedupe_key` is unique; members can read their salon's rows, only triggers, cron and the service role write |
| `manage_booking`, `cancel_booking_by_token`, `reschedule_booking_by_token` | Service-role RPCs for the `manage-booking` function. Each only touches the appointment behind the token |
| `reminder_queue(salon, day?)`, `mark_text_reminder_sent(appt, sent)` | Members: tomorrow's confirmed clients (or `day`), with phone and manage token |
| `private.client_change_policy`, `private.on_client_change` | Cancellation-policy hook (see below) |

## Emails

- A trigger on `appointments` queues a **confirmation** (with an `.ics` invite) when a booking becomes `confirmed` (Vagaro imports excluded), **rescheduled** (updated `.ics`) when a confirmed booking moves to another day or by an hour or more, and **cancellation** (`.ics` with `METHOD:CANCEL`) when a confirmed booking is cancelled. Every email carries the manage link, except the cancellation, which links to the salon's booking page.
- pg_cron job `client-emails-tick` (every minute) queues **reminders** for confirmed appointments `client_reminder_hours` before the start (only the nearest due one, so a late booking or a missed tick never sends two), then `pg_net` POSTs to the notifier if anything is due. It is a separate job, like `payout-summary-tick`, so it doesn't redefine `notifications_tick`. It uses the same `notifier_url` / `notifier_secret` Vault secrets as push.
- The `notifier` function drains pushes and then emails (`claim_client_emails` / `finish_client_emails`). Claiming skips stale rows: the appointment moved or was cancelled since it was queued, it has started, the client has no email, or the salon turned emails off. Failed sends retry with backoff (2^attempts minutes), up to 5 attempts; permanent rejections (SMTP 5xx, Resend 4xx other than 429, e.g. a bad address) are skipped at once with the error recorded.
- Email is only sent to the client's own address on file (`clients.email`).

### Setup (manual)

Email needs a sender. Pick one; Resend is preferred because hosted Edge Functions often can't reach SMTP ports 25/587.

```bash
# Resend (verify your domain in Resend first)
npx supabase secrets set EMAIL_FROM="Studio K <hello@yourdomain.com>" PUBLIC_APP_URL=https://app.yourdomain.com RESEND_API_KEY=re_...

# or SMTP (port 465 = TLS, 587 = STARTTLS; override with SMTP_SECURITY=tls|starttls|none)
npx supabase secrets set EMAIL_FROM="Studio K <hello@yourdomain.com>" PUBLIC_APP_URL=https://app.yourdomain.com \
  SMTP_HOST=smtp.example.com SMTP_PORT=465 SMTP_USER=... SMTP_PASS=...
```

`PUBLIC_APP_URL` is the web app's origin, used for manage links. Without `EMAIL_FROM` and `PUBLIC_APP_URL` (or without a provider), emails stay queued and the notifier reports `emails: { skipped: "email_not_configured" }`; pushes are unaffected. The notifier's Vault secrets are set up as in [Push notifications](push-notifications.md).

Deploy the manage link API:

```bash
npx supabase functions deploy manage-booking --no-verify-jwt
```

The app needs `EXPO_PUBLIC_WEB_URL` (the same origin) so texted reminders link to the web build.

### Locally

Mailpit catches every email. With the stack running:

```bash
cat > supabase/functions/.env.local <<'EOF'
NOTIFIER_SECRET=dev
EMAIL_FROM=Chairside <noreply@chairside.test>
PUBLIC_APP_URL=http://localhost:8081
SMTP_HOST=supabase_inbucket_chairside
SMTP_PORT=1025
EOF
npx supabase functions serve --env-file supabase/functions/.env.local
```

Set the Vault secrets to `http://host.docker.internal:54321/functions/v1/notifier` and `dev` (or POST to the notifier yourself with `x-notifier-secret: dev`), then open Mailpit at http://127.0.0.1:54324. `SMTP_HOST` is the Mailpit container's name on the stack's Docker network (`supabase_inbucket_<project_id>`).

## The manage link

`/m/<token>` is a public route (outside `(app)/`, no sign-in). It calls `functions/manage-booking` (`verify_jwt = false`):

- `view`: salon name and timezone, services, time, status, the client's first name and what they may do. No ids, no other clients.
- `slots`: open times for the same services (same segments and durations) around a date, from `@chairside/core`'s `findSlots`. Open hours only: Tentative-hour slots need the stylist's approval, so they aren't offered. Busy time comes without names.
- `reschedule`: re-checks the picked start with `planBooking` (lead time, booking window, no overlap), then `reschedule_booking_by_token` re-checks the shape, Tentative hours and the no-overlap constraint, moves it, audits, and pushes the stylist "<client> moved their appointment". The trigger sends the client a "rescheduled" email.
- `cancel`: `set_appointment_status(…, 'cancelled')`, so the slot frees at once and the existing "<client> cancelled" push reaches the stylist; the client gets a cancellation email.

Rate limits (`hit_rate_limit`): `view` and `slots` 60/min per IP; `cancel`/`reschedule` 20/hour per IP and 6/hour per token.

## Cancellation policy hook (for #12)

`private.client_change_policy(appointment, action)` returns `{ allowed, reason?, message?, feeCents }` for `view`, `cancel` and `reschedule`. Today it only refuses when self-service is off or the appointment has started. `private.on_client_change(appointment, action, policy)` runs after a client cancels or moves, with the policy that allowed it; today it does nothing. #12 replaces both with `create or replace` to add a cutoff window, show the policy text (`message`), and charge `feeCents` (e.g. keep the deposit). The manage page already shows `message` and warns about a fee before cancelling.

## Reminder queue

Today shows "Remind tomorrow" with tomorrow's confirmed clients. Tapping **Send** opens Messages with a reminder and the manage link prefilled (on web it copies the text), then marks it reminded (`mark_text_reminder_sent`; tap undo to clear).

## Manual test

1. Settings → Client emails: on, reminders 48h and 2h. Give a client your email.
2. Book them for tomorrow, confirmed. Within a minute Mailpit (or your inbox) has a confirmation with an `.ics` that adds to Calendar.
3. Open the link signed out: the appointment shows. **Reschedule**: pick a time; the stylist gets a push and the client a "rescheduled" email with an updated invite. **Cancel**: the slot frees, the stylist gets the cancellation push and the client a cancellation email.
4. Book one starting in 90 minutes: the 2h reminder arrives on the next tick; the 48h one is skipped.
5. Today → Remind tomorrow: tap Send, check the prefilled text and link, and that the row shows Reminded.
