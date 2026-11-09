import { mergeIntervals } from './intervals';
import { MINUTE, toMs } from './time';
import type { DurationOverride, ExistingAppointment, Interval, PlacedSegment, PlacedSegmentKind, ServiceRequest, ServiceSegment } from './types';

/** Segment kinds during which the stylist is occupied (hands-on or prep/cleanup). */
export function isBlocking(kind: PlacedSegmentKind): boolean {
  return kind !== 'processing';
}

/** Applies per-client duration overrides. Returns a new array; throws on invalid results. */
export function applyDurationOverrides(segments: readonly ServiceSegment[], overrides: readonly DurationOverride[] = []): ServiceSegment[] {
  const out = segments.map((s) => ({ ...s }));
  for (const o of overrides) {
    const seg = out[o.index];
    if (!seg) throw new RangeError(`Duration override index out of range: ${o.index}`);
    if (o.minutes !== undefined) seg.minutes = o.minutes;
    if (o.deltaMinutes !== undefined) seg.minutes += o.deltaMinutes;
  }
  validateSegments(out);
  return out;
}

export function validateSegments(segments: readonly ServiceSegment[]): void {
  if (segments.length === 0) throw new RangeError('A service needs at least one segment');
  for (const s of segments) {
    if (!Number.isInteger(s.minutes) || s.minutes <= 0) throw new RangeError(`Segment minutes must be a positive integer, got ${s.minutes}`);
  }
  if (segments[0]!.kind === 'processing' || segments[segments.length - 1]!.kind === 'processing') {
    throw new RangeError('A service cannot start or end with a processing segment');
  }
}

export interface TimedSegment {
  kind: PlacedSegmentKind;
  start: number;
  end: number;
}

/**
 * Lays a service out from `clientStart` (start of the first real segment). Buffer-before precedes
 * it and buffer-after follows the last segment, as `buffer` segments.
 */
export function layoutService(service: ServiceRequest, clientStart: number): TimedSegment[] {
  const segments = applyDurationOverrides(service.segments, service.overrides);
  const out: TimedSegment[] = [];
  const before = service.bufferBeforeMinutes ?? 0;
  const after = service.bufferAfterMinutes ?? 0;
  if (before < 0 || after < 0) throw new RangeError('Buffers cannot be negative');
  if (before > 0) out.push({ kind: 'buffer', start: clientStart - before * MINUTE, end: clientStart });
  let t = clientStart;
  for (const s of segments) {
    out.push({ kind: s.kind, start: t, end: t + s.minutes * MINUTE });
    t += s.minutes * MINUTE;
  }
  if (after > 0) out.push({ kind: 'buffer', start: t, end: t + after * MINUTE });
  return out;
}

/**
 * The stylist-occupied ranges of an appointment: busy, style and buffer segments, merged, half-open.
 *
 * This is exactly what the DB guard protects: `appointment_segments` rows with a blocking kind get an
 * exclusion constraint `EXCLUDE USING gist (salon_id WITH =, stylist_id WITH =, range WITH &&)
 * WHERE (kind <> 'processing')` (btree_gist, `tstzrange` with default `[)` bounds).
 */
export function busyRanges(segments: readonly PlacedSegment[] | readonly TimedSegment[]): Interval[] {
  return mergeIntervals(
    segments.filter((s) => isBlocking(s.kind)).map((s) => ({ start: toMs(s.start), end: toMs(s.end) })),
  );
}

export function processingRanges(segments: readonly PlacedSegment[] | readonly TimedSegment[]): Interval[] {
  return mergeIntervals(
    segments.filter((s) => !isBlocking(s.kind)).map((s) => ({ start: toMs(s.start), end: toMs(s.end) })),
  );
}

/** Busy ranges as Postgres `tstzrange` literals, e.g. `[2026-03-06T15:00:00.000Z,2026-03-06T15:30:00.000Z)`. */
export function toTstzRanges(ranges: readonly Interval[]): string[] {
  return ranges.map((r) => `[${new Date(r.start).toISOString()},${new Date(r.end).toISOString()})`);
}

/** Busy ranges across many appointments that overlap each other (what the DB would reject). */
export function findBusyConflicts(appointments: readonly ExistingAppointment[]): Array<{ a: string; b: string; overlap: Interval }> {
  const ranges = appointments.flatMap((appt) => busyRanges(appt.segments).map((r) => ({ id: appt.id, ...r })));
  ranges.sort((x, y) => x.start - y.start || x.end - y.end || x.id.localeCompare(y.id));
  const conflicts: Array<{ a: string; b: string; overlap: Interval }> = [];
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length && ranges[j]!.start < ranges[i]!.end; j++) {
      const x = ranges[i]!;
      const y = ranges[j]!;
      if (x.id === y.id) continue;
      conflicts.push({ a: x.id, b: y.id, overlap: { start: y.start, end: Math.min(x.end, y.end) } });
    }
  }
  return conflicts;
}
