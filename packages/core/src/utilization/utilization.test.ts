import { describe, expect, it } from 'vitest';

import { appt, at, NY, ROOT_TOUCH_UP } from '../availability/test-helpers';
import type { WorkHours } from '../availability/types';
import {
  dayUtilization,
  rangeUtilization,
  summarizeUtilization,
  utilizationLevel,
} from './utilization';

/** Tue–Sat 9–5 open with a 12–1 lunch; Saturday 5–7 tentative; Sunday 10–2 tentative. */
const hours: WorkHours = {
  timeZone: NY,
  weekly: {
    0: { blocks: [{ start: '10:00', end: '14:00', type: 'tentative' }] },
    2: {
      blocks: [{ start: '09:00', end: '17:00', type: 'open' }],
      breaks: [{ start: '12:00', end: '13:00' }],
    },
    3: { blocks: [{ start: '09:00', end: '17:00', type: 'open' }] },
    4: { blocks: [{ start: '09:00', end: '17:00', type: 'open' }] },
    5: { blocks: [{ start: '09:00', end: '17:00', type: 'open' }] },
    6: {
      blocks: [
        { start: '09:00', end: '17:00', type: 'open' },
        { start: '17:00', end: '19:00', type: 'tentative' },
      ],
    },
  },
};

const TUE = '2026-03-03';
const SAT = '2026-03-07';
const SUN_DST = '2026-03-08';
const MON = '2026-03-09';

describe('dayUtilization', () => {
  it('an empty working day is all open time inside a closed day', () => {
    const d = dayUtilization(hours, TUE, []);
    expect(d).toMatchObject({
      date: TUE,
      weekday: 2,
      status: 'open',
      totalMinutes: 1440,
      bookedMinutes: 0,
      openMinutes: 420,
      tentativeMinutes: 0,
      closedMinutes: 1020,
      capacityMinutes: 420,
      utilization: 0,
      appointmentCount: 0,
    });
    expect(d.runs.map((r) => r.state)).toEqual(['closed', 'open', 'closed', 'open', 'closed']);
    expect(d.hours).toHaveLength(24);
    expect(d.hours[9]).toMatchObject({ hour: 9, open: 60, booked: 0, closed: 0 });
    expect(d.hours[12]).toMatchObject({ hour: 12, open: 0, closed: 60 });
  });

  it('busy and style count as booked; processing stays open for others', () => {
    const color = appt('a', at(TUE, '09:00'), [
      ['busy', 30],
      ['processing', 35],
      ['style', 30],
    ]);
    const d = dayUtilization(hours, TUE, [color]);
    expect(d.bookedMinutes).toBe(60);
    expect(d.processingMinutes).toBe(35);
    expect(d.openMinutes).toBe(360);
    expect(d.capacityMinutes).toBe(420);
    expect(d.utilization).toBeCloseTo(60 / 420);
    expect(d.appointmentCount).toBe(1);
    expect(d.hours[9]).toMatchObject({ booked: 30, open: 30, processing: 30 });
    expect(d.hours[10]).toMatchObject({ booked: 30, open: 30, processing: 5 });
    expect(d.runs.slice(1, 4).map((r) => [r.state, (r.end - r.start) / 60_000])).toEqual([
      ['booked', 30],
      ['open', 35],
      ['booked', 30],
    ]);
  });

  it('a cut booked inside processing time is not double-counted', () => {
    const color = appt(
      'a',
      at(TUE, '09:00'),
      ROOT_TOUCH_UP.map((s) => [s.kind, s.minutes]),
    );
    const cut = appt('b', at(TUE, '09:30'), [['busy', 30]]);
    const d = dayUtilization(hours, TUE, [color, cut]);
    expect(d.bookedMinutes).toBe(90);
    expect(d.processingMinutes).toBe(5);
    expect(d.appointmentCount).toBe(2);
    expect(d.bookedMinutes + d.openMinutes + d.tentativeMinutes + d.closedMinutes).toBe(1440);
  });

  it('buffers block time but do not count as an appointment on their own', () => {
    const d = dayUtilization(hours, TUE, [
      appt('a', at(TUE, '14:00'), [
        ['buffer', 15],
        ['busy', 45],
        ['buffer', 15],
      ]),
      appt('late', at(TUE, '23:50'), [['buffer', 10]]),
    ]);
    expect(d.bookedMinutes).toBe(85);
    expect(d.appointmentCount).toBe(1);
  });

  it('shows tentative hours separately and tracks booked tentative time', () => {
    const d = dayUtilization(hours, SAT, [appt('a', at(SAT, '17:30'), [['busy', 60]])]);
    expect(d.status).toBe('mixed');
    expect(d.openMinutes).toBe(480);
    expect(d.tentativeMinutes).toBe(60);
    expect(d.bookedMinutes).toBe(60);
    expect(d.bookedTentativeMinutes).toBe(60);
    expect(d.capacityMinutes).toBe(600);
    expect(d.runs.map((r) => r.state)).toEqual([
      'closed',
      'open',
      'tentative',
      'booked',
      'tentative',
      'closed',
    ]);
  });

  it('after-hours bookings count as booked and grow capacity', () => {
    const d = dayUtilization(hours, TUE, [appt('a', at(TUE, '18:00'), [['busy', 60]])]);
    expect(d.bookedOutsideHoursMinutes).toBe(60);
    expect(d.capacityMinutes).toBe(480);
    expect(d.closedMinutes).toBe(960);
  });

  it('a closed day with nothing booked has no capacity', () => {
    const d = dayUtilization(hours, MON, []);
    expect(d).toMatchObject({ status: 'closed', capacityMinutes: 0, utilization: 0 });
    expect(d.runs).toEqual([{ state: 'closed', start: d.start, end: d.end }]);
    expect(utilizationLevel(d)).toBeNull();
  });

  it('clips appointments that span midnight to the day', () => {
    const d = dayUtilization(hours, TUE, [appt('a', at(TUE, '23:30'), [['busy', 60]])]);
    expect(d.bookedMinutes).toBe(30);
    const next = dayUtilization(hours, '2026-03-04', [appt('a', at(TUE, '23:30'), [['busy', 60]])]);
    expect(next.bookedMinutes).toBe(30);
  });

  it('handles the spring-forward day (23 hours)', () => {
    const d = dayUtilization(hours, SUN_DST, [appt('a', at(SUN_DST, '10:00'), [['busy', 120]])]);
    expect(d.totalMinutes).toBe(1380);
    expect(d.hours).toHaveLength(23);
    expect(d.hours.map((h) => h.hour).slice(0, 4)).toEqual([0, 1, 3, 4]);
    expect(d.tentativeMinutes).toBe(120);
    expect(d.bookedTentativeMinutes).toBe(120);
    expect(d.utilization).toBe(0.5);
    expect(d.bookedMinutes + d.openMinutes + d.tentativeMinutes + d.closedMinutes).toBe(1380);
  });

  it('accepts an instant and resolves the salon-local date', () => {
    expect(dayUtilization(hours, at(TUE, '23:59'), []).date).toBe(TUE);
  });
});

