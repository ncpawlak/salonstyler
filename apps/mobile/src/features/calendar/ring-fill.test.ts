import { dayUtilization, type WorkHours } from '@chairside/core';
import { describe, expect, it } from 'vitest';

import {
  bookedLabel,
  bookedPercent,
  dayRingFill,
  freeLabel,
  ringAccessibilityLabel,
} from './ring-fill';

const day = (bookedMinutes: number, openMinutes: number, tentativeMinutes = 0) => ({
  bookedMinutes,
  openMinutes,
  tentativeMinutes,
});

/** Total arc length of a given state, as a fraction of the ring. */
const arc = (fill: ReturnType<typeof dayRingFill>, state: string) =>
  fill.slices.filter((s) => s.state === state).reduce((n, s) => n + (s.to - s.from), 0);

describe('dayRingFill', () => {
  it('fills the ring by share of working hours, not time of day', () => {
    // 8h day: 86% booked should look nearly full, 51% about half.
    const busy = dayRingFill(day(413, 67));
    const half = dayRingFill(day(245, 235));
    expect(busy.percent).toBe(86);
    expect(arc(busy, 'booked')).toBeCloseTo(0.86, 2);
    expect(half.percent).toBe(51);
    expect(arc(half, 'booked')).toBeCloseTo(0.51, 2);
  });

  it('lays out booked, then tentative, then open, closing the ring at 12 o’clock', () => {
    const fill = dayRingFill(day(240, 180, 60));
    expect(fill.slices).toEqual([
      { state: 'booked', from: 0, to: 0.5, minutes: 240 },
      { state: 'tentative', from: 0.5, to: 0.625, minutes: 60 },
      { state: 'open', from: 0.625, to: 1, minutes: 180 },
    ]);
    expect(fill.workMinutes).toBe(480);
    expect(fill.freeMinutes).toBe(240);
  });

  it('keeps ring, percent and free time in agreement', () => {
    for (const [b, o, t] of [
      [0, 480, 0],
      [1, 479, 0],
      [478, 2, 0],
      [300, 100, 80],
      [480, 0, 0],
    ] as const) {
      const fill = dayRingFill(day(b, o, t));
      expect(fill.bookedMinutes + fill.freeMinutes).toBe(fill.workMinutes);
      expect(arc(fill, 'booked') + arc(fill, 'tentative') + arc(fill, 'open')).toBeCloseTo(1, 9);
      expect(fill.slices.at(-1)!.to).toBe(1);
      // Something free never reads 100%, something booked never reads 0%.
      if (fill.freeMinutes > 0) expect(fill.percent).toBeLessThan(100);
      if (fill.bookedMinutes > 0) expect(fill.percent).toBeGreaterThan(0);
    }
  });

  it('treats a day with no working hours as Off', () => {
    const fill = dayRingFill(day(0, 0, 0));
    expect(fill).toMatchObject({ closed: true, percent: 0, workMinutes: 0, slices: [] });
    expect(bookedLabel(fill)).toBe('Off');
    expect(freeLabel(fill)).toBe('Off');
    expect(ringAccessibilityLabel(fill)).toBe('Day off');
  });

  it('is a full booked ring when nothing is free', () => {
    const fill = dayRingFill(day(480, 0));
    expect(fill.slices).toEqual([{ state: 'booked', from: 0, to: 1, minutes: 480 }]);
    expect(bookedLabel(fill)).toBe('100% booked');
    expect(freeLabel(fill)).toBe('Fully booked');
    expect(ringAccessibilityLabel(fill)).toBe('100% booked, all 8h taken.');
  });
});

describe('labels', () => {
  it('reads at a glance', () => {
    const fill = dayRingFill(day(415, 65));
    expect(bookedLabel(fill)).toBe('86% booked');
    expect(freeLabel(fill)).toBe('1h 5m free');
    expect(ringAccessibilityLabel(fill)).toBe('86% booked, 1h 5m free of 8h.');
  });

  it('mentions tentative free time for screen readers', () => {
    expect(ringAccessibilityLabel(dayRingFill(day(240, 180, 60)))).toBe(
      '50% booked, 4h free of 8h. 1h of the free time is tentative.',
    );
  });
});

describe('bookedPercent', () => {
  it('rounds without contradicting the free time', () => {
    expect(bookedPercent(0, 480)).toBe(0);
    expect(bookedPercent(1, 480)).toBe(1);
    expect(bookedPercent(240, 480)).toBe(50);
    expect(bookedPercent(479, 480)).toBe(99);
    expect(bookedPercent(480, 480)).toBe(100);
    expect(bookedPercent(10, 0)).toBe(0);
  });
});

describe('with core dayUtilization', () => {
  const hours: WorkHours = {
    timeZone: 'America/New_York',
    weekly: { 2: { blocks: [{ start: '09:00', end: '17:00', type: 'open' }] } },
  };

  it('uses only working hours for the ring, not the 24h day', () => {
    // Tuesday 2026-11-10, 9a–5p ET (UTC-5). Booked 9a–1p = 4h of 8h.
    const u = dayUtilization(hours, '2026-11-10', [
      {
        segments: [{ kind: 'style', start: '2026-11-10T14:00:00Z', end: '2026-11-10T18:00:00Z' }],
      },
    ]);
    const fill = dayRingFill(u);
    expect(u.totalMinutes).toBe(1440);
    expect(fill.workMinutes).toBe(480);
    expect(fill.percent).toBe(50);
    expect(arc(fill, 'booked')).toBeCloseTo(0.5, 9);
  });
});
