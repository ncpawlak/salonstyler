import type { AppointmentStatus } from '@chairside/db';
import type { AppointmentWithDetails } from '@chairside/db/appointments';
import { describe, expect, it } from 'vitest';

import {
  activityProps,
  alertContent,
  dismissOverride,
  DONE_GRACE_MS,
  extendOverride,
  OVERRIDE_TTL_MS,
  planActivities,
  planAlerts,
  processingSegments,
  pruneOverrides,
  resolveTimers,
  startOverride,
  timerSummary,
} from './timers';

const DATE = '2026-03-06';
const at = (hhmm: string) => Date.parse(`${DATE}T${hhmm}:00Z`);
const iso = (hhmm: string) => new Date(at(hhmm)).toISOString();
const MIN = 60_000;

let seq = 0;
function appt(
  segments: [kind: 'busy' | 'processing' | 'buffer', start: string, end: string][],
  status: AppointmentStatus = 'confirmed',
  name: string | null = 'Karina Lopez',
): AppointmentWithDetails {
  seq += 1;
  return {
    id: `a${seq}`,
    salon_id: 's',
    client_id: `c${seq}`,
    status,
    starts_at: iso(segments[0]![1]),
    ends_at: iso(segments[segments.length - 1]![2]),
    services: [{ serviceId: 'svc', name: 'Color', colorTag: 'purple' }],
    client: name ? { id: `c${seq}`, name, phone: null, notes: null } : null,
    segments: segments.map(([kind, start, end]) => ({
      kind,
      label: kind === 'processing' ? 'Process' : null,
      start: iso(start),
      end: iso(end),
    })),
  } as unknown as AppointmentWithDetails;
}

const color = appt([
  ['busy', '09:00', '09:30'],
  ['processing', '09:30', '10:00'],
  ['busy', '10:00', '10:30'],
  ['processing', '10:30', '10:45'],
  ['busy', '10:45', '11:00'],
  ['buffer', '11:00', '11:15'],
]);
const other = appt(
  [
    ['busy', '09:00', '09:20'],
    ['processing', '09:20', '09:50'],
  ],
  'confirmed',
  null,
);
const requested = appt([['processing', '09:00', '10:00']], 'requested');
const segs = processingSegments([color, other, requested]);

describe('processingSegments', () => {
  it('lists processing on timed appointments with stable keys', () => {
    expect(segs.map((s) => s.key)).toEqual([`${other.id}:0`, `${color.id}:0`, `${color.id}:1`]);
    expect(segs[1]).toMatchObject({
      clientName: 'Karina Lopez',
      service: 'Color',
      label: 'Process',
    });
    expect(segs[0]!.clientName).toBe('Walk-in');
  });
});

describe('resolveTimers', () => {
  it('auto-starts at the scheduled time and runs concurrent timers soonest-first', () => {
    const b = resolveTimers(segs, {}, at('09:40'));
    expect(b.running.map((t) => t.key)).toEqual([`${other.id}:0`, `${color.id}:0`]);
    expect(b.running.every((t) => t.source === 'scheduled')).toBe(true);
  });

  it('keeps finished timers for a grace period, then drops them', () => {
    const finishedAt = (hhmm: string) =>
      resolveTimers(segs, {}, at(hhmm)).finished.map((t) => t.key);
    expect(finishedAt('09:55')).toEqual([`${other.id}:0`]);
    expect(finishedAt('10:05')).toEqual([`${color.id}:0`]);
    expect(resolveTimers(segs, {}, at('10:00') + DONE_GRACE_MS).finished).toHaveLength(0);
  });

  it('offers "Start processing" for the next segment while the client is here (manual mode)', () => {
    const b = resolveTimers(segs, {}, at('08:45'), { autoStart: false });
    expect(b.running).toHaveLength(0);
    expect(b.startable.map((s) => s.key)).toEqual([`${other.id}:0`, `${color.id}:0`]);
    expect(resolveTimers(segs, {}, at('08:00'), { autoStart: false }).startable).toHaveLength(0);
  });

  it('applies manual starts, extensions and dismissals', () => {
    const seg = segs[1]!;
    const now = at('09:10');
    const started = resolveTimers(segs, { [seg.key]: startOverride(seg, now) }, now + MIN);
    const t = started.running.find((r) => r.key === seg.key)!;
    expect(t).toMatchObject({ source: 'manual', start: now, end: now + 30 * MIN });
    // The next segment of the same appointment is offered once this one is under way.
    expect(started.startable.map((s) => s.key)).toEqual([`${other.id}:0`, `${color.id}:1`]);

    const extended = extendOverride(t, 5, now + MIN);
    expect(extended.endsAt).toBe(now + 35 * MIN);
    const late = extendOverride({ ...t, end: now }, 5, now + 10 * MIN);
    expect(late.endsAt).toBe(now + 15 * MIN);

    const dismissed = resolveTimers(segs, { [seg.key]: dismissOverride(now) }, at('09:40'));
    expect(dismissed.running.map((r) => r.key)).toEqual([`${other.id}:0`]);
  });

  it('prunes old overrides', () => {
    const now = at('12:00');
    const kept = pruneOverrides(
      { old: dismissOverride(now - OVERRIDE_TTL_MS), fresh: dismissOverride(now - MIN) },
      now,
    );
    expect(Object.keys(kept)).toEqual(['fresh']);
  });
});

