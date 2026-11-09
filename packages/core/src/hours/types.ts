import type {
  BookingRules,
  DateOverride,
  HoursBlock,
  Interval,
  TimeRange,
  WorkHours,
} from '../availability/types.ts';

/** `work_hours_template` row (snake_case, as returned by `@chairside/db`). */
export interface WorkHoursTemplateRow {
  weekday: number;
  /** JSON array of `HoursBlock`. */
  blocks: unknown;
  /** JSON array of `TimeRange`. */
  breaks: unknown;
}

export type OverrideKind = 'custom' | 'day_off' | 'vacation';

/** `work_hours_override` row (snake_case, as returned by `@chairside/db`). */
export interface WorkHoursOverrideRow {
  start_date: string;
  end_date: string;
  kind: OverrideKind;
  blocks: unknown;
  breaks: unknown;
  note?: string | null;
  updated_at?: string;
}

/** Booking-rule columns of the `settings` row. */
export interface BookingSettingsRow {
  min_notice_minutes: number;
  booking_window_days: number;
  slot_grid_minutes: number;
}

export interface WorkHoursRows {
  /** `salons.timezone` (IANA). */
  timeZone: string;
  template: readonly WorkHoursTemplateRow[];
  overrides?: readonly WorkHoursOverrideRow[];
}

/** A `DateOverride` that remembers its DB kind/note so the UI can label it. */
export interface WorkHoursOverride extends DateOverride {
  kind?: OverrideKind;
  note?: string | null;
}

/** How a day reads at a glance in the calendar. */
export type DayStatus = 'open' | 'tentative' | 'mixed' | 'closed';

/**
 * The resolved hours for one local date. `blocks` uses the availability engine's own
 * `HoursBlock` type: open/tentative only, sorted, non-overlapping, with breaks and closed
 * blocks already removed, so `{ blocks }` is a valid `DaySchedule` for the engine.
 */
export interface WorkingBlocks {
  /** Local `YYYY-MM-DD` in the salon's time zone. */
  date: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  timeZone: string;
  source: 'template' | 'override';
  /** The override in effect, when `source === 'override'`. */
  override?: WorkHoursOverride;
  status: DayStatus;
  blocks: HoursBlock[];
  /** Real (UTC) instants, DST-correct. Matches the engine's `dayAvailability`. */
  open: Interval[];
  tentative: Interval[];
  available: Interval[];
  /** Real elapsed minutes of open/tentative time (differs from wall clock on DST days). */
  openMinutes: number;
  tentativeMinutes: number;
}

export type { BookingRules, DateOverride, HoursBlock, TimeRange, WorkHours };
