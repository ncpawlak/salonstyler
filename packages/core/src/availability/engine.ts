import { dayAvailability, type DayAvailability } from './hours';
import { mergeIntervals, overlapMs, overlaps, contains, subtractIntervals } from './intervals';
import { busyRanges, isBlocking, layoutService, processingRanges, type TimedSegment } from './segments';
import {
  MINUTE,
  DAY_MS,
  addDays,
  assertTimeZone,
  daysBetween,
  formatClock,
  formatLocalDate,
  parseClock,
  parseLocalDate,
  toIso,
  toMs,
  zonedParts,
  zonedToUtc,
} from './time';
import type {
  BookingRules,
  ExistingAppointment,
  FindSlotsInput,
  InstantInput,
  Interval,
  ServiceRequest,
  SlotCandidate,
  TimePreference,
  WorkHours,
} from './types';

export const DEFAULT_RULES: Required<BookingRules> = {
  leadTimeMinutes: 0,
  bookingWindowDays: Number.POSITIVE_INFINITY,
  slotGridMinutes: 15,
  snapGridMinutes: 5,
  minUsefulGapMinutes: 30,
};

/** Local windows for named parts of day, in minutes since local midnight: [from, to). */
export const TIME_OF_DAY_WINDOWS = {
  morning: { from: 0, to: 12 * 60 },
  afternoon: { from: 12 * 60, to: 17 * 60 },
  evening: { from: 17 * 60, to: 24 * 60 },
} as const;

export type RejectionReason = 'lead-time' | 'booking-window' | 'outside-hours' | 'conflict' | 'tentative-excluded';

export type Evaluation =
  | { ok: true; candidate: SlotCandidate }
  | { ok: false; reason: RejectionReason };

interface Context {
  service: ServiceRequest;
  hours: WorkHours;
  rules: Required<BookingRules>;
  now: number;
  occupied: Interval[];
  processing: Interval[];
  includeTentative: boolean;
  preference: { from: number; to: number } | undefined;
  requestedDate: string;
}