describe('glance copy', () => {
  const t = resolveTimers(segs, {}, at('09:40')).running.find((r) => r.appointment === color)!;

  it('summarizes like the Dynamic Island', () => {
    expect(timerSummary(t, at('09:48') + 1)).toBe('Karina · color · 12 min left');
    expect(timerSummary(t, at('10:00'))).toBe('Karina · color · done');
    expect(activityProps(t, at('09:40'))).toEqual({
      client: 'Karina',
      service: 'color',
      start: at('09:30'),
      end: at('10:00'),
      done: false,
    });
    expect(alertContent(t).title).toBe('Karina’s color is done');
  });
});

describe('planActivities / planAlerts', () => {
  const board = resolveTimers(segs, {}, at('09:45'));
  const [a, b] = board.running;

  it('starts, updates, finishes and removes Live Activities', () => {
    const finishedBoard = resolveTimers(segs, {}, at('09:55'));
    expect(planActivities(board, [], true).start).toHaveLength(2);
    const plan = planActivities(
      board,
      [
        { key: a!.key, start: a!.start, end: a!.end },
        { key: b!.key, start: b!.start, end: b!.end - MIN },
        { key: 'gone', start: 0, end: 1 },
      ],
      true,
    );
    expect(plan).toEqual({ start: [], update: [b], finish: [], remove: ['gone'] });
    const done = planActivities(finishedBoard, [{ key: a!.key, start: 0, end: 0 }], true);
    expect(done.finish.map((t) => t.key)).toEqual([a!.key]);
    // Already "Done": left alone while finished, removed on dismiss, replaced if extended.
    const ended = [{ key: a!.key, start: 0, end: 0, done: true }];
    expect(planActivities(finishedBoard, ended, true).finish).toEqual([]);
    expect(planActivities(finishedBoard, ended, true).remove).toEqual([]);
    expect(planActivities({ running: [], finished: [] }, ended, true).remove).toEqual([a!.key]);
    const revived = planActivities(board, ended, true);
    expect(revived.remove).toEqual([a!.key]);
    expect(revived.start.map((t) => t.key)).toContain(a!.key);
    expect(planActivities(board, [{ key: a!.key, start: 0, end: 0 }], false).remove).toEqual([
      a!.key,
    ]);
  });

  it('schedules one alert per running timer and reschedules on extend', () => {
    expect(planAlerts(board.running, [], true).schedule).toHaveLength(2);
    const plan = planAlerts(
      board.running,
      [
        { key: a!.key, at: a!.end },
        { key: b!.key, at: b!.end - MIN },
        { key: 'stale', at: 1 },
      ],
      true,
    );
    expect(plan.schedule).toEqual([b]);
    expect(plan.cancel.sort()).toEqual([b!.key, 'stale'].sort());
    expect(planAlerts(board.running, [{ key: a!.key, at: 1 }], false)).toEqual({
      schedule: [],
      cancel: [a!.key],
    });
  });
});