describe('rangeUtilization + summarizeUtilization', () => {
  const week = rangeUtilization(hours, '2026-03-01', '2026-03-07', [
    appt('a', at(TUE, '09:00'), [['busy', 210]]),
    appt('b', at('2026-03-04', '09:00'), [['busy', 480]]),
    appt('c', at('2026-03-20', '09:00'), [['busy', 60]]),
  ]);

  it('returns one entry per local date', () => {
    expect(week.map((d) => d.date)).toEqual([
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
      '2026-03-07',
    ]);
    expect(week.map(utilizationLevel)).toEqual([0, null, 2, 4, 0, 0, 0]);
  });

  it('summarizes the week', () => {
    const s = summarizeUtilization(week);
    expect(s).toMatchObject({
      days: 7,
      workingDays: 6,
      bookedMinutes: 690,
      appointmentCount: 2,
      busiestDate: '2026-03-04',
      mostOpenDate: '2026-03-07',
    });
    expect(s.utilization).toBeCloseTo(690 / s.capacityMinutes);
  });

  it('rejects inverted or oversized ranges', () => {
    expect(() => rangeUtilization(hours, '2026-03-07', '2026-03-01', [])).toThrow(RangeError);
    expect(() => rangeUtilization(hours, '2026-01-01', '2026-06-01', [])).toThrow(RangeError);
  });
});

describe('utilizationLevel', () => {
  it.each([
    [0, 0],
    [0.2, 1],
    [0.5, 2],
    [0.8, 3],
    [0.95, 4],
    [1, 4],
  ])('%s → %s', (utilization, level) => {
    expect(utilizationLevel({ capacityMinutes: 100, utilization })).toBe(level);
  });
});
