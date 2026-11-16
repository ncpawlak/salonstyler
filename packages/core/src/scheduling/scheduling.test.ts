import { describe, expect, it } from 'vitest';

import {
  MENS_CUT,
  NY,
  ROOT_TOUCH_UP,
  appt,
  at,
  weekdayHours,
} from '../availability/test-helpers.ts';
import type { WorkHours } from '../availability/types.ts';
import {
  analyzeHabits,
  defaultStart,
  dueDate,
  formatCadence,
  formatTime12,
  suggestSlots,
} from './index.ts';

const CUT = { segments: MENS_CUT };
const COLOR = { segments: ROOT_TOUCH_UP };
/** Wednesday, after the Monday 2026-04-06 visit. */
const NOW = at('2026-04-08', '12:00');
const visit = (date: string, time = '10:00', status = 'completed') => ({
  startsAt: at(date, time),
  status,
});
/** Every other Monday at 10. */
const BIWEEKLY_MONDAYS = [
  visit('2026-02-23'),
  visit('2026-03-09', '10:15'),
  visit('2026-03-23'),
  visit('2026-04-06', '09:45'),
];
const label = (s: { reasons: { label: string }[] }) => s.reasons.map((r) => r.label);

describe('analyzeHabits', () => {
  it('learns weekday, time of day and cadence', () => {
    expect(analyzeHabits(BIWEEKLY_MONDAYS, NY, { now: NOW })).toEqual({
      visits: 4,
      weekdays: [1],
      usualMinutes: 600,
      timeOfDay: 'morning',
      cadenceDays: 14,
      lastVisitDate: '2026-04-06',
    });
  });

  it('ignores visits that did not happen and future ones for the last visit', () => {
    const habits = analyzeHabits(
      [
        visit('2026-03-30', '10:00', 'cancelled'),
        visit('2026-04-01', '10:00', 'no_show'),
        visit('2026-04-20', '10:00', 'confirmed'),
        ...BIWEEKLY_MONDAYS,
      ],
      NY,
      { now: NOW },
    );
    expect(habits.visits).toBe(5);
    expect(habits.lastVisitDate).toBe('2026-04-06');
    expect(habits.cadenceDays).toBe(14);
  });

  it('finds weekend clients and has no usual time when times vary', () => {
    const habits = analyzeHabits(
      [
        visit('2026-03-07', '09:00'),
        visit('2026-03-14', '15:00'),
        visit('2026-03-28', '11:00'),
        visit('2026-04-02', '18:00'),
      ],
      NY,
    );
    expect(habits.weekdays).toEqual([6]);
    expect(habits.usualMinutes).toBeNull();
    expect(habits.timeOfDay).toBeNull();
  });

  it('needs two visits for any habit', () => {
    expect(analyzeHabits([visit('2026-04-06')], NY)).toMatchObject({
      visits: 1,
      weekdays: [],
      usualMinutes: null,
      cadenceDays: null,
      lastVisitDate: '2026-04-06',
    });
    expect(analyzeHabits([], NY).lastVisitDate).toBeNull();
  });
});

describe('dueDate', () => {
  it('uses the client cadence, then the service rebook interval', () => {
    const habits = analyzeHabits(BIWEEKLY_MONDAYS, NY, { now: NOW });
    expect(dueDate(habits)).toEqual({ date: '2026-04-20', label: 'Every other week' });

    const thin = analyzeHabits([visit('2026-03-02')], NY, { now: NOW });
    expect(dueDate(thin)).toBeNull();
    expect(dueDate(thin, { days: 42, serviceName: 'Color' })).toEqual({
      date: '2026-04-13',
      label: '6 weeks since last color',
    });
  });

  it('formats cadences and times', () => {
    expect(formatCadence(7)).toBe('Every week');
    expect(formatCadence(15)).toBe('Every other week');
    expect(formatCadence(28)).toBe('Every 4 weeks');
    expect(formatCadence(10)).toBe('Every 10 days');
    expect(formatTime12(600)).toBe('10 AM');
    expect(formatTime12(870)).toBe('2:30 PM');
    expect(formatTime12(0)).toBe('12 AM');
  });
});

