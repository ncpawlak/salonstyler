# Supabase (backend)

Multi-tenant Postgres for Chairside. Every tenant row carries `salon_id`, and RLS scopes access by `salon_members` (see [`docs/PLAN.md` §13](../docs/PLAN.md#13-data-model-all-rows-carry-salon_id-rls-by-membership)).

## Local development

Requires Docker (or Podman with its Docker-compatible socket).

```bash
npx supabase start          # Postgres, Auth, REST, Mailpit; applies migrations + seed.sql
npx supabase status         # URLs and keys (copy into .env, see ../.env.example)
npx supabase db reset       # rebuild the DB from migrations + seed
npx supabase test db        # pgTAP tests in supabase/tests/database
npx supabase db lint        # plpgsql/schema lint
npx supabase stop
```

Local sign-in emails (magic link + 6-digit code) land in **Mailpit**: http://127.0.0.1:54324.

Quick end-to-end check of the first-run flow (sign in → create salon → list salons, plus cross-salon isolation over REST):

```bash
npm install   # from the repo root (npm workspaces)
SUPABASE_ANON_KEY=<publishable/anon key from `npx supabase status`> npm run smoke --workspace @chairside/db
```

## Schema (foundation)

| Table | Purpose | Access (authenticated) |
|---|---|---|
| `salons` | Tenant root: name, unique `slug`, IANA `timezone` | Members read; owners update/delete. Created **only** via `create_salon()` |
| `salon_members` | `(salon_id, user_id, role)`; role = `owner` \| `stylist` | Members read co-members; owners manage; anyone can leave. A salon always keeps ≥ 1 owner |
| `settings` | 1:1 per salon: autonomy (`draft`), booking rules (`booking_window_days` 60, `min_notice_minutes` 120, `slot_grid_minutes` 15), hold expiry / follow-up nudge (24h) | Members read; owners update |
| `work_hours_template` | `(salon_id, weekday 0=Sun..6)`: `blocks` (`{start,end,type: open\|tentative}`) + `breaks`, `HH:MM` salon-local | Members read; owners manage |
| `work_hours_override` | Date or date range (`start_date..end_date`) with `kind` = `custom` (own blocks/breaks) \| `day_off` \| `vacation`. Beats the template; narrower/newer overrides win | Members read; owners manage |
| `audit_log` | Append-only event log | Members read and append as themselves; no update/delete |
| `push_tokens` | Expo push tokens per user per salon | Users manage only their own tokens |

`anon` has no table access; the public booking page will go through Edge Functions.

RPCs (authenticated only):
- `create_salon(p_name, p_slug, p_timezone)`: creates the salon, makes the caller `owner`, creates default `settings`, writes `audit_log`.
- `is_salon_slug_available(p_slug)`: boolean check for the create-salon form.

Helpers in the non-exposed `private` schema: `is_salon_member(salon_id)`, `has_salon_role(salon_id, role)`.

## Schema (service builder, #4)

| Table | Purpose | Access (authenticated) |
|---|---|---|
| `services` | Menu item: name, category, price, `color_tag`, buffers, flags (`consultation_required`, `bookable_online`, `new_clients_only`), `is_combo`, `archived_at` | Members read; owners manage |
| `service_segments` | Ordered `busy` / `processing` / `style` segments of a service **or** an add-on (exactly one of `service_id` / `addon_id`) | Members read; owners manage |
| `service_variants` | e.g. hair length: `delta_minutes` added to busy/style time | Members read; owners manage |
| `service_addons` | Toner, deep conditioning…: own segments, `placement` = `before_finish` \| `end` | Members read; owners manage |
| `service_combo_items` | Ordered services in a combo (`replaces_previous_finish`); no nested combos | Members read; owners manage |

RPCs (authenticated, owners only; write `audit_log`):
- `save_service(p_salon_id, p_service jsonb)`: creates (no `id`) or replaces a service/combo with its segments, variants and items atomically. Uses the `ServiceDefinition` shape from `@chairside/core`. Validates segments the same way the availability engine does.
- `save_service_addon(p_salon_id, p_addon jsonb)`: the same for add-ons.

New salons get the Appendix A starter menu (an `after insert` trigger on `salons` → `private.seed_starter_menu`). Salons that already have services are left alone. Resolution (variants, add-ons, combos) is done in `@chairside/core` (`resolveService` / `resolveCombo`); `@chairside/db` has `listServiceMenu` / `saveService`.

### Adding a tenant table

1. Add a new migration: `npx supabase migration new <name>`.
2. Include `salon_id uuid not null references public.salons(id) on delete cascade`.
3. `enable row level security` and write policies with `private.is_salon_member(salon_id)` / `private.has_salon_role(salon_id, 'owner')`.
4. Regenerate types: `npm run gen:types` in `packages/db`.

`tests/database/00_tenancy.test.sql` fails if any `public` table lacks RLS, lacks a NOT NULL `salon_id`, or is readable by `anon`.

## AI providers (bring your own key)

Owners pick OpenAI, Anthropic or Gemini in **Settings → AI assistant** (`apps/mobile/src/app/settings/ai.tsx`) and paste an API key. The LLM only interprets requests; slot math stays in `packages/core`.

| Object | Purpose | Access (authenticated) |
|---|---|---|
| `ai_provider_config` | 1:1 per salon: provider, model, `monthly_token_budget` (0 = AI off), masked `key_hint` | Members read; written **only** via the RPCs below |
| `ai_usage` | One row per LLM call: provider, model, purpose, input/output tokens | Members read; inserted only by the `ai` Edge Function (service role) |
| `private.ai_provider_secrets` | `salon_id → vault.secrets.id`. The key itself is encrypted in Supabase Vault | No access |

RPCs:
- `save_ai_provider_config(p_salon_id, p_provider, p_model, p_monthly_token_budget, p_api_key?)`: owner only. Writes the key to Vault and returns the public row (never the key). A key is required on first save and when switching provider; omit it to keep the saved key.
- `delete_ai_provider_config(p_salon_id)`: owner only. Also destroys the Vault secret.
- `ai_tokens_used_this_month(p_salon_id)`: members; calendar month in the salon's timezone.
- `get_ai_provider_secret(p_salon_id)`: **service role only** (the Edge Function). Returns the decrypted key.

All LLM calls go through the `ai` Edge Function (`functions/ai`), which verifies the user's JWT, checks membership, enforces the monthly budget, loads the key server-side, calls the provider via `@chairside/ai`, and records usage. Provider errors are returned with the key redacted. Actions: `test` (owner; tests the saved key, or a pasted key before saving) and `chat` (any member).

```bash
npx supabase functions serve ai   # local; uses the local stack's URL and keys automatically
```

Deploy: `npx supabase functions deploy ai`. The function imports `packages/ai/src` through `functions/ai/deno.json`, so deploy from the repo root. `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided by the platform; provider keys are **not** function secrets, they come from Vault per salon.

Provider contract tests replay fixtures in `packages/ai/fixtures` (no network in CI). To re-record against the live APIs: `OPENAI_API_KEY=… ANTHROPIC_API_KEY=… GEMINI_API_KEY=… npm run record:fixtures --workspace @chairside/ai` (keys are redacted from fixtures; review the diff before committing).

## Hosted project setup (manual)

1. Create a project at https://supabase.com/dashboard (region near the salon). Note the project ref.
2. `npx supabase login` then `npx supabase link --project-ref <ref>`.
3. `npx supabase db push` to apply migrations.
4. **Auth → URL configuration:** set Site URL and add redirect URLs `chairside://**` (plus the web URL once deployed).
5. **Auth → Email templates → Magic link:** paste `supabase/templates/magic_link.html` (must include `{{ .Token }}` for the in-app code).
6. **Auth → SMTP:** configure a real sender (e.g. Resend); the built-in sender is heavily rate limited.
7. Put the project URL + anon/publishable key in the app's `.env` (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`). Never ship the service role key.
8. Deploy the AI gateway: `npx supabase functions deploy ai` (see "AI providers" above). Vault is enabled by the migration.

## Sign in with Apple (manual)

Native iOS sign-in uses `expo-apple-authentication` and `supabase.auth.signInWithIdToken({ provider: 'apple', token })`, so no secret is needed for the iOS app itself.

1. Apple Developer → Identifiers: enable **Sign in with Apple** on the app's bundle ID.
2. (Web/public page only) Create a **Services ID** + a Sign in with Apple **key**, then generate the client secret JWT (it expires every 6 months).
3. Supabase dashboard → Auth → Providers → Apple: enable; **Client IDs** = `<bundle id>,<services id>`; secret = the JWT from step 2 (web only).
4. Locally: set `SUPABASE_AUTH_EXTERNAL_APPLE_CLIENT_ID` / `SUPABASE_AUTH_EXTERNAL_APPLE_SECRET` in `.env` and flip `[auth.external.apple] enabled = true` in `config.toml`.

App Store rule: if the app offers any third-party sign-in, it must also offer Sign in with Apple.
