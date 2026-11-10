# Marketing (#27)

Migration `20261109490000_marketing.sql`, function `functions/marketing`, shared logic in `packages/ai/src/marketing` (nudge planning in `nudges.ts`, copy drafting in `copy.ts`, request handling in `handler.ts`), db API `@chairside/db/marketing`, email `packages/notifications/src/server/marketing-email.ts`, app routes `/marketing` (Settings → Marketing) and `/u/<token>` (the client's unsubscribe link).

Three kinds of marketing message, all rows in `marketing_messages`:

- **Rebook nudges** ("Time for a touch-up?"): when a client is due back for their usual service and has nothing booked. The due date comes from the [rebook engine](rebook.md) (`@chairside/core/rebook`, #42): the client's own rhythm, then the service's `rebook_interval_days`, then the typical interval for the service; never the model.
- **Review requests**: a thank-you a few hours after checkout, linking to the salon's review page (`settings.marketing_review_url`, e.g. the Google review link).
- **Campaigns**: one email to every opted-in client (or a slice: recent, lapsed, tags), now or scheduled.

Nudges and review requests are **drafted for the stylist to approve** on the Marketing screen (they can edit or dismiss them). Each has an opt-in **auto-send** toggle. A campaign is approved as a whole when the stylist taps Send now / Schedule.

## Consent

- Only clients with `clients.marketing_opt_in` (the "OK to send marketing" toggle on the client screen) and an email get marketing. The audience, the nudge scan, the review trigger, approving a draft and the final claim all check it, so a client who unsubscribes after a message was queued doesn't get it (`skipped`, `opted_out`).
- Every marketing email has an unsubscribe link (`/u/<clients.marketing_token>`) in the footer and `List-Unsubscribe` headers. With `PUBLIC_FUNCTIONS_URL` set they include an RFC 8058 one-click target (`POST /functions/v1/marketing?token=…`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`), so Gmail and Apple Mail show their own Unsubscribe button.
- Opening `/u/<token>` unsubscribes right away (sets `marketing_opt_in = false`, stamps `marketing_opted_out_at`); the page offers Resubscribe. Turning the toggle back on clears the stamp.
- Transactional client emails ([#10](client-self-service.md): confirmations, reminders, receipts, forms) don't look at `marketing_opt_in` and are unchanged.

## Objects

| Object | Purpose |
|---|---|
| `settings.marketing_nudges_enabled` / `_auto_send` / `marketing_nudge_lead_days` | Nudges on (default), auto-send (default off), send 0–21 days before the due date (default 3) |
| `settings.marketing_reviews_enabled` / `_auto_send` / `marketing_review_url` / `marketing_review_delay_hours` | Review requests on (default; need an https review URL), auto-send (default off), hours after checkout, 0–72 (default 2) |
| `clients.marketing_token`, `clients.marketing_opted_out_at` | The 64-hex unsubscribe token; when they unsubscribed |
| `marketing_campaigns` | Name, subject, body, `audience` (`{tags?, lastVisitWithinDays?, noVisitForDays?}`), `draft → scheduled → sent` (or `cancelled`), `recipient_count` |
| `marketing_messages` | One per client and message: kind, `channel` (`email`; `sms` reserved), subject/body with placeholders, `draft → queued → sending → sent` (or `dismissed`, `skipped`, `failed`), `due_at`, `dedupe_key` (one nudge per visit, one review request per visit, one campaign message per client) |
| `approve_marketing_message`, `dismiss_marketing_message`, `save_marketing_campaign`, `send_marketing_campaign`, `cancel_marketing_campaign`, `marketing_audience_count` | Members (checked inside): the Marketing screen |
| `marketing_nudge_candidates`, `save_rebook_nudges`, `claim_marketing_messages`, `finish_marketing_messages`, `marketing_subscription_by_token`, `set_marketing_subscription_by_token` | Service role only: the `marketing` function |
| `private.marketing_on_completed` (trigger `appointments_marketing_on_completed`) | Drafts (or queues) the review request when a visit becomes `completed`; at most one per client every 180 days |
| `private.marketing_tick` (pg_cron `marketing-tick`, every minute) | Skips nudges for clients who have booked since, expires drafts after 30 days, flips scheduled campaigns to sent, and pokes the function when something is due |
| pg_cron `marketing-nudge-scan` (hourly, `:17`) | Asks the function to scan for clients due a nudge |

Members can read their salon's campaigns and messages; only the RPCs write. Placeholders filled per client at send time: `{firstName}`, `{salonName}`, `{bookingLink}` (`/b/<slug>`), `{reviewLink}`.

## Flow

1. **Scan.** Hourly, `scan` pages through `marketing_nudge_candidates` (each opted-in client's latest completed visit in the last 400 days, salons with nudges on, no future booking, no nudge in the last 21 days). `planRebookNudge` runs `rebookInterval` / `rebookTargetDate` on the visit's services; a nudge is due from `lead_days` before the target until 30 days after. `save_rebook_nudges` stores them as drafts (or queued with auto-send), re-checking consent and bookings.
2. **Approve.** The Marketing screen lists drafts with the client, service and due date. **Approve & send** (optionally after editing) queues it; **Dismiss** drops it.
3. **Send.** `marketing_tick` / an approval pokes `send`. `claim_marketing_messages` first skips queued messages that no longer apply (opted out, no address, booked since, feature off), then claims due ones for the channels the function can deliver. Each goes through its channel's `MarketingChannelSender`; `finish_marketing_messages` records `sent`, `skipped` (permanent provider errors) or a retry with backoff (2^attempts minutes, `failed` after 5).
4. **Campaigns.** "New campaign" → a brief → **Draft it for me** (`draft_copy`: AI when the salon has a provider set up and budget left, metered as `marketing_copy`; otherwise a template) → edit → pick the audience (live count) → Send now or 9 AM on a coming day. `send_marketing_campaign` queues one message per matching client.

Rate limits (`hit_rate_limit`): `view` 120/min per IP; `unsubscribe`/`resubscribe` 120/hour per IP (mail providers POST from shared servers) and 10/hour per token; `draft_copy` 30/hour per salon (then the template).

## Channels and SMS

`MarketingChannelSender` (`packages/ai/src/marketing/types.ts`) is `{ channel, send(message) }`; the function registers the ones it can deliver and `claim_marketing_messages(p_channels)` only claims those, so messages for other channels stay queued. Email is the only sender today. SMS needs the salon's Twilio number (#22): add an `sms` sender in `functions/marketing` (and let campaigns pick the channel); the schema, consent checks (`no_phone`) and queue already handle it.

## Setup

Reuses the notifier's Vault secrets ([Push notifications](push-notifications.md)): `notifier_secret`, and `marketing_url` (optional; defaults to `notifier_url` with `/notifier` replaced by `/marketing`). Email uses the same `EMAIL_FROM` / `PUBLIC_APP_URL` / Resend or SMTP secrets as [client emails](client-self-service.md); without them messages stay queued. Set `PUBLIC_FUNCTIONS_URL` to the function's public URL (`https://<ref>.supabase.co/functions/v1/marketing`) for one-click unsubscribe.

```bash
npx supabase secrets set PUBLIC_FUNCTIONS_URL=https://<ref>.supabase.co/functions/v1/marketing
npx supabase functions deploy marketing --no-verify-jwt
```

Locally, emails land in Mailpit (`supabase status` → Mailpit URL).
