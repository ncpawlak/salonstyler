import { describe, expect, it } from 'vitest';
import {
  EARLY_NOW,
  FRI,
  MENS_CUT,
  NY,
  ROOT_TOUCH_UP,
  appt,
  at,
  weekdayHours,
} from '../availability/test-helpers.ts';
import {
  DEFAULT_REBOOK_DAYS,
  formatRebookInterval,
  learnClientInterval,
  rebookInterval,
  rebookTargetDate,
  suggestRebookSlots,
  typicalRebookDays,
} from './index.ts';

describe('typicalRebookDays', () => {
  it.each([
    ["Men's cut", 'Cuts', 21],
    ['Beard trim', 'Cuts', 21],
    ['Bang/fringe trim', 'Cuts', 21],
    ["Women's cut & style", 'Cuts', 42],
    ["Kids' cut", 'Cuts', 42],
    ['Root touch-up', 'Color', 28],
    ['All-over color', 'Color', 42],
    ['Toner / gloss', 'Color', 42],
    ['Full highlights', 'Color', 56],
    ['Balayage', 'Color', 84],
    ['Keratin / smoothing', 'Treatments', 84],
    ['Deep conditioning', 'Treatments', 28],
    ['Blowout', 'Styling', 7],
  ])('%s → %i days', (name, category, days) => {
    expect(typicalRebookDays({ name, category })).toBe(days);
  });

  it.each([
    ['Consultation', 'Other'],
    ['Bridal trial', 'Styling'],
    ['Updo / special occasion', 'Styling'],
    ['Color correction', 'Color'],
    ['Something custom', null],
  ])('%s is a one-off', (name, category) => {
    expect(typicalRebookDays({ name, category })).toBeNull();
  });
});

describe('learnClientInterval', () => {
  const visit = (date: string, ...serviceIds: string[]) => ({
    startsAt: at(date, '10:00'),
    serviceIds,
  });

  it('needs two visits with the service', () => {
    expect(learnClientInterval([visit('2026-01-02', 'color')], 'color')).toBeNull();
    expect(
      learnClientInterval([visit('2026-01-02', 'cut'), visit('2026-02-02', 'cut')], 'color'),
    ).toBeNull();
  });

  it('takes the median of the most recent gaps', () => {
    const visits = [
      visit('2025-01-01', 'color'), // 100-day gap, dropped as older than the last 4
      visit('2025-04-11', 'color'),
      visit('2025-05-16', 'color', 'cut'), // 35
      visit('2025-06-20', 'color'), // 35
      visit('2025-08-08', 'color'), // 49
      visit('2025-09-12', 'cut'),
      visit('2025-09-26', 'color'), // 49
    ];
    expect(learnClientInterval(visits, 'color')).toEqual({ days: 42, samples: 4 });
  });

  it('ignores fix-ups within a week and gaps over a year', () => {
    const visits = [
      visit('2024-01-05', 'color'),
      visit('2025-03-07', 'color'), // > 365
      visit('2025-03-10', 'color'), // 3-day fix
      visit('2025-04-21', 'color'), // 42
      visit('2025-04-21', 'color'), // same day
    ];
    expect(learnClientInterval(visits, 'color')).toEqual({ days: 42, samples: 1 });
  });
});

describe('rebookInterval', () => {
  const cut = { id: 'cut', name: "Women's cut & style", category: 'Cuts' };
  const color = { id: 'color', name: 'All-over color', category: 'Color' };
  const consult = { id: 'consult', name: 'Consultation', category: 'Other' };

  it('follows the longest service on the visit', () => {
    const balayage = { id: 'b', name: 'Balayage', category: 'Color' };
    expect(rebookInterval([cut, balayage])).toMatchObject({
      serviceId: 'b',
      days: 84,
      source: 'typical',
    });
  });

  it("prefers the client's history, then the owner's setting", () => {
    const set = { ...color, rebookIntervalDays: 35 };
    expect(rebookInterval([set])).toMatchObject({ days: 35, source: 'service' });
    const history = [
      { startsAt: at('2025-01-02', '10:00'), serviceIds: ['color'] },
      { startsAt: at('2025-02-20', '10:00'), serviceIds: ['color'] },
    ];
    expect(rebookInterval([set], history)).toMatchObject({
      days: 49,
      source: 'client',
      samples: 1,
    });
  });

  it('falls back to six weeks, or null with nothing booked', () => {
    expect(rebookInterval([consult])).toMatchObject({
      serviceId: 'consult',
      days: DEFAULT_REBOOK_DAYS,
      source: 'default',
    });
    expect(rebookInterval([])).toBeNull();
  });
});

