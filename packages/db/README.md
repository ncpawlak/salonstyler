# @chairside/db

Typed Supabase client for Chairside apps and scripts.

The root entry (`@chairside/db`) holds only the client (`createChairsideClient`, `ChairsideClient`) and the shared database types (`Database`, `Tables`, row aliases). Each feature's queries live in their own module and are imported by path: `@chairside/db/<module>` maps to `src/<module>.ts` (e.g. `@chairside/db/appointments`, `@chairside/db/work-hours`). A new feature adds a new file; there is no shared export list to edit. Edge Functions list each module they use in their `deno.json` import map.

```ts
import { createChairsideClient } from '@chairside/db';
import { createSalon, listMySalons } from '@chairside/db/salons';

const supabase = createChairsideClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!);
const salons = await listMySalons(supabase); // [] => first run: show "Create your salon"
await createSalon(supabase, { name: 'Karina Hair', slug: 'karina-hair', timezone: 'America/Chicago' });
```

Work hours (`@chairside/db/work-hours`): `getWorkHours(client, salonId)` loads the template, overrides and booking rules; pass the rows plus the salon `timezone` to `buildWorkHours({ timeZone, template, overrides })` from `@chairside/core/hours` to get the engine's `WorkHours`. Save with `saveWorkHoursTemplate`, `upsertWorkHoursOverride`, `deleteWorkHoursOverride` and `updateBookingRules`.

Notifications (`@chairside/db/notifications`): `getNotificationSettings` / `updateNotificationSettings` (nudge delay, hold expiry, quiet hours, daily agenda), `registerPushToken` on sign-in and `unregisterPushToken` before sign-out, and `getAppointment` (`@chairside/db/appointments`) for a request opened from a push. See [`supabase/docs/push-notifications.md`](../../supabase/docs/push-notifications.md).

| Script | What it does |
|---|---|
| `npm run gen:types` | Regenerates `src/database.types.ts` from the local DB (`npx supabase start` first). Run after every migration and commit the result. CI fails if it is stale; on a merge conflict take either side and re-run. |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run smoke` | End-to-end first-run check against the local stack (needs `SUPABASE_ANON_KEY`). See [`supabase/docs/local-development.md`](../../supabase/docs/local-development.md). |
