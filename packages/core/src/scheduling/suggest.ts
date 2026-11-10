/**
 * Ranked slot suggestions for Auto-Find (new appointment, #88) and Auto-Schedule (inbox request,
 * #84). The availability engine does all the slot math (segments, processing gaps, open vs.
 * tentative hours, minimum notice, buffers, overlaps); this only ranks the slots it returns by the
 * request, the client's habits and when they're due, and explains each pick with reason chips.
 */
import { TIME_OF_DAY_WINDOWS, findSlots } from '../availability/engine.ts';
import {
  addDays,
  daysBetween,
  formatLocalDate,
  parseClock,
  parseLocalDate,
  toMs,
  weekday,
  zonedParts,
} from '../availability/time.ts';
import type {
  BookingRules,
  ExistingAppointment,
  InstantInput,
  ServiceRequest,
  SlotCandidate,
  TimePreference,
  WorkHours,
} from '../availability/types.ts';
import {
  type ClientHabits,
  type DueDate,
  WEEKDAY_NAMES,
  type Weekday,
  formatTime12,
  hasHabits,
} from './habits.ts';

/**
 * - `requested`: inside what the client asked for.
 * - `nearest`: outside it, but the closest the calendar allows.
 * - `usual`: the client's usual weekday / time.
 * - `due`: around when they're due back (cadence or rebook interval).
 * - `popular`: the salon's busiest weekday / time (new clients).
 * - `soonest`: among the earliest openings.
 * - `tentative`: in tentative hours; booking it needs the stylist's OK.
 */
export type SuggestionReasonKind =
  'requested' | 'nearest' | 'usual' | 'due' | 'popular' | 'soonest' | 'tentative';

export interface SuggestionReason {
  kind: SuggestionReasonKind;
  label: string;
}

export interface SlotSuggestion {
  slot: SlotCandidate;
  reasons: SuggestionReason[];
  /** Falls in tentative hours. */
  tentative: boolean;
}

/** What the client asked for, as local dates (inclusive) and an optional time of day / weekdays. */
export interface RequestWindow {
  from: string;
  to: string;
  preference?: TimePreference | null;
  weekdays?: readonly Weekday[] | null;
  /** Chip text for slots inside the window ("Next week, mornings"). */
  label?: string;
}

export interface SuggestSlotsInput {
  service: ServiceRequest;
  hours: WorkHours;
  existing?: readonly ExistingAppointment[];
  blocked?: { start: InstantInput; end: InstantInput }[];
  /** The salon's booking rules (minimum notice, grid…). */
  rules?: BookingRules;
  now: InstantInput;
  habits?: ClientHabits | null;
  due?: DueDate | null;
  /** The salon's own booking pattern, for clients without history. */
  popular?: ClientHabits | null;
  request?: RequestWindow | null;
  /** Days ahead to look (beyond any request / due date). Default 42. */
  horizonDays?: number;
  /** Default 5. */
  limit?: number;
  /** Earliest openings to include alongside habit picks. Default 2. */
  soonest?: number;
}

export interface SlotSuggestions {
  /** Best first; at most one per day. */
  suggestions: SlotSuggestion[];
  /** With a request: whether anything fits inside it. Null without a request. */
  fits: boolean | null;
}

const USUAL_TIME_WINDOW = 45;

function preferenceWindow(p: TimePreference): { from: number; to: number } {
  return typeof p === 'string'
    ? TIME_OF_DAY_WINDOWS[p]
    : { from: parseClock(p.start), to: parseClock(p.end) };
}

const outside = (minutes: number, w: { from: number; to: number }) =>
  minutes < w.from ? w.from - minutes : minutes >= w.to ? minutes - w.to + 1 : 0;

interface Scored {
  slot: SlotCandidate;
  reasons: SuggestionReason[];
  score: number;
  inRequest: boolean;
  /** Days outside the request window, then minutes outside its time; for "nearest" ordering. */
  requestDays: number;
  requestMinutes: number;
}

function habitReason(
  kind: 'usual' | 'popular',
  habits: ClientHabits,
  w: Weekday,
  minutes: number,
): { reason: SuggestionReason | null; points: number } {
  const prefix = kind === 'usual' ? 'Usual' : 'Popular';
  const day = habits.weekdays.includes(w);
  const time =
    habits.usualMinutes !== null && Math.abs(minutes - habits.usualMinutes) <= USUAL_TIME_WINDOW;
  const part =
    !time &&
    habits.timeOfDay !== null &&
    outside(minutes, TIME_OF_DAY_WINDOWS[habits.timeOfDay]) === 0;
  const scale = kind === 'usual' ? 1 : 0.4;
  let points = 0;
  if (day) points += 40 * scale;
  if (time) points += (40 - Math.abs(minutes - habits.usualMinutes!) / 3) * scale;
  if (part) points += 15 * scale;
  const name = WEEKDAY_NAMES[w];
  const clock = time ? formatTime12(habits.usualMinutes!) : null;
  const label =
    day && clock
      ? `${prefix} ${name} ${clock}`
      : day
        ? `${prefix} ${name}`
        : clock
          ? `${prefix} time · ${clock}`
          : part
            ? `${prefix} ${habits.timeOfDay}`
            : null;
  return { reason: label ? { kind, label } : null, points };
}

