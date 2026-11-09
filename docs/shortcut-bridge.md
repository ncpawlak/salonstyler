# iOS Shortcut bridge: install, onboarding and health

Issue: #6, Part 2. The spike and its on-device test protocol are in [`spikes/ios-shortcut-keyword-bridge.md`](spikes/ios-shortcut-keyword-bridge.md). The `/inbox` contract is in [`supabase/README.md`](../supabase/README.md#inbox-agent-functionsinbox-34).

A client texts the stylist's normal number: _"Chairside cut Friday afternoon"_. A Shortcuts **Message** trigger (Message Contains `Chairside`, plus `Chair side` because autocorrect splits the word) runs the **Chairside Bridge** shortcut. The shortcut POSTs the text to `/functions/v1/inbox` with the salon's `X-Bridge-Token`. Texts without the keyword never run it, so they never leave the phone.

## Pieces

| Piece | Where |
|---|---|
| Version, trigger phrases, replies, health rules | `packages/ai/src/inbox/shortcut.ts` (`@chairside/ai/shortcut`, shared by the server and the app) |
| Server: test messages, help reply, auto-reply, queued `replies` (#7), version tracking | `packages/ai/src/inbox/handler.ts`, migration `20261109290000_shortcut_bridge.sql` |
| Guided setup (about 1 min) | App → Settings → Text bridge → **Set up** (`apps/mobile/src/app/settings/text-bridge-setup.tsx`) |
| Health, auto-reply toggle | Settings → Text bridge; a banner on the Inbox tab |
| Station card (QR code that opens Messages with "Chairside " typed) | Settings → Text bridge → Station card |
| Keyword teaching | Every auto-reply and the confirmation offered after approving a texted request end with _Next time just text "Chairside" + what you need_ |

## The shortcut (v3)

Version 3 is what `BRIDGE_SHORTCUT_VERSION` expects. It adds step 9, which texts the confirmations queued by auto-send (#7, Settings → Client replies). Version 2 has only the `reply` step (8). Version 1 is the spike recipe: it has no reply step and sends `bridgeVersion: "1"`. The server hands queued `replies` only to v3+ (`OUTBOX_BRIDGE_VERSION`), so an older Shortcut never makes a confirmation look sent when it isn't.

**Details (ⓘ):** Receive **Messages**. **If there's no input: Continue**, so a hand run reaches the server with an empty `text` and counts as a test. **Privacy → Allow Running When Locked: on** (iOS 27).

1. **Text** `«https://<project>.supabase.co/functions/v1/inbox»` → rename **InboxURL**. Import Question: _"Inbox URL. Keep as is."_ with the production URL as the default.
2. **Text** `«paste token»` → rename **BridgeToken**. Import Question: _"Bridge token. Paste it from the Chairside app."_
3. **Get Details of Contacts**: Phone Number of _Shortcut Input → Sender_ → **SenderPhone**.
4. **Text**: _Shortcut Input → Sender_ → **SenderText**.
5. **Text**: _Shortcut Input → Content_ → **MessageText**.
6. **Format Date**: Current Date, ISO 8601, include time → **ReceivedAt**.
7. **Get Contents of URL**: InboxURL, **POST**, headers `X-Bridge-Token: BridgeToken` and `Content-Type: application/json`. JSON body: `sender` SenderText, `senderPhone` SenderPhone, `text` MessageText, `receivedAt` ReceivedAt, `bridgeVersion` `3`.
8. **Get Dictionary Value** `reply` from _Contents of URL_ → **If** _has any value_ → **Send Message** _Dictionary Value_ to _Shortcut Input → Sender_ (Show When Run **off**). → **End If**.
9. **Get Dictionary Value** `replies` from _Contents of URL_ → **Repeat with Each** → **Send Message** _Repeat Item → text_ to _Repeat Item → to_ (Show When Run **off**). → **End Repeat**. Usually empty; with auto-send on it holds confirmations approved since the last call.

**Optional outbox automation:** queued confirmations otherwise go out with the next keyword text. To send them sooner, add a second automation (for example, when the Chairside app closes) that runs a copy of steps 1, 2, 7 and 9 with the JSON body `{"action": "outbox"}`.

Don't add Show Result, Show Notification or Ask actions: they stall a locked run. The server sends `reply` only when the salon turns **Auto-reply** on, and `replies` only with **Auto-send** on, so switching modes never needs a reinstall.

## Publishing it

Apple doesn't let an app create or sign a shortcut for each user. So one shared shortcut is published, and each user pastes their own token at the Import Question. Setup copies the token to the clipboard just before opening the link.

1. On a Mac or iPhone signed in to the Chairside Apple ID, build v3 as above. Use the production `InboxURL` and leave `BridgeToken` as `paste token`.
2. Pick one:
   - **iCloud link (recommended):** Share → **Copy iCloud Link**. You get `https://www.icloud.com/shortcuts/<id>`.
   - **Signed file:** File → Export, then `shortcuts sign --mode anyone --input "Chairside Bridge.shortcut" --output chairside-bridge-v3.shortcut`. Host it over HTTPS.
3. Set `EXPO_PUBLIC_BRIDGE_SHORTCUT_URL` to that URL for the app build (see `apps/mobile/.env.example`). Without it, setup shows the build-it-yourself recipe instead.

**Versioning:** every change to the shortcut bumps `BRIDGE_SHORTCUT_VERSION` and the `bridgeVersion` sent in step 7, and gets a new link. The server records the version each call reports (`inbox_bridges.last_bridge_version`), and the app shows "update available" when it's older. Adding the new link and choosing **Replace** keeps the triggers. Keep the request body backward compatible: old shortcuts keep posting until they're updated.

## Onboarding (in the app)

1. **Token**: generate it and copy it to the clipboard. Regenerating warns that the old shortcut stops working.
2. **Add the Shortcut**: open the published link and paste the token at the Import Question.
3. **Trigger**: per-iOS instructions with a drawn mock of the settings to look for. iOS 27: _Edit → Automation → Message_, Confirm Before Run off, Allow Running When Locked. iOS 17–26: _Automation tab → Message → Run Immediately_. One trigger per phrase, no Sender filter.
4. **Always Allow**: run the shortcut once by hand. The app waits until the server sees that run (`last_test_at`).
5. **Test text**: from another phone, text _"Chairside test"_ to the iPhone (ideally locked). The app polls every 2 s and shows a green check when it arrives. Test texts never create a request.

## Health

- **Last fired**: `last_received_at`, stamped on every authenticated call.
- **Check it**: nothing for `BRIDGE_STALE_DAYS` (7). Triggers aren't restored on a new phone, and a changed setting can silently stop them. The Inbox tab shows a banner that links to setup.
- **Update available**: `last_bridge_version` < `BRIDGE_SHORTCUT_VERSION`.

## Needs a human on an iPhone

These can't be automated or checked in a browser:

- [ ] Build and publish v3 (above) and set `EXPO_PUBLIC_BRIDGE_SHORTCUT_URL`. Confirm the Import Questions appear and the pasted token sticks.
- [ ] Run the spike's [§2 test protocol](spikes/ios-shortcut-keyword-bridge.md#2-on-device-test-protocol-15-min) against the real `/inbox` and fill in §5 Results. Most important: locked, Focus, cellular, and **case**. `CHAIRSIDE` and `chairside` haven't been confirmed to match Message Contains `Chairside`. If they don't, add triggers for those spellings and extend `triggerPhrases`.
- [ ] iOS 27: confirm two Message triggers can live on one shortcut. If not, use a duplicate shortcut for `Chair side`.
- [ ] Turn on Auto-reply and confirm **Send Message** sends without a prompt while locked. If iOS asks, also turn on _Allow Running When Locked_ for that action, or leave Auto-reply off.
- [ ] Hand run with no input reaches the server as a test ("If there's no input: Continue").
- [ ] Print the station card and scan the QR code with an iPhone and an Android phone. Messages should open to the salon number with "Chairside " typed.
- [ ] Turn on auto-send (Settings → Client replies), approve a texted request, then send another keyword text or run the outbox automation. The client should get the confirmation once.
