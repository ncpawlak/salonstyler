import {
  applyBlanketSchedule,
  getWorkingBlocksRange,
  paintDays,
  setTemplateDay,
  withOverride,
  withoutOverride,
  type BlanketScheduleInput,
  type Paint,
  type TimeRange,
  type Weekday,
  type WorkHours,
} from '@chairside/core';
import { useCallback, useMemo, useState } from 'react';

export interface BookingRulesState {
  minNoticeMinutes: number;
  bookingWindowDays: number;
  slotGridMinutes: number;
}

export const DEFAULT_BOOKING_RULES: BookingRulesState = {
  minNoticeMinutes: 120,
  bookingWindowDays: 60,
  slotGridMinutes: 15,
};

function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * Local editor state for work hours. Everything is computed with `@chairside/core`, so the
 * screen behaves exactly like the booking engine. Persisting via `@chairside/db`
 * (`saveWorkHoursTemplate`, `upsertWorkHoursOverride`, …) plugs in once auth/salon context lands.
 */
export function useWorkHoursEditor(initial?: Partial<WorkHours>) {
  const [hours, setHours] = useState<WorkHours>(() => ({
    timeZone: initial?.timeZone ?? deviceTimeZone(),
    weekly: initial?.weekly ?? {},
    overrides: initial?.overrides ?? [],
  }));
  const [rules, setRules] = useState<BookingRulesState>(DEFAULT_BOOKING_RULES);

  const applyBlanket = useCallback(
    (input: BlanketScheduleInput) =>
      setHours((h) => ({ ...h, weekly: applyBlanketSchedule(h.weekly, input) })),
    [],
  );

  const setWeekday = useCallback(
    (day: Weekday, paint: Paint, range?: TimeRange, breaks?: TimeRange[]) =>
      setHours((h) => ({ ...h, weekly: setTemplateDay(h.weekly, day, paint, range, breaks) })),
    [],
  );

  const paint = useCallback(
    (paint: Paint, from: string, to: string = from, range?: TimeRange) =>
      setHours((h) => withOverride(h, paintDays(h, paint, from, to, range))),
    [],
  );

  const clear = useCallback(
    (from: string, to: string = from) => setHours((h) => withoutOverride(h, from, to)),
    [],
  );

  /** Back to the weekly template: drops the exact override, then masks any wider one. */
  const reset = useCallback(
    (from: string, to: string = from) =>
      setHours((h) => {
        let next = withoutOverride(h, from, to);
        for (const day of getWorkingBlocksRange(next, from, to)) {
          if (day.source !== 'override') continue;
          const usual = next.weekly[day.weekday] ?? { blocks: [] };
          next = withOverride(next, {
            from: day.date,
            blocks: usual.blocks,
            breaks: usual.breaks ?? [],
            kind: usual.blocks.length ? 'custom' : 'day_off',
          });
        }
        return next;
      }),
    [],
  );

  return useMemo(
    () => ({ hours, rules, setRules, applyBlanket, setWeekday, paint, clear, reset }),
    [hours, rules, applyBlanket, setWeekday, paint, clear, reset],
  );
}
