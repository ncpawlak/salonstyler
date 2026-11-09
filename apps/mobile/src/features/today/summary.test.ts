import type { WorkHours } from '@chairside/core';
import type { AppointmentStatus, AppointmentWithDetails } from '@chairside/db';
import { describe, expect, it } from 'vitest';

import {
  activeProcessing,
  checkoutCandidate,
  dayUtilization,
  formatClock,
  formatCountdown,
  summarizeToday,
} from './summary';

const DATE = '2026-03-06'; // Friday
const at = (hhmm: string) => Date.parse(`${DATE}T${hhmm}:00Z`);
const iso = (hhmm: string) => new Date(at(hhmm)).toISOString();

const hours: WorkHours = {
  timeZone: 'UTC',
  weekly: {
    5: {
      blocks: [{ start: '09:00', end: '17:00', type: 'open' }],
      breaks: [{ start: '12:00', end: '13:00' }],
    },
  },
};

let seq = 0;
function appt(
  segments: [kind: 'busy' | 'processing' | 'buffer', start: string, end: string][],
  status: AppointmentStatus = 'confirmed',
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
    client: { id: `c${seq}`, name: `Client ${seq}`, phone: null, notes: null },
    segments: segments.map(([kind, start, end]) => ({
      kind,
      label: kind === 'processing' ? 'Color develops' : null,
      start: iso(start),
      end: iso(end),
    })),
  } as unknown as AppointmentWithDetails;
}

describe('dayUtilization', () => {
  it('shares booked time (buffers included, like the Calendar ring) over open hours minus breaks', () => {
    const list = [
      appt([
        ['busy', '09:00', '10:00'],
        ['buffer', '10:00', '10:15'],
      ]),
      appt([['busy', '13:00', '14:45']]),
    ];
    const u = dayUtilization(hours, DATE, list);
    expect(u.availableMs).toBe(7 * 3_600_000);
    expect(u.bookedMs).toBe(3 * 3_600_000);
    expect(u.share).toBeCloseTo(3 / 7);
    expect(u.isOpen).toBe(true);
  });

  it('counts requests (they hold the slot), ignores cancellations, and separates overtime', () => {
    const list = [
      appt([['busy', '09:00', '11:00']]),
      appt([['busy', '14:00', '15:00']], 'requested'),
      appt([['busy', '15:00', '16:00']], 'cancelled'),
      appt([['busy', '16:30', '17:30']], 'held'),
    ];
    const u = dayUtilization(hours, DATE, list);
    expect(u.bookedMs).toBe(3.5 * 3_600_000);
    expect(u.overtimeMs).toBe(30 * 60_000);
  });

  it('is closed with a full ring when booked on a day off', () => {
    const sunday = '2026-03-08';
    const u = dayUtilization(hours, sunday, []);
    expect(u).toMatchObject({ isOpen: false, share: 0 });
    const extra = dayUtilization(hours, sunday, [
      {
        ...appt([['busy', '09:00', '10:00']]),
        starts_at: '2026-03-08T09:00:00Z',
        ends_at: '2026-03-08T10:00:00Z',
        segments: [
          { kind: 'busy', label: null, start: '2026-03-08T09:00:00Z', end: '2026-03-08T10:00:00Z' },
        ],
      },
    ]);
    expect(extra).toMatchObject({ isOpen: false, share: 1, overtimeMs: 3_600_000 });
  });
});

describe('summarizeToday', () => {
  const morning = appt([
    ['busy', '09:00', '09:30'],
    ['processing', '09:30', '10:15'],
    ['busy', '10:15', '10:45'],
  ]);
  const late = appt([['busy', '14:00', '15:00']], 'held');
  const done = appt([['busy', '08:00', '08:30']], 'completed');
  const request = appt([['busy', '11:00', '11:30']], 'requested');
  const list = [late, request, morning, done];

  it('finds who is in the chair, who is next and how many are left', () => {
    const s = summarizeToday(hours, DATE, list, at('09:40'));
    expect(s.current?.id).toBe(morning.id);
    expect(s.next?.id).toBe(late.id);
    expect(s.clientCount).toBe(3);
    expect(s.remainingCount).toBe(1);
  });

  it('skips requests for next and returns nothing after the last booking', () => {
    expect(summarizeToday(hours, DATE, list, at('10:50')).next?.id).toBe(late.id);
    const evening = summarizeToday(hours, DATE, list, at('16:00'));
    expect(evening.next).toBeNull();
    expect(evening.current).toBeNull();
  });

  it('lists running processing segments', () => {
    const timers = activeProcessing(list, at('09:40'));
    expect(timers).toHaveLength(1);
    expect(timers[0]).toMatchObject({ label: 'Color develops', end: at('10:15') });
    expect(activeProcessing(list, at('10:15'))).toHaveLength(0);
    expect(activeProcessing([{ ...morning, status: 'requested' }], at('09:40'))).toHaveLength(0);
  });
});

describe('formatting', () => {
  it('formats countdowns', () => {
    expect(formatCountdown(12 * 60_000)).toBe('in 12 min');
    expect(formatCountdown(125 * 60_000)).toBe('in 2h 5m');
    expect(formatCountdown(120 * 60_000)).toBe('in 2h');
    expect(formatCountdown(10_000)).toBe('now');
    expect(formatCountdown(-5 * 60_000)).toBe('5 min ago');
  });

  it('formats timers', () => {
    expect(formatClock(65_000)).toBe('01:05');
    expect(formatClock(64_001)).toBe('01:05');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(formatClock(-1)).toBe('00:00');
  });
});

describe('checkoutCandidate', () => {
  it('prefers the confirmed client in the chair', () => {
    const done = appt([['busy', '09:00', '10:00']]);
    const inChair = appt([
      ['busy', '10:00', '11:00'],
      ['buffer', '11:00', '11:15'],
    ]);
    const next = appt([['busy', '13:00', '14:00']]);
    expect(checkoutCandidate([next, done, inChair], at('10:30'))?.id).toBe(inChair.id);
  });

  it('falls back to whoever finished most recently, ignoring buffers and settled appointments', () => {
    const early = appt([['busy', '09:00', '10:00']]);
    const later = appt([
      ['busy', '10:00', '11:00'],
      ['buffer', '11:00', '11:30'],
    ]);
    const paid = appt([['busy', '11:00', '11:10']], 'completed');
    expect(checkoutCandidate([early, later, paid], at('11:15'))?.id).toBe(later.id);
  });

  it('otherwise picks the next confirmed appointment, or nothing', () => {
    const held = appt([['busy', '09:00', '10:00']], 'held');
    const next = appt([['busy', '14:00', '15:00']]);
    const nextLater = appt([['busy', '16:00', '17:00']]);
    expect(checkoutCandidate([nextLater, held, next], at('08:00'))?.id).toBe(next.id);
    expect(checkoutCandidate([held], at('08:00'))).toBeNull();
  });
});
