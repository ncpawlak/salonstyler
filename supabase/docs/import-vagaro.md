# Import from Vagaro (#15)

The Settings → Import from Vagaro wizard (`apps/mobile/src/app/(app)/import`) reads a Vagaro **Customers** or **Appointments Summary** export (.xlsx or CSV) on the device. The only AI step is the column mapping: the `ai` function's `map_columns` action gets the headers plus 3 **masked** samples per column (`redactSample`) and returns `{ mapping, source }`. Masking keeps an email's domain only and replaces digits with `#` and most letters with `x`. `sanitizeColumnMapping` drops unknown fields and out-of-range or duplicate columns. Usage is metered as `purpose = 'import_mapping'`. If there's no key (`409 not_configured`), the budget is spent, or the provider fails, the app falls back to `guessColumnMapping` (header synonyms) and the owner confirms or fixes every column. Parsing and validation (names, phones, dates, Excel serials, durations, prices, cancelled/past rows) are deterministic code in `packages/core/src/import`.

| Object | Purpose |
|---|---|
| `clients.birthday`, `imported_last_visit_on`, `imported_no_show_count` | Vagaro history. `client_summaries` uses the imported last visit and no-shows until real visits exist. |
| `appointments.import_key` | Unique per salon (partial index). Makes appointment imports idempotent. |
| `private.phone_key(text)` | Last 10 digits; indexed on `clients` for phone dedupe. |

RPCs (members; `security definer`, salon membership checked):
- `import_clients(p_salon_id, p_clients jsonb)` (≤500 per call): matches by email, then phone, then exact name when neither is given. Creates missing clients; for existing ones it only **fills empty fields** and adds tags (notes are appended once). Per row it returns `created | updated | unchanged | invalid` with the `clientId`.
- `import_appointments(p_salon_id, p_appointments jsonb)` (≤200 per call): books each one through `book_appointment` as `confirmed`, `source = 'import'`, on the caller's calendar. Per row it returns `booked | duplicate` (same `import_key`) `| past | conflict | invalid`. A conflict (the busy-time exclusion constraint) isn't booked; it reports the clashing appointment's id, start and client name so the app can list it. Writes one `audit_log` row per call.

Local check without a key: serve `ai` with `CHAIRSIDE_AI_DEMO=1` (same env file as in [Ask Chairside](ai-providers.md#ask-chairside-functionsai-assistant)). `map_columns` then returns the header-synonym mapping with `source: "demo"`. Sample exports are in `packages/core/src/import/fixtures`.
