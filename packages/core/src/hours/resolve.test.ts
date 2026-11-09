import { describe, expect, it } from 'vitest';
import { findSlots } from '../availability/engine.ts';
import { dayAvailability } from '../availability/hours.ts';
import { addDays, formatLocalDate, parseClock, parseLocalDate } from '../availability/time.ts';
import { at } from '../availability/test-helpers.ts';
import { getWorkingBlocks, getWorkingBlocksRange, toSalonDate } from './resolve.ts';
import {
  bookingRulesFromSettings,
  buildWorkHours,
  parseHoursBlocks,
  sortOverrides,
} from './rows.ts';
import type { WorkHoursOverrideRow, WorkHoursTemplateRow } from './types.ts';

const CHI = 'America/Chicago';
const iso = (i: { start: number; end: number }) => [
  new Date(i.start).toISOString(),
  new Date(i.end).toISOString(),
];

/** Acceptance scenario, as DB rows: Tue–Sat 9–6 with lunch, Sunday 10–2 tentative, Dec 24–26 off. */
const template: WorkHoursTemplateRow[] = [
  ...[2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    blocks: [{ start: '09:00', end: '18:00', type: 'open' }],
    breaks: [{ start: '12:00', end: '13:00' }],
  })),
  { weekday: 0, blocks: [{ start: '10:00', end: '14:00', type: 'tentative' }], breaks: [] },
];
const christmas: WorkHoursOverrideRow = {
  start_date: '2026-12-24',
  end_date: '2026-12-26',
  kind: 'vacation',
  blocks: [],
  breaks: [],
  note: 'Christmas',
};
const hours = buildWorkHours({ timeZone: CHI, template, overrides: [christmas] });

describe('getWorkingBlocks — acceptance', () => {
  it('Tue–Sat 9–6 with lunch', () => {
    const tue = getWorkingBlocks(hours, '2026-03-10');
    expect(tue).toMatchObject({ weekday: 2, source: 'template', status: 'open' });
    expect(tue.blocks).toEqual([
      { start: '09:00', end: '12:00', type: 'open' },
      { start: '13:00', end: '18:00', type: 'open' },
    ]);
    expect(tue.open.map(iso)).toEqual([
      [at('2026-03-10', '09:00', CHI), at('2026-03-10', '12:00', CHI)],
      [at('2026-03-10', '13:00', CHI), at('2026-03-10', '18:00', CHI)],
    ]);
    expect(tue.openMinutes).toBe(480);
    expect(tue.tentative).toEqual([]);
  });

  it('Monday is closed', () => {
    expect(getWorkingBlocks(hours, '2026-03-09')).toMatchObject({
      status: 'closed',
      blocks: [],
      available: [],
    });
  });

  it('Sunday 10–2 is tentative', () => {
    const sun = getWorkingBlocks(hours, '2026-03-15');
    expect(sun.status).toBe('tentative');
    expect(sun.blocks).toEqual([{ start: '10:00', end: '14:00', type: 'tentative' }]);
    expect(sun.open).toEqual([]);
    expect(sun.tentativeMinutes).toBe(240);
  });

  it('Dec 24–26 are off; the days around them follow the template', () => {
    for (const d of ['2026-12-24', '2026-12-25', '2026-12-26']) {
      const day = getWorkingBlocks(hours, d);
      expect(day).toMatchObject({ source: 'override', status: 'closed', blocks: [] });
      expect(day.override).toMatchObject({ kind: 'vacation', note: 'Christmas' });
    }
    expect(getWorkingBlocks(hours, '2026-12-23').status).toBe('open');
    expect(getWorkingBlocks(hours, '2026-12-27').status).toBe('tentative');
    expect(getWorkingBlocks(hours, '2025-12-25').status).toBe('open');
  });

  it('feeds the availability engine: tentative Sunday slots require approval', () => {
    const { leadTimeMinutes, slotGridMinutes, bookingWindowDays } = bookingRulesFromSettings({
      min_notice_minutes: 120,
      booking_window_days: 60,
      slot_grid_minutes: 15,
    });
    const slots = findSlots({
      service: { segments: [{ kind: 'busy', minutes: 45 }] },
      hours,
      requestedDate: '2026-03-15',
      searchRadiusDays: 0,
      now: '2026-03-01T12:00:00Z',
      rules: { leadTimeMinutes, slotGridMinutes, bookingWindowDays },
    });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((s) => s.requiresApproval)).toBe(true);
    expect(slots[0]!.localTime).toBe('10:00');
  });
});

