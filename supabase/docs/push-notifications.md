# Push notifications (#8)

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

## Manual on-device test

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
