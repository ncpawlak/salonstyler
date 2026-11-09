/**
 * Availability engine types. See docs/PLAN.md §2, §3, §5.
 *
 * Conventions:
 * - Instants are UTC epoch milliseconds internally; inputs accept `Date`, ISO strings or ms.
 * - Wall-clock times are `HH:MM` strings (`24:00` allowed as an end) in the salon's IANA time zone.
 * - Local dates are `YYYY-MM-DD` strings in the salon's time zone.
 * - All intervals are half-open `[start, end)`, matching Postgres' default `tstzrange` bounds.
 */

/**
 * - `busy`: stylist is hands-on (apply, cut, tone).
 * - `processing`: client is processing; the stylist is free for someone else's busy time.
 * - `style`: finishing (rinse/blow-dry/style); the stylist is hands-on.
 */
export type SegmentKind = 'busy' | 'processing' | 'style';

/** A resolved segment of a service: kind + duration in minutes, in order. */
export interface ServiceSegment {
  kind: SegmentKind;
  minutes: number;
  label?: string;
}

/** Kinds of a placed (timed) segment. `buffer` is prep/cleanup time and blocks the stylist. */
export type PlacedSegmentKind = SegmentKind | 'buffer';

export type InstantInput = Date | string | number;

/** A placed segment of an existing appointment or hold. */
export interface PlacedSegment {
  kind: PlacedSegmentKind;
  start: InstantInput;
  end: InstantInput;
}

/** Existing appointment or hold occupying the calendar. */
export interface ExistingAppointment {
  id: string;
  segments: PlacedSegment[];
}

export interface Interval {
  start: number;
  end: number;
}

export type HoursType = 'open' | 'tentative' | 'closed';

/** A painted block of hours on a day, in local wall-clock time. */
export interface HoursBlock {
  start: string;
  end: string;
  type: HoursType;
}

export interface TimeRange {
  start: string;
  end: string;
}

/** What a single day looks like. No blocks = closed all day. */
export interface DaySchedule {
  blocks: HoursBlock[];
  breaks?: TimeRange[];
}

/** Weekly template keyed by weekday, 0 = Sunday … 6 = Saturday. Missing weekday = closed. */
export type WeeklyTemplate = Partial<Record<0 | 1 | 2 | 3 | 4 | 5 | 6, DaySchedule>>;

/**
 * Replaces the weekly template for a single date (`to` omitted) or an inclusive date range
 * (vacation, special hours). Later overrides in the array win.
 */
export interface DateOverride extends DaySchedule {
  from: string;
  to?: string;
}

export interface WorkHours {
  timeZone: string;
  weekly: WeeklyTemplate;
  overrides?: DateOverride[];
}

export type TimeOfDay = 'morning' | 'afternoon' | 'evening';

/** Either a named part of day or an explicit local window. */
export type TimePreference = TimeOfDay | TimeRange;

export interface BookingRules {
  /** Minimum minutes between `now` and a slot start. Default 0. */
  leadTimeMinutes?: number;
  /** Maximum days ahead of `now` a slot may start. Default unlimited. */
  bookingWindowDays?: number;
  /** Local wall-clock grid for candidate starts. Default 15. */
  slotGridMinutes?: number;
  /**
   * Candidates that exactly abut existing bookings/hour edges are also offered when aligned to
   * this finer grid (e.g. a cut starting 11:05 right after a color's apply). Default 5. 0 disables.
   */
  snapGridMinutes?: number;
  /** Free fragments shorter than this (but > 0) are considered unusable dead time. Default 30. */
  minUsefulGapMinutes?: number;
}

export interface DurationOverride {
  /** Index into the service's segment list. */
  index: number;
  /** Replace the duration. */
  minutes?: number;
  /** Add (or subtract) minutes. Applied after `minutes`. */
  deltaMinutes?: number;
}

export interface ServiceRequest {
  segments: ServiceSegment[];
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  /** Per-client duration overrides, e.g. "Karina's color always takes +20m". */
  overrides?: DurationOverride[];
}

export interface FindSlotsInput {
  service: ServiceRequest;
  hours: WorkHours;
  /** Local `YYYY-MM-DD` the client asked for. */
  requestedDate: string;
  /** Also search ±N days around the requested date. Default 3. */
  searchRadiusDays?: number;
  preference?: TimePreference;
  existing?: ExistingAppointment[];
  /** Fully blocked time (personal events, holds without segments). */
  blocked?: { start: InstantInput; end: InstantInput }[];
  rules?: BookingRules;
  now: InstantInput;
  /** Include tentative-hour slots. Default true. */
  includeTentative?: boolean;
  /** Maximum candidates returned. Default unlimited. */
  limit?: number;
}

export interface SlotCandidate {
  /** Client start (first service segment, excluding buffer-before), ISO UTC. */
  start: string;
  /** Client end (last service segment, excluding buffer-after), ISO UTC. */
  end: string;
  localDate: string;
  localTime: string;
  /** Signed days from the requested date. */
  dayOffset: number;
  /** True when any part of the booking falls in tentative hours. */
  requiresApproval: boolean;
  /** Whether the slot satisfies the time-of-day preference (true when none given). */
  matchesPreference: boolean;
  /** Minutes the start falls outside the preferred window (0 when it matches). */
  preferenceDistanceMinutes: number;
  /** Fit quality; higher is better. Only comparable between candidates for the same service. */
  score: number;
  /** Minutes of unusable free fragments this booking would leave. */
  deadMinutes: number;
  /** Minutes of this booking's hands-on time placed inside other appointments' processing time. */
  processingFillMinutes: number;
  /** Placed segments, including buffers. */
  segments: { kind: PlacedSegmentKind; start: string; end: string }[];
  reasons: string[];
}
