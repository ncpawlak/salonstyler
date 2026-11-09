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

### Adding a tenant table

1. Add a new migration: `npx supabase migration new <name>`.
2. Include `salon_id uuid not null references public.salons(id) on delete cascade`.
3. `enable row level security` and write policies with `private.is_salon_member(salon_id)` / `private.has_salon_role(salon_id, 'owner')`.
4. Regenerate types: `npm run gen:types` in `packages/db`.

`tests/database/00_tenancy.test.sql` fails if any `public` table lacks RLS, lacks a NOT NULL `salon_id`, or is readable by `anon`.

## Hosted project setup (manual)

1. Create a project at https://supabase.com/dashboard (region near the salon). Note the project ref.
2. `npx supabase login` then `npx supabase link --project-ref <ref>`.
3. `npx supabase db push` to apply migrations.
4. **Auth → URL configuration:** set Site URL and add redirect URLs `chairside://**` (plus the web URL once deployed).
5. **Auth → Email templates → Magic link:** paste `supabase/templates/magic_link.html` (must include `{{ .Token }}` for the in-app code).
6. **Auth → SMTP:** configure a real sender (e.g. Resend); the built-in sender is heavily rate limited.
7. Put the project URL + anon/publishable key in the app's `.env` (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`). Never ship the service role key.

## Sign in with Apple (manual)

Native iOS sign-in uses `expo-apple-authentication` and `supabase.auth.signInWithIdToken({ provider: 'apple', token })`, so no secret is needed for the iOS app itself.

1. Apple Developer → Identifiers: enable **Sign in with Apple** on the app's bundle ID.
2. (Web/public page only) Create a **Services ID** + a Sign in with Apple **key**, then generate the client secret JWT (it expires every 6 months).
3. Supabase dashboard → Auth → Providers → Apple: enable; **Client IDs** = `<bundle id>,<services id>`; secret = the JWT from step 2 (web only).
4. Locally: set `SUPABASE_AUTH_EXTERNAL_APPLE_CLIENT_ID` / `SUPABASE_AUTH_EXTERNAL_APPLE_SECRET` in `.env` and flip `[auth.external.apple] enabled = true` in `config.toml`.

App Store rule: if the app offers any third-party sign-in, it must also offer Sign in with Apple.
