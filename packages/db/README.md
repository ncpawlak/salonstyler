# @chairside/db

Typed Supabase client for Chairside apps and scripts.

```ts
import { createChairsideClient, createSalon, listMySalons } from '@chairside/db';

const supabase = createChairsideClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!);
const salons = await listMySalons(supabase); // [] => first run: show "Create your salon"
await createSalon(supabase, { name: 'Karina Hair', slug: 'karina-hair', timezone: 'America/Chicago' });
```

Work hours: `getWorkHours(client, salonId)` loads the template, overrides and booking rules; pass the rows plus the salon `timezone` to `buildWorkHours({ timeZone, template, overrides })` from `@chairside/core/hours` to get the engine's `WorkHours`. Save with `saveWorkHoursTemplate`, `upsertWorkHoursOverride`, `deleteWorkHoursOverride` and `updateBookingRules`.

Notifications: `getNotificationSettings` / `updateNotificationSettings` (nudge delay, hold expiry, quiet hours, daily agenda), `registerPushToken` on sign-in and `unregisterPushToken` before sign-out, and `getAppointment` for a request opened from a push. See "Push notifications" in `../../supabase/README.md`.

| Script | What it does |
|---|---|
| `npm run gen:types` | Regenerates `src/database.types.ts` from the local DB (`npx supabase start` first). Run after every migration and commit the result. |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run smoke` | End-to-end first-run check against the local stack (needs `SUPABASE_ANON_KEY`). See `../../supabase/README.md`. |
