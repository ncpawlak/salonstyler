import {
  dayUtilization as coreDayUtilization,
  parseLocalDate,
  zonedToUtc,
  type Interval,
  type WorkHours,
} from '@chairside/core';
import type { AppointmentStatus } from '@chairside/db';
import {
  ACTIVE_APPOINTMENT_STATUSES,
  type AppointmentWithDetails,
} from '@chairside/db/appointments';

/** Statuses that are actually on the books (requests are pending, not booked). */
const BOOKED: readonly AppointmentStatus[] = ['confirmed', 'held', 'completed'];
/** Statuses that can still turn up in the chair. */
const UPCOMING: readonly AppointmentStatus[] = ['confirmed', 'held'];

export interface DayUtilization {
  /** Bookable time today (open + tentative hours, minus breaks), ms. */
  availableMs: number;
  /** Client time booked inside those hours, ms. */
  bookedMs: number;
  /** Client time booked outside hours (squeezed in early/late or on a day off), ms. */
  overtimeMs: number;
  /** `bookedMs / availableMs`, 0..1; 1 on a day off with bookings. */
  share: number;
  /** False when the salon is closed all day. */
  isOpen: boolean;
}

export interface ProcessingTimer {
  appointment: AppointmentWithDetails;
  label: string;
  start: number;
  end: number;
}

export interface TodaySummary {
  /** In the chair right now (client span contains `now`). */
  current: AppointmentWithDetails | null;
  /** Next booked appointment that hasn't started. */
  next: AppointmentWithDetails | null;
  /** Booked appointments today (excludes requests). */
  clientCount: number;
  /** Booked appointments still to start. */
  remainingCount: number;
  utilization: DayUtilization;
  /** Processing segments running now, soonest-finishing first. */
  processing: ProcessingTimer[];
}

/** Client span: the appointment minus leading/trailing buffers. */
export function clientSpan(appt: AppointmentWithDetails): Interval {
  const work = appt.segments.filter((s) => s.kind !== 'buffer');
  if (!work.length) return { start: Date.parse(appt.starts_at), end: Date.parse(appt.ends_at) };
  return {
    start: Math.min(...work.map((s) => Date.parse(s.start))),
    end: Math.max(...work.map((s) => Date.parse(s.end))),
  };
}

const MINUTE_MS = 60_000;

/**
 * How much of today's bookable time is taken, from `@chairside/core`'s `dayUtilization` so Today and
 * the Calendar ring agree. Like the Calendar, requests count: they already hold their slot.
 */
export function dayUtilization(
  hours: WorkHours,
  date: string,
  appointments: readonly AppointmentWithDetails[],
): DayUtilization {
  const day = coreDayUtilization(
    hours,
    // Local noon pins the salon day regardless of DST.
    zonedToUtc(parseLocalDate(date), 12 * 60, hours.timeZone),
    appointments.filter((a) => ACTIVE_APPOINTMENT_STATUSES.includes(a.status)),
  );
  const overtimeMs = day.bookedOutsideHoursMinutes * MINUTE_MS;
  const bookedMs = day.bookedMinutes * MINUTE_MS - overtimeMs;
  const availableMs = day.capacityMinutes * MINUTE_MS - overtimeMs;
  return {
    availableMs,
    bookedMs,
    overtimeMs,
    share: availableMs > 0 ? Math.min(1, bookedMs / availableMs) : overtimeMs > 0 ? 1 : 0,
    isOpen: availableMs > 0,
  };
}
/** Processing segments (color developing, etc.) running at `now`. */
export function activeProcessing(
  appointments: readonly AppointmentWithDetails[],
  now: number,
): ProcessingTimer[] {
  const out: ProcessingTimer[] = [];
  for (const appointment of appointments) {
    if (appointment.status !== 'confirmed' && appointment.status !== 'completed') continue;
    for (const s of appointment.segments) {
      if (s.kind !== 'processing') continue;
      const start = Date.parse(s.start);
      const end = Date.parse(s.end);
      if (start <= now && now < end)
        out.push({ appointment, label: s.label ?? 'Processing', start, end });
    }
  }
  return out.sort((a, b) => a.end - b.end);
}

export function summarizeToday(
  hours: WorkHours,
  date: string,
  appointments: readonly AppointmentWithDetails[],
  now: number,
): TodaySummary {
  const booked = appointments
    .filter((a) => BOOKED.includes(a.status))
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  const upcoming = booked.filter((a) => UPCOMING.includes(a.status) && clientSpan(a).start > now);
  const current =
    booked.find((a) => {
      if (a.status === 'completed') return false;
      const span = clientSpan(a);
      return span.start <= now && now < span.end;
    }) ?? null;
  return {
    current,
    next: upcoming[0] ?? null,
    clientCount: booked.length,
    remainingCount: upcoming.length,
    utilization: dayUtilization(hours, date, appointments),
    processing: activeProcessing(appointments, now),
  };
}

/**
 * Who Today's Checkout action should ring up: the confirmed client in the chair, else the one who
 * most recently finished, else the next one. Completed appointments are already settled or can be
 * reached from the picker.
 */
export function checkoutCandidate(
  appointments: readonly AppointmentWithDetails[],
  now: number,
): AppointmentWithDetails | null {
  const confirmed = appointments.filter((a) => a.status === 'confirmed');
  const inChair = confirmed.find((a) => {
    const span = clientSpan(a);
    return span.start <= now && now < span.end;
  });
  if (inChair) return inChair;
  const finished = confirmed
    .filter((a) => clientSpan(a).end <= now)
    .sort((a, b) => clientSpan(b).end - clientSpan(a).end);
  if (finished[0]) return finished[0];
  const upcoming = confirmed
    .filter((a) => clientSpan(a).start > now)
    .sort((a, b) => clientSpan(a).start - clientSpan(b).start);
  return upcoming[0] ?? null;
}

/** `in 2h 5m`, `in 12 min`, `now`, `5 min ago`. */
export function formatCountdown(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes === 0) return 'now';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const text = h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m} min`;
  return minutes > 0 ? `in ${text}` : `${text} ago`;
}

/** `mm:ss` (or `h:mm:ss`) for a processing timer. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