describe('rebookTargetDate / formatRebookInterval', () => {
  it('keeps the weekday from two weeks out', () => {
    expect(rebookTargetDate(at(FRI, '10:00'), 42, NY)).toBe('2026-04-17');
    expect(rebookTargetDate(at(FRI, '10:00'), 45, NY)).toBe('2026-04-17');
    expect(rebookTargetDate(at(FRI, '10:00'), 46, NY)).toBe('2026-04-24');
    expect(rebookTargetDate(at(FRI, '10:00'), 10, NY)).toBe('2026-03-16');
  });

  it('uses the local date of the visit', () => {
    // 21:30 New York on Friday is already Saturday in UTC.
    expect(rebookTargetDate(at(FRI, '21:30'), 7, NY)).toBe('2026-03-13');
  });

  it('formats', () => {
    expect(formatRebookInterval(42)).toBe('~6 weeks');
    expect(formatRebookInterval(7)).toBe('1 week');
    expect(formatRebookInterval(10)).toBe('10 days');
  });
});

describe('suggestRebookSlots', () => {
  const base = {
    service: { segments: ROOT_TOUCH_UP },
    hours: weekdayHours(),
    visitStart: at(FRI, '10:00'),
    intervalDays: 42,
    now: EARLY_NOW,
  };

  it('offers the due date at the usual time first, one slot per day', () => {
    const { targetDate, slots } = suggestRebookSlots({ ...base, existing: [] });
    expect(targetDate).toBe('2026-04-17');
    expect(slots).toHaveLength(3);
    expect(slots[0]).toMatchObject({ localDate: '2026-04-17', matchesPreference: true });
    expect(new Set(slots.map((s) => s.localDate)).size).toBe(3);
    for (const s of slots) expect(s.matchesPreference).toBe(true);
  });

  it('suggests the same time of day, not the earliest time in the window', () => {
    const { slots } = suggestRebookSlots({ ...base, visitStart: at(FRI, '14:00'), existing: [] });
    for (const s of slots) expect(s.start).toBe(at(s.localDate, '14:00'));
  });

  it('keeps the usual time over the exact day when the morning is taken', () => {
    const existing = [appt('a', at('2026-04-17', '09:00'), [['busy', 180]])];
    const { slots } = suggestRebookSlots({ ...base, existing });
    expect(slots).toHaveLength(3);
    for (const s of slots) {
      expect(s.localDate).not.toBe('2026-04-17');
      expect(s.matchesPreference).toBe(true);
    }
  });

  it('moves to a later week when the due week is full', () => {
    const existing = ['13', '14', '15', '16', '17', '18', '19', '20'].map((d) =>
      appt(`full-${d}`, at(`2026-04-${d}`, '09:00'), [['busy', 8 * 60]]),
    );
    const { targetDate, slots } = suggestRebookSlots({
      ...base,
      service: { segments: MENS_CUT },
      existing,
    });
    expect(targetDate).toBe('2026-04-17');
    expect(slots[0]!.localDate >= '2026-04-21').toBe(true);
  });

  it('returns nothing when there are no hours', () => {
    const { slots } = suggestRebookSlots({
      ...base,
      hours: { timeZone: NY, weekly: {} },
      existing: [],
      extraWeeks: 1,
    });
    expect(slots).toEqual([]);
  });
});