function buildContext(input: {
  service: ServiceRequest;
  hours: WorkHours;
  existing?: ExistingAppointment[] | undefined;
  blocked?: Array<{ start: InstantInput; end: InstantInput }> | undefined;
  rules?: BookingRules | undefined;
  now: InstantInput;
  includeTentative?: boolean | undefined;
  preference?: TimePreference | undefined;
  requestedDate: string;
}): Context {
  assertTimeZone(input.hours.timeZone);
  const rules = { ...DEFAULT_RULES, ...stripUndefined(input.rules ?? {}) };
  if (rules.slotGridMinutes <= 0 || !Number.isInteger(rules.slotGridMinutes)) throw new RangeError('slotGridMinutes must be a positive integer');
  layoutService(input.service, 0);
  const existing = input.existing ?? [];
  const blocked = (input.blocked ?? []).map((b) => ({ start: toMs(b.start), end: toMs(b.end) }));
  return {
    service: input.service,
    hours: input.hours,
    rules,
    now: toMs(input.now),
    occupied: mergeIntervals([...existing.flatMap((a) => busyRanges(a.segments)), ...blocked]),
    processing: mergeIntervals(existing.flatMap((a) => processingRanges(a.segments))),
    includeTentative: input.includeTentative ?? true,
    preference: resolvePreference(input.preference),
    requestedDate: formatLocalDate(parseLocalDate(input.requestedDate)),
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function resolvePreference(p: TimePreference | undefined): { from: number; to: number } | undefined {
  if (p === undefined) return undefined;
  if (typeof p === 'string') return TIME_OF_DAY_WINDOWS[p];
  return { from: parseClock(p.start), to: parseClock(p.end) };
}

function evaluate(ctx: Context, clientStart: number, day: DayAvailability): Evaluation {
  const { rules } = ctx;
  if (clientStart < ctx.now + rules.leadTimeMinutes * MINUTE) return { ok: false, reason: 'lead-time' };
  if (clientStart > ctx.now + rules.bookingWindowDays * DAY_MS) return { ok: false, reason: 'booking-window' };

  const timed = layoutService(ctx.service, clientStart);
  const span: Interval = { start: timed[0]!.start, end: timed[timed.length - 1]!.end };
  const container = day.available.find((a) => contains(a, span));
  if (!container) return { ok: false, reason: 'outside-hours' };

  const blocking = timed.filter((s) => isBlocking(s.kind));
  if (blocking.some((s) => ctx.occupied.some((o) => overlaps(o, s)))) return { ok: false, reason: 'conflict' };

  const requiresApproval = day.tentative.some((t) => overlaps(t, span));
  if (requiresApproval && !ctx.includeTentative) return { ok: false, reason: 'tentative-excluded' };

  const newOccupied = mergeIntervals(blocking);
  const allOccupied = mergeIntervals([...ctx.occupied, ...newOccupied]);

  let processingFillMs = 0;
  for (const s of newOccupied) for (const p of ctx.processing) processingFillMs += overlapMs(s, p);

  let deadMs = 0;
  const minUseful = rules.minUsefulGapMinutes * MINUTE;
  for (const f of subtractIntervals(day.available, allOccupied)) {
    const len = f.end - f.start;
    if (len >= minUseful) continue;
    if (newOccupied.some((n) => n.end === f.start || n.start === f.end)) deadMs += len;
  }

  let abutting = 0;
  for (const n of newOccupied) {
    if (n.start === container.start || ctx.occupied.some((o) => o.end === n.start)) abutting++;
    if (n.end === container.end || ctx.occupied.some((o) => o.start === n.end)) abutting++;
  }

  const deadMinutes = Math.round(deadMs / MINUTE);
  const processingFillMinutes = Math.round(processingFillMs / MINUTE);
  const score = 100 + 10 * abutting + processingFillMinutes - 2 * deadMinutes - (requiresApproval ? 50 : 0);

  const local = zonedParts(clientStart, ctx.hours.timeZone);
  const localDate = formatLocalDate(local);
  const pref = ctx.preference;
  let preferenceDistance = 0;
  if (pref) {
    if (local.minutes < pref.from) preferenceDistance = pref.from - local.minutes;
    else if (local.minutes >= pref.to) preferenceDistance = local.minutes - pref.to + 1;
  }

  const clientSegments = timed.filter((s) => s.kind !== 'buffer');
  const reasons: string[] = [];
  if (processingFillMinutes > 0) reasons.push(`uses ${processingFillMinutes}m of another client's processing time`);
  if (abutting > 0) reasons.push(`fits snugly (${abutting} edge${abutting > 1 ? 's' : ''} flush)`);
  if (deadMinutes > 0) reasons.push(`leaves ${deadMinutes}m unusable gap`);
  if (requiresApproval) reasons.push('in tentative hours: needs stylist approval');
  if (pref && preferenceDistance > 0) reasons.push('outside requested time of day');

  const candidate: SlotCandidate = {
    start: toIso(clientStart),
    end: toIso(clientSegments[clientSegments.length - 1]!.end),
    localDate,
    localTime: formatClock(local.minutes),
    dayOffset: daysBetween(parseLocalDate(ctx.requestedDate), local),
    requiresApproval,
    matchesPreference: preferenceDistance === 0,
    score,
    deadMinutes,
    processingFillMinutes,
    segments: timed.map((s) => ({ kind: s.kind, start: toIso(s.start), end: toIso(s.end) })),
    reasons,
    preferenceDistanceMinutes: preferenceDistance,
  };
  return { ok: true, candidate };
}

/**
 * Ranking: requested day first, then nearer days (earlier before later on ties); within a day, slots
 * matching the time-of-day preference, then Open before Tentative, then closeness to the preferred
 * window, then fit score, then earliest start. Total order ⇒ deterministic.
 */
export function compareCandidates(a: SlotCandidate, b: SlotCandidate): number {
  return (
    Math.abs(a.dayOffset) - Math.abs(b.dayOffset) ||
    a.dayOffset - b.dayOffset ||
    Number(b.matchesPreference) - Number(a.matchesPreference) ||
    Number(a.requiresApproval) - Number(b.requiresApproval) ||
    a.preferenceDistanceMinutes - b.preferenceDistanceMinutes ||
    b.score - a.score ||
    Date.parse(a.start) - Date.parse(b.start)
  );
}

function candidateStarts(ctx: Context, date: string, day: DayAvailability, timed: TimedSegment[]): number[] {
  const tz = ctx.hours.timeZone;
  const ld = parseLocalDate(date);
  const starts = new Set<number>();
  const { slotGridMinutes: grid, snapGridMinutes: snap } = ctx.rules;

  for (let m = 0; m < 24 * 60; m += grid) starts.add(zonedToUtc(ld, m, tz));

  if (snap > 0 && day.available.length > 0) {
    const anchors = new Set<number>();
    for (const a of day.available) anchors.add(a.start).add(a.end);
    const dayStart = day.available[0]!.start;
    const dayEnd = day.available[day.available.length - 1]!.end;
    for (const o of ctx.occupied) {
      if (o.end >= dayStart && o.start <= dayEnd) anchors.add(o.start).add(o.end);
    }
    for (const s of timed.filter((t) => isBlocking(t.kind))) {
      for (const anchor of anchors) {
        for (const candidate of [anchor - s.start, anchor - s.end]) {
          const p = zonedParts(candidate, tz);
          if (p.minutes % snap === 0 && formatLocalDate(p) === date) starts.add(candidate);
        }
      }
    }
  }
  return [...starts].sort((a, b) => a - b);
}

/** Days to search, in order: requested, −1, +1, −2, +2, … */
function searchDates(requestedDate: string, radius: number): string[] {
  const base = parseLocalDate(requestedDate);
  const out = [formatLocalDate(base)];
  for (let d = 1; d <= radius; d++) out.push(formatLocalDate(addDays(base, -d)), formatLocalDate(addDays(base, d)));
  return out;
}

/**
 * Finds bookable starts for a service on the requested day and ±`searchRadiusDays`, ranked.
 * Pure and deterministic: same input ⇒ same output.
 */
export function findSlots(input: FindSlotsInput): SlotCandidate[] {
  const ctx = buildContext(input);
  const radius = input.searchRadiusDays ?? 3;
  if (radius < 0 || !Number.isInteger(radius)) throw new RangeError('searchRadiusDays must be a non-negative integer');
  const relative = layoutService(ctx.service, 0);
  const results: SlotCandidate[] = [];
  for (const date of searchDates(ctx.requestedDate, radius)) {
    const day = dayAvailability(ctx.hours, date);
    if (day.available.length === 0) continue;
    for (const start of candidateStarts(ctx, date, day, relative)) {
      const r = evaluate(ctx, start, day);
      if (r.ok) results.push(r.candidate);
    }
  }
  results.sort(compareCandidates);
  return input.limit !== undefined ? results.slice(0, input.limit) : results;
}

/**
 * Checks a specific start (e.g. manual booking or drag-to-move) against the same rules as
 * `findSlots`. Exclude the appointment being moved from `existing`.
 */
export function evaluateStart(
  input: Omit<FindSlotsInput, 'requestedDate' | 'searchRadiusDays' | 'limit'> & { start: InstantInput },
): Evaluation {
  const start = toMs(input.start);
  const date = formatLocalDate(zonedParts(start, input.hours.timeZone));
  const ctx = buildContext({ ...input, requestedDate: date });
  return evaluate(ctx, start, dayAvailability(ctx.hours, date));
}
