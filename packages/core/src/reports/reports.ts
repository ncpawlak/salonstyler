import {
  addDays,
  daysBetween,
  formatLocalDate,
  parseLocalDate,
  weekday,
} from '../availability/time.ts';

/** Reports date ranges and chart helpers (issue #43). Dates are salon-local `YYYY-MM-DD`. */

export type ReportPeriod = 'week' | 'month' | 'quarter' | 'year' | 'custom';

export interface DateRange {
  from: string;
  to: string;
}

/** Longest range a report covers (the `sales_report` RPC enforces the same cap). */
export const MAX_REPORT_DAYS = 367;

/**
 * The calendar week / month / quarter / year containing `today`, shifted by `offset` periods
 * (`-1` = the previous one). Weeks start on Sunday unless `weekStartsOn` says otherwise.
 */
export function periodRange(
  period: Exclude<ReportPeriod, 'custom'>,
  today: string,
  offset = 0,
  weekStartsOn: 0 | 1 = 0,
): DateRange {
  const d = parseLocalDate(today);
  if (period === 'week') {
    const start = addDays(d, -((weekday(d) - weekStartsOn + 7) % 7) + offset * 7);
    return { from: formatLocalDate(start), to: formatLocalDate(addDays(start, 6)) };
  }
  const months = period === 'month' ? 1 : period === 'quarter' ? 3 : 12;
  const first = Math.floor((d.month - 1) / months) * months + offset * months;
  const startIndex = d.year * 12 + first;
  const endIndex = startIndex + months;
  const start = { year: Math.floor(startIndex / 12), month: (startIndex % 12) + 1, day: 1 };
  const next = { year: Math.floor(endIndex / 12), month: (endIndex % 12) + 1, day: 1 };
  return { from: formatLocalDate(start), to: formatLocalDate(addDays(next, -1)) };
}

/** Number of days in an inclusive range. */
export const rangeDays = ({ from, to }: DateRange) =>
  daysBetween(parseLocalDate(from), parseLocalDate(to)) + 1;

/**
 * What to compare a range with: the previous calendar period for week / month / quarter / year,
 * otherwise the same number of days just before it.
 */
export function comparisonRange(period: ReportPeriod, range: DateRange): DateRange {
  if (period !== 'custom') return periodRange(period, range.from, -1);
  const days = rangeDays(range);
  const from = parseLocalDate(range.from);
  return { from: formatLocalDate(addDays(from, -days)), to: formatLocalDate(addDays(from, -1)) };
}

/** Phrases the assistant understands ("last month"), resolved against `today`. */
export const NAMED_RANGES = [
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'this_quarter',
  'last_quarter',
  'this_year',
  'last_year',
] as const;
export type NamedRange = (typeof NAMED_RANGES)[number];

export function namedRange(name: NamedRange, today: string): DateRange & { period: ReportPeriod } {
  const [when, unit] = name.split('_') as ['this' | 'last', Exclude<ReportPeriod, 'custom'>];
  return { ...periodRange(unit, today, when === 'last' ? -1 : 0), period: unit };
}

/** Splits a range into consecutive pieces of at most `maxDays` (the utilization engine's cap). */
export function chunkRange(range: DateRange, maxDays = 62): DateRange[] {
  const out: DateRange[] = [];
  let start = parseLocalDate(range.from);
  const end = parseLocalDate(range.to);
  while (daysBetween(start, end) >= 0) {
    const stop = daysBetween(start, end) < maxDays ? end : addDays(start, maxDays - 1);
    out.push({ from: formatLocalDate(start), to: formatLocalDate(stop) });
    start = addDays(stop, 1);
  }
  return out;
}

export type Granularity = 'day' | 'week' | 'month';

/** Bars that stay readable on a phone: days up to a month, weeks up to a quarter, then months. */
export function granularityFor(range: DateRange): Granularity {
  const days = rangeDays(range);
  if (days <= 31) return 'day';
  if (days <= 98) return 'week';
  return 'month';
}

/** First date of the bucket `date` falls in. Weeks start on Sunday (or `weekStartsOn`). */
export function bucketStart(date: string, granularity: Granularity, weekStartsOn: 0 | 1 = 0) {
  if (granularity === 'day') return date;
  if (granularity === 'week') return periodRange('week', date, 0, weekStartsOn).from;
  return `${date.slice(0, 7)}-01`;
}

/** Sums the numeric `fields` of daily points into day / week / month buckets, in date order. */
export function bucketSeries<T extends { date: string }, K extends keyof T & string>(
  points: readonly T[],
  granularity: Granularity,
  fields: readonly K[],
  weekStartsOn: 0 | 1 = 0,
): ({ date: string } & Record<K, number>)[] {
  const buckets = new Map<string, { date: string } & Record<K, number>>();
  for (const p of points) {
    const key = bucketStart(p.date, granularity, weekStartsOn);
    let b = buckets.get(key);
    if (!b) {
      b = { date: key, ...Object.fromEntries(fields.map((f) => [f, 0])) } as {
        date: string;
      } & Record<K, number>;
      buckets.set(key, b);
    }
    const sums = b as Record<K, number>;
    for (const f of fields) sums[f] += Number(p[f]) || 0;
  }
  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Change from `previous` to `current` as a fraction (0.12 = +12%); null when there's no base. */
export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

/** Share of `part` in `whole`, 0..1; null when `whole` is 0. */
export const share = (part: number, whole: number) => (whole > 0 ? part / whole : null);
