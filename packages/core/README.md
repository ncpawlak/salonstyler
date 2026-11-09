# @chairside/core

Pure, dependency-free TypeScript shared by the app and Edge Functions. See `docs/PLAN.md` §2, §3, §5.

## Availability engine (`src/availability`)

The LLM never does slot math; this deterministic engine does.

```ts
import { findSlots } from '@chairside/core';

const slots = findSlots({
  service: { segments: [{ kind: 'busy', minutes: 30 }], bufferAfterMinutes: 5 },
  hours: { timeZone: 'America/New_York', weekly: { 5: { blocks: [{ start: '09:00', end: '17:00', type: 'open' }] } } },
  requestedDate: '2026-03-06',
  searchRadiusDays: 3,
  preference: 'afternoon',
  existing: [/* appointments + holds with placed segments */],
  rules: { leadTimeMinutes: 120, bookingWindowDays: 60, slotGridMinutes: 15 },
  now: new Date(),
});
```

- **Segments:** `busy` and `style` (hands-on) and `buffer` block the stylist; `processing` doesn't. Another client's busy time may sit inside an existing appointment's processing time, as long as the whole new service fits in hours.
- **Hours:** weekly template + date/range overrides + breaks. Painted with precedence `closed > open > tentative`. Any part of a booking in tentative hours ⇒ `requiresApproval: true`.
- **Ranking:** requested day, then ±1, ±2… (earlier first on ties); within a day: matches time-of-day preference → Open before Tentative → closeness to the preferred window → fit score (flush edges, processing-time reuse, minus unusable holes shorter than `minUsefulGapMinutes`) → earliest.
- **Time zones:** grid is aligned to local wall-clock time; DST uses Temporal's `compatible` disambiguation. Independent of the host time zone.
- `evaluateStart` validates one specific start (manual booking, drag-to-move) against the same rules.
- `busyRanges` / `toTstzRanges` produce the half-open busy ranges that the `appointment_segments` exclusion constraint (#30) protects; `findBusyConflicts` mirrors that check in memory.

## Service builder (`src/services`)

Turns a service definition (+ chosen variant and add-ons, or a combo) into the `ServiceRequest` the availability engine consumes.

```ts
import { resolveService, resolveCombo, formatDuration, describeSegments } from '@chairside/core';

const r = resolveService(fullColor, { variant: { deltaMinutes: 30 }, addons: [toner] });
findSlots({ service: r, ... }); // r is a ServiceRequest with overrides already applied
formatDuration(r.totalMinutes); // "1h35"
```

- **Order:** variant → add-ons → per-booking `overrides`.
- **Variants** (hair length: Short +0, Medium +15, Long +30) spread their delta over `busy`/`style` segments in proportion to length, in 5-minute steps. `processing` is never stretched.
- **Add-ons** go `before_finish` (before the trailing `style` run, e.g. toner before the blow-dry) or at the `end` (blowout finish).
- **Combos** (`resolveCombo`) concatenate items; `replacesPreviousFinish` drops the previous item's trailing `style` (Balayage + Women's cut doesn't blow-dry twice). Buffer-before comes from the first item, buffer-after from the last.
- `STARTER_MENU` is the Appendix A menu. `supabase/migrations/*_service_builder.sql` embeds the same JSON to seed new salons; a test keeps them in sync.

## Scripts

```sh
npm test          # vitest run
npm run typecheck # tsc --noEmit
```
