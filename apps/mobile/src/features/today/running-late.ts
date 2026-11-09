import {
  MAX_RUNNING_LATE_MINUTES,
  runningLateOptions,
  type RunningLatePlan,
  type RunningLateStrategy,
  type WorkHours,
} from '@chairside/core';
import type { AppointmentStatus } from '@chairside/db';
import type { AppointmentWithDetails } from '@chairside/db/appointments';

import { clientSpan } from './summary';

/** Delay presets on the sheet ("I'm 15 late"). */
export const RUNNING_LATE_PRESETS = [5, 10, 15, 20, 30, 45] as const;

const MOVABLE: readonly AppointmentStatus[] = ['held', 'requested', 'confirmed'];

const firstName = (a: AppointmentWithDetails | undefined) =>
  a?.client?.name.trim().split(/\s+/)[0] || 'walk-in';

/** Appointments the delay can start from: not finished and not over yet, earliest first. */
export function runningLateCandidates(
  appointments: readonly AppointmentWithDetails[],
  now: number,
): AppointmentWithDetails[] {
  return appointments
    .filter((a) => MOVABLE.includes(a.status) && clientSpan(a).end > now)
    .sort((a, b) => clientSpan(a).start - clientSpan(b).start);
}

/**
 * The client who's going to be kept waiting: the next one who hasn't started, or (if everyone
 * left is already due) the earliest remaining one.
 */
export function defaultLateAppointment(
  appointments: readonly AppointmentWithDetails[],
  now: number,
): AppointmentWithDetails | null {
  const candidates = runningLateCandidates(appointments, now);
  return candidates.find((a) => clientSpan(a).start > now) ?? candidates[0] ?? null;
}

/** Clamps the "running late" deep link (`?late=15`) to a usable delay. */
export function parseLateParam(value: string | undefined): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(Math.round(n), MAX_RUNNING_LATE_MINUTES);
}

/** Squeeze / shift everyone / just one, computed by `@chairside/core` for this day. */
export function planOptions(input: {
  appointments: readonly AppointmentWithDetails[];
  hours: WorkHours;
  delayMinutes: number;
  firstId: string;
  now: number;
}): RunningLatePlan[] {
  const { appointments } = input;
  return runningLateOptions({
    appointments: appointments.map((a) => ({ id: a.id, segments: a.segments })),
    delayMinutes: input.delayMinutes,
    firstId: input.firstId,
    fixedIds: appointments.filter((a) => !MOVABLE.includes(a.status)).map((a) => a.id),
    hours: input.hours,
    now: input.now,
  });
}

export function strategyLabel(
  strategy: RunningLateStrategy,
  first: AppointmentWithDetails | undefined,
): string {
  switch (strategy) {
    case 'ripple':
      return 'Squeeze';
    case 'shift_all':
      return 'Shift everyone';
    case 'move_one':
      return `Just ${firstName(first)}`;
  }
}

/** One line under an option: what it does, or why it can't. */
export function describePlan(
  plan: RunningLatePlan,
  byId: ReadonlyMap<string, AppointmentWithDetails>,
): string {
  if (!plan.ok) {
    const c = plan.conflicts[0];
    const names = c ? [byId.get(c.a), byId.get(c.b)].map(firstName) : [];
    return names.length ? `Would overlap ${names[0]} and ${names[1]}` : 'Doesn’t fit';
  }
  if (!plan.moves.length) return 'Nobody needs to move';
  const moved = plan.moves.length === 1 ? '1 client moves' : `${plan.moves.length} clients move`;
  const absorbed = plan.unchanged.length ? ` · ${plan.unchanged.length} unaffected` : '';
  const overtime = plan.overtimeMinutes ? ` · ${plan.overtimeMinutes} min past close` : '';
  return `${moved}${absorbed}${overtime}`;
}
