/**
 * Rebook at checkout (docs/PLAN.md §11b, issue #42): how soon a client should come back for a
 * service, and 2–3 engine-checked slots for that visit at the same weekday and time of day.
 */
import { findSlots } from '../availability/engine.ts';
import {
  DAY_MS,
  addDays,
  formatClock,
  formatLocalDate,
  parseLocalDate,
  toMs,
  zonedParts,
} from '../availability/time.ts';
import type {
  BookingRules,
  ExistingAppointment,
  InstantInput,
  ServiceRequest,
  SlotCandidate,
  WorkHours,
} from '../availability/types.ts';

/** Used when nothing on the visit has a known interval. */
export const DEFAULT_REBOOK_DAYS = 42;
export const MIN_REBOOK_DAYS = 7;
export const MAX_REBOOK_DAYS = 365;

/** Name patterns first (most specific), then categories. `null` = a one-off, no rebook. */
const TYPICAL_BY_NAME: readonly [RegExp, number | null][] = [
  [/consult|bridal|wedding|updo|special occasion|prom\b|correction/i, null],
  [/\bmen'?s\b|beard|fade|bang|fringe|line[- ]?up/i, 21],
  [/balayage|ombr[eé]/i, 84],
  [/keratin|smoothing|\bperm\b|extension/i, 84],
  [/highlight|foil/i, 56],
  [/root|retouch|touch[- ]?up/i, 28],
  [/toner|gloss/i, 42],
  [/condition|treatment|bond|olaplex/i, 28],
  [/blow[- ]?out|blow[- ]?dry/i, 7],
];

const TYPICAL_BY_CATEGORY: Readonly<Record<string, number>> = {
  cuts: 42,
  color: 42,
  treatments: 42,
};

/** Typical days between visits for a service the owner hasn't set an interval on. */
export function typicalRebookDays(service: {
  name: string;
  category?: string | null;
}): number | null {
  for (const [pattern, days] of TYPICAL_BY_NAME) if (pattern.test(service.name)) return days;
  return TYPICAL_BY_CATEGORY[service.category?.trim().toLowerCase() ?? ''] ?? null;
}

/** A past visit, for learning the client's own rhythm. */
export interface RebookVisit {
  startsAt: InstantInput;
  /** `services.id` of everything booked on the visit. */
  serviceIds: readonly string[];
}

/**
 * The client's own interval for a service: the median gap between their recent visits that
 * included it (the last `maxGaps` gaps). Same-week repeats (fixes) and gaps over a year are
 * ignored. Null until there are at least two such visits.
 */
export function learnClientInterval(
  visits: readonly RebookVisit[],
  serviceId: string,
  options: { maxGaps?: number } = {},
): { days: number; samples: number } | null {
  const starts = [
    ...new Set(
      visits
        .filter((v) => v.serviceIds.includes(serviceId))
        .map((v) => Math.floor(toMs(v.startsAt) / DAY_MS)),
    ),
  ].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i]! - starts[i - 1]!;
    if (gap >= MIN_REBOOK_DAYS && gap <= MAX_REBOOK_DAYS) gaps.push(gap);
  }
  const recent = gaps.slice(-(options.maxGaps ?? 4));
  if (recent.length === 0) return null;
  const sorted = [...recent].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { days: Math.round(median), samples: recent.length };
}

/** A service booked on the visit being checked out. */
export interface RebookService {
  id: string;
  name: string;
  category?: string | null;
  /** The owner's setting (`services.rebook_interval_days`); null = use the typical interval. */
  rebookIntervalDays?: number | null;
}

/**
 * - `client`: learned from this client's history.
 * - `service`: the owner's setting on the service.
 * - `typical`: a sensible default for that kind of service.
 * - `default`: nothing known; six weeks.
 */
export type RebookIntervalSource = 'client' | 'service' | 'typical' | 'default';

export interface RebookInterval {
  /** The service the interval came from (the one with the longest interval on the visit). */
  serviceId: string;
  serviceName: string;
  days: number;
  source: RebookIntervalSource;
  /** Gaps the client interval was learned from. */
  samples?: number;
}

/**
 * When the client's next visit is due. Each booked service gets the client's own interval, else
 * the owner's setting, else the typical one; the visit follows the longest of those (a color +
 * cut comes back on the color's rhythm). Null when nothing was booked.
 */
export function rebookInterval(
  services: readonly RebookService[],
  history: readonly RebookVisit[] = [],
): RebookInterval | null {
  let best: RebookInterval | null = null;
  for (const s of services) {
    const learned = learnClientInterval(history, s.id);
    const typical = typicalRebookDays(s);
    const base = { serviceId: s.id, serviceName: s.name };
    const candidate: RebookInterval | null = learned
      ? { ...base, days: learned.days, source: 'client', samples: learned.samples }
      : s.rebookIntervalDays != null
        ? { ...base, days: s.rebookIntervalDays, source: 'service' }
        : typical != null
          ? { ...base, days: typical, source: 'typical' }
          : null;
    if (candidate && (!best || candidate.days > best.days)) best = candidate;
  }
  if (best) return best;
  const first = services[0];
  return first
    ? { serviceId: first.id, serviceName: first.name, days: DEFAULT_REBOOK_DAYS, source: 'default' }
    : null;
}

