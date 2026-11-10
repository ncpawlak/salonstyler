# Waitlist (#21)

Migration `20261109430000_waitlist.sql`, function `functions/waitlist`, shared logic in `packages/ai/src/waitlist` (engine matching in `match.ts`, request handling in `handler.ts`), db API `@chairside/db/waitlist`, offer email `packages/notifications/src/server/waitlist-email.ts`, app routes `/waitlist` (Settings → Waitlist) and `/w/<token>` (the client's link).

Clients wait for a day, optionally a part of it. When an appointment is cancelled, the scheduling engine (`@chairside/core`'s `findSlots` / `planBooking`, never the model) checks who fits the freed time, and drafts offers. The stylist sends them (or they go out automatically), and the first client to claim the time gets it.

| Object | Purpose |
|---|---|
| `settings.waitlist_enabled` | Clients can join from the booking page and cancellations are matched (default on) |
| `settings.waitlist_auto_offer` | Opt-in: email offers right away instead of waiting for the stylist (default off) |
| `settings.waitlist_offer_minutes` | How long a sent offer stays open, 15–1440 (default 120) |
| `waitlist_entries` | One per client and day: services (`items`, `services_label`), optional `window_start`/`window_end`, status `waiting → offered → booked` (or `cancelled`, `expired`), and the 64-hex `token` behind `/w/<token>` |
| `waitlist_openings` | A freed time from a cancellation (`pending → offered → filled`/`closed`) |
| `waitlist_offers` | An engine fit for one entry and opening: start/end, segments and service snapshots, `draft → sent → accepted` (or `taken`, `expired`, `withdrawn`) |
| `add_waitlist_entry`, `remove_waitlist_entry`, `send_waitlist_offer`, `dismiss_waitlist_offer` | Members (RLS-checked): the Waitlist screen |
| `claim_waitlist_openings`, `save_waitlist_offers`, `join_waitlist`, `waitlist_by_token`, `leave_waitlist_by_token`, `accept_waitlist_offer` | Service role only: the `waitlist` function |
| `private.waitlist_on_cancel` (trigger `appointments_waitlist_on_cancel`) | Records the opening and pokes the function |
| `private.waitlist_tick` (pg_cron `waitlist-tick`, every minute) | Expires lapsed offers and re-matches their opening, closes past openings and days |

Members can read their salon's rows; only the RPCs write.

## Flow

1. **Join.** On `/b/<slug>`, under the times, "No time that works? Join the waitlist" takes a part of the day (any, morning, afternoon, evening), name, phone and a verified email (the same code sign-in as booking). `join` checks the salon has the waitlist on, the day is within 90 days, the services exist, and the client waits for at most 3 days at a time, then opens `/w/<token>`. The stylist can also add a client from the Waitlist screen.
2. **Cancel.** Any cancellation of a future appointment (the stylist, the client's manage link, a lapsed deposit hold) fires `appointments_waitlist_on_cancel`, which records a `waitlist_opening` if anyone is waiting for that day and POSTs to the function with `pg_net`. It is its own trigger: it doesn't change `private.client_change_policy` / `private.on_client_change` (the #12 policy hook) or any existing trigger.
3. **Match.** `process` claims pending openings and, for each waiting client (oldest first, up to 5 per opening), runs `findSlots` for exactly their services on that day, inside their window, Open hours only, and keeps the start inside the freed time closest to when it began; `planBooking` confirms it. Clients whose services no longer fit get nothing. The stylist gets a "Waitlist" push.
4. **Offer.** Off (default): drafts wait on the Waitlist screen. **Text offer** opens Messages with the `/w/<token>` link (copies on web); **Email offer** sends it from the function. On: offers are emailed at once. A sent offer stays open for `waitlist_offer_minutes`.
5. **Accept.** On `/w/<token>` the client taps **Claim this time**. The function re-plans the time with the engine, then `accept_waitlist_offer` locks the opening and books through `book_appointment` (confirmed, source `owner`, notes "From the waitlist"), so the no-overlap constraint has the last word. The other offers for that time become `taken`. The existing triggers send the confirmation email with the manage link, and the stylist gets a push. If someone else got there first, the client sees "Someone else just took it" and stays on the waitlist.
6. **Expire.** `waitlist-tick` expires lapsed offers; those clients go back to waiting and the opening is matched again, so the next people in line get a chance. Entries expire after their day.

Rate limits (`hit_rate_limit`): `view` 60/min per IP; `join` 10/hour per IP and per user; `accept`/`leave` 20/hour per IP and 10/hour per token; a member's "Check now" 20/min.

## Setup

The waitlist reuses the notifier's Vault secrets ([Push notifications](push-notifications.md)): `notifier_secret`, and `waitlist_url` (optional; defaults to `notifier_url` with `/notifier` replaced by `/waitlist`). Offer emails use the same `EMAIL_FROM` / `PUBLIC_APP_URL` / Resend or SMTP secrets as [client emails](client-self-service.md); without them, emailing an offer fails and texting still works.

```bash
npx supabase functions deploy waitlist --no-verify-jwt
```

Locally, serve functions as in [Client self-service](client-self-service.md#locally) and set the Vault secret `waitlist_url` to `http://host.docker.internal:54321/functions/v1/waitlist`.

## Manual test

1. Settings → Waitlist: on, auto-offer off.
2. Book a client for tomorrow 10:00. Signed out, on `/b/<slug>`, pick tomorrow, tap **Join waitlist**, choose Morning, verify your email; you land on `/w/<token>` ("On the waitlist").
3. Cancel the 10:00 booking (as the stylist or from its `/m/<token>` link). Within seconds the Waitlist screen shows "Opening fits: tomorrow · 10:00 AM" and the stylist gets a push.
4. Tap **Email offer** (or **Text offer**). Mailpit has the offer; `/w/<token>` shows "A spot opened up!".
5. Tap **Claim this time**: the client is booked, gets the confirmation email, and the calendar shows the appointment. A second waitlisted client's offer now shows "taken".
6. Turn auto-offer on and repeat step 3: the offer email goes out without step 4.
