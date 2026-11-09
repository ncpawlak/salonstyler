import { dayAvailability } from '../availability/hours.ts';
import { subtractIntervals } from '../availability/intervals.ts';
import {
  addDays,
  assertTimeZone,
  daysBetween,
  formatClock,
  formatLocalDate,
  parseClock,
  parseLocalDate,
  toMs,
  weekday,
  zonedParts,
} from '../availability/time.ts';
import type { DaySchedule, InstantInput, Interval } from '../availability/types.ts';
import type {
  DayStatus,
  HoursBlock,
  WorkHours,
  WorkHoursOverride,
  WorkingBlocks,
} from './types.ts';

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MINUTE = 60_000;

/**
 * The salon-local `YYYY-MM-DD` for `at`. A `YYYY-MM-DD` string is taken as already local;
 * anything else is an instant converted with the salon's time zone.
 */
export function toSalonDate(at: InstantInput, timeZone: string): string {
  if (typeof at === 'string' && LOCAL_DATE_RE.test(at)) {
    return formatLocalDate(parseLocalDate(at));
  }
  return formatLocalDate(zonedParts(toMs(at), timeZone));
}

/** The override in effect on `date` (last match wins, same rule as the engine), if any. */
export function findOverride(hours: WorkHours, date: string): WorkHoursOverride | undefined {
  const overrides = hours.overrides ?? [];
  for (let i = overrides.length - 1; i >= 0; i--) {
    const o = overrides[i]!;
    if (o.from <= date && date <= (o.to ?? o.from)) return o;
  }
  return undefined;
}

const toMinutes = (r: { start: string; end: string }): Interval => ({
  start: parseClock(r.start),
  end: parseClock(r.end),
});

/** Wall-clock painting with the engine's precedence: closed > open > tentative, minus breaks. */
function paintLocal(schedule: DaySchedule): HoursBlock[] {
  const of = (type: HoursBlock['type']) =>
    schedule.blocks.filter((b) => b.type === type).map(toMinutes);
  const removed = [...of('closed'), ...(schedule.breaks ?? []).map(toMinutes)];
  const open = subtractIntervals(of('open'), removed);
  const tentative = subtractIntervals(of('tentative'), [...removed, ...open]);
  const block = (type: 'open' | 'tentative') => (i: Interval) => ({
    start: formatClock(i.start),
    end: formatClock(i.end),
    type,
  });
  return [...open.map(block('open')), ...tentative.map(block('tentative'))].sort(
    (a, b) => parseClock(a.start) - parseClock(b.start),
  );
}

const totalMinutes = (xs: Interval[]) => xs.reduce((n, i) => n + (i.end - i.start), 0) / MINUTE;

function statusOf(blocks: HoursBlock[]): DayStatus {
  if (blocks.length === 0) return 'closed';
  if (blocks.every((b) => b.type === 'open')) return 'open';
  if (blocks.every((b) => b.type === 'tentative')) return 'tentative';
  return 'mixed';
}

/**
 * Resolves the working blocks for one salon-local date (or the local date of an instant).
 * Overrides beat the weekly template; the result's `blocks` are engine-ready `HoursBlock`s and
 * `open`/`tentative`/`available` are the exact UTC intervals the availability engine uses.
 */
export function getWorkingBlocks(hours: WorkHours, at: InstantInput): WorkingBlocks {
  assertTimeZone(hours.timeZone);
  const date = toSalonDate(at, hours.timeZone);
  const override = findOverride(hours, date);
  const wd = weekday(parseLocalDate(date));
  const schedule: DaySchedule = override ?? hours.weekly[wd] ?? { blocks: [] };
  const blocks = paintLocal(schedule);
  const { open, tentative, available } = dayAvailability(hours, date);
  return {
    date,
    weekday: wd,
    timeZone: hours.timeZone,
    source: override ? 'override' : 'template',
    ...(override ? { override } : {}),
    status: statusOf(blocks),
    blocks,
    open,
    tentative,
    available,
    openMinutes: totalMinutes(open),
    tentativeMinutes: totalMinutes(tentative),
  };
}

/** `getWorkingBlocks` for every local date in `[from, to]` (inclusive), e.g. a month view. */
export function getWorkingBlocksRange(
  hours: WorkHours,
  from: InstantInput,
  to: InstantInput,
): WorkingBlocks[] {
  const start = parseLocalDate(toSalonDate(from, hours.timeZone));
  const end = parseLocalDate(toSalonDate(to, hours.timeZone));
  const days = daysBetween(start, end);
  if (days < 0) throw new RangeError('Range ends before it starts');
  if (days > 731) throw new RangeError('Range too long (max 2 years)');
  return Array.from({ length: days + 1 }, (_, i) =>
    getWorkingBlocks(hours, formatLocalDate(addDays(start, i))),
  );
}
