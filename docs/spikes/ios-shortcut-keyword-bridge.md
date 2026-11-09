# Spike: iOS Shortcut "Chairside" keyword bridge

Issue: #6, Part 1 (spike). Plan: [`docs/PLAN.md` §4](../PLAN.md#4-agentic-inbox-client-texts-flow-in-automatically), Bridge B.
Status: **desk research done; on-device verification pending** (fill in [§2 results table](#2-on-device-test-protocol-15-min)).
Researched: Nov 2026. Current iOS is **iOS 27** (shipped Sept 2026); many stylists will still be on **iOS 26 / 18**. The recipe covers both UIs.

**Goal:** a client texts the stylist's normal number, e.g. *"Chairside schedule me Dec 18 for a cut"*. An iOS Shortcuts **Message** automation with **Message Contains = "Chairside"** and no confirmation forwards *only that text* (sender + body) to our `/inbox` endpoint via **Get Contents of URL**. iOS apps can't read SMS, so Shortcuts is the only platform-allowed bridge.

**TL;DR:** The concept is supported by Apple's documented features (Message trigger with *Message Contains*, Run Immediately since iOS 17, Get Contents of URL POSTing JSON). The unknowns are details Apple doesn't document: case sensitivity, group-thread behavior, the exact shape of *Sender*, and how reliably it fires while locked. None of them block the design, and the server can absorb most of them. The 15-minute on-device test below settles them.

---

## 1. Findings per spike question

Confidence: **High** = documented by Apple. **Medium** = consistent community reports and/or follows from documented behavior. **Low** = undocumented or conflicting; the on-device test decides.

| # | Question | Expected answer | Confidence | Design impact |
|---|---|---|---|---|
| Q1 | Runs with **Run Immediately**, including when locked? | **Yes.** iOS 17 added Run Immediately to Message triggers [S2][S3]. iOS 27 moved triggers into the shortcut itself: turn **Confirm Before Run** off and turn on **Privacy → Allow Running When Locked** [S3][S4]. iOS still shows a "ran your automation" notification on every run [S2]. | High (supported), **Medium** (locked reliability) | Onboarding must cover the per-version toggles and the one-time **Always Allow** network prompt (see Q5). Health check (Part 2) watches for silent failures. |
| Q2 | Is matching **case-insensitive** (Chairside / chairside / CHAIRSIDE)? | **Probably yes**, but Apple doesn't document it [S1]. Most Apple text "contains" matching is case-insensitive. | **Low** | If it's case-sensitive, add automations for `chairside` and `CHAIRSIDE` too, or pick a lowercase keyword. The server always matches case-insensitively. |
| Q3 | **Autocorrect**: "Chair side"? Need a second automation? | "Chairside" isn't in most keyboards' dictionaries, so iOS may split it into "Chair side" or change it to something else. It may also learn the word after a client uses it once. A substring trigger on "Chairside" will **not** match "Chair side". | Medium | **Yes, plan for a second "Chair side" trigger** (PLAN.md already says so). It costs little: both triggers run the same shortcut. Server strips `chair\s*side` case-insensitively. |
| Q4 | Works for **iMessage (blue) and SMS (green)**? **Group threads** ignored? | The trigger is "when you receive a message" in Messages, for both iMessage and SMS/MMS [S1]. RCS (iOS 18+) also lands in Messages, so it should trigger as well. Some users on iOS 26 report SMS failing to trigger when a **Sender** filter is used and the contact only has an Apple ID saved [S5]. We don't use a Sender filter. **Group threads**: Apple's docs list no group option [S1], so expect the trigger to **fire for group messages too**. | Medium (1:1 blue/green), **Low** (RCS, groups) | Don't add a Sender filter. If groups fire, the Shortcut can't reliably tell that it was a group. The server treats the request as a normal request from that sender; the risk is low because the keyword shows intent. Record the actual behavior in the test. |
| Q5 | Does the Shortcut get **sender + full text**, and can it **POST**? | **Yes.** *Shortcut Input* is a Message with *Content* (full body) and *Sender* properties [S6][S7]. **Get Contents of URL** supports POST with a JSON body and custom headers [S8]. The first network call to a new domain shows an **Allow / Always Allow** prompt. Answer **Always Allow** while unlocked, or locked runs will stall [S4]. *Sender* is a **Contact**: as text it may show the **contact name** for saved clients and the number/email for unknown senders. | High (POST), **Medium** (sender format) | Send the sender **as text** plus best-effort **phone/email**. The server normalizes to E.164 when possible and otherwise matches by name. The test records the exact strings. |

**Additional notes**
- **Privacy guarantee holds:** messages that don't match the trigger never run the shortcut, so they never leave the phone. This is enforced by iOS, not our code.
- **Focus / Do Not Disturb:** Focus doesn't stop a Run Immediately automation, but it can hide the confirmation banner if confirmation is accidentally still on [S4][S5].
- **Automations aren't restored from iCloud on a new phone** (community-reported [S6]). The *shortcut* syncs, the *automation trigger* may not (iOS ≤ 26). Part 2's health check should flag "bridge silent for N days".
- **iOS 27 UI change** [S3][S4]: there's no separate Automation-tab flow; open the shortcut → **Edit → Automation** → add the trigger. Older guides are often wrong for 27.

### Sources
- [S1] Apple, *Communication triggers in Shortcuts on iPhone or iPad*: Message trigger options **Sender** and **Message Contains**; all criteria must match. https://support.apple.com/guide/shortcuts/apdd711f9dff/ios
- [S2] Matthew Cassinelli, *Shortcuts automations now "Run Immediately" in iOS 17*: Messages/Email automations gained Run Immediately and always notify when run. https://matthewcassinelli.com/automations-run-immediately-shortcuts-notifications/
- [S3] Apple, *Add automations to Shortcuts on iPhone or iPad* (iOS 27): Edit → Automation; Privacy → **Allow Running When Locked**; Message is in the list of automations that can run without asking; "you also may need to set individual actions to run automatically." https://support.apple.com/guide/shortcuts/apdfbdbd7123/ios
- [S4] Finny, *Send Message Automation Requires Confirmation: 2026 Fix* (Oct 2026): per-version table (iOS 17 → 27), privacy Always Allow prompt, Focus interactions. https://getfinny.app/blog/shortcut-automation-confirm-send-message-2026
- [S5] minto.tech, *iOS 26 message-trigger troubleshooting* (Japanese, Apr 2026): SMS vs Apple ID sender matching, Focus, background refresh. https://minto.tech/ios26-iphone-shortcuts-personal-automation-message-trigger-fix/
- [S6] r/shortcuts, *How do I make an auto reply to the person who triggers a text message?*: Shortcut Input → **Sender** property; automations aren't backed up to iCloud. https://www.reddit.com/r/shortcuts/comments/1cn9ac2/
- [S7] MacMost, *An Introduction to Shortcuts Automation in macOS Tahoe*: Message trigger input exposes **Content**. https://macmost.com/an-introduction-to-shortcuts-automation-in-macos-tahoe.html
- [S8] Apple, *Shortcuts User Guide → Use Web APIs / Request your first API / Work with JSON*: Get Contents of URL with method, headers, JSON request body. https://support.apple.com/guide/shortcuts/welcome/ios

---

## 2. On-device test protocol (~15 min)

**You need:** the stylist's iPhone (the *receiver*, record its iOS version), a second phone to send from (ideally one iPhone **and** one Android/green-bubble sender, or turn off iMessage on the sender to force SMS), and a laptop running the echo server.

### 2a. Start the echo endpoint (2 min)
```powershell
# from the repo root; Node 18+ is the only requirement
$env:BRIDGE_TOKEN = "spike-test-token"; $env:LOG_FILE = "inbox-echo.log"
node scripts/inbox-echo.mjs
```
```bash
BRIDGE_TOKEN=spike-test-token LOG_FILE=inbox-echo.log node scripts/inbox-echo.mjs
```
Expose it so the phone can reach it (pick one):
- **Same Wi-Fi:** use `http://<laptop-LAN-IP>:8787/inbox` (allow Node through the firewall). The quickest option, but it doesn't test cellular or locked-away-from-home behavior.
- **Public HTTPS tunnel (recommended):** `cloudflared tunnel --url http://localhost:8787` (no account needed) or `ngrok http 8787`. Use the printed `https://…/inbox` URL.

Sanity check from the laptop:
```bash
curl -s -X POST http://localhost:8787/inbox -H "content-type: application/json" -H "X-Bridge-Token: spike-test-token" -d '{"sender":"test","text":"Chairside hi","receivedAt":"2026-01-01T00:00:00Z"}'
```
Open `https://<tunnel>/health` in Safari on the iPhone to confirm it's reachable. `inbox-echo.log` contains client numbers, so delete it after the spike and don't commit it.

### 2b. Build the shortcut + automation (5 min)
Follow [§3 recipe](#3-shortcut-recipe). Run the shortcut **once by hand** while unlocked and choose **Always Allow** on the network prompt.

### 2c. Run the tests (8 min)
Send each text from the sender phone. Wait about 10 s and check the echo console. Unless noted, the receiver is **unlocked, on the home screen, Messages closed**.

| ID | Setup | Send this text | Expect | Fired? (Y/N) | Latency (s) | `sender` value seen | `text` intact? | Notes |
|---|---|---|---|---|---|---|---|---|
| T1 | iMessage, 1:1, saved contact | `Chairside schedule me Dec 18 for a cut` | fires | | | | | |
| T2 | same | `chairside cut fri` | fires if case-insensitive | | | | | |
| T3 | same | `CHAIRSIDE color next week` | fires if case-insensitive | | | | | |
| T4 | same, type it on the sender phone and let autocorrect act | `Chairside` (typed naturally) | record what autocorrect produced | | | | | |
| T5 | same | `Chair side trim Tue` | fires **only** with the "Chair side" trigger | | | | | |
| T6 | same | `can I get a cut friday` (no keyword) | **must NOT fire** | | | | | |
| T7 | receiver **locked**, screen off ≥ 1 min | `Chairside locked test` | fires | | | | | |
| T8 | receiver locked + **Focus/Sleep** on | `Chairside focus test` | fires | | | | | |
| T9 | **SMS (green)**: Android sender or iMessage off | `Chairside sms test` | fires | | | | | |
| T10 | sender is **not a saved contact** | `Chairside unknown sender` | fires; sender = number | | | | | |
| T11 | **group thread** (receiver + 2 others) | `Chairside group test` | record: fires or not | | | | | |
| T12 | 1:1, long text with emoji + line break | `Chairside ✂️ color + trim\nFri after 2?` | text intact, UTF-8 | | | | | |
| T13 | receiver on **cellular only** (Wi-Fi off), locked | `Chairside cellular test` | fires (tunnel URL only) | | | | | |
| T14 | stop the echo server, then send | `Chairside server down` | record: error prompt? silent? | | | | | |

Also record: **iOS version** ______, **device** ______, **did a "Running your automation" notification appear?** ______, **any prompts while locked?** ______.

**Pass criteria for the spike:** T1, T7, T9, T10 fire within ~10 s with the full text and a usable sender. T6 never fires. T2–T5 and T11 just need to be *known*; the design adapts either way (see §1).

When done, paste the table and the `inbox-echo.log` lines (redact client numbers) into this doc under **§5 Results**, and tick the Part 1 boxes on #6.

---

## 3. Shortcut recipe

The keyword trigger and the forwarding logic are separate: one **shortcut** named `Chairside Bridge`, plus one or two **triggers** (Chairside, Chair side) that run it. Part 2 ships the shortcut as an iCloud "Add to Shortcuts" link (see [`../shortcut-bridge.md`](../shortcut-bridge.md) for the shipped v2 recipe, publishing and onboarding). The trigger can't be shared, so onboarding walks the user through it.

### 3a. The shortcut: `Chairside Bridge`
Values in `«»` are placeholders.

1. **Text** → `«https://api.chairside.app/inbox»` → rename the variable to **InboxURL**. (Spike: your tunnel URL.)
2. **Text** → `«salon bridge token»` → rename to **BridgeToken**. (Spike: `spike-test-token`.)
3. **Get Details of Contacts**: Detail = **Phone Number**, input = *Shortcut Input* → **Sender**. Rename the result to **SenderPhone**. (It may be empty for email-only iMessage senders. That's fine.)
4. **Text** → *Shortcut Input* → tap the variable → **Sender**. Rename to **SenderText**. (This is the display name or the raw number/email.)
5. **Text** → *Shortcut Input* → **Content**. Rename to **MessageText**.
6. **Format Date**: Date = **Current Date**, Format = **ISO 8601**, Include Time = on. Rename to **ReceivedAt**.
7. **Get Contents of URL**
   - URL: **InboxURL**
   - Method: **POST**
   - Headers: `X-Bridge-Token` = **BridgeToken**, `Content-Type` = `application/json`
   - Request Body: **JSON** with fields:
     | Key | Type | Value |
     |---|---|---|
     | `sender` | Text | **SenderText** |
     | `senderPhone` | Text | **SenderPhone** |
     | `text` | Text | **MessageText** |
     | `receivedAt` | Text | **ReceivedAt** |
     | `bridgeVersion` | Text | `1` |
8. *(Draft mode v1: stop here. The response is ignored.)* Later auto-reply mode: **Get Dictionary Value** `reply` from the response → **If** it has any value → **Send Message** (*Show Compose Sheet / Show When Run* **off**) to *Shortcut Input → Sender*.

Do **not** add Show Result / Show Notification / Ask actions. They need interaction and will stall a locked run.

Resulting body (the core is `{sender, text, receivedAt}`; `senderPhone` and `bridgeVersion` are additive):
```json
{
  "sender": "Karina M.",
  "senderPhone": "+1 (555) 010-0199",
  "text": "Chairside schedule me Dec 18 for a cut",
  "receivedAt": "2026-12-01T14:03:22-05:00",
  "bridgeVersion": "1"
}
```

### 3b. The trigger(s)

**iOS 27** (triggers live in the shortcut) [S3][S4]:
1. Open `Chairside Bridge` → **Edit** → **Automation** → **Message**.
2. **Message Contains** = `Chairside`. Leave **Sender** empty (any sender).
3. Expand the trigger: Automation **on**, **Confirm Before Run off**.
4. Add a second **Message** trigger with **Message Contains** = `Chair side`, same settings. *(If iOS 27 only allows one Message trigger per shortcut, duplicate the shortcut as `Chairside Bridge (Chair side)` instead. Record which applies.)*
5. Shortcut **ⓘ → Privacy → Allow Running When Locked: on**.

**iOS 17 / 18 / 26** (Automation tab):
1. Shortcuts → **Automation** tab → **+** → **Message**.
2. **Message Contains** = `Chairside` → **Next**.
3. Choose **Run Immediately** (not "Run After Confirmation"). Leave "Notify When Run" as iOS allows.
4. Select the existing shortcut **Chairside Bridge** (don't build actions inline, so the logic stays in one place and syncs via iCloud).
5. Repeat for **Message Contains** = `Chair side`.

**Final step (all versions):** run the shortcut once by hand while unlocked → **Always Allow** for the domain.

---

## 4. Risks & fallbacks

| Risk | Likelihood | Mitigation / fallback |
|---|---|---|
| Matching is case-sensitive (Q2) | Low–Med | Extra triggers for `chairside` / `CHAIRSIDE`; or make the per-salon keyword one that's naturally lowercase. |
| Autocorrect mangles the keyword in other ways (`Chair-side`, `Chairsides`) | Med | Substring matching already covers `Chairsides`. Teach the keyword in every reply ("Next time just text 'Chairside' + what you need ✂️"); station card / QR code prefilled with `sms:«stylist number»&body=Chairside%20`. |
| Automation silently stops (iOS update, new phone, Focus, Low Power, disabled background refresh) | Med | Part 2 **health check**: show "bridge last fired …" in the app and push a warning after N days of silence during business hours; onboarding "send a test message" step. |
| One-time **Always Allow** network prompt never answered → locked runs stall | Med | Onboarding forces a manual test run while unlocked. |
| Group threads fire (Q4) | Med | Acceptable (the keyword shows intent). Server treats it as a 1:1 request from the sender; Draft mode keeps a human in the loop. |
| *Sender* arrives as a contact name, not a number (Q5) | Med | Send both `sender` and `senderPhone`. Server matches name → client record, normalizes numbers to E.164, and flags ambiguous matches for review. |
| Endpoint down / offline phone → text lost | Low–Med | Server is idempotent (dedupe on sender+text+receivedAt). The stylist still has the original text, and **manual capture (#2: share sheet / paste / screenshot)** is always available. Investigate whether Get Contents of URL failures show an error notification (T14). |
| Bridge token leaks (shortcut shared/exported) | Low | Per-salon token, **inbox-write-only** scope, rotatable from settings; rate-limit per token. |
| Apple changes or removes the Message trigger | Low | Bridges C/D (Instagram API, AI booking line) and Bridge E / #2 are channel-independent fallbacks; the `/inbox` contract is shared by all bridges. |
| Clients don't adopt the keyword | Med | Non-keyword texts stay private and untouched; the stylist uses #2 (share sheet) for those, and the booking link moves clients toward self-booking (PLAN.md §4). |

---

## 5. Results

*(Fill in after running §2: iOS version, device, completed table, and conclusions for Q1–Q5. Then update §1's confidence column and tick the Part 1 checklist on #6.)*
