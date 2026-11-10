# Inbox agent (`functions/inbox`, #34)

The endpoint the salon's iOS Shortcut forwards keyword texts to (see [`docs/shortcut-bridge.md`](../../docs/shortcut-bridge.md) and the spike in `docs/spikes/ios-shortcut-keyword-bridge.md`). It has no user JWT (`verify_jwt = false`). The `X-Bridge-Token` header identifies the salon, and the body is never used for that. The owner generates the token in Settings → Text bridge (`rotate_inbox_bridge_token`). Only its SHA-256 is stored in `inbox_bridges`, and the plain token is shown once. Each token is limited to 60 texts per hour.

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

**Draft-then-approve:** besides those acknowledgements, nothing is sent to the client without the stylist (see [Client replies](client-replies.md)). The stylist approves or declines the held slot in the Inbox tab. A trigger then marks the request approved, declined or expired, keeps the new client on confirm, and cancels the old appointment for an approved reschedule. Cancel requests have a **Cancel appointment** action (`resolve_captured_request`). Duplicates are matched on sender, text and `receivedAt`. Non-requests ("thanks!") store nothing.

Local check without a key: serve with `CHAIRSIDE_AI_DEMO=1` (same env file as in [Ask Chairside](ai-providers.md#ask-chairside-functionsai-assistant)). The function then uses a rule-based parser and needs no AI provider.

```bash
curl -X POST http://127.0.0.1:54321/functions/v1/inbox -H "X-Bridge-Token: csb_…" \
  -H 'Content-Type: application/json' \
  -d '{"sender":"Dana","senderPhone":"+13125550199","text":"Chairside cut fri afternoon?","bridgeVersion":"1"}'
```

Deploy: `npx supabase functions deploy inbox --no-verify-jwt`.

The same function also takes signed-in **manual captures** (paste, share sheet, screenshot read by a vision model). See [Manual capture](manual-capture.md).
