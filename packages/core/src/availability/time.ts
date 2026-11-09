import type { InstantInput } from './types';

export const MINUTE = 60_000;
export const DAY_MS = 86_400_000;

export function toMs(input: InstantInput): number {
  const ms = input instanceof Date ? input.getTime() : typeof input === 'number' ? input : Date.parse(input);
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid instant: ${String(input)}`);
  return ms;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

export function parseLocalDate(date: string): LocalDate {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError(`Invalid local date (expected YYYY-MM-DD): ${date}`);
  const ld = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  if (formatLocalDate(addDays(ld, 0)) !== date) throw new RangeError(`Invalid local date: ${date}`);
  return ld;
}

export function formatLocalDate({ year, month, day }: LocalDate): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function addDays(d: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(d: LocalDate): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

export function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS);
}

/** Parses `HH:MM` to minutes since local midnight. `24:00` is allowed. */
export function parseClock(time: string): number {
  const m = TIME_RE.exec(time);
  if (!m) throw new RangeError(`Invalid time (expected HH:MM): ${time}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) throw new RangeError(`Invalid time: ${time}`);
  return h * 60 + min;
}

export function formatClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export interface ZonedParts extends LocalDate {
  /** Minutes since local midnight. */
  minutes: number;
}

export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const p: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { year: p.year!, month: p.month!, day: p.day!, minutes: p.hour! * 60 + p.minute! };
}

/** Offset of `timeZone` from UTC at instant `ms`, in ms (e.g. -5h for EST). Minute precision. */
export function zoneOffset(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const floored = Math.floor(ms / MINUTE) * MINUTE;
  return Date.UTC(p.year, p.month - 1, p.day, 0, p.minutes) - floored;
}

/**
 * Converts a local wall-clock time to a UTC instant.
 * DST handling matches Temporal's `disambiguation: 'compatible'`:
 * - ambiguous (fall back) → the earlier instant;
 * - nonexistent (spring forward) → shifted forward by the gap (02:30 → 03:30).
 * `minutes` may be ≥ 1440 (e.g. `24:00`), which rolls into the next day.
 */
export function zonedToUtc(date: LocalDate, minutes: number, timeZone: string): number {
  const wall = Date.UTC(date.year, date.month - 1, date.day, 0, minutes);
  const before = zoneOffset(wall - DAY_MS / 2, timeZone);
  const after = zoneOffset(wall + DAY_MS / 2, timeZone);
  const valid = [before, after].map((o) => wall - o).filter((utc) => zoneOffset(utc, timeZone) === wall - utc);
  if (valid.length > 0) return Math.min(...valid);
  return wall - before;
}

export function assertTimeZone(timeZone: string): void {
  try {
    formatter(timeZone);
  } catch {
    throw new RangeError(`Unknown time zone: ${timeZone}`);
  }
}
