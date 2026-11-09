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
- 📥 **Import from Vagaro:** clients and upcoming appointments from Excel/CSV exports, with AI column mapping, a preview, and no duplicates on re-import (services next).
- 🧴 **Inventory:** products, barcode scanning, low-stock alerts, per-service product usage.
- ⏱️ **Processing timers** on the lock screen / Dynamic Island, plus home-screen widgets.
- 🏃 **Running late?** One tap or "I'm 15 late" and Chairside drafts texts to every affected client.
- 🔁 **Rebook at checkout**, 🗣️ **Siri** commands, 📊 **reports**, 💼 **booth-renter finances**, 📝 **intake & consent forms**, 📤 **full data export**.
- ✨ **Minimal, native-feeling UI:** 4 tabs + "Ask Chairside" everywhere, light/dark mode, accessible. Custom branding comes later.

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
packages/db/          typed Supabase client + generated DB types
supabase/migrations/  schema, RLS, constraints (see supabase/README.md)
supabase/functions/   inbox, ai-assistant, public-booking, notifier, stripe-webhook, import
docs/                 plan & design docs
```

## Getting started
Requires **Node 22.12+** (see `.nvmrc`) and npm. This is an npm workspaces monorepo: run everything from the repo root.

```bash
npm install
npm run dev               # Expo dev server + opens the app in your browser
```

**On an iPhone:** install [Expo Go](https://apps.apple.com/app/expo-go/id982107779), run `npm run dev` (or `npm run ios`), and scan the QR code in the terminal with the Camera app. Your phone and computer must be on the same Wi‑Fi (otherwise run `npx expo start --tunnel` from `apps/mobile`). Features that need native modules outside Expo Go will later require a development build (`npx eas-cli build --profile development`).

| Command | What it does |
|---|---|
| `npm run dev` | Start the app on web (extra flags pass through, e.g. `npm run dev -- --port 8082`) |
| `npm run ios` | Start the Expo dev server for iOS |
| `npm run typecheck` | `tsc --noEmit` in every workspace |
| `npm run lint` | ESLint (Expo config + Prettier compat) |
| `npm run format` / `format:check` | Prettier write / check |
| `npm test` | Vitest in `packages/*` |

CI (`.github/workflows/ci.yml`) runs typecheck, lint, format check, and tests on every PR. A second job starts Supabase, runs the pgTAP tests (`supabase test db`) and fails if `packages/db/src/database.types.ts` is stale. Working on a feature in parallel with others? See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to add one without merge conflicts.

**Stack in `apps/mobile`:** Expo SDK 58 · Expo Router (routes in `src/app/`) · NativeWind 4 (Tailwind classes via `className`) · TanStack Query · Zod. Shared code lives in `@chairside/core` and `@chairside/ai` (`packages/*`), imported directly as TypeScript source.

**Backend (Supabase):** requires Docker. `npx supabase start` runs Postgres, Auth, and REST locally and applies migrations; copy keys from `npx supabase status` into `.env` (see `.env.example`). Details in [`supabase/README.md`](supabase/README.md).

**Running the app against local Supabase:** copy `apps/mobile/.env.example` to `apps/mobile/.env` and paste the API URL plus the publishable (anon) key from `npx supabase status`. Then run `npm run dev`. To sign in, enter any email and read the 6-digit code from Mailpit at <http://127.0.0.1:54324>. On first sign-in you create a salon (name, booking link, timezone) and land on home. In code, `useSession()` / `useCurrentSalon()` (`apps/mobile/src/providers/session-provider.tsx`) give you the signed-in user and the current `salon_id`. Sign in with Apple appears only in iOS builds. It needs the Apple capability and the Supabase Apple provider, configured as described in [`supabase/docs/sign-in-with-apple.md`](supabase/docs/sign-in-with-apple.md).

## Roadmap
Work is tracked as GitHub issues, one per feature, each landing as its own PR. Phases:
0 Foundation → 1 Services + Calendar → 2 Agentic Inbox → 3 Payments → 4 Public booking → 5 Vagaro import + Clients → 6 TestFlight pilot → 7 Inventory → 8 SaaS launch → v2.

See [`docs/PLAN.md`](docs/PLAN.md#16-roadmap) for details.
