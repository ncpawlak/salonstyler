import type { WorkHours } from '@chairside/core';
import type { AppointmentStatus } from '@chairside/db';
import type { AppointmentWithDetails } from '@chairside/db/appointments';
import { describe, expect, it } from 'vitest';

import { buildGlance, glanceSignature, type GlanceInput } from './glance';

const DATE = '2026-03-06'; // Friday
const at = (hhmm: string) => Date.parse(`${DATE}T${hhmm}:00Z`);
const iso = (hhmm: string) => new Date(at(hhmm)).toISOString();

const hours: WorkHours = {
  timeZone: 'UTC',
  weekly: { 5: { blocks: [{ start: '09:00', end: '17:00', type: 'open' }], breaks: [] } },
};

let seq = 0;
function appt(
  start: string,
  end: string,
  name: string,
  status: AppointmentStatus = 'confirmed',
): AppointmentWithDetails {
  seq += 1;
  return {
    id: `a${seq}`,
    salon_id: 's',
    client_id: `c${seq}`,
    status,
    starts_at: iso(start),
    ends_at: iso(end),
    services: [{ serviceId: 'svc', name: 'Color', colorTag: 'purple' }],
    client: { id: `c${seq}`, name, phone: null, notes: null },
    segments: [{ kind: 'busy', label: null, start: iso(start), end: iso(end) }],
  } as unknown as AppointmentWithDetails;
}

const list = [
  appt('09:00', '11:00', 'Karina Lopez'),
  appt('13:00', '15:00', 'Dana Kim'),
  appt('15:00', '16:00', 'Request Person', 'requested'),
];
const input = (now: number, extra: Partial<GlanceInput> = {}): GlanceInput => ({
  hours,
  date: DATE,
  appointments: list,
  pendingRequests: 2,
  now,
  dayEnd: Date.parse('2026-03-07T00:00:00Z'),
  ...extra,
});

describe('buildGlance', () => {
  it('rolls "Next client" forward as clients arrive and leave, then clears at midnight', () => {
    const g = buildGlance(input(at('08:00')));
    expect(
      g.nextClient.map((e) => [
        new Date(e.date).toISOString().slice(11, 16),
        e.props.name,
        e.props.inChair,
      ]),
    ).toEqual([
      ['08:00', 'Karina', null],
      ['09:00', 'Dana', 'Karina'],
      ['11:00', 'Dana', null],
      ['13:00', null, 'Dana'],
      ['15:00', null, null],
      ['00:00', null, null],
    ]);
    expect(g.nextClient[0]!.props).toMatchObject({
      service: 'Color',
      time: '9:00 AM',
      start: at('09:00'),
      remaining: 2,
      today: true,
    });
    expect(g.nextClient.at(-1)!.props.today).toBe(false);
  });

  it('shows the share booked (requests hold their slot) and pending requests', () => {
    const g = buildGlance(input(at('08:00')));
    expect(g.dayBooked[0]!.props).toEqual({
      share: 5 / 8,
      percent: 63,
      clients: 2,
      open: true,
      today: true,
    });
    expect(g.requests).toEqual({ count: 2 });
  });

  it('keeps the same signature while nothing visible changes', () => {
    expect(glanceSignature(buildGlance(input(at('08:00'))))).toBe(
      glanceSignature(buildGlance(input(at('08:05')))),
    );
    expect(glanceSignature(buildGlance(input(at('08:00'))))).not.toBe(
      glanceSignature(buildGlance(input(at('08:00'), { pendingRequests: 3 }))),
    );
  });
});
