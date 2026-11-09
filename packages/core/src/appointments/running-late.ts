/**
 * "Running late" cascade (docs/PLAN.md §11b, issue #37). Given the day's appointments and a delay,
 * works out which appointments have to move and by how much. Deterministic: the LLM only drafts
 * the client texts afterwards, it never decides times.
 *
 * Strategies:
 * - `ripple` ("Squeeze"): the late client moves by the full delay; every later appointment moves
 *   only as far as it must so busy time never overlaps. Free gaps and other clients' processing
 *   time absorb the delay, so the cascade often stops after one or two clients.
 * - `shift_all`: everyone from the late client on moves by the full delay (keeps the day's rhythm).
 * - `move_one`: only the late client moves. Feasible only if that creates no busy overlap.
 */
import { dayAvailability } from '../availability/hours.ts';
import { busyRanges, findBusyConflicts } from '../availability/segments.ts';
import { MINUTE, toIso, toMs } from '../availability/time.ts';
import type {
  ExistingAppointment,
  InstantInput,
  Interval,
  PlacedSegment,
  WorkHours,
} from '../availability/types.ts';
import { toSalonDate } from '../hours/resolve.ts';
import type { BookingSegment } from './plan.ts';

export type RunningLateStrategy = 'ripple' | 'shift_all' | 'move_one';

export const RUNNING_LATE_STRATEGIES: readonly RunningLateStrategy[] = [
  'ripple',
  'shift_all',
  'move_one',
];

/** Upper bound on a delay; beyond this rescheduling the day by hand makes more sense. */
export const MAX_RUNNING_LATE_MINUTES = 240;

export interface PlanRunningLateInput {
  /** The day's active appointments (cancelled / no-show already excluded), with segments. */
  appointments: readonly ExistingAppointment[];
  delayMinutes: number;
  strategy?: RunningLateStrategy;
  /**
   * The appointment that starts late. Default: the first movable appointment whose client start is
   * at or after `now - delay` (a client due a few minutes ago is still waiting).
   */
  firstId?: string;
  now?: InstantInput;
  /** Appointments that must not move (completed, already in the chair). */
  fixedIds?: readonly string[];
  /** Knock-on shifts are rounded up to this many minutes so texts read "10:45", not "10:43". Default 5. */
  roundToMinutes?: number;
  /** Enables the `overtimeMinutes` check against the day's bookable hours. */
  hours?: WorkHours;
}

export interface RunningLateMove {
  id: string;
  shiftMinutes: number;
  /** Client span (first to last non-buffer segment) before and after, ISO UTC. */
  from: { start: string; end: string };
  to: { start: string; end: string };
  /** All segments (including buffers) at the new time, ready for `apply_running_late`. */
  segments: BookingSegment[];
}

export interface RunningLatePlan {
  strategy: RunningLateStrategy;
  delayMinutes: number;
  /** The late appointment, or null when nothing is left to start today. */
  firstId: string | null;
  /** False when the strategy can't work without double-booking (only `move_one`). */
  ok: boolean;
  /** Appointments that change, in time order. Each needs a client text. */
  moves: RunningLateMove[];
  /** Later appointments the delay never reaches (absorbed by gaps or processing time). */
  unchanged: string[];
  /** Busy overlaps the plan would create (non-empty only when `ok` is false). */
  conflicts: { a: string; b: string; overlap: Interval }[];
  /** How far the moved appointments now run past the day's bookable hours, in minutes. */
  overtimeMinutes: number;
}

interface Timed {
  id: string;
  segments: { kind: PlacedSegment['kind']; start: number; end: number }[];
  span: Interval;
}

function toTimed(appt: ExistingAppointment): Timed {
  const segments = appt.segments
    .map((s) => ({ kind: s.kind, start: toMs(s.start), end: toMs(s.end) }))
    .sort((a, b) => a.start - b.start);
  const work = segments.filter((s) => s.kind !== 'buffer');
  const span = work.length
    ? { start: work[0]!.start, end: Math.max(...work.map((s) => s.end)) }
    : { start: segments[0]?.start ?? 0, end: segments[segments.length - 1]?.end ?? 0 };
  return { id: appt.id, segments, span };
}

const shifted = (t: Timed, ms: number): Timed => ({
  id: t.id,
  segments: t.segments.map((s) => ({ ...s, start: s.start + ms, end: s.end + ms })),
  span: { start: t.span.start + ms, end: t.span.end + ms },
});

/** Smallest shift >= `minMs` (rounded up to `gridMs` above the minimum) avoiding `placed` busy time. */
function minimalShift(
  t: Timed,
  placed: readonly Interval[],
  minMs: number,
  gridMs: number,
): number {
  const own = busyRanges(t.segments);
  let s = minMs;
  for (let guard = 0; guard < 10_000; guard++) {
    let push = 0;
    for (const r of own) {
      const start = r.start + s;
      const end = r.end + s;
      for (const p of placed) {
        if (p.start < end && start < p.end) push = Math.max(push, p.end - start);
      }
    }
    if (push === 0) return s;
    const next = s + push;
    s = next <= minMs ? minMs : minMs + Math.ceil((next - minMs) / gridMs) * gridMs;
  }
  throw new RangeError('Could not find a conflict-free time');
}

