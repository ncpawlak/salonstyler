import { mergeIntervals, overlapMs, subtractIntervals } from '../availability/intervals.ts';
import { isBlocking } from '../availability/segments.ts';
import {
  addDays,
  daysBetween,
  formatLocalDate,
  MINUTE,
  parseLocalDate,
  toMs,
  zonedParts,
  zonedToUtc,
} from '../availability/time.ts';
import type { InstantInput, Interval, PlacedSegment, WorkHours } from '../availability/types.ts';
import { getWorkingBlocks, toSalonDate } from '../hours/resolve.ts';
import type { DayStatus } from '../hours/types.ts';

/**
 * How each minute of a day reads on the calendar. Precedence: booked > open > tentative > closed.
 * - `booked`: the stylist is occupied (busy, style or buffer segments), in or out of hours.
 * - `open` / `tentative`: free working time. Processing time counts here: it's still bookable.
 * - `closed`: outside working hours (or a break) and not booked.
 */
export type UtilizationState = 'booked' | 'open' | 'tentative' | 'closed';

/** Anything with placed segments: `AppointmentWithDetails`, `ExistingAppointment`, holds. */
export interface UtilizationAppointment {
  segments: readonly PlacedSegment[];
}

/** A contiguous stretch of one state, as UTC epoch ms. */
export interface UtilizationRun {
  state: UtilizationState;
  start: number;
  end: number;
}

/** Minutes of each state within one clock hour of the day. */
export interface HourUtilization {
  /** UTC epoch ms of the start of this hour. */
  start: number;
  end: number;
  /** Local wall-clock hour, 0–23 (repeats on a fall-back day). */
  hour: number;
  booked: number;
  open: number;
  tentative: number;
  closed: number;
  /** Processing minutes in this hour (already counted as open/tentative/closed). */
  processing: number;
}

export interface DayUtilization {
  /** Salon-local `YYYY-MM-DD`. */
  date: string;
  weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** The working-hours status, independent of bookings. */
  status: DayStatus;
  /** Local midnight to the next local midnight, UTC epoch ms. */
  start: number;
  end: number;
  /** Real elapsed minutes in the day (1380/1440/1500 around DST). */
  totalMinutes: number;
  /** `booked + open + tentative + closed === totalMinutes`. */
  bookedMinutes: number;
  openMinutes: number;
  tentativeMinutes: number;
  closedMinutes: number;
  /** Booked minutes that fall in tentative hours (subset of `bookedMinutes`). */
  bookedTentativeMinutes: number;
  /** Booked minutes outside working hours (subset of `bookedMinutes`). */
  bookedOutsideHoursMinutes: number;
  /** Processing minutes not overlapped by booked time (subset of open/tentative/closed). */
  processingMinutes: number;
  /** `booked + open + tentative`: everything that was or still is bookable. */
  capacityMinutes: number;
  /** `bookedMinutes / capacityMinutes`, 0..1; 0 when there's no capacity. */
  utilization: number;
  /** Appointments with at least one non-buffer segment on this day. */
  appointmentCount: number;
  runs: UtilizationRun[];
  hours: HourUtilization[];
}

const HOUR = 60 * MINUTE;
const minutes = (ms: number) => Math.round(ms / MINUTE);
const sum = (xs: readonly Interval[]) => xs.reduce((n, i) => n + (i.end - i.start), 0);
const clip = (xs: readonly Interval[], window: Interval) =>
  xs
    .map((i) => ({ start: Math.max(i.start, window.start), end: Math.min(i.end, window.end) }))
    .filter((i) => i.end > i.start);

function toIntervals(
  appointments: readonly UtilizationAppointment[],
  keep: (s: PlacedSegment) => boolean,
): Interval[] {
  return appointments.flatMap((a) =>
    a.segments.filter(keep).map((s) => ({ start: toMs(s.start), end: toMs(s.end) })),
  );
}

