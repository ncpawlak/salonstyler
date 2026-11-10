/**
 * A sensible start time for a new appointment (#88): the next grid time inside work hours, not
 * "now rounded up" (which at 9:30 PM lands outside hours and under the minimum notice).
 */
import { dayAvailability } from '../availability/hours.ts';
import {
  addDays,
  formatLocalDate,
  parseLocalDate,
  toMs,
  zonedParts,
  zonedToUtc,
} from '../availability/time.ts';
import type { InstantInput, Interval, WorkHours } from '../availability/types.ts';

export interface DefaultStartInput {
  hours: WorkHours;
  /** Local date the stylist is booking on (the calendar day); default today. */
  date?: string;
  now: InstantInput;
  /** Minimum notice in minutes. Default 0. */
  leadTimeMinutes?: number;
  /** Default 15. */
  gridMinutes?: number;
  /** Days to look ahead for open hours when the day has none left. Default 14. */
  lookaheadDays?: number;
}

/**
 * The first grid-aligned start at or after now + notice inside open hours (tentative hours when
 * the day has none open). Today with nothing left moves to the next working day; a future day the
 * salon is closed keeps that day at 10 AM (the stylist picked it on purpose).
 */
export function defaultStart(input: DefaultStartInput): number {
  const { timeZone } = input.hours;
  const grid = (input.gridMinutes ?? 15) * 60_000;
  const earliest = toMs(input.now) + (input.leadTimeMinutes ?? 0) * 60_000;
  const today = formatLocalDate(zonedParts(toMs(input.now), timeZone));
  const date = input.date && input.date > today ? input.date : today;
  const tenAm = zonedToUtc(parseLocalDate(date), 10 * 60, timeZone);

  const pick = (intervals: Interval[]) => {
    for (const i of intervals) {
      const from = Math.max(i.start, earliest);
      const aligned = i.start + Math.ceil((from - i.start) / grid) * grid;
      if (aligned + grid <= i.end) return aligned;
    }
    return null;
  };

  if (date > today && dayAvailability(input.hours, date).available.length === 0) return tenAm;
  for (let d = 0; d <= (input.lookaheadDays ?? 14); d++) {
    const day = dayAvailability(input.hours, formatLocalDate(addDays(parseLocalDate(date), d)));
    const found = pick(day.open) ?? pick(day.tentative);
    if (found !== null) return found;
  }
  return Math.max(tenAm, Math.ceil(earliest / grid) * grid);
}
