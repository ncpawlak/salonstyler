/** Value parsers for spreadsheet cells. All pure and locale-independent (US month/day order). */
import { type LocalDate, formatLocalDate } from '../availability/time.ts';

/**
 * Dedupe key for a phone number: its digits, without a leading US country code. Null when too
 * short to be a phone. Mirrors `private.phone_key()` in the Vagaro import migration.
 */
export function phoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

/** "5551234567" / "+1 555.123.4567" → "(555) 123-4567"; other valid numbers are kept as typed. */
export function formatPhone(raw: string | null | undefined): string | null {
  const key = phoneKey(raw);
  if (!key) return null;
  if (key.length === 10) return `(${key.slice(0, 3)}) ${key.slice(3, 6)}-${key.slice(6)}`;
  return raw!.trim().slice(0, 32);
}

/** Lower-cased email, or null if it doesn't look like one (same rule as the `clients` check). */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const v = raw?.trim().toLowerCase();
  if (!v || v.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return null;
  return v;
}

/**
 * Collapses whitespace, turns "Lopez, Maria" into "Maria Lopez" and fixes ALL CAPS / all lower
 * names. Null when empty.
 */
export function normalizeName(raw: string | null | undefined): string | null {
  let v = raw?.replace(/\s+/g, ' ').trim() ?? '';
  const comma = /^([^,]+),\s*([^,]+)$/.exec(v);
  if (comma) v = `${comma[2]} ${comma[1]}`;
  if (!v) return null;
  if (v === v.toUpperCase() || v === v.toLowerCase()) {
    v = v
      .toLowerCase()
      .replace(/(^|[\s'-])(\p{L})/gu, (_, p: string, c: string) => p + c.toUpperCase());
  }
  return v.slice(0, 80);
}

export const NO_YEAR = 1604;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function validDate(year: number, month: number, day: number): LocalDate | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1) return null;
  return { year, month, day };
}

const fullYear = (y: number) => (y >= 100 ? y : y + (y < 70 ? 2000 : 1900));

export interface ParsedDateTime {
  date: LocalDate;
  /** Minutes after local midnight, when the cell also had a time. */
  minutes?: number;
  /** The cell had no year (birthdays like "03/14"); `date.year` is `NO_YEAR`. */
  noYear?: boolean;
}

/**
 * Parses `2026-03-14`, `3/14/2026`, `3/14/26`, `3/14`, `Mar 14, 2026`, `14-Mar-2026`, `March 14`,
 * Excel serial days (`46095`), each optionally followed by a time (`3/14/2026 2:30 PM`).
 */
export function parseDateTime(raw: string | null | undefined): ParsedDateTime | null {
  const v = raw?.trim().replace(/\s+/g, ' ');
  if (!v) return null;

  if (/^\d{5}(\.\d+)?$/.test(v)) {
    const serial = Number(v);
    if (serial < 20_000 || serial > 80_000) return null;
    const ms = Math.round((serial - 25_569) * 86_400_000);
    const d = new Date(ms);
    const date = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
    return minutes ? { date, minutes } : { date };
  }

  let date: LocalDate | null = null;
  let noYear = false;
  let rest = '';
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](.*))?$/.exec(v))) {
    date = validDate(+m[1]!, +m[2]!, +m[3]!);
    rest = m[4] ?? '';
  } else if ((m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?(?:,? (.*))?$/.exec(v))) {
    noYear = m[3] === undefined;
    date = validDate(noYear ? NO_YEAR : fullYear(+m[3]!), +m[1]!, +m[2]!);
    rest = m[4] ?? '';
  } else if (
    (m =
      /^(?:[a-z]+,? )?([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?(?:,? (.*))?$/i.exec(
        v,
      ))
  ) {
    const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1;
    noYear = m[3] === undefined;
    date = month ? validDate(noYear ? NO_YEAR : +m[3]!, month, +m[2]!) : null;
    rest = m[4] ?? '';
  } else if ((m = /^(\d{1,2})[ -]([a-z]{3,9})[ -](\d{2,4})(?: (.*))?$/i.exec(v))) {
    const month = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1;
    date = month ? validDate(fullYear(+m[3]!), month, +m[1]!) : null;
    rest = m[4] ?? '';
  }
  if (!date) return null;
  const out: ParsedDateTime = noYear ? { date, noYear } : { date };
  if (rest.trim()) {
    const minutes = parseTimeOfDay(rest);
    if (minutes === null) return null;
    out.minutes = minutes;
  }
  return out;
}

/** "YYYY-MM-DD", or null. Birthdays without a year use `NO_YEAR` (1604, the vCard convention). */
export function parseDateString(raw: string | null | undefined): string | null {
  const p = parseDateTime(raw);
  return p ? formatLocalDate(p.date) : null;
}

/** `2:30 PM`, `2:30pm`, `2 PM`, `14:30`, `14:30:00`, `0.6041` (Excel fraction) → minutes. */
export function parseTimeOfDay(raw: string | null | undefined): number | null {
  const v = raw?.trim().toLowerCase();
  if (!v) return null;
  if (/^0?\.\d+$/.test(v)) return Math.round(Number(v) * 1440) % 1440;
  const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2}(?:\.\d+)?)?\s*(a\.?m\.?|p\.?m\.?|a|p)?$/.exec(v);
  if (!m) return null;
  let h = +m[1]!;
  const min = m[2] ? +m[2] : 0;
  if (!m[3] && !m[2]) return null;
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    const pm = m[3].startsWith('p');
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  } else if (h > 23) return null;
  return h * 60 + min;
}

/** `90`, `90 min`, `1h 30m`, `1:30`, `1.5 hours` → minutes (1–1440), or null. */
export function parseDuration(raw: string | null | undefined): number | null {
  const v = raw?.trim().toLowerCase();
  if (!v) return null;
  let minutes: number | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^(\d+):(\d{2})$/.exec(v))) minutes = +m[1]! * 60 + +m[2]!;
  else if (
    (m = /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?$/.exec(v))
  )
    minutes = m[1] || m[2] ? Math.round(Number(m[1] ?? 0) * 60) + Number(m[2] ?? 0) : null;
  if (minutes === null && /^\d+$/.test(v)) minutes = +v;
  return minutes !== null && minutes >= 1 && minutes <= 1440 ? minutes : null;
}

/** `$65.00`, `65`, `1,250.50` → cents, or null. */
export function parseMoneyCents(raw: string | null | undefined): number | null {
  const v = raw?.replace(/[$,\s]/g, '');
  if (!v || !/^\d+(\.\d{1,2})?$/.test(v)) return null;
  const cents = Math.round(Number(v) * 100);
  return cents <= 10_000_000 ? cents : null;
}

export function parseCount(raw: string | null | undefined): number | null {
  const v = raw?.trim();
  if (!v || !/^\d+(\.0+)?$/.test(v)) return null;
  return Math.min(Number.parseInt(v, 10), 10_000);
}

/** Splits on `,` `;` `|` and dedupes case-insensitively. Fits the `clients.tags` check. */
export function parseTags(raw: string | null | undefined): string[] {
  return mergeTags([], (raw ?? '').split(/[,;|]/));
}

export function mergeTags(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const t of [...a, ...b]) {
    const tag = t.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    if (out.length >= 20 || total + tag.length > 400) break;
    seen.add(tag.toLowerCase());
    out.push(tag);
    total += tag.length;
  }
  return out;
}
