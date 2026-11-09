# Public booking page (`functions/public-booking`, #14)

The signed-out booking page at `/b/<salon-slug>` (Expo web). The owner turns it on in Settings → Booking page (`settings.public_booking_enabled`, `booking_page_intro`, `booking_page_faq`). The function has no salon JWT (`verify_jwt = false`) and uses the service role, but only through the service-role-only RPCs in `20261109320000_public_booking.sql`. `anon` and `authenticated` can't call them. Logic lives in `@chairside/ai/public-booking` and is unit-tested.

| Action | What it returns |
| --- | --- |
| `page` | Salon name, timezone, intro, FAQ and the **bookable-online** menu (`public_booking_page`). No salon id and no client data |
| `slots` | Open times for the chosen services on one day, from the `packages/core` engine (booking window, min notice, Tentative flag) |
| `send_code` | Emails a 6-digit sign-in code (Supabase Auth OTP). The page verifies it on its own client, stored apart from the owner session |
| `book` | Requires the verified client's JWT. Re-runs the engine for the exact start, then `book_public_appointment` links or creates the client's own profile by verified email (`clients.user_id`) and writes a `confirmed` (Autonomy Auto, Open hours) or `requested` (Draft, Tentative hours or consultation) appointment. Each client may have 3 upcoming public bookings |
| `my_bookings` | The verified client's own upcoming bookings (`public_client_bookings`) |
| `chat` | The client concierge. It uses the salon's key and budget (`purpose = 'concierge'`) with a read-only toolset: `list_services` (bookable-online only), `find_slots` (engine), `get_salon_info` (the FAQ) and `my_bookings` (verified only). It can't book. It returns slot cards, and the client confirms through `book` |

**Abuse protection:** fixed-window limits in `hit_rate_limit` with hashed keys. They cover IP, the email and phone on `send_code`, the user and phone on `book`, and a daily cap on concierge turns per salon. Limited calls return `429`. The IP comes from `CF-Connecting-IP`, then `X-Forwarded-For`; the per-email, phone, user and salon limits backstop spoofed IPs. A confirmed booking pushes **New booking** (`public_booking`) to the owner. A request uses the existing Approve/Decline push (#62).

Local check: serve with `CHAIRSIDE_AI_DEMO=1` (same env file as in [Ask Chairside](ai-providers.md#ask-chairside-functionsai-assistant)) for a rule-based concierge. Read the code from Mailpit (`http://127.0.0.1:54324`).

Deploy: `npx supabase functions deploy public-booking --no-verify-jwt`.