/** Run-length strip over `day`; earlier layers win. Layers must be merged interval lists. */
function buildRuns(
  day: Interval,
  layers: readonly [UtilizationState, readonly Interval[]][],
): UtilizationRun[] {
  const edges = new Set<number>([day.start, day.end]);
  for (const [, xs] of layers) for (const i of xs) edges.add(i.start).add(i.end);
  const points = [...edges].sort((a, b) => a - b);
  const runs: UtilizationRun[] = [];
  for (let k = 0; k < points.length - 1; k++) {
    const start = points[k]!;
    const end = points[k + 1]!;
    const state =
      layers.find(([, xs]) => xs.some((i) => i.start <= start && end <= i.end))?.[0] ?? 'closed';
    const last = runs[runs.length - 1];
    if (last && last.state === state && last.end === start) last.end = end;
    else runs.push({ state, start, end });
  }
  return runs;
}

/**
 * Booked / open / tentative / closed minutes for one salon-local date, plus a run-length strip
 * and per-hour buckets for charts. Processing segments stay bookable, so they never count as
 * booked. Pass only appointments that occupy the calendar (e.g. `listAppointments`' default).
 */
export function dayUtilization(
  hours: WorkHours,
  date: InstantInput,
  appointments: readonly UtilizationAppointment[],
): DayUtilization {
  const working = getWorkingBlocks(hours, date);
  const local = parseLocalDate(working.date);
  const day: Interval = {
    start: zonedToUtc(local, 0, hours.timeZone),
    end: zonedToUtc(addDays(local, 1), 0, hours.timeZone),
  };

  const tentativeHours = subtractIntervals(working.tentative, working.open);
  const booked = clip(mergeIntervals(toIntervals(appointments, (s) => isBlocking(s.kind))), day);
  const open = subtractIntervals(clip(working.open, day), booked);
  const tentative = subtractIntervals(clip(tentativeHours, day), booked);
  const processing = subtractIntervals(
    clip(mergeIntervals(toIntervals(appointments, (s) => s.kind === 'processing')), day),
    booked,
  );
  const bookedTentative = booked.flatMap((b) => clip(tentativeHours, b));
  const bookedOutside = subtractIntervals(booked, [...working.open, ...working.tentative]);

  const runs = buildRuns(day, [
    ['booked', booked],
    ['open', open],
    ['tentative', tentative],
  ]);

  const hourBuckets: HourUtilization[] = [];
  for (let t = day.start; t < day.end; t += HOUR) {
    const slot: Interval = { start: t, end: Math.min(t + HOUR, day.end) };
    const bucket: HourUtilization = {
      start: slot.start,
      end: slot.end,
      hour: Math.floor(zonedParts(t, hours.timeZone).minutes / 60),
      booked: 0,
      open: 0,
      tentative: 0,
      closed: 0,
      processing: minutes(processing.reduce((n, p) => n + overlapMs(p, slot), 0)),
    };
    for (const r of runs) bucket[r.state] += minutes(overlapMs(r, slot));
    hourBuckets.push(bucket);
  }

  const totalMinutes = minutes(day.end - day.start);
  const bookedMinutes = minutes(sum(booked));
  const openMinutes = minutes(sum(open));
  const tentativeMinutes = minutes(sum(tentative));
  const capacityMinutes = bookedMinutes + openMinutes + tentativeMinutes;
  const appointmentCount = appointments.filter((a) =>
    a.segments.some(
      (s) => s.kind !== 'buffer' && overlapMs({ start: toMs(s.start), end: toMs(s.end) }, day) > 0,
    ),
  ).length;

  return {
    date: working.date,
    weekday: working.weekday,
    status: working.status,
    start: day.start,
    end: day.end,
    totalMinutes,
    bookedMinutes,
    openMinutes,
    tentativeMinutes,
    closedMinutes: totalMinutes - capacityMinutes,
    bookedTentativeMinutes: minutes(sum(bookedTentative)),
    bookedOutsideHoursMinutes: minutes(sum(bookedOutside)),
    processingMinutes: minutes(sum(processing)),
    capacityMinutes,
    utilization: capacityMinutes > 0 ? bookedMinutes / capacityMinutes : 0,
    appointmentCount,
    runs,
    hours: hourBuckets,
  };
}

