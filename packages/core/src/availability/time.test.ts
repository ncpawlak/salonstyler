import { describe, expect, it } from 'vitest';
import { mergeIntervals, subtractIntervals } from './intervals';
import {
  addDays,
  parseClock,
  parseLocalDate,
  weekday,
  zoneOffset,
  zonedParts,
  zonedToUtc,
} from './time';

const iso = (ms: number) => new Date(ms).toISOString();

describe('time zone conversion', () => {
  it('converts wall-clock times in standard and daylight time', () => {
    expect(iso(zonedToUtc({ year: 2026, month: 3, day: 6 }, 9 * 60, 'America/New_York'))).toBe(
      '2026-03-06T14:00:00.000Z',
    );
    expect(iso(zonedToUtc({ year: 2026, month: 3, day: 9 }, 9 * 60, 'America/New_York'))).toBe(
      '2026-03-09T13:00:00.000Z',
    );
  });

  it('shifts nonexistent spring-forward times forward (02:30 → 03:30 EDT)', () => {
    expect(iso(zonedToUtc({ year: 2026, month: 3, day: 8 }, 150, 'America/New_York'))).toBe(
      '2026-03-08T07:30:00.000Z',
    );
  });

  it('resolves ambiguous fall-back times to the earlier instant', () => {
    expect(iso(zonedToUtc({ year: 2026, month: 11, day: 1 }, 90, 'America/New_York'))).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('handles half-hour offsets and 24:00', () => {
    expect(iso(zonedToUtc({ year: 2026, month: 3, day: 6 }, 9 * 60, 'Asia/Kolkata'))).toBe(
      '2026-03-06T03:30:00.000Z',
    );
    expect(iso(zonedToUtc({ year: 2026, month: 3, day: 6 }, 24 * 60, 'UTC'))).toBe(
      '2026-03-07T00:00:00.000Z',
    );
  });

  it('round-trips through zonedParts', () => {
    const ms = Date.parse('2026-07-04T18:45:00Z');
    expect(zonedParts(ms, 'America/Los_Angeles')).toEqual({
      year: 2026,
      month: 7,
      day: 4,
      minutes: 11 * 60 + 45,
    });
    expect(zoneOffset(ms, 'America/Los_Angeles')).toBe(-7 * 3_600_000);
  });

  it('does date math and validation', () => {
    expect(addDays(parseLocalDate('2026-02-28'), 1)).toEqual({ year: 2026, month: 3, day: 1 });
    expect(weekday(parseLocalDate('2026-03-06'))).toBe(5);
    expect(() => parseLocalDate('2026-02-30')).toThrow();
    expect(() => parseClock('25:00')).toThrow();
    expect(() => parseClock('9:00')).toThrow();
    expect(parseClock('24:00')).toBe(1440);
  });
});

describe('interval math', () => {
  it('merges overlapping and touching intervals', () => {
    expect(
      mergeIntervals([
        { start: 5, end: 8 },
        { start: 0, end: 2 },
        { start: 2, end: 4 },
        { start: 7, end: 9 },
        { start: 3, end: 3 },
      ]),
    ).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 9 },
    ]);
  });

  it('subtracts', () => {
    expect(
      subtractIntervals(
        [{ start: 0, end: 10 }],
        [
          { start: 2, end: 3 },
          { start: 8, end: 12 },
          { start: -5, end: 1 },
        ],
      ),
    ).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 8 },
    ]);
    expect(subtractIntervals([{ start: 0, end: 10 }], [{ start: 0, end: 10 }])).toEqual([]);
  });
});
