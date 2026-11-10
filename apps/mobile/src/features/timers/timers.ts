import type { AppointmentStatus } from '@chairside/db';
import type { AppointmentWithDetails } from '@chairside/db/appointments';

/**
 * Processing timers (#40). A processing segment (color developing, a treatment setting) becomes a
 * timer either automatically at its scheduled time or when the stylist taps "Start processing"
 * (the client sat down late, or the color went on early). Everything here is pure so the Today UI,
 * the Live Activities and the end-of-processing alerts all agree, and it all runs in unit tests.
 */

const MINUTE_MS = 60_000;
/** A finished timer stays on Today (as "Done") this long unless dismissed. */
export const DONE_GRACE_MS = 10 * MINUTE_MS;
/** "Start processing" is offered from this long before the client's appointment starts. */
export const START_EARLY_MS = 30 * MINUTE_MS;
/** Manual starts and dismissals are forgotten after a day. */
export const OVERRIDE_TTL_MS = 24 * 60 * MINUTE_MS;

/** Appointments whose processing time actually happens. */
const TIMED: readonly AppointmentStatus[] = ['confirmed', 'completed'];

export interface ProcessingSegment {
  /** Stable per appointment: `<appointmentId>:<n>` for its n-th processing segment. */
  key: string;
  appointment: AppointmentWithDetails;
  clientName: string;
  /** What's processing, e.g. "Color" (the appointment's first service). */
  service: string;
  /** The segment's own label, e.g. "Process". */
  label: string;
  scheduledStart: number;
  scheduledEnd: number;
}

export interface ProcessingTimer extends ProcessingSegment {
  start: number;
  end: number;
  /** `scheduled`: started by itself at the booked time. `manual`: started or extended by hand. */
  source: 'scheduled' | 'manual';
}

/** What the stylist changed by hand, keyed by segment key. Stored on the device. */
export type TimerOverride =
  | { startedAt: number; endsAt: number; updatedAt: number; dismissed?: undefined }
  | { dismissed: true; updatedAt: number; startedAt?: undefined; endsAt?: undefined };
export type TimerOverrides = Record<string, TimerOverride>;

export interface TimerPrefs {
  /** Start timers by themselves at the scheduled time. */
  autoStart: boolean;
  /** Mirror running timers on the Lock Screen / Dynamic Island (iOS). */
  liveActivities: boolean;
  /** Notify (sound + haptic) when processing is done, even with the app closed. */
  alerts: boolean;
}

export const DEFAULT_TIMER_PREFS: TimerPrefs = {
  autoStart: true,
  liveActivities: true,
  alerts: true,
};

export interface TimerBoard {
  /** Counting down, soonest-finishing first. */
  running: ProcessingTimer[];
  /** Hit zero within the last `DONE_GRACE_MS` and not dismissed yet. */
  finished: ProcessingTimer[];
  /** Processing coming up for a client who is here (or nearly), which can be started now. */
  startable: ProcessingSegment[];
}

const clientName = (a: AppointmentWithDetails) => a.client?.name?.trim() || 'Walk-in';

/** Every processing segment on timed (confirmed/completed) appointments, in time order. */
export function processingSegments(
  appointments: readonly AppointmentWithDetails[],
): ProcessingSegment[] {
  const out: ProcessingSegment[] = [];
  for (const appointment of appointments) {
    if (!TIMED.includes(appointment.status)) continue;
    let n = 0;
    for (const s of appointment.segments) {
      if (s.kind !== 'processing') continue;
      const label = s.label?.trim() || 'Processing';
      out.push({
        key: `${appointment.id}:${n}`,
        appointment,
        clientName: clientName(appointment),
        service: appointment.services[0]?.name?.trim() || label,
        label,
        scheduledStart: Date.parse(s.start),
        scheduledEnd: Date.parse(s.end),
      });
      n += 1;
    }
  }
  return out.sort((a, b) => a.scheduledStart - b.scheduledStart);
}

/** When the client is in the chair: first to last non-buffer segment. */
function clientWindow(appointment: AppointmentWithDetails): { start: number; end: number } {
  const work = appointment.segments.filter((s) => s.kind !== 'buffer');
  const list = work.length ? work : appointment.segments;
  if (!list.length)
    return { start: Date.parse(appointment.starts_at), end: Date.parse(appointment.ends_at) };
  return {
    start: Math.min(...list.map((s) => Date.parse(s.start))),
    end: Math.max(...list.map((s) => Date.parse(s.end))),
  };
}

/** Applies the stylist's overrides and the clock to the day's processing segments. */
export function resolveTimers(
  segments: readonly ProcessingSegment[],
  overrides: TimerOverrides,
  now: number,
  prefs: Pick<TimerPrefs, 'autoStart'> = DEFAULT_TIMER_PREFS,
): TimerBoard {
  const running: ProcessingTimer[] = [];
  const finished: ProcessingTimer[] = [];
  const startable: ProcessingSegment[] = [];
  const offered = new Set<string>();

  for (const seg of segments) {
    const o = overrides[seg.key];
    if (o?.dismissed) continue;
    let timer: ProcessingTimer | null = null;
    if (o?.startedAt !== undefined) {
      timer = { ...seg, start: o.startedAt, end: o.endsAt, source: 'manual' };
    } else if (prefs.autoStart && seg.scheduledStart <= now) {
      timer = { ...seg, start: seg.scheduledStart, end: seg.scheduledEnd, source: 'scheduled' };
    }

    if (timer) {
      if (now < timer.end) running.push(timer);
      else if (now < timer.end + DONE_GRACE_MS) finished.push(timer);
      continue;
    }

    // Not started: offer it while the client is here (or about to be), one per appointment.
    const id = seg.appointment.id;
    if (offered.has(id)) continue;
    const window = clientWindow(seg.appointment);
    if (now >= window.start - START_EARLY_MS && now < window.end) {
      startable.push(seg);
      offered.add(id);
    }
  }

  running.sort((a, b) => a.end - b.end);
  finished.sort((a, b) => b.end - a.end);
  return { running, finished, startable };
}

