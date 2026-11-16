/**
 * Client booking habits (issue #88): which weekdays and time of day a client books, and how often
 * they come in. Learned from their visit history; the slot suggestions (`suggest.ts`) rank the
 * engine's open slots by them.
 */
import { TIME_OF_DAY_WINDOWS } from '../availability/engine.ts';
import {
  DAY_MS,
  addDays,
  formatLocalDate,
  parseLocalDate,
  toMs,
  weekday,
  zonedParts,
} from '../availability/time.ts';
import type { InstantInput, TimeOfDay } from '../availability/types.ts';
import { MAX_REBOOK_DAYS, MIN_REBOOK_DAYS, formatRebookInterval } from '../rebook/rebook.ts';

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** Statuses that never happened (or haven't been agreed yet) and say nothing about habits. */
const IGNORED_STATUSES = new Set([
  'cancelled',
  'no_show',
  'declined',
  'expired',
  'held',
  'requested',
]);

export interface HabitVisit {
  startsAt: InstantInput;
  /** Appointment status; visits that didn't happen are ignored. */
  status?: string | null;
}

export interface ClientHabits {
  /** Visits the habits were learned from. */
  visits: number;
  /** Weekdays the client keeps coming back on, most frequent first. */
  weekdays: Weekday[];
  /** Median local start time (minutes after midnight), when the client books a consistent time. */
  usualMinutes: number | null;
  /** The part of day most of their visits start in. */
  timeOfDay: TimeOfDay | null;
  /** Median days between visits ("every other week" = 14), from at least two gaps. */
  cadenceDays: number | null;
  /** Local date of the most recent visit at or before `now`. */
  lastVisitDate: string | null;
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export const timeOfDayAt = (minutes: number): TimeOfDay =>
  minutes < TIME_OF_DAY_WINDOWS.morning.to
    ? 'morning'
    : minutes < TIME_OF_DAY_WINDOWS.afternoon.to
      ? 'afternoon'
      : 'evening';

/** True when there is any weekday or time-of-day signal worth ranking by. */
export const hasHabits = (h: ClientHabits | null | undefined): h is ClientHabits =>
  !!h && (h.weekdays.length > 0 || h.usualMinutes !== null || h.timeOfDay !== null);

/**
 * Learns a client's habits from their visits (any order; the latest `recent` count). A weekday is
 * a habit when it holds at least two visits and a third of them; the usual time needs most visits
 * within an hour of the median; cadence needs two gaps (three visits on separate days, 1–52 weeks
 * apart).
 */
export function analyzeHabits(
  visits: readonly HabitVisit[],
  timeZone: string,
  options: { now?: InstantInput; recent?: number } = {},
): ClientHabits {
  const now = options.now === undefined ? Number.POSITIVE_INFINITY : toMs(options.now);
  const kept = visits
    .filter((v) => !v.status || !IGNORED_STATUSES.has(v.status))
    .map((v) => toMs(v.startsAt))
    .sort((a, b) => a - b)
    .slice(-(options.recent ?? 12));
  const parts = kept.map((ms) => ({ ms, ...zonedParts(ms, timeZone) }));
  const past = parts.filter((p) => p.ms <= now);
  const last = past[past.length - 1];
  const habits: ClientHabits = {
    visits: parts.length,
    weekdays: [],
    usualMinutes: null,
    timeOfDay: null,
    cadenceDays: null,
    lastVisitDate: last ? formatLocalDate(last) : null,
  };
  if (parts.length < 2) return habits;

  const counts = new Map<Weekday, number>();
  for (const p of parts) {
    const w = weekday(p);
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  habits.weekdays = [...counts]
    .filter(([, n]) => n >= 2 && n / parts.length >= 1 / 3)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([w]) => w);

  const minutes = parts.map((p) => p.minutes);
  const mid = median(minutes);
  const near = minutes.filter((m) => Math.abs(m - mid) <= 60).length;
  if (near / minutes.length > 0.5) habits.usualMinutes = Math.round(mid / 15) * 15;

  const buckets = new Map<TimeOfDay, number>();
  for (const m of minutes) buckets.set(timeOfDayAt(m), (buckets.get(timeOfDayAt(m)) ?? 0) + 1);
  const [topBucket, topCount] = [...buckets].sort((a, b) => b[1] - a[1])[0]!;
  if (topCount / minutes.length >= 0.6) habits.timeOfDay = topBucket;

  const days = [...new Set(kept.map((ms) => Math.floor(ms / DAY_MS)))];
  const gaps: number[] = [];
  for (let i = 1; i < days.length; i++) {
    const gap = days[i]! - days[i - 1]!;
    if (gap >= MIN_REBOOK_DAYS && gap <= MAX_REBOOK_DAYS) gaps.push(gap);
  }
  const recentGaps = gaps.slice(-4);
  if (recentGaps.length >= 2) habits.cadenceDays = Math.round(median(recentGaps));

  return habits;
}

/** "Every week", "Every other week", "Every 3 weeks", "Every 10 days". */
export function formatCadence(days: number): string {
  const weeks = Math.round(days / 7);
  if (weeks >= 1 && Math.abs(days - weeks * 7) <= 1) {
    if (weeks === 1) return 'Every week';
    if (weeks === 2) return 'Every other week';
    return `Every ${weeks} weeks`;
  }
  return `Every ${days} days`;
}

/** "10 AM", "2:30 PM". */
export function formatTime12(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const suffix = h < 12 ? 'AM' : 'PM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hour}:${String(m).padStart(2, '0')} ${suffix}` : `${hour} ${suffix}`;
}

/** When the client is next due, and the reason chip that explains it. */
export interface DueDate {
  date: string;
  label: string;
}

/**
 * The client's next due date: their own cadence after the last visit, else the service's rebook
 * interval (#42: `rebookInterval`) after the last visit. Null with no past visit.
 */
export function dueDate(
  habits: ClientHabits,
  fallback?: { days: number; serviceName: string } | null,
): DueDate | null {
  if (!habits.lastVisitDate) return null;
  const last = parseLocalDate(habits.lastVisitDate);
  if (habits.cadenceDays) {
    return {
      date: formatLocalDate(addDays(last, habits.cadenceDays)),
      label: formatCadence(habits.cadenceDays),
    };
  }
  if (!fallback) return null;
  const days = fallback.days >= 14 ? Math.round(fallback.days / 7) * 7 : fallback.days;
  const interval = formatRebookInterval(fallback.days).replace('~', '');
  return {
    date: formatLocalDate(addDays(last, days)),
    label: `${interval} since last ${fallback.serviceName.toLowerCase()}`,
  };
}