describe('getWorkingBlocks — time zones & DST', () => {
  it('Sunday 10–2 stays 10–2 local across both US transitions', () => {
    const cases: [string, string, string][] = [
      ['2026-03-01', '16:00', '20:00'], // CST (UTC−6)
      ['2026-03-08', '15:00', '19:00'], // spring forward → CDT (UTC−5)
      ['2026-10-25', '15:00', '19:00'], // CDT
      ['2026-11-01', '16:00', '20:00'], // fall back → CST
    ];
    for (const [date, s, e] of cases) {
      const day = getWorkingBlocks(hours, date);
      expect(day.blocks).toEqual([{ start: '10:00', end: '14:00', type: 'tentative' }]);
      expect(day.tentative.map(iso)).toEqual([[`${date}T${s}:00.000Z`, `${date}T${e}:00.000Z`]]);
      expect(day.tentativeMinutes).toBe(240);
    }
  });

  it('counts real elapsed time for blocks spanning the 2 AM change', () => {
    const night = buildWorkHours({
      timeZone: CHI,
      template: [
        { weekday: 0, blocks: [{ start: '00:00', end: '06:00', type: 'open' }], breaks: [] },
      ],
    });
    expect(getWorkingBlocks(night, '2026-03-08').openMinutes).toBe(300);
    expect(getWorkingBlocks(night, '2026-11-01').openMinutes).toBe(420);
    expect(getWorkingBlocks(night, '2026-11-08').openMinutes).toBe(360);
  });

  it('resolves instants to the salon-local date', () => {
    // 04:30Z on Mar 11 is 23:30 on Mar 10 in Chicago (CDT).
    expect(toSalonDate('2026-03-11T04:30:00Z', CHI)).toBe('2026-03-10');
    expect(getWorkingBlocks(hours, new Date('2026-03-11T04:30:00Z')).date).toBe('2026-03-10');
    expect(getWorkingBlocks(hours, Date.parse('2026-12-25T05:59:00Z')).date).toBe('2026-12-24');
    expect(toSalonDate('2026-03-29T23:30:00Z', 'Europe/London')).toBe('2026-03-30');
    expect(toSalonDate('2026-03-29T23:30:00Z', 'Pacific/Auckland')).toBe('2026-03-30');
    expect(toSalonDate('2026-03-29T23:30:00Z', 'America/Los_Angeles')).toBe('2026-03-29');
  });

  it('is consistent with the engine for every date over two years', () => {
    const start = parseLocalDate('2026-01-01');
    for (let i = 0; i < 730; i++) {
      const date = formatLocalDate(addDays(start, i));
      const day = getWorkingBlocks(hours, date);
      const engine = dayAvailability(hours, date);
      expect(day.open).toEqual(engine.open);
      expect(day.tentative).toEqual(engine.tentative);
      // Resolved blocks are a valid engine schedule that reproduces the same intervals.
      const replay = dayAvailability(
        { timeZone: CHI, weekly: {}, overrides: [{ from: date, blocks: day.blocks }] },
        date,
      );
      expect(replay.available).toEqual(engine.available);
      // These hours never cross 2 AM, so wall-clock minutes equal real minutes, even on DST days.
      const wall = day.blocks.reduce((n, b) => n + parseClock(b.end) - parseClock(b.start), 0);
      expect(day.openMinutes + day.tentativeMinutes).toBe(wall);
    }
  });

  it('returns a range for calendar views', () => {
    const month = getWorkingBlocksRange(hours, '2026-12-01', '2026-12-31');
    expect(month).toHaveLength(31);
    expect(month.filter((d) => d.status === 'closed').map((d) => d.date)).toEqual([
      '2026-12-07',
      '2026-12-14',
      '2026-12-21',
      '2026-12-24',
      '2026-12-25',
      '2026-12-26',
      '2026-12-28',
    ]);
    expect(() => getWorkingBlocksRange(hours, '2026-12-31', '2026-12-01')).toThrow();
  });
});