/** Override for "Start processing" now, for the segment's booked length. */
export function startOverride(seg: ProcessingSegment, now: number): TimerOverride {
  const length = Math.max(MINUTE_MS, seg.scheduledEnd - seg.scheduledStart);
  return { startedAt: now, endsAt: now + length, updatedAt: now };
}

/** Override adding `minutes` to a timer (from now if it has already finished). */
export function extendOverride(
  timer: ProcessingTimer,
  minutes: number,
  now: number,
): TimerOverride {
  return {
    startedAt: timer.start,
    endsAt: Math.max(timer.end, now) + minutes * MINUTE_MS,
    updatedAt: now,
  };
}

/** Override for stopping a running timer or clearing a finished one. */
export function dismissOverride(now: number): TimerOverride {
  return { dismissed: true, updatedAt: now };
}

/** Drops overrides older than a day so the stored map doesn't grow forever. */
export function pruneOverrides(overrides: TimerOverrides, now: number): TimerOverrides {
  const out: TimerOverrides = {};
  for (const [key, o] of Object.entries(overrides)) {
    if (now - o.updatedAt < OVERRIDE_TTL_MS) out[key] = o;
  }
  return out;
}

/** First name for glanceable surfaces ("Karina" from "Karina Lopez"). */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** Whole minutes left, rounded up (`0` once done). */
export function minutesLeft(timer: Pick<ProcessingTimer, 'end'>, now: number): number {
  return Math.max(0, Math.ceil((timer.end - now) / MINUTE_MS));
}

/** "Karina · color · 12 min left" (or "… · done"). */
export function timerSummary(timer: ProcessingTimer, now: number): string {
  const left = minutesLeft(timer, now);
  const what = timer.service.toLowerCase();
  return `${firstName(timer.clientName)} · ${what} · ${left ? `${left} min left` : 'done'}`;
}

/** Props rendered by the Live Activity (`src/widgets/processing-activity.tsx`). */
export interface ProcessingActivityProps {
  client: string;
  /** Lower-cased service, e.g. "color". */
  service: string;
  /** Epoch ms. */
  start: number;
  /** Epoch ms. */
  end: number;
  done: boolean;
}

export function activityProps(timer: ProcessingTimer, now: number): ProcessingActivityProps {
  return {
    client: firstName(timer.clientName),
    service: timer.service.toLowerCase(),
    start: timer.start,
    end: timer.end,
    done: now >= timer.end,
  };
}

/** A Live Activity we started, as remembered across launches. */
export interface ActiveActivity {
  key: string;
  start: number;
  end: number;
  /** Already ended with the "Done" state (still on the Lock Screen until dismissed). */
  done?: boolean;
}

export interface ActivityPlan {
  start: ProcessingTimer[];
  /** Running timers whose start/end changed (extended, restarted). */
  update: ProcessingTimer[];
  /** Hit zero: show "Done" and leave it on the Lock Screen for a while. */
  finish: ProcessingTimer[];
  /** Stopped, cancelled, or turned off: remove now. */
  remove: string[];
}

/**
 * What to do to the Live Activities so there's exactly one per running timer. Finished timers
 * end with a final "Done" state; anything else no longer wanted is removed.
 */
export function planActivities(
  board: Pick<TimerBoard, 'running' | 'finished'>,
  active: readonly ActiveActivity[],
  enabled: boolean,
): ActivityPlan {
  const plan: ActivityPlan = { start: [], update: [], finish: [], remove: [] };
  const current = new Map(active.map((a) => [a.key, a]));
  if (enabled) {
    for (const t of board.running) {
      const a = current.get(t.key);
      current.delete(t.key);
      // An ended activity can't be revived, so an extended "Done" timer gets a fresh one.
      if (!a) plan.start.push(t);
      else if (a.done) {
        plan.remove.push(t.key);
        plan.start.push(t);
      } else if (a.start !== t.start || a.end !== t.end) plan.update.push(t);
    }
    for (const t of board.finished) {
      const a = current.get(t.key);
      if (!a) continue;
      current.delete(t.key);
      if (!a.done) plan.finish.push(t);
    }
  }
  plan.remove.push(...current.keys());
  return plan;
}

/** A scheduled "processing done" notification. */
export interface ScheduledAlert {
  key: string;
  /** Epoch ms it fires. */
  at: number;
}

export interface AlertPlan {
  schedule: ProcessingTimer[];
  cancel: string[];
}

/** One alert per running timer at its end; reschedules when a timer is extended. */
export function planAlerts(
  running: readonly ProcessingTimer[],
  scheduled: readonly ScheduledAlert[],
  enabled: boolean,
): AlertPlan {
  const plan: AlertPlan = { schedule: [], cancel: [] };
  const current = new Map(scheduled.map((s) => [s.key, s]));
  if (enabled) {
    for (const t of running) {
      const s = current.get(t.key);
      current.delete(t.key);
      if (!s) plan.schedule.push(t);
      else if (s.at !== t.end) {
        plan.cancel.push(t.key);
        plan.schedule.push(t);
      }
    }
  }
  plan.cancel.push(...current.keys());
  return plan;
}

/** Notification copy for a finished timer. */
export function alertContent(timer: ProcessingTimer): { title: string; body: string } {
  return {
    title: `${firstName(timer.clientName)}’s ${timer.service.toLowerCase()} is done`,
    body: `${timer.label} time is up.`,
  };
}
