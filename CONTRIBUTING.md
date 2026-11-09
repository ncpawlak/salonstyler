# Contributing

Features land as separate PRs, often in parallel. The repo is laid out so a new feature adds files instead of editing shared lists. Follow these and two feature PRs rarely touch the same lines.

## How to add a feature without conflicts

| You're adding | Do this | Don't |
|---|---|---|
| A migration | New file in `supabase/migrations/` with a fresh timestamp, plus a new pgTAP file in `supabase/tests/database/`. Then `npm run gen:types --workspace @chairside/db` and commit `database.types.ts`. | Edit an existing migration. |
| Database queries | New module `packages/db/src/<feature>.ts`, imported as `@chairside/db/<feature>`. If an Edge Function uses it, add one line to that function's `deno.json`. | Add exports to `packages/db/src/index.ts` (client and shared types only). |
| A signed-in screen | New file under `apps/mobile/src/app/(app)/`. The URL is the path without `(app)`. | Edit the root `_layout.tsx`. Only touch `(app)/_layout.tsx` if the screen needs options such as `presentation: 'modal'`. |
| A public screen | New file at the top level of `apps/mobile/src/app/` (like `b/`, `receipt/`). | Put it in `(app)/`, which requires sign-in. |
| A Settings row | New file in `apps/mobile/src/features/settings/rows/` exporting `defineSettingsRow({ section, order, ... })`. Pick an unused `order` (they're spaced by 10). | Edit the Settings screen. |
| An Ask Chairside tool | New file in `packages/ai/src/assistant/tools/` exporting `defineTool({ name, order, ... })`, then `npm run gen:tools --workspace @chairside/ai`. | Edit `tools.ts`. |
| Backend docs | New `supabase/docs/<feature>.md` and one line in `supabase/README.md`. | Grow one big README. |

## Generated files

Two files are generated. Don't resolve conflicts in them by hand: take either side, re-run the generator and commit the result. CI and the tests fail if either is stale.

| File | Regenerate with |
|---|---|
| `packages/db/src/database.types.ts` | `npx supabase start`, then `npm run gen:types --workspace @chairside/db` |
| `packages/ai/src/assistant/tools/index.ts` | `npm run gen:tools --workspace @chairside/ai` |

## Before you push

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
npx supabase test db   # with the local stack running
```