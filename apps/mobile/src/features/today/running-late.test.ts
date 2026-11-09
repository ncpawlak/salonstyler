import type { WorkHours } from '@chairside/core';
import type { AppointmentStatus, AppointmentWithDetails } from '@chairside/db';
import { describe, expect, it } from 'vitest';

import {
  defaultLateAppointment,
  describePlan,
  parseLateParam,
  planOptions,
  runningLateCandidates,
  strategyLabel,
} from './running-late';

const DATE = '2026-03-06'; // Friday
const at = (hhmm: string) => Date.parse(`${DATE}T${hhmm}:00Z`);
const iso = (hhmm: string) => new Date(at(hhmm)).toISOString();

const hours: WorkHours = {
  timeZone: 'UTC',
  weekly: { 5: { blocks: [{ start: '09:00', end: '17:00', type: 'open' }], breaks: [] } },
};

function appt(
  id: string,
  segments: [kind: 'busy' | 'processing', start: string, end: string][],
  status: AppointmentStatus = 'confirmed',
): AppointmentWithDetails {
  return {
    id,
    status,
    starts_at: iso(segments[0]![1]),
    ends_at: iso(segments.at(-1)![2]),
    client: {
      id: `c-${id}`,
      name: `${id[0]!.toUpperCase()}${id.slice(1)} Smith`,
      phone: null,
      notes: null,
    },
    segments: segments.map(([kind, start, end]) => ({
      kind,
      label: null,
      start: iso(start),
      end: iso(end),
    })),
  } as unknown as AppointmentWithDetails;
}

// Done at 9, in the chair 10:00–10:30, then Maya 10:30 and Nora 11:00 back to back, Omar at 2.
const day = [
  appt('done', [['busy', '09:00', '09:30']], 'completed'),
  appt('lia', [['busy', '10:00', '10:30']]),
  appt('maya', [['busy', '10:30', '11:00']]),
  appt('nora', [['busy', '11:00', '11:30']]),
  appt('omar', [['busy', '14:00', '15:00']]),
];
const byId = new Map(day.map((a) => [a.id, a]));

describe('runningLateCandidates / defaultLateAppointment', () => {
  it('skips completed and finished appointments; defaults to the next client not yet started', () => {
    const now = at('10:10');
    expect(runningLateCandidates(day, now).map((a) => a.id)).toEqual([
      'lia',
      'maya',
      'nora',
      'omar',
    ]);
    expect(defaultLateAppointment(day, now)?.id).toBe('maya');
  });

  it('falls back to the client already due when nobody is left to start', () => {
    expect(defaultLateAppointment(day, at('14:05'))?.id).toBe('omar');
    expect(defaultLateAppointment(day, at('16:00'))).toBeNull();
  });
});

describe('planOptions', () => {
  it('cascades back-to-back clients and leaves gaps to absorb the delay', () => {
    const [squeeze, ...rest] = planOptions({
      appointments: day,
      hours,
      delayMinutes: 15,
      firstId: 'maya',
      now: at('10:10'),
    });
    expect(squeeze!.moves.map((m) => [m.id, m.shiftMinutes])).toEqual([
      ['maya', 15],
      ['nora', 15],
    ]);
    expect(squeeze!.unchanged).toEqual(['omar']);
    expect(describePlan(squeeze!, byId)).toBe('2 clients move · 1 unaffected');

    const one = rest.find((p) => p.strategy === 'move_one')!;
    expect(one.ok).toBe(false);
    expect(describePlan(one, byId)).toBe('Would overlap Maya and Nora');
    expect(strategyLabel('move_one', byId.get('maya'))).toBe('Just Maya');
  });
});

describe('parseLateParam', () => {
  it('accepts positive minutes, capped', () => {
    expect(parseLateParam('15')).toBe(15);
    expect(parseLateParam('999')).toBe(240);
    expect(parseLateParam('0')).toBeNull();
    expect(parseLateParam(undefined)).toBeNull();
    expect(parseLateParam('soon')).toBeNull();
  });
});