describe('overrides', () => {
  const day = (start: string, end: string, extra: Partial<WorkHoursOverrideRow> = {}) =>
    ({
      start_date: start,
      end_date: end,
      kind: 'custom',
      blocks: [],
      breaks: [],
      ...extra,
    }) as const;

  it('a single painted day beats the vacation it sits in, whatever the row order', () => {
    const vacation = day('2026-12-20', '2026-12-31', { kind: 'vacation' });
    const open27 = day('2026-12-27', '2026-12-27', {
      blocks: [{ start: '11:00', end: '15:00', type: 'open' }],
    });
    for (const overrides of [
      [vacation, open27],
      [open27, vacation],
    ]) {
      const h = buildWorkHours({ timeZone: CHI, template, overrides });
      expect(getWorkingBlocks(h, '2026-12-27').blocks).toEqual([
        { start: '11:00', end: '15:00', type: 'open' },
      ]);
      expect(getWorkingBlocks(h, '2026-12-28').status).toBe('closed');
    }
  });

  it('same-length overlaps go to the most recently updated', () => {
    const a = day('2026-07-01', '2026-07-02', {
      blocks: [{ start: '09:00', end: '10:00', type: 'open' }],
      updated_at: '2026-06-02T00:00:00Z',
    });
    const b = day('2026-07-02', '2026-07-03', {
      kind: 'day_off',
      updated_at: '2026-06-01T00:00:00Z',
    });
    expect(sortOverrides([a, b])).toEqual([b, a]);
    const h = buildWorkHours({ timeZone: CHI, template, overrides: [a, b] });
    expect(getWorkingBlocks(h, '2026-07-02').status).toBe('open');
  });

  it('custom days can mix open, tentative and closed, with breaks', () => {
    const h = buildWorkHours({
      timeZone: CHI,
      template,
      overrides: [
        day('2026-07-09', '2026-07-09', {
          blocks: [
            { start: '09:00', end: '18:00', type: 'open' },
            { start: '18:00', end: '20:00', type: 'tentative' },
            { start: '15:00', end: '16:00', type: 'closed' },
          ],
          breaks: [{ start: '12:00', end: '12:30' }],
        }),
      ],
    });
    const thu = getWorkingBlocks(h, '2026-07-09');
    expect(thu.status).toBe('mixed');
    expect(thu.blocks).toEqual([
      { start: '09:00', end: '12:00', type: 'open' },
      { start: '12:30', end: '15:00', type: 'open' },
      { start: '16:00', end: '18:00', type: 'open' },
      { start: '18:00', end: '20:00', type: 'tentative' },
    ]);
  });

  it('day_off / vacation rows ignore stray blocks', () => {
    const h = buildWorkHours({
      timeZone: CHI,
      template,
      overrides: [
        day('2026-07-07', '2026-07-07', {
          kind: 'day_off',
          blocks: [{ start: '09:00', end: '10:00', type: 'open' }],
        }),
      ],
    });
    expect(getWorkingBlocks(h, '2026-07-07').status).toBe('closed');
  });
});

describe('row validation', () => {
  it('rejects malformed rows', () => {
    expect(() => parseHoursBlocks([{ start: '09:00', end: '17:00', type: 'maybe' }])).toThrow();
    expect(() => parseHoursBlocks([{ start: '17:00', end: '09:00', type: 'open' }])).toThrow();
    expect(() => parseHoursBlocks({})).toThrow();
    expect(parseHoursBlocks(null)).toEqual([]);
    expect(() => buildWorkHours({ timeZone: 'Mars/Olympus', template: [] })).toThrow();
    expect(() =>
      buildWorkHours({ timeZone: CHI, template: [{ weekday: 7, blocks: [], breaks: [] }] }),
    ).toThrow();
    expect(() => getWorkingBlocks(hours, '2026-02-30')).toThrow();
  });
});