describe('suggestSlots', () => {
  const hours = weekdayHours();

  it('ranks the usual Monday 10 AM when due first, then the soonest openings', () => {
    const habits = analyzeHabits(BIWEEKLY_MONDAYS, NY, { now: NOW });
    const { suggestions, fits } = suggestSlots({
      service: CUT,
      hours,
      now: NOW,
      habits,
      due: dueDate(habits),
    });
    expect(fits).toBeNull();
    expect(suggestions[0]!.slot).toMatchObject({ localDate: '2026-04-20', localTime: '10:00' });
    expect(label(suggestions[0]!)).toEqual(['Usual Monday 10 AM', 'Every other week']);
    expect(suggestions).toHaveLength(5);
    expect(new Set(suggestions.map((s) => s.slot.localDate)).size).toBe(5);
    const soonest = suggestions.find((s) => label(s).includes('Soonest opening'))!;
    expect(soonest.slot).toMatchObject({ localDate: '2026-04-08', localTime: '12:00' });
  });

  it('works around the calendar: the engine skips taken time and respects minimum notice', () => {
    const habits = analyzeHabits(BIWEEKLY_MONDAYS, NY, { now: NOW });
    const { suggestions } = suggestSlots({
      service: CUT,
      hours,
      now: NOW,
      habits,
      due: dueDate(habits),
      existing: [appt('taken', at('2026-04-20', '09:30'), [['busy', 60]])],
      rules: { leadTimeMinutes: 24 * 60 },
    });
    expect(suggestions[0]!.slot).toMatchObject({ localDate: '2026-04-20', localTime: '10:30' });
    for (const s of suggestions)
      expect(Date.parse(s.slot.start)).toBeGreaterThanOrEqual(Date.parse(NOW) + 24 * 3_600_000);
  });

  it('fits a cut into another client’s processing time', () => {
    // Someone else's color is processing 10:30–11:05; a cut fits inside it.
    const { suggestions } = suggestSlots({
      service: CUT,
      hours: {
        timeZone: NY,
        weekly: { 3: { blocks: [{ start: '10:00', end: '11:30', type: 'open' }] } },
      },
      now: at('2026-04-08', '08:00'),
      existing: [
        appt('color', at('2026-04-08', '10:00'), [
          ['busy', 30],
          ['processing', 35],
          ['style', 25],
        ]),
      ],
      horizonDays: 0,
    });
    expect(suggestions.map((s) => s.slot.localTime)).toEqual(['10:30']);
  });

  it('gives new clients the soonest openings, or the salon’s popular times', () => {
    const plain = suggestSlots({ service: COLOR, hours, now: NOW, limit: 3 });
    expect(plain.suggestions.map((s) => s.slot.localDate)).toEqual([
      '2026-04-08',
      '2026-04-09',
      '2026-04-10',
    ]);
    expect(label(plain.suggestions[0]!)).toEqual(['Soonest opening']);
    expect(label(plain.suggestions[1]!)).toEqual(['Opens soon']);

    const popular = analyzeHabits(
      ['2026-03-07', '2026-03-14', '2026-03-21', '2026-03-28'].map((d) => visit(d, '11:00')),
      NY,
    );
    const { suggestions } = suggestSlots({ service: COLOR, hours, now: NOW, popular, limit: 3 });
    expect(suggestions[0]!.slot).toMatchObject({ localDate: '2026-04-11', localTime: '11:00' });
    expect(label(suggestions[0]!)).toEqual(['Popular Saturday 11 AM']);
  });

  it('fits a request inside its window and time of day', () => {
    const { suggestions, fits } = suggestSlots({
      service: CUT,
      hours,
      now: NOW,
      request: {
        from: '2026-04-13',
        to: '2026-04-19',
        preference: 'morning',
        label: 'Next week, mornings',
      },
    });
    expect(fits).toBe(true);
    const inside = suggestions.filter((s) => label(s).includes('Next week, mornings'));
    expect(inside).toHaveLength(4);
    for (const s of inside) {
      expect(s.slot.localDate >= '2026-04-13' && s.slot.localDate <= '2026-04-19').toBe(true);
      expect(s.slot.localTime < '12:00').toBe(true);
    }
    expect(label(suggestions[4]!)).toEqual(['Near request']);
  });

  it('says when a request does not fit and offers the nearest alternatives', () => {
    const { suggestions, fits } = suggestSlots({
      service: CUT,
      hours,
      now: NOW,
      request: { from: '2026-04-12', to: '2026-04-12', preference: 'morning' },
      limit: 3,
    });
    expect(fits).toBe(false);
    expect(suggestions.map((s) => [s.slot.localDate, s.slot.localTime])).toEqual([
      ['2026-04-11', '09:00'],
      ['2026-04-13', '09:00'],
      ['2026-04-10', '09:00'],
    ]);
    expect(label(suggestions[0]!)).toEqual(['Closest to request']);
  });

  it('labels tentative-hour slots', () => {
    const withTentative: WorkHours = {
      ...hours,
      weekly: {
        ...hours.weekly,
        0: { blocks: [{ start: '10:00', end: '14:00', type: 'tentative' }] },
      },
    };
    const { suggestions, fits } = suggestSlots({
      service: CUT,
      hours: withTentative,
      now: NOW,
      request: { from: '2026-04-12', to: '2026-04-12', label: 'Sunday' },
      limit: 2,
    });
    expect(fits).toBe(true);
    expect(suggestions[0]).toMatchObject({ tentative: true, slot: { localDate: '2026-04-12' } });
    expect(label(suggestions[0]!)).toEqual(['Sunday', 'Tentative hours']);
  });

  it('honours requested weekdays', () => {
    const { suggestions } = suggestSlots({
      service: CUT,
      hours,
      now: NOW,
      request: { from: '2026-04-13', to: '2026-04-30', weekdays: [5], label: 'Fridays' },
      limit: 3,
    });
    expect(suggestions.slice(0, 2).map((s) => s.slot.localDate)).toEqual([
      '2026-04-17',
      '2026-04-24',
    ]);
  });
});