function overtime(
  hours: WorkHours | undefined,
  before: readonly Timed[],
  after: readonly Timed[],
): number {
  if (!hours || after.length === 0) return 0;
  const date = toSalonDate(after[0]!.span.start, hours.timeZone);
  const available = dayAvailability(hours, date).available;
  if (available.length === 0) return 0;
  const dayEnd = available[available.length - 1]!.end;
  const lastEnd = (list: readonly Timed[]) =>
    Math.max(...list.flatMap((t) => t.segments.map((s) => s.end)));
  // Only count time the delay adds; something already booked past closing isn't news.
  const limit = Math.max(dayEnd, lastEnd(before));
  return Math.max(0, Math.round((lastEnd(after) - limit) / MINUTE));
}

export function planRunningLate(input: PlanRunningLateInput): RunningLatePlan {
  const strategy = input.strategy ?? 'ripple';
  const delay = input.delayMinutes;
  if (!Number.isInteger(delay) || delay < 1 || delay > MAX_RUNNING_LATE_MINUTES) {
    throw new RangeError(`Delay must be 1–${MAX_RUNNING_LATE_MINUTES} whole minutes`);
  }
  const delayMs = delay * MINUTE;
  const gridMs = Math.max(1, input.roundToMinutes ?? 5) * MINUTE;
  const fixed = new Set(input.fixedIds ?? []);
  const all = input.appointments
    .filter((a) => a.segments.length > 0)
    .map(toTimed)
    .sort((a, b) => a.span.start - b.span.start || a.id.localeCompare(b.id));

  const movable = all.filter((t) => !fixed.has(t.id));
  const now = input.now === undefined ? undefined : toMs(input.now);
  const first = input.firstId
    ? movable.find((t) => t.id === input.firstId)
    : movable.find((t) => now === undefined || t.span.start >= now - delayMs);
  if (input.firstId && !first) throw new RangeError('That appointment cannot be moved');

  const empty: RunningLatePlan = {
    strategy,
    delayMinutes: delay,
    firstId: first?.id ?? null,
    ok: true,
    moves: [],
    unchanged: [],
    conflicts: [],
    overtimeMinutes: 0,
  };
  if (!first) return empty;

  const downstream = movable.filter((t) => t.id !== first.id && t.span.start >= first.span.start);
  const candidates = [first, ...downstream];
  const candidateIds = new Set(candidates.map((t) => t.id));
  const obstacles = all.filter((t) => !candidateIds.has(t.id));

  const placed = new Map<string, Timed>();
  if (strategy === 'shift_all') {
    for (const t of candidates) placed.set(t.id, shifted(t, delayMs));
  } else if (strategy === 'move_one') {
    placed.set(first.id, shifted(first, delayMs));
    for (const t of downstream) placed.set(t.id, t);
  } else {
    const busy: Interval[] = obstacles.flatMap((t) => busyRanges(t.segments));
    for (const t of candidates) {
      const min = t === first ? delayMs : 0;
      const s = minimalShift(t, busy, min, t === first ? MINUTE : gridMs);
      const moved = shifted(t, s);
      placed.set(t.id, moved);
      busy.push(...busyRanges(moved.segments));
    }
  }

  const finalAll = [...obstacles, ...candidates.map((t) => placed.get(t.id)!)];
  const conflicts = findBusyConflicts(
    finalAll.map((t) => ({ id: t.id, segments: t.segments })),
  ).filter((c) => candidateIds.has(c.a) || candidateIds.has(c.b));

  const moves: RunningLateMove[] = [];
  const unchanged: string[] = [];
  for (const t of candidates) {
    const after = placed.get(t.id)!;
    const ms = after.span.start - t.span.start;
    if (ms === 0) {
      unchanged.push(t.id);
      continue;
    }
    moves.push({
      id: t.id,
      shiftMinutes: Math.round(ms / MINUTE),
      from: { start: toIso(t.span.start), end: toIso(t.span.end) },
      to: { start: toIso(after.span.start), end: toIso(after.span.end) },
      segments: after.segments.map((s) => ({
        kind: s.kind,
        start: toIso(s.start),
        end: toIso(s.end),
      })),
    });
  }

  const movedIds = new Set(moves.map((m) => m.id));
  return {
    ...empty,
    ok: conflicts.length === 0,
    moves,
    unchanged,
    conflicts,
    overtimeMinutes: overtime(
      input.hours,
      candidates.filter((t) => movedIds.has(t.id)),
      moves.map((m) => placed.get(m.id)!),
    ),
  };
}

const sameMoves = (a: RunningLatePlan, b: RunningLatePlan) =>
  a.moves.length === b.moves.length &&
  a.moves.every((m, i) => m.id === b.moves[i]!.id && m.shiftMinutes === b.moves[i]!.shiftMinutes);

/**
 * Every strategy for the delay, best first, with duplicates dropped (e.g. when the squeeze already
 * moves just one client, "move one" adds nothing).
 */
export function runningLateOptions(
  input: Omit<PlanRunningLateInput, 'strategy'>,
): RunningLatePlan[] {
  const out: RunningLatePlan[] = [];
  for (const strategy of RUNNING_LATE_STRATEGIES) {
    const plan = planRunningLate({ ...input, strategy });
    if (!out.some((o) => sameMoves(o, plan))) out.push(plan);
  }
  return out;
}
