import { addDays, daysBetween, formatLocalDate, parseLocalDate } from '../availability/time.ts';

/**
 * Booth-renter finances (issue #44): expense categories, recurring due dates (mirrors
 * `private.expense_due_dates`), the IRS estimated-tax quarters and the set-aside math. Dates are
 * salon-local `YYYY-MM-DD`.
 */

export const EXPENSE_CATEGORIES = [
  'booth_rent',
  'products',
  'tools',
  'education',
  'other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  booth_rent: 'Booth rent',
  products: 'Products',
  tools: 'Tools',
  education: 'Education',
  other: 'Other',
};

export const isExpenseCategory = (value: unknown): value is ExpenseCategory =>
  typeof value === 'string' && (EXPENSE_CATEGORIES as readonly string[]).includes(value);

export type ExpenseFrequency = 'weekly' | 'monthly';

const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * Due dates of a weekly / monthly schedule between `from` and `to` (inclusive). Weekly repeats
 * every 7 days from `startsOn`; monthly falls on the same day of the month, or the last day in
 * shorter months.
 */
export function dueDates(
  frequency: ExpenseFrequency,
  startsOn: string,
  from: string,
  to: string,
): string[] {
  const start = parseLocalDate(startsOn);
  const lo = from > startsOn ? from : startsOn;
  if (lo > to) return [];
  const out: string[] = [];
  if (frequency === 'weekly') {
    const skip = Math.ceil(daysBetween(start, parseLocalDate(lo)) / 7);
    for (let d = addDays(start, skip * 7); formatLocalDate(d) <= to; d = addDays(d, 7)) {
      out.push(formatLocalDate(d));
    }
    return out;
  }
  const first = parseLocalDate(lo);
  for (let i = first.year * 12 + first.month - 1; ; i++) {
    const year = Math.floor(i / 12);
    const month = (i % 12) + 1;
    const date = formatLocalDate({
      year,
      month,
      day: Math.min(start.day, daysInMonth(year, month)),
    });
    if (date > to) break;
    if (date >= lo) out.push(date);
  }
  return out;
}

/** The first due date on or after `onOrAfter`. */
export function nextDueDate(frequency: ExpenseFrequency, startsOn: string, onOrAfter: string) {
  const end = formatLocalDate(addDays(parseLocalDate(onOrAfter), 62));
  return dueDates(frequency, startsOn, onOrAfter, end)[0] ?? startsOn;
}

/** Roughly what a schedule costs per month (weekly × 52 / 12). */
export const monthlyCost = (frequency: ExpenseFrequency, amountCents: number) =>
  frequency === 'monthly' ? amountCents : Math.round((amountCents * 52) / 12);

export interface TaxQuarter {
  /** 1–4: the IRS estimated-tax payment periods. */
  quarter: 1 | 2 | 3 | 4;
  year: number;
  from: string;
  to: string;
  /** When the estimated payment for this period is due (before weekend / holiday shifts). */
  due: string;
}

/**
 * US estimated-tax payment periods (Form 1040-ES), which aren't calendar quarters:
 * Jan–Mar (due Apr 15), Apr–May (Jun 15), Jun–Aug (Sep 15), Sep–Dec (Jan 15 next year).
 */
export function taxQuarters(year: number): TaxQuarter[] {
  return [
    { quarter: 1, year, from: `${year}-01-01`, to: `${year}-03-31`, due: `${year}-04-15` },
    { quarter: 2, year, from: `${year}-04-01`, to: `${year}-05-31`, due: `${year}-06-15` },
    { quarter: 3, year, from: `${year}-06-01`, to: `${year}-08-31`, due: `${year}-09-15` },
    { quarter: 4, year, from: `${year}-09-01`, to: `${year}-12-31`, due: `${year + 1}-01-15` },
  ];
}

/** The estimated-tax period a date falls in. */
export function taxQuarterFor(date: string): TaxQuarter {
  const year = parseLocalDate(date).year;
  return taxQuarters(year).find((q) => date >= q.from && date <= q.to) as TaxQuarter;
}

/** The next estimated-tax payment due on or after `today`. */
export function nextTaxDue(today: string): TaxQuarter {
  const year = parseLocalDate(today).year;
  return [...taxQuarters(year - 1), ...taxQuarters(year)].find((q) => q.due >= today) as TaxQuarter;
}

/** Valid range for the set-aside percentage (the database enforces the same). */
export const TAX_PERCENT_MIN = 0;
export const TAX_PERCENT_MAX = 60;

/** `percent` of a profit, nothing on a loss. Rounded to the cent like the database. */
export const taxSetAside = (profitCents: number, percent: number) =>
  profitCents > 0 ? Math.round((profitCents * percent) / 100) : 0;

/** Parses a set-aside percentage typed by the owner ("25", "22.5%"), or null when invalid. */
export function parsePercent(input: string): number | null {
  const s = input.trim().replace(/%$/, '').trim();
  if (!/^\d{1,2}(\.\d)?$/.test(s)) return null;
  const n = Number(s);
  return n >= TAX_PERCENT_MIN && n <= TAX_PERCENT_MAX ? n : null;
}
