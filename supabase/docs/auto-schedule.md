# Auto-Schedule and Auto-Find (#84, #88)

Two AI buttons suggest times. Both use the same list, with chips that explain each suggestion.

- **Auto-Schedule** (#84) is on every Inbox request card except cancellations. It lists the best openings for what the client asked for ("any chance we can move my appointment to next week? Mornings are best"). If nothing fits, it says so and shows the nearest openings instead. Tapping one books the appointment, or moves it for a reschedule, and approves the request.
- **Auto-Find** (#88) is in the **New appointment** sheet once a client and services are chosen. It lists good times based on the client's booking history, such as their usual weekday, time of day and how often they come in. Tapping one fills in the date and time.

Rules:

- The model only interprets *when* the client can come in.
- The scheduling engine (`@chairside/core/availability`) does all the slot math:
  - segment durations, including processing gaps
  - open vs. tentative hours (tentative suggestions are labeled, and picking one in Auto-Find books it as **held**)
  - minimum notice
  - buffers and overlaps
- Nothing is sent without the stylist. After Auto-Schedule books, the app opens a drafted confirmation reply. The only exception is when the opt-in **Auto-send replies** toggle is on, in which case the existing approve path sends it.

## Client habits and ranking

The logic is in `packages/core/src/scheduling` (`@chairside/core/scheduling`), and is unit-tested.

- **`analyzeHabits(visits)`** learns from the client's recent visits that actually happened:
  - **Preferred weekdays:** a day with at least 2 visits that makes up at least a third of them.
  - **Usual time:** when most visits start within an hour of the median.
  - **Part of day.**
  - **Cadence:** the median gap between visits, such as "every other week". It needs 3 visits on separate days, 1 to 52 weeks apart.
- **`dueDate(habits, fallback)`** returns when the client is due back. It uses their own cadence after their last visit. Otherwise it falls back to the service's rebook interval from #42 (`rebookInterval`).
- **Popular times:** for new clients who have no history, `analyzeHabits` runs over the salon's recent appointments to find its busiest weekday and time.
- **`suggestSlots(...)`** takes the engine's open slots and ranks them by:
  1. the request window
  2. the client's habits
  3. when they're due
  4. popularity, for new clients

  It keeps at most one suggestion per day and always includes a couple of the soonest openings. Each suggestion has reason chips: `requested`, `nearest`, `usual`, `due`, `popular`, `soonest` and `tentative`.
- **`defaultStart(...)`** gives the New appointment sheet a sensible starting time: the first slot on the grid that is inside open hours and past the minimum notice. If today has nothing left, it uses the next working day. Today and Calendar both use it, so the sheet no longer opens at 9:30 PM with a minimum-notice warning.

## Auto-Schedule pipeline

1. The app calls the `inbox` edge function with `{ action: 'auto_schedule', salonId, requestId }`. The handler is `packages/ai/src/inbox/auto-schedule.ts`.
2. The salon's model turns the message into a window: dates, time of day, a clock time and weekdays. It uses recorded fixtures under `packages/ai/fixtures/*/inbox_auto_schedule.json`. If there is no usable model (no API key, the budget is spent, a provider error, or local demo mode), the window comes from the request's stored parse plus a few phrase rules: "next week", "this week", "weekends" and "mondays".
3. The handler loads the requested services, the client's visits, work hours and the calendar. `suggestSlots` then returns the ranked openings with their segments. For a reschedule, the client's current appointment and the request's own hold don't count as conflicts.
4. The stylist taps a suggestion, which calls `schedule_captured_request`.

## Database

| Function | Purpose |
|---|---|
| `schedule_captured_request(request, segments, services?, price?)` | Books the picked slot for a pending request and approves it, all in one transaction. **Reschedule:** releases the pipeline's hold (reason `replaced`), then moves the client's appointment in place with `reschedule_appointment`. **Booking:** moves the request's hold to the picked slot, or books a new `requested` appointment (source `inbox`), then confirms it. In both cases the existing triggers approve the request, put the appointment on hold if a deposit is due, and queue the auto-send reply when that's on. Fails with `P0002` if the request isn't found, `22023` if it was already handled or is a cancellation, and `23P01` if the slot overlaps. Audited as `captured_request.auto_scheduled`. Members who can book only |

There are no new tables. The tests are in `supabase/tests/database/32_auto_schedule.test.sql`.
