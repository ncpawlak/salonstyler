# Local development

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
