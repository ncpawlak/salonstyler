# Manual capture: paste, share sheet, screenshot (`functions/inbox`, #2)

Bridge E in [`docs/PLAN.md` §4](../../docs/PLAN.md). The fallback for requests the [Shortcut bridge](inbox.md) can't see, such as Instagram DMs, WhatsApp, Messenger, or a text on someone else's phone. The stylist pastes the message, shares it (or a screenshot) from any app, or picks a screenshot. It goes through the **same pipeline** as a forwarded text: parse, match client, engine slot, `capture_inbox_request`. So it shows up as the same Inbox card with a slot held and the same approve, decline or other-time actions.

## API

Same function as the Shortcut, but authenticated with the signed-in member's JWT instead of `X-Bridge-Token`. The salon comes from the body and must be one the caller belongs to.

```http
POST /functions/v1/inbox
Authorization: Bearer <user JWT>
{ "action": "capture", "salonId": "…", "source": "paste" | "share" | "screenshot",
  "text": "Hey! can I get color + trim fri afternoon?",       // text and/or image
  "sender": "Karina Lopez", "senderPhone": "+15550101",       // optional, overrides the screenshot
  "image": { "mimeType": "image/jpeg", "data": "<base64, ≤ 8 MB>" } }
→ 200 { "ok": true, "status": "captured" | "duplicate" | "ignored" | "confirmed", "source": "screenshot",
        "requestId": "…", "appointmentId": "…",
        "read": { "platform": "instagram", "sender": "Karina Lopez", "text": "…", "sentOn": "2026-11-30", "parser": "llm" } }
```

Errors use the `ai` function's shape (`{ "error": { "code", "message" } }`): `401` no or invalid JWT, `403` not a member, `409 not_configured` (no AI key for a screenshot), `422 no_message_found` (the image isn't a conversation), `429 budget_exceeded`, `502` the provider failed.

Flow (`handleManualCapture` in `@chairside/ai/inbox`):

1. **Screenshot only:** the salon's model reads the image with one forced `read_conversation` tool call. It returns the platform, the client's display name (preferred over an @handle so the client match works), a phone if shown, the client's latest messages verbatim, and the date they were sent. It only transcribes. Usage is metered as `purpose = 'inbox_screenshot'` against the salon budget.
2. The text (typed or pasted text is appended to what was read) goes through `captureInboxMessage`, the same code the Shortcut uses. The parse is metered as `inbox`. When the screenshot shows the message was sent earlier, relative days ("Friday", "tomorrow") resolve from that date, not today. The engine still does all slot math.
3. The request is stored with `channel` set to the platform (`instagram`, `whatsapp`, `imessage`, `messenger`, `sms`, `screenshot` if unknown) or the source (`paste`, `share`). The Inbox card shows it ("Instagram DM", "Pasted", …).

There are no test or hand-run branches: an empty or non-request message returns `status: "ignored"` and stores nothing. Duplicates are matched on sender, text and received time like any other request. There is no auto-reply.

## Demo mode

With `CHAIRSIDE_AI_DEMO=1` (local only; see [Inbox agent](inbox.md)), a screenshot is "read" as a fixed Instagram DM from Karina Lopez asking for color and a trim Friday afternoon, and text goes through the rule-based parser. No AI key is needed. Tests use the recorded provider fixtures in `packages/ai/fixtures/<provider>/inbox_screenshot_*.json`.

## App

- **Inbox → Paste request / Screenshot** opens `/capture` (`apps/mobile/src/app/(app)/capture.tsx`). **Paste request** reads the clipboard (text, or an image if one was copied). **Choose screenshot** picks from the library. Pickers and shares are resized to a ≤ 1280 px JPEG on device before upload.
- **iOS Share Extension** ("Save to Chairside" in the share sheet), added by the [`expo-share-intent`](https://github.com/achorein/expo-share-intent) config plugin in `app.config.ts`. It accepts text and one image. It opens the app with `chairside://dataUrl=…`, and `src/app/+native-intent.ts` routes that to `/capture`, which fills the form from the share. The stylist reviews it and taps **Add to Inbox**. If the app isn't signed in, the share is dropped after sign-in; share again.
- Android: paste and screenshot upload work. The Android share target is off (`disableAndroid: true`) until share intents can be routed without a root layout listener.

### Builds (EAS)

The plugin adds a `SavetoChairside…` extension target with bundle ID `<app bundle ID>.share-extension` and App Group `group.<app bundle ID>` per variant (for example `com.chairside.app.dev.share-extension`, `group.com.chairside.app.dev`). It lists them in `extra.eas.build.experimental.ios.appExtensions`, so EAS creates the identifiers, App Group and profiles on the next `eas build` (or run `eas credentials` → iOS → set up all targets). Expo Go can't load share extensions, so use the dev client (`eas build --profile development`).

### On-device check

1. `eas build --profile development --platform ios`, install, and sign in (with an AI key in Settings → AI, or a local stack served with `CHAIRSIDE_AI_DEMO=1`).
2. In Instagram, open a DM asking for an appointment, take a screenshot, tap the thumbnail → Share → **Save to Chairside Dev**. The app opens on Add a request with the screenshot attached. Tap **Add to Inbox**. You should see "Added to your Inbox" and what was read.
3. Inbox shows the card labelled "Instagram DM" with the client matched and a slot held, the same card as forwarding that text through the Shortcut.
4. In Messages, long-press a message → Copy. Then Inbox → **Paste request** → **Paste request** → **Add to Inbox**. A "Pasted" card appears.
5. In Messages or Notes, select text → Share → **Save to Chairside Dev**. It fills the message box and the card says "Shared".
