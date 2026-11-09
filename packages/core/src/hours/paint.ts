import {
  addDays,
  formatLocalDate,
  parseClock,
  parseLocalDate,
  weekday,
} from '../availability/time';
import type { WeeklyTemplate } from '../availability/types';
import type { HoursBlock, TimeRange, WorkHours, WorkHoursOverride } from './types';

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
/** What the stylist "paints" on a day. */
export type Paint = 'open' | 'tentative' | 'closed';

export const WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];
/** Used when painting hours onto a day whose template is closed and no range is given. */
export const DEFAULT_DAY_RANGE: TimeRange = { start: '09:00', end: '17:00' };

export interface BlanketScheduleInput {
  weekdays: readonly Weekday[];
  start: string;
  end: string;
  type?: 'open' | 'tentative';
  breaks?: TimeRange[];
}

function assertRange(r: TimeRange): void {
  if (parseClock(r.end) <= parseClock(r.start)) {
    throw new RangeError(`Time range must end after it starts: ${r.start}–${r.end}`);
  }
}

/** Sets the same hours (and breaks) on each listed weekday, keeping other weekdays as they were. */
export function applyBlanketSchedule(
  weekly: WeeklyTemplate,
  { weekdays, start, end, type = 'open', breaks = [] }: BlanketScheduleInput,
): WeeklyTemplate {
  assertRange({ start, end });
  breaks.forEach(assertRange);
  const next: WeeklyTemplate = { ...weekly };
  for (const d of weekdays) next[d] = { blocks: [{ start, end, type }], breaks: [...breaks] };
  return next;
}

/** Sets or clears (`null`) one weekday in the template. */
export function setTemplateDay(
  weekly: WeeklyTemplate,
  day: Weekday,
  paint: Paint,
  range: TimeRange = DEFAULT_DAY_RANGE,
  breaks: TimeRange[] = [],
): WeeklyTemplate {
  const next: WeeklyTemplate = { ...weekly };
  if (paint === 'closed') {
    delete next[day];
    return next;
  }
  assertRange(range);
  next[day] = { blocks: [{ ...range, type: paint }], breaks: [...breaks] };
  return next;
}

/**
 * The override produced by painting `from`…`to` (default a single day).
 * - `closed`: a day off (or `vacation` when a range).
 * - `open` / `tentative`: `range` when given; otherwise the template hours of `from`'s
 *   weekday re-typed, keeping its breaks; otherwise `DEFAULT_DAY_RANGE`.
 */
export function paintDays(
  hours: WorkHours,
  paint: Paint,
  from: string,
  to: string = from,
  range?: TimeRange,
): WorkHoursOverride {
  parseLocalDate(from);
  parseLocalDate(to);
  if (to < from) throw new RangeError(`Range ends before it starts: ${from}…${to}`);
  if (paint === 'closed') {
    return { from, to, blocks: [], breaks: [], kind: from === to ? 'day_off' : 'vacation' };
  }
  if (range) {
    assertRange(range);
    return { from, to, blocks: [{ ...range, type: paint }], breaks: [], kind: 'custom' };
  }
  const template = hours.weekly[weekday(parseLocalDate(from))];
  const usual = (template?.blocks ?? []).filter((b) => b.type !== 'closed');
  const blocks: HoursBlock[] = usual.length
    ? usual.map((b) => ({ ...b, type: paint }))
    : [{ ...DEFAULT_DAY_RANGE, type: paint }];
  return {
    from,
    to,
    blocks,
    breaks: usual.length ? [...(template?.breaks ?? [])] : [],
    kind: 'custom',
  };
}

function shiftDate(date: string, days: number): string {
  return formatLocalDate(addDays(parseLocalDate(date), days));
}

/**
 * Cuts `from`…`to` out of every override, keeping the parts outside it (a vacation with a day
 * painted in the middle becomes two shorter vacations). Overrides therefore never overlap, so
 * the engine's "last match wins" and the DB's `sortOverrides` precedence always agree.
 */
function clipOverrides(
  overrides: readonly WorkHoursOverride[],
  from: string,
  to: string,
): WorkHoursOverride[] {
  return overrides.flatMap((o) => {
    const oTo = o.to ?? o.from;
    if (oTo < from || o.from > to) return [o];
    const parts: WorkHoursOverride[] = [];
    if (o.from < from) parts.push({ ...o, to: shiftDate(from, -1) });
    if (oTo > to) parts.push({ ...o, from: shiftDate(to, 1), to: oTo });
    return parts;
  });
}

/** Returns `hours` with `override` painted on top: it replaces whatever covered its dates. */
export function withOverride(hours: WorkHours, override: WorkHoursOverride): WorkHours {
  const to = override.to ?? override.from;
  return {
    ...hours,
    overrides: [...clipOverrides(hours.overrides ?? [], override.from, to), override],
  };
}

/** Clears every override touching `from`…`to`, so those dates fall back to the template. */
export function withoutOverride(hours: WorkHours, from: string, to: string = from): WorkHours {
  return { ...hours, overrides: clipOverrides(hours.overrides ?? [], from, to) };
}

/** "9:00 AM" style label for an `HH:MM` wall-clock time. */
export function formatClock12(time: string): string {
  const m = parseClock(time);
  const h = Math.floor(m / 60) % 24;
  const min = m % 60;
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return min === 0 ? `${h12} ${suffix}` : `${h12}:${String(min).padStart(2, '0')} ${suffix}`;
}

/** "9 AM–12 PM, 1–6 PM" style summary of blocks. */
export function formatBlocks(blocks: readonly { start: string; end: string }[]): string {
  if (blocks.length === 0) return 'Closed';
  return blocks.map((b) => `${formatClock12(b.start)}–${formatClock12(b.end)}`).join(', ');
}