/** Ranks the engine's open slots from today out to the horizon (and past any request / due date). */
export function suggestSlots(input: SuggestSlotsInput): SlotSuggestions {
  const { timeZone } = input.hours;
  const limit = input.limit ?? 5;
  const today = parseLocalDate(formatLocalDate(zonedParts(toMs(input.now), timeZone)));
  const { request, due, habits, popular } = input;

  let end = addDays(today, input.horizonDays ?? 42);
  for (const d of [request?.to, due?.date]) {
    if (!d) continue;
    const past = addDays(parseLocalDate(d), 7);
    if (daysBetween(end, past) > 0) end = past;
  }
  const span = Math.min(366, Math.max(0, daysBetween(today, end)));
  const radius = Math.ceil(span / 2);
  const candidates = findSlots({
    service: input.service,
    hours: input.hours,
    requestedDate: formatLocalDate(addDays(today, radius)),
    searchRadiusDays: radius,
    existing: [...(input.existing ?? [])],
    blocked: input.blocked,
    rules: input.rules,
    now: input.now,
  });

  const window = request?.preference ? preferenceWindow(request.preference) : null;
  const useHabits = hasHabits(habits);
  const usePopular = !useHabits && hasHabits(popular);

  const scored: Scored[] = candidates.map((slot) => {
    const date = parseLocalDate(slot.localDate);
    const w = weekday(date) as Weekday;
    const minutes = parseClock(slot.localTime);
    const reasons: SuggestionReason[] = [];
    let score = -0.5 * daysBetween(today, date);

    let inRequest = false;
    let requestDays = 0;
    let requestMinutes = 0;
    if (request) {
      requestDays =
        slot.localDate < request.from
          ? daysBetween(date, parseLocalDate(request.from))
          : slot.localDate > request.to
            ? daysBetween(parseLocalDate(request.to), date)
            : 0;
      requestMinutes = window ? outside(minutes, window) : 0;
      const dayOk = !request.weekdays?.length || request.weekdays.includes(w);
      inRequest = requestDays === 0 && requestMinutes === 0 && dayOk;
      if (!dayOk && requestDays === 0) requestDays = 1;
      if (inRequest) {
        score += 1000;
        reasons.push({ kind: 'requested', label: request.label ?? 'As requested' });
      } else {
        score -= requestDays * 20 + requestMinutes / 10;
      }
    }
    if (useHabits || usePopular) {
      const { reason, points } = habitReason(
        useHabits ? 'usual' : 'popular',
        (useHabits ? habits : popular)!,
        w,
        minutes,
      );
      score += points;
      if (reason) reasons.push(reason);
    }
    if (due) {
      const off = Math.abs(daysBetween(parseLocalDate(due.date), date));
      if (off <= 7) score += 45 - off * 6;
      if (off <= 3) reasons.push({ kind: 'due', label: due.label });
    }
    if (slot.requiresApproval) score -= 25;
    return { slot, reasons, score, inRequest, requestDays, requestMinutes };
  });

  const byScore = (a: Scored, b: Scored) =>
    b.score - a.score || b.slot.score - a.slot.score || a.slot.start.localeCompare(b.slot.start);
  const byStart = (a: Scored, b: Scored) => a.slot.start.localeCompare(b.slot.start);
  const bestPerDay = new Map<string, Scored>();
  for (const s of [...scored].sort(byScore)) {
    if (!bestPerDay.has(s.slot.localDate)) bestPerDay.set(s.slot.localDate, s);
  }
  const days = [...bestPerDay.values()];
  const earliestPerDay = new Map<string, Scored>();
  for (const s of [...scored].sort(byStart)) {
    if (!earliestPerDay.has(s.slot.localDate)) earliestPerDay.set(s.slot.localDate, s);
  }
  const earliest = [...earliestPerDay.values()][0];

  let picked: Scored[];
  let fits: boolean | null = null;
  // How a slot relates to the request leads its chips.
  const add = (list: Scored[], reason: SuggestionReason) =>
    list.map((s) => ({ ...s, reasons: [reason, ...s.reasons] }));

  if (request) {
    const inside = days.filter((s) => s.inRequest);
    fits = inside.length > 0;
    const closest = days
      .filter((s) => !s.inRequest)
      .sort(
        (a, b) =>
          a.requestDays - b.requestDays || a.requestMinutes - b.requestMinutes || byScore(a, b),
      );
    const main = inside.slice(0, Math.max(1, limit - 1));
    picked = [
      ...main,
      ...add(closest.slice(0, limit - main.length), {
        kind: 'nearest',
        label: fits ? 'Near request' : 'Closest to request',
      }),
    ];
  } else {
    const signal = useHabits || usePopular || !!due;
    if (!signal) {
      picked = [...earliestPerDay.values()].slice(0, limit);
    } else {
      const soonest = Math.min(input.soonest ?? 2, limit);
      const main = days.filter((s) => s.reasons.length > 0).slice(0, limit - soonest);
      const taken = new Set(main.map((s) => s.slot.localDate));
      const rest = [...earliestPerDay.values()].filter((s) => !taken.has(s.slot.localDate));
      picked = [...main, ...rest.slice(0, limit - main.length)];
    }
    picked = picked.map((s) =>
      s === earliest
        ? { ...s, reasons: [...s.reasons, { kind: 'soonest', label: 'Soonest opening' }] }
        : s.reasons.length === 0
          ? { ...s, reasons: [{ kind: 'soonest', label: 'Opens soon' }] }
          : s,
    );
  }

  return {
    fits,
    suggestions: picked.map(({ slot, reasons }) => ({
      slot,
      tentative: slot.requiresApproval,
      reasons: slot.requiresApproval
        ? [...reasons, { kind: 'tentative', label: 'Tentative hours' }]
        : reasons,
    })),
  };
}
