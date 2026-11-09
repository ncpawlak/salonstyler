import { mergeIntervals, subtractIntervals } from './intervals';
import { formatLocalDate, parseClock, parseLocalDate, weekday, zonedToUtc, type LocalDate } from './time';
import type { DaySchedule, Interval, WorkHours } from './types';

export interface DayAvailability {
  date: string;
  /** Bookable without approval. */
  open: Interval[];
  /** Bookable as a request only. Never overlaps `open`. */
  tentative: Interval[];
  /** `open ∪ tentative`, merged. A booking must fit inside one of these. */
  available: Interval[];
}

/** The schedule in effect on a local date: the last matching override, else the weekly template. */
export function scheduleForDate(hours: WorkHours, date: string): DaySchedule {
  const overrides = hours.overrides ?? [];
  for (let i = overrides.length - 1; i >= 0; i--) {
    const o = overrides[i]!;
    const to = o.to ?? o.from;
    if (o.from <= date && date <= to) return o;
  }
  return hours.weekly[weekday(parseLocalDate(date))] ?? { blocks: [] };
}

function toInterval(date: LocalDate, start: string, end: string, timeZone: string): Interval {
  const s = parseClock(start);
  const e = parseClock(end);
  if (e <= s) throw new RangeError(`Time range must end after it starts: ${start}–${end}`);
  return { start: zonedToUtc(date, s, timeZone), end: zonedToUtc(date, e, timeZone) };
}

/**
 * Paints a day's hours. Precedence: closed > open > tentative, then breaks are removed.
 * DST is handled by converting each wall-clock edge separately, so a 01:00–04:00 block on a
 * spring-forward day is 2 real hours.
 */
export function dayAvailability(hours: WorkHours, date: string): DayAvailability {
  const ld = parseLocalDate(date);
  const schedule = scheduleForDate(hours, date);
  const byType = { open: [] as Interval[], tentative: [] as Interval[], closed: [] as Interval[] };
  for (const b of schedule.blocks) byType[b.type].push(toInterval(ld, b.start, b.end, hours.timeZone));
  const removed = [...byType.closed, ...(schedule.breaks ?? []).map((b) => toInterval(ld, b.start, b.end, hours.timeZone))];
  const open = subtractIntervals(byType.open, removed);
  const tentative = subtractIntervals(byType.tentative, [...removed, ...open]);
  return { date: formatLocalDate(ld), open, tentative, available: mergeIntervals([...open, ...tentative]) };
}