/**
 * Local date the next visit is due: `days` after the visit. From two weeks out it is rounded to
 * whole weeks so it lands on the same weekday the client already comes in on.
 */
export function rebookTargetDate(visitStart: InstantInput, days: number, timeZone: string): string {
  const local = zonedParts(toMs(visitStart), timeZone);
  const offset = days >= 14 ? Math.round(days / 7) * 7 : Math.max(1, days);
  return formatLocalDate(addDays(local, offset));
}

/** "~6 weeks", "1 week", "10 days". */
export function formatRebookInterval(days: number): string {
  if (days >= 14) return `~${Math.round(days / 7)} weeks`;
  return days === 7 ? '1 week' : `${days} days`;
}

export interface SuggestRebookInput {
  /** The visit's services, resolved as one request (the same thing `planBooking` books). */
  service: ServiceRequest;
  hours: WorkHours;
  /** Everything on the calendar around the target date. */
  existing: readonly ExistingAppointment[];
  /** Start of the visit being checked out: anchors the weekday and time of day. */
  visitStart: InstantInput;
  intervalDays: number;
  now: InstantInput;
  /** Owner bookings: no lead time or booking window unless given. */
  rules?: BookingRules;
  /** Default 3. */
  limit?: number;
  /** Minutes either side of the visit's start time that count as "the same time". Default 60. */
  timeWindowMinutes?: number;
  /** Weeks to look past the target when it is fully booked. Default 3. */
  extraWeeks?: number;
}

export interface RebookSuggestion {
  /** Local date the visit is due. */
  targetDate: string;
  /** Best first: the due date at the client's usual time, then the nearest days around it. */
  slots: SlotCandidate[];
}

/**
 * Suggests slots for the next visit with the availability engine: the due date (±3 days), with
 * the visit's time of day as the preference, one slot per day so the client has real choices.
 * When that whole week is booked up it tries the following weeks.
 */
export function suggestRebookSlots(input: SuggestRebookInput): RebookSuggestion {
  const { timeZone } = input.hours;
  const limit = input.limit ?? 3;
  const targetDate = rebookTargetDate(input.visitStart, input.intervalDays, timeZone);
  const usual = zonedParts(toMs(input.visitStart), timeZone).minutes;
  const window = input.timeWindowMinutes ?? 60;
  const preference = {
    start: formatClock(Math.max(0, usual - window)),
    end: formatClock(Math.min(24 * 60, usual + window)),
  };
  const rules: BookingRules = {
    leadTimeMinutes: 0,
    bookingWindowDays: Number.POSITIVE_INFINITY,
    ...input.rules,
  };

  for (let week = 0; week <= (input.extraWeeks ?? 3); week++) {
    const requestedDate = formatLocalDate(addDays(parseLocalDate(targetDate), week * 7));
    const ranked = findSlots({
      service: input.service,
      hours: input.hours,
      requestedDate,
      searchRadiusDays: 3,
      preference,
      existing: [...input.existing],
      rules,
      now: input.now,
    });
    const slots = pickSpread(ranked, limit, (slot) =>
      Math.abs(zonedParts(toMs(slot.start), timeZone).minutes - usual),
    );
    if (slots.length > 0) return { targetDate, slots };
  }
  return { targetDate, slots: [] };
}

/**
 * One slot per day at the usual time (days in rank order, the closest time on each), then one per
 * remaining day at any time, then more from the same days if still short.
 */
function pickSpread(
  ranked: readonly SlotCandidate[],
  limit: number,
  distance: (slot: SlotCandidate) => number,
): SlotCandidate[] {
  const days = new Set<string>();
  const picked: SlotCandidate[] = [];
  for (const slot of ranked) {
    if (picked.length >= limit) break;
    if (!slot.matchesPreference || days.has(slot.localDate)) continue;
    let best = slot;
    for (const other of ranked) {
      if (other.matchesPreference && other.localDate === slot.localDate) {
        if (distance(other) < distance(best)) best = other;
      }
    }
    days.add(best.localDate);
    picked.push(best);
  }
  const take = (accept: (slot: SlotCandidate) => boolean) => {
    for (const slot of ranked) {
      if (picked.length >= limit) return;
      if (picked.includes(slot) || !accept(slot)) continue;
      days.add(slot.localDate);
      picked.push(slot);
    }
  };
  take((s) => !days.has(s.localDate));
  take(() => true);
  return picked;
}
