import {
  applyBlanketSchedule,
  overrideToRow,
  paintDays,
  setTemplateDay,
  templateToRows,
  withOverride,
  withoutOverride,
  type BlanketScheduleInput,
  type Paint,
  type TimeRange,
  type Weekday,
  type WorkHours,
} from '@chairside/core';
import { useCallback, useMemo, useState } from 'react';

import type { BookingRulesState, SavedWorkHours } from './use-work-hours';

/** Comparable snapshot of what would be written to the DB. */
function snapshot(hours: WorkHours, rules: BookingRulesState): string {
  const overrides = (hours.overrides ?? [])
    .map(overrideToRow)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  return JSON.stringify([templateToRows(hours.weekly), overrides, rules]);
}

/**
 * Editor state for work hours, starting from the saved data. Everything is computed with
 * `@chairside/core`, so the screen behaves exactly like the booking engine.
 */
export function useWorkHoursEditor(saved: SavedWorkHours) {
  const [hours, setHours] = useState<WorkHours>(saved.hours);
  const [rules, setRules] = useState<BookingRulesState>(saved.rules);

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

  /** Back to the weekly template for these dates. */
  const reset = useCallback(
    (from: string, to: string = from) => setHours((h) => withoutOverride(h, from, to)),
    [],
  );

  const discard = useCallback(() => {
    setHours(saved.hours);
    setRules(saved.rules);
  }, [saved]);

  const savedSnapshot = useMemo(() => snapshot(saved.hours, saved.rules), [saved]);
  const dirty = useMemo(
    () => snapshot(hours, rules) !== savedSnapshot,
    [hours, rules, savedSnapshot],
  );

  return useMemo(
    () => ({ hours, rules, setRules, applyBlanket, setWeekday, paint, reset, discard, dirty }),
    [hours, rules, applyBlanket, setWeekday, paint, reset, discard, dirty],
  );
}