describe('defaultStart', () => {
  const hours = weekdayHours();

  it('is the next grid time inside work hours', () => {
    expect(defaultStart({ hours, now: at('2026-04-08', '10:07') })).toBe(
      Date.parse(at('2026-04-08', '10:15')),
    );
    expect(defaultStart({ hours, now: at('2026-04-08', '07:00') })).toBe(
      Date.parse(at('2026-04-08', '09:00')),
    );
  });

  it('moves past closing to the next working day, honouring notice', () => {
    expect(defaultStart({ hours, now: at('2026-04-08', '21:30') })).toBe(
      Date.parse(at('2026-04-09', '09:00')),
    );
    expect(
      defaultStart({
        hours,
        now: at('2026-04-08', '16:00'),
        leadTimeMinutes: 120,
        gridMinutes: 30,
      }),
    ).toBe(Date.parse(at('2026-04-09', '09:00')));
    // Saturday evening → Monday (Sunday closed).
    expect(defaultStart({ hours, now: at('2026-04-11', '18:00') })).toBe(
      Date.parse(at('2026-04-13', '09:00')),
    );
  });

  it('opens a future day at opening, or 10 AM when closed', () => {
    expect(defaultStart({ hours, date: '2026-04-15', now: NOW })).toBe(
      Date.parse(at('2026-04-15', '09:00')),
    );
    expect(defaultStart({ hours, date: '2026-04-12', now: NOW })).toBe(
      Date.parse(at('2026-04-12', '10:00')),
    );
  });
});