/** `dayUtilization` for every salon-local date in `[from, to]` (inclusive), e.g. a week or month. */
export function rangeUtilization(
  hours: WorkHours,
  from: InstantInput,
  to: InstantInput,
  appointments: readonly UtilizationAppointment[],
): DayUtilization[] {
  const start = parseLocalDate(toSalonDate(from, hours.timeZone));
  const end = parseLocalDate(toSalonDate(to, hours.timeZone));
  const days = daysBetween(start, end);
  if (days < 0) throw new RangeError('Range ends before it starts');
  if (days > 62) throw new RangeError('Range too long (max 62 days)');
  const firstMs = zonedToUtc(start, 0, hours.timeZone);
  const lastMs = zonedToUtc(addDays(end, 1), 0, hours.timeZone);
  // Filter once so each day only scans appointments that can touch the range.
  const relevant = appointments.filter((a) =>
    a.segments.some((s) => toMs(s.end) > firstMs && toMs(s.start) < lastMs),
  );
  return Array.from({ length: days + 1 }, (_, i) =>
    dayUtilization(hours, formatLocalDate(addDays(start, i)), relevant),
  );
}

export interface UtilizationSummary {
  days: number;
  /** Days with any capacity (working hours or bookings). */
  workingDays: number;
  bookedMinutes: number;
  openMinutes: number;
  tentativeMinutes: number;
  capacityMinutes: number;
  utilization: number;
  appointmentCount: number;
  /** The day with the most free (open + tentative) time, if any. */
  mostOpenDate: string | null;
  /** The day with the highest utilization, if anything is booked. */
  busiestDate: string | null;
}

/** Totals across days, for a week or month header. */
export function summarizeUtilization(days: readonly DayUtilization[]): UtilizationSummary {
  let mostOpen: DayUtilization | null = null;
  let busiest: DayUtilization | null = null;
  const free = (d: DayUtilization) => d.openMinutes + d.tentativeMinutes;
  const totals = {
    days: days.length,
    workingDays: 0,
    bookedMinutes: 0,
    openMinutes: 0,
    tentativeMinutes: 0,
    capacityMinutes: 0,
    appointmentCount: 0,
  };
  for (const d of days) {
    if (d.capacityMinutes > 0) totals.workingDays++;
    totals.bookedMinutes += d.bookedMinutes;
    totals.openMinutes += d.openMinutes;
    totals.tentativeMinutes += d.tentativeMinutes;
    totals.capacityMinutes += d.capacityMinutes;
    totals.appointmentCount += d.appointmentCount;
    if (free(d) > 0 && (!mostOpen || free(d) > free(mostOpen))) mostOpen = d;
    if (d.bookedMinutes > 0 && (!busiest || d.utilization > busiest.utilization)) busiest = d;
  }
  return {
    ...totals,
    utilization: totals.capacityMinutes > 0 ? totals.bookedMinutes / totals.capacityMinutes : 0,
    mostOpenDate: mostOpen?.date ?? null,
    busiestDate: busiest?.date ?? null,
  };
}

export type UtilizationLevel = 0 | 1 | 2 | 3 | 4;

/** Heatmap bucket: `null` = no capacity (closed), else 0 (nothing booked) … 4 (≥ 90% booked). */
export function utilizationLevel(
  day: Pick<DayUtilization, 'capacityMinutes' | 'utilization'>,
): UtilizationLevel | null {
  if (day.capacityMinutes <= 0) return null;
  const u = day.utilization;
  if (u <= 0) return 0;
  if (u < 0.35) return 1;
  if (u < 0.65) return 2;
  if (u < 0.9) return 3;
  return 4;
}
