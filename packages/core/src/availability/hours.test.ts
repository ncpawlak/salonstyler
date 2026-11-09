import { describe, expect, it } from 'vitest';
import { dayAvailability, scheduleForDate } from './hours.ts';
import { FRI, NY, at, weekdayHours } from './test-helpers.ts';
import type { WorkHours } from './types.ts';

const iso = (i: { start: number; end: number }) => [
  new Date(i.start).toISOString(),
  new Date(i.end).toISOString(),
];

describe('work hours', () => {
  it('uses the weekly template; missing weekday = closed', () => {
    const h = weekdayHours();
    expect(dayAvailability(h, FRI).open.map(iso)).toEqual([[at(FRI, '09:00'), at(FRI, '17:00')]]);
    expect(dayAvailability(h, '2026-03-08').available).toEqual([]);
  });

  it('applies single-date and range overrides, last one wins', () => {
    const h: WorkHours = {
      ...weekdayHours(),
      overrides: [
        { from: '2026-03-02', to: '2026-03-06', blocks: [] },
        { from: FRI, blocks: [{ start: '12:00', end: '15:00', type: 'open' }] },
      ],
    };
    expect(dayAvailability(h, '2026-03-04').available).toEqual([]);
    expect(dayAvailability(h, FRI).open.map(iso)).toEqual([[at(FRI, '12:00'), at(FRI, '15:00')]]);
    expect(scheduleForDate(h, '2026-03-07')).toBe(h.weekly[6]);
  });

  it('paints closed > open > tentative and removes breaks', () => {
    const h: WorkHours = {
      timeZone: NY,
      weekly: {
        5: {
          blocks: [
            { start: '08:00', end: '20:00', type: 'tentative' },
            { start: '09:00', end: '17:00', type: 'open' },
            { start: '15:00', end: '16:00', type: 'closed' },
          ],
          breaks: [{ start: '12:00', end: '12:30' }],
        },
      },
    };
    const d = dayAvailability(h, FRI);
    expect(d.open.map(iso)).toEqual([
      [at(FRI, '09:00'), at(FRI, '12:00')],
      [at(FRI, '12:30'), at(FRI, '15:00')],
      [at(FRI, '16:00'), at(FRI, '17:00')],
    ]);
    expect(d.tentative.map(iso)).toEqual([
      [at(FRI, '08:00'), at(FRI, '09:00')],
      [at(FRI, '17:00'), at(FRI, '20:00')],
    ]);
    expect(d.available.map(iso)).toEqual([
      [at(FRI, '08:00'), at(FRI, '12:00')],
      [at(FRI, '12:30'), at(FRI, '15:00')],
      [at(FRI, '16:00'), at(FRI, '20:00')],
    ]);
  });

  it('measures real elapsed time across DST transitions', () => {
    const night: WorkHours = {
      timeZone: NY,
      weekly: { 0: { blocks: [{ start: '01:00', end: '04:00', type: 'open' }] } },
    };
    const [spring] = dayAvailability(night, '2026-03-08').available;
    expect((spring!.end - spring!.start) / 3_600_000).toBe(2);
    const [fall] = dayAvailability(night, '2026-11-01').available;
    expect((fall!.end - fall!.start) / 3_600_000).toBe(4);
  });

  it('rejects inverted ranges', () => {
    const h: WorkHours = {
      timeZone: NY,
      weekly: { 5: { blocks: [{ start: '17:00', end: '09:00', type: 'open' }] } },
    };
    expect(() => dayAvailability(h, FRI)).toThrow();
  });
});
