import { assertTimeZone, parseClock, parseLocalDate } from '../availability/time';
import type { HoursType, WeeklyTemplate } from '../availability/types';
import type {
  BookingRules,
  BookingSettingsRow,
  HoursBlock,
  TimeRange,
  WorkHours,
  WorkHoursOverride,
  WorkHoursOverrideRow,
  WorkHoursRows,
  WorkHoursTemplateRow,
} from './types';

const HOURS_TYPES: readonly HoursType[] = ['open', 'tentative', 'closed'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRange(value: unknown, what: string): TimeRange {
  if (!isRecord(value) || typeof value.start !== 'string' || typeof value.end !== 'string') {
    throw new RangeError(`Invalid ${what}: ${JSON.stringify(value)}`);
  }
  if (parseClock(value.end) <= parseClock(value.start)) {
    throw new RangeError(`${what} must end after it starts: ${value.start}–${value.end}`);
  }
  return { start: value.start, end: value.end };
}

function asArray(value: unknown, what: string): unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new RangeError(`${what} must be an array`);
  return value;
}

/** Validates a `blocks` JSON column. Mirrors `private.is_valid_hours_ranges(_, true)`. */
export function parseHoursBlocks(value: unknown): HoursBlock[] {
  return asArray(value, 'blocks').map((b) => {
    const range = parseRange(b, 'hours block');
    const type = (b as Record<string, unknown>).type;
    if (typeof type !== 'string' || !HOURS_TYPES.includes(type as HoursType)) {
      throw new RangeError(`Invalid hours type: ${String(type)}`);
    }
    return { ...range, type: type as HoursType };
  });
}

/** Validates a `breaks` JSON column. */
export function parseTimeRanges(value: unknown): TimeRange[] {
  return asArray(value, 'breaks').map((b) => parseRange(b, 'break'));
}

function rangeDays(o: WorkHoursOverrideRow): number {
  const a = parseLocalDate(o.start_date);
  const b = parseLocalDate(o.end_date);
  return Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
}

export function overrideFromRow(row: WorkHoursOverrideRow): WorkHoursOverride {
  if (row.end_date < row.start_date) {
    throw new RangeError(`Override ends before it starts: ${row.start_date}…${row.end_date}`);
  }
  const closed = row.kind !== 'custom';
  return {
    from: row.start_date,
    to: row.end_date,
    blocks: closed ? [] : parseHoursBlocks(row.blocks),
    breaks: closed ? [] : parseTimeRanges(row.breaks),
    kind: row.kind,
    note: row.note ?? null,
  };
}

/**
 * Orders overrides for the engine, where the last match wins: wider ranges first, so a
 * single painted day beats the vacation it sits in; ties go to the most recently updated.
 */
export function sortOverrides(rows: readonly WorkHoursOverrideRow[]): WorkHoursOverrideRow[] {
  return [...rows].sort(
    (a, b) =>
      rangeDays(b) - rangeDays(a) ||
      (a.updated_at ?? '').localeCompare(b.updated_at ?? '') ||
      a.start_date.localeCompare(b.start_date),
  );
}

/** Builds the availability engine's `WorkHours` input from DB rows. */
export function buildWorkHours({ timeZone, template, overrides = [] }: WorkHoursRows): WorkHours {
  assertTimeZone(timeZone);
  const weekly: WeeklyTemplate = {};
  for (const row of template) {
    if (!Number.isInteger(row.weekday) || row.weekday < 0 || row.weekday > 6) {
      throw new RangeError(`Invalid weekday: ${row.weekday}`);
    }
    weekly[row.weekday as keyof WeeklyTemplate] = {
      blocks: parseHoursBlocks(row.blocks),
      breaks: parseTimeRanges(row.breaks),
    };
  }
  return { timeZone, weekly, overrides: sortOverrides(overrides).map(overrideFromRow) };
}

/** Template rows for all 7 weekdays (closed days get empty blocks), ready to upsert. */
export function templateToRows(weekly: WeeklyTemplate): WorkHoursTemplateRow[] {
  return ([0, 1, 2, 3, 4, 5, 6] as const).map((weekday) => ({
    weekday,
    blocks: weekly[weekday]?.blocks ?? [],
    breaks: weekly[weekday]?.breaks ?? [],
  }));
}

/** Override row for an upsert on `(salon_id, start_date, end_date)`. */
export function overrideToRow(o: WorkHoursOverride): WorkHoursOverrideRow {
  const hasHours = o.blocks.some((b) => b.type !== 'closed');
  const kind = o.kind ?? (hasHours ? 'custom' : 'day_off');
  const closed = kind !== 'custom';
  return {
    start_date: o.from,
    end_date: o.to ?? o.from,
    kind,
    blocks: closed ? [] : o.blocks,
    breaks: closed ? [] : (o.breaks ?? []),
    note: o.note ?? null,
  };
}

/** Maps `settings` columns onto the engine's `BookingRules`. */
export function bookingRulesFromSettings(row: BookingSettingsRow): BookingRules {
  return {
    leadTimeMinutes: row.min_notice_minutes,
    bookingWindowDays: row.booking_window_days,
    slotGridMinutes: row.slot_grid_minutes,
  };
}

/**
 * What to write so the DB matches the edited overrides: `deletes` are ids of saved rows whose
 * range is gone, `upserts` are new or changed rows (keyed by `start_date`/`end_date`).
 */
export function diffOverrides(
  saved: readonly (WorkHoursOverrideRow & { id: string })[],
  edited: readonly WorkHoursOverride[],
): { upserts: WorkHoursOverrideRow[]; deletes: string[] } {
  const key = (r: WorkHoursOverrideRow) => `${r.start_date}|${r.end_date}`;
  const same = (a: WorkHoursOverrideRow, b: WorkHoursOverrideRow) =>
    JSON.stringify(a) === JSON.stringify(b);
  const savedByKey = new Map(saved.map((r) => [key(r), overrideToRow(overrideFromRow(r))]));
  const next = edited.map(overrideToRow);
  const nextKeys = new Set(next.map(key));
  return {
    upserts: next.filter((r) => {
      const prev = savedByKey.get(key(r));
      return !prev || !same(prev, r);
    }),
    deletes: saved.filter((r) => !nextKeys.has(key(r))).map((r) => r.id),
  };
}
