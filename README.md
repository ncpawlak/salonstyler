# Chairside ✂️

**The AI-first booking app for independent stylists.** It's a cheaper, smarter replacement for Vagaro, built around one idea: *a client texts, and the app works out where the appointment fits.*

> Status: **planning complete, build starting.** See [`docs/PLAN.md`](docs/PLAN.md) for the full product & technical plan.

---

## Why
Stylists get texts like *"can I get a balayage + trim next Friday afternoon?"* and have to work out in their heads how long that takes, where the processing gaps fall, and what's open. Chairside does that automatically:

1. **Agentic Inbox:** client texts to his normal iPhone number are forwarded (via an iOS Shortcut) to Chairside's AI.
2. The AI understands the request (who, which services, when), and a **deterministic availability engine** finds slots that fit, including color processing time.
3. He gets a push: *"Karina · Color + Trim · Fri 1:30?"* → **Approve / Edit / Decline** → the reply goes out from his own number.

## Features (v1)
- 📅 **Calendar:** weekly hours plus per-day overrides, with **Open / Tentative / Closed** time. Day donut, week bars, and month "how busy am I" heatmap.
- 💇 **Service builder:** services made of timed segments (apply → *process* → style), variants by hair length, add-ons, and combos. Booking auto-blocks the right time.
- 🤖 **AI assistant:** "schedule Karina for December 18th" → slots on that day and nearby days. Bring your own OpenAI / Anthropic / Gemini key.
- 📲 **Agentic Inbox:** iOS Shortcut bridge, push approvals, editable replies, 1-day follow-up nudges (adjustable), auto-reply toggle.
- 🌐 **Public booking page:** clients self-book, get confirmations and reminders, and can cancel.
- 💳 **Payments:** Tap to Pay on iPhone checkout after the service (Stripe), plus optional deposits.
- 📥 **Import from Vagaro:** clients, services, and upcoming appointments.
- 🧴 **Inventory:** products, barcode scanning, low-stock alerts, per-service product usage.

## Tech stack
| Layer | Choice |
|---|---|
| App | Expo (React Native) + TypeScript + Expo Router, iPhone first, web for local testing + public booking |
| Backend | Supabase: Postgres (RLS, multi-tenant), Auth, Edge Functions, Storage, pg_cron, Vault |
| AI | Provider adapters for OpenAI, Anthropic, Gemini (tool calling + vision) |
| Payments | Stripe Connect + Stripe Terminal (Tap to Pay on iPhone) |
| Notifications | Expo Push, Resend (email) |

## Repo layout (planned)
```
apps/mobile/          Expo app (owner app + public booking routes)
packages/core/        availability engine, service/segment math, shared schemas
packages/ai/          LLM provider adapters, agent tools, prompts
supabase/migrations/  schema, RLS, constraints
supabase/functions/   inbox, ai-assistant, public-booking, notifier, stripe-webhook, import
docs/                 plan & design docs
```

## Getting started
_Coming in Phase 0._ Planned commands:
```bash
npm install
npx supabase start        # local Postgres + functions
npm run dev --workspace apps/mobile -- --web   # run the app in a browser
```

## Roadmap
Work is tracked as GitHub issues, one per feature, each landing as its own PR. Phases:
0 Foundation → 1 Services + Calendar → 2 Agentic Inbox → 3 Payments → 4 Public booking → 5 Vagaro import + Clients → 6 TestFlight pilot → 7 Inventory → 8 SaaS launch → v2.

See [`docs/PLAN.md`](docs/PLAN.md#16-roadmap) for details.
