/**
 * Manual booking checks (docs/PLAN.md §5, issue #30): quick-book, drag-to-move and edits.
 * Thin wrappers over the availability engine so the app never re-implements slot math.
 */
import { evaluateStart, type RejectionReason } from '../availability/engine';
import { findBusyConflicts, layoutService, type TimedSegment } from '../availability/segments';
import { MINUTE, toIso, toMs } from '../availability/time';
import type {
  BookingRules,
  ExistingAppointment,
  InstantInput,
  PlacedSegment,
  PlacedSegmentKind,
  ServiceRequest,
  ServiceSegment,
  WorkHours,
} from '../availability/types';

/** A placed segment as stored in `appointment_segments` / sent to `book_appointment`. */
export interface BookingSegment {
  kind: PlacedSegmentKind;
  start: string;
  end: string;
}

export interface PlanBookingInput {
  service: ServiceRequest;
  /** Client start (first real segment, excluding buffer-before). */
  start: InstantInput;
  hours: WorkHours;
  /** Other appointments and holds on the calendar. Exclude the one being moved/edited. */
  existing: readonly ExistingAppointment[];
  /** Display names for conflict messages, keyed by appointment id. */
  names?: Readonly<Record<string, string>>;
  /** Owner bookings ignore lead time and the booking window unless rules say otherwise. */
  rules?: BookingRules;
  now?: InstantInput;
}

/** Reasons an owner may still book after confirming. */
export type BookingWarning = Extract<
  RejectionReason,
  'outside-hours' | 'lead-time' | 'booking-window'
>;

export type BookingPlan =
  | {
      ok: true;
      /** All segments including buffers, ISO UTC. */
      segments: BookingSegment[];
      /** Client start/end (excluding buffers), ISO UTC. */
      start: string;
      end: string;
      /** Allowed for the owner, but worth confirming (e.g. outside work hours). */
      warning?: BookingWarning;
      requiresApproval: boolean;
    }
  | {
      ok: false;
      reason: 'conflict' | 'invalid';
      message: string;
      conflictWith?: string;
    };

const NEW_ID = '\u0000new';

const fmtTime = (ms: number, timeZone: string) =>
  new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });

/**
 * Lays the service out at `start` and checks it against the calendar. Busy/style/buffer overlap
 * with another appointment's blocking time is a hard conflict (the DB rejects it too); busy time
 * inside someone else's processing is fine. Outside hours is only a warning for the owner.
 */
export function planBooking(input: PlanBookingInput): BookingPlan {
  const startMs = toMs(input.start);
  let timed: TimedSegment[];
  try {
    timed = layoutService(input.service, startMs);
    if (!timed.some((s) => s.kind !== 'buffer')) throw new RangeError('Pick at least one service');
  } catch (e) {
    return { ok: false, reason: 'invalid', message: (e as Error).message };
  }

  const conflict = findBusyConflicts([{ id: NEW_ID, segments: timed }, ...input.existing]).find(
    (c) => c.a === NEW_ID || c.b === NEW_ID,
  );
  if (conflict) {
    const other = conflict.a === NEW_ID ? conflict.b : conflict.a;
    const name = input.names?.[other];
    const at = fmtTime(conflict.overlap.start, input.hours.timeZone);
    return {
      ok: false,
      reason: 'conflict',
      conflictWith: other,
      message: `Overlaps ${name ? `${name}'s` : 'another'} appointment at ${at}. Busy time can only overlap processing time.`,
    };
  }

  const evaluation = evaluateStart({
    service: input.service,
    hours: input.hours,
    existing: [...input.existing],
    rules: { leadTimeMinutes: 0, ...input.rules },
    now: input.now ?? 0,
    start: startMs,
  });

  const client = timed.filter((s) => s.kind !== 'buffer');
  const base = {
    ok: true as const,
    segments: timed.map((s) => ({ kind: s.kind, start: toIso(s.start), end: toIso(s.end) })),
    start: toIso(client[0]!.start),
    end: toIso(client[client.length - 1]!.end),
  };
  if (evaluation.ok) return { ...base, requiresApproval: evaluation.candidate.requiresApproval };
  // Conflicts were handled above and tentative hours are included, so this is a soft warning.
  return { ...base, warning: evaluation.reason as BookingWarning, requiresApproval: false };
}

/** Rebuilds a `ServiceRequest` from an appointment's stored segments (to move it as-is). */
export function serviceFromSegments(segments: readonly PlacedSegment[]): {
  service: ServiceRequest;
  /** Client start (first non-buffer segment), epoch ms. */
  start: number;
} {
  const sorted = [...segments].sort((a, b) => toMs(a.start) - toMs(b.start));
  const minutes = (s: PlacedSegment) => Math.round((toMs(s.end) - toMs(s.start)) / MINUTE);
  let bufferBeforeMinutes = 0;
  let bufferAfterMinutes = 0;
  const core: ServiceSegment[] = [];
  let start: number | undefined;
  for (const s of sorted) {
    if (s.kind === 'buffer') {
      if (start === undefined) bufferBeforeMinutes += minutes(s);
      else bufferAfterMinutes += minutes(s);
      continue;
    }
    if (bufferAfterMinutes > 0) throw new RangeError('Buffers can only wrap an appointment');
    start ??= toMs(s.start);
    core.push({ kind: s.kind, minutes: minutes(s) });
  }
  if (start === undefined) throw new RangeError('An appointment needs a non-buffer segment');
  return { service: { segments: core, bufferBeforeMinutes, bufferAfterMinutes }, start };
}

/** Snaps an instant to a whole-minute grid (in UTC; fine for zones with whole-hour/half-hour offsets). */
export function snapToGrid(ms: number, gridMinutes: number): number {
  const grid = Math.max(1, gridMinutes) * MINUTE;
  return Math.round(ms / grid) * grid;
}

/** Friendly text for an error from the booking RPCs (23P01 = exclusion constraint violation). */
export function bookingErrorMessage(error: { code?: string; message?: string } | null): string {
  if (error?.code === '23P01')
    return 'That time overlaps another appointment. Busy time can only overlap processing time.';
  return error?.message || 'Something went wrong. Try again.';
}
