import { zonedToUtc } from './time.ts';
import type { ExistingAppointment, PlacedSegmentKind, ServiceSegment, WorkHours } from './types.ts';

export const NY = 'America/New_York';

/** UTC ISO for a local wall-clock time. */
export function at(date: string, time: string, timeZone = NY): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  return new Date(zonedToUtc({ year: y, month: m, day: d }, hh * 60 + mm, timeZone)).toISOString();
}

/** Builds an existing appointment from a start and `[kind, minutes]` pairs laid out back-to-back. */
export function appt(
  id: string,
  startIso: string,
  parts: [PlacedSegmentKind, number][],
): ExistingAppointment {
  let t = Date.parse(startIso);
  return {
    id,
    segments: parts.map(([kind, minutes]) => {
      const seg = {
        kind,
        start: new Date(t).toISOString(),
        end: new Date(t + minutes * 60_000).toISOString(),
      };
      t += minutes * 60_000;
      return seg;
    }),
  };
}

export const MENS_CUT: ServiceSegment[] = [{ kind: 'busy', minutes: 30, label: "Men's cut" }];
export const ROOT_TOUCH_UP: ServiceSegment[] = [
  { kind: 'busy', minutes: 30, label: 'Apply' },
  { kind: 'processing', minutes: 35, label: 'Process' },
  { kind: 'style', minutes: 30, label: 'Rinse/Style' },
];

/** Mon–Sat 09:00–17:00 open, Sunday closed. */
export function weekdayHours(timeZone = NY): WorkHours {
  const day = { blocks: [{ start: '09:00', end: '17:00', type: 'open' as const }] };
  return { timeZone, weekly: { 1: day, 2: day, 3: day, 4: day, 5: day, 6: day } };
}

/** Friday 2026-03-06 (two days before US DST starts). */
export const FRI = '2026-03-06';
/** A "now" well before FRI so lead time doesn't interfere. */
export const EARLY_NOW = '2026-03-01T12:00:00Z';
