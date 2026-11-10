import type { WorkHours } from '@chairside/core';
import type { AppointmentWithDetails } from '@chairside/db/appointments';

import { formatTime } from '../appointments/format';
import { firstName } from '../timers/timers';
import { clientSpan, summarizeToday } from '../today/summary';

/**
 * Home/Lock Screen widget data (#40). Widgets can't run our JS or reach Supabase, so the app
 * pushes them small JSON snapshots whenever today's appointments or requests change, plus a
 * timeline so "Next client" rolls forward on its own as the day goes by.
 */

/** "Next client" widget (`src/widgets/next-client-widget.tsx`). */
export interface NextClientProps {
  /** Next client's first name, or null when nobody else is booked today. */
  name: string | null;
  /** Their first service, e.g. "Color". */
  service: string | null;
  /** Start in the salon's time zone, e.g. "2:30 PM". */
  time: string | null;
  /** Start, epoch ms (drives the "in 12 min" countdown). */
  start: number | null;
  /** Who's in the chair now (first name). */
  inChair: string | null;
  /** Booked clients still to come, including `name`. */
  remaining: number;
  /** False once the day is over (after midnight with no refresh). */
  today: boolean;
}

/** "Today booked" donut widget (`src/widgets/day-booked-widget.tsx`). */
export interface DayBookedProps {
  /** Booked share of today's open hours, 0..1. */
  share: number;
  /** `share` as a whole percentage. */
  percent: number;
  /** Booked clients today. */
  clients: number;
  open: boolean;
  today: boolean;
}

/** "Requests" widget (`src/widgets/requests-widget.tsx`). */
export interface RequestsProps {
  count: number;
}

export interface TimelineEntry<P> {
  /** Epoch ms the entry takes over. */
  date: number;
  props: P;
}

export interface Glance {
  nextClient: TimelineEntry<NextClientProps>[];
  dayBooked: TimelineEntry<DayBookedProps>[];
  requests: RequestsProps;
}

export interface GlanceInput {
  hours: WorkHours;
  /** Salon-local `YYYY-MM-DD`. */
  date: string;
  /** Today's appointments (any status). */
  appointments: readonly AppointmentWithDetails[];
  pendingRequests: number;
  now: number;
  /** When the salon day ends (next local midnight), epoch ms. */
  dayEnd: number;
}

/** Widget timelines are capped by iOS; a salon day never needs more. */
const MAX_ENTRIES = 40;

export const EMPTY_NEXT_CLIENT: NextClientProps = {
  name: null,
  service: null,
  time: null,
  start: null,
  inChair: null,
  remaining: 0,
  today: false,
};

export function nextClientAt(input: GlanceInput, at: number): NextClientProps {
  const s = summarizeToday(input.hours, input.date, input.appointments, at);
  const next = s.next;
  return {
    name: next ? firstName(next.client?.name?.trim() || 'Walk-in') : null,
    service: next?.services[0]?.name ?? null,
    time: next ? formatTime(clientSpan(next).start, input.hours.timeZone) : null,
    start: next ? clientSpan(next).start : null,
    inChair: s.current ? firstName(s.current.client?.name?.trim() || 'Walk-in') : null,
    remaining: s.remainingCount,
    today: true,
  };
}

export function buildGlance(input: GlanceInput): Glance {
  const { now, dayEnd } = input;
  // "Next client" changes whenever someone sits down or leaves the chair.
  const changes = new Set<number>();
  for (const a of input.appointments) {
    const span = clientSpan(a);
    for (const t of [span.start, span.end]) if (t > now && t < dayEnd) changes.add(t);
  }
  const times = [now, ...[...changes].sort((a, b) => a - b)].slice(0, MAX_ENTRIES - 1);

  const nextClient: TimelineEntry<NextClientProps>[] = [];
  for (const t of times) {
    const props = nextClientAt(input, t);
    const prev = nextClient[nextClient.length - 1]?.props;
    if (prev && JSON.stringify(prev) === JSON.stringify(props)) continue;
    nextClient.push({ date: t, props });
  }
  nextClient.push({ date: dayEnd, props: EMPTY_NEXT_CLIENT });

  const s = summarizeToday(input.hours, input.date, input.appointments, now);
  const share = Math.max(0, Math.min(1, s.utilization.share));
  const booked: DayBookedProps = {
    share,
    percent: Math.round(share * 100),
    clients: s.clientCount,
    open: s.utilization.isOpen,
    today: true,
  };
  return {
    nextClient,
    dayBooked: [
      { date: now, props: booked },
      { date: dayEnd, props: { share: 0, percent: 0, clients: 0, open: true, today: false } },
    ],
    requests: { count: input.pendingRequests },
  };
}

/**
 * Stable fingerprint so widgets are only reloaded when something visible changed (the first
 * entry's date is just "now", so it's left out).
 */
export function glanceSignature(glance: Glance): string {
  const timeline = <P>(entries: TimelineEntry<P>[]) =>
    entries.map((e, i) => (i ? e : { props: e.props }));
  return JSON.stringify({
    nextClient: timeline(glance.nextClient),
    dayBooked: timeline(glance.dayBooked),
    requests: glance.requests,
  });
}
