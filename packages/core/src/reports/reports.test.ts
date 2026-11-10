import { describe, expect, it } from 'vitest';
import {
  bucketSeries,
  chunkRange,
  comparisonRange,
  granularityFor,
  namedRange,
  percentChange,
  periodRange,
  rangeDays,
  share,
} from './reports.ts';

describe('periodRange', () => {
  // 2026-11-18 is a Wednesday.
  it('finds the week, month, quarter and year containing a date', () => {
    expect(periodRange('week', '2026-11-18')).toEqual({ from: '2026-11-15', to: '2026-11-21' });
    expect(periodRange('week', '2026-11-18', 0, 1)).toEqual({
      from: '2026-11-16',
      to: '2026-11-22',
    });
    expect(periodRange('month', '2026-11-18')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(periodRange('quarter', '2026-11-18')).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(periodRange('year', '2026-11-18')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });

  it('shifts across year boundaries and handles leap February', () => {
    expect(periodRange('month', '2026-01-10', -1)).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
    expect(periodRange('quarter', '2026-02-10', -1)).toEqual({
      from: '2025-10-01',
      to: '2025-12-31',
    });
    expect(periodRange('month', '2028-03-05', -1)).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
    expect(periodRange('week', '2026-01-01', -1)).toEqual({ from: '2025-12-21', to: '2025-12-27' });
  });
});

describe('namedRange / comparisonRange', () => {
  it('resolves "last month" against today', () => {
    expect(namedRange('last_month', '2026-11-18')).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
      period: 'month',
    });
    expect(namedRange('this_year', '2026-11-18').from).toBe('2026-01-01');
  });

  it('compares calendar periods with the previous one and custom ranges with the days before', () => {
    expect(comparisonRange('month', { from: '2026-03-01', to: '2026-03-31' })).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(comparisonRange('custom', { from: '2026-03-10', to: '2026-03-16' })).toEqual({
      from: '2026-03-03',
      to: '2026-03-09',
    });
  });
});

describe('chunkRange', () => {
  it('covers a year in ≤62-day pieces with no gaps or overlap', () => {
    const chunks = chunkRange({ from: '2026-01-01', to: '2026-12-31' });
    expect(chunks.every((c) => rangeDays(c) <= 62)).toBe(true);
    expect(chunks.reduce((n, c) => n + rangeDays(c), 0)).toBe(365);
    expect(chunks[0]?.from).toBe('2026-01-01');
    expect(chunks.at(-1)?.to).toBe('2026-12-31');
  });

  it('keeps short ranges whole', () => {
    expect(chunkRange({ from: '2026-05-01', to: '2026-05-01' })).toEqual([
      { from: '2026-05-01', to: '2026-05-01' },
    ]);
  });
});

describe('bucketSeries', () => {
  const daily = [
    { date: '2026-10-30', salesCents: 100, checkouts: 1 },
    { date: '2026-10-31', salesCents: 200, checkouts: 2 },
    { date: '2026-11-01', salesCents: 400, checkouts: 1 },
  ];

  it('sums by month and by Sunday-start week, preserving totals', () => {
    expect(bucketSeries(daily, 'month', ['salesCents', 'checkouts'])).toEqual([
      { date: '2026-10-01', salesCents: 300, checkouts: 3 },
      { date: '2026-11-01', salesCents: 400, checkouts: 1 },
    ]);
    expect(bucketSeries(daily, 'week', ['salesCents'])).toEqual([
      { date: '2026-10-25', salesCents: 300 },
      { date: '2026-11-01', salesCents: 400 },
    ]);
  });

  it('picks a granularity readable on a phone', () => {
    expect(granularityFor({ from: '2026-10-01', to: '2026-10-31' })).toBe('day');
    expect(granularityFor({ from: '2026-10-01', to: '2026-12-31' })).toBe('week');
    expect(granularityFor({ from: '2026-01-01', to: '2026-12-31' })).toBe('month');
  });
});

describe('percentChange / share', () => {
  it('returns null without a base', () => {
    expect(percentChange(120, 100)).toBeCloseTo(0.2);
    expect(percentChange(50, 100)).toBeCloseTo(-0.5);
    expect(percentChange(5, 0)).toBeNull();
    expect(share(1, 4)).toBe(0.25);
    expect(share(1, 0)).toBeNull();
  });
});
