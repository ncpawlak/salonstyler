import { describe, expect, it } from 'vitest';

import {
  dueDates,
  isExpenseCategory,
  monthlyCost,
  nextDueDate,
  nextTaxDue,
  parsePercent,
  taxQuarterFor,
  taxSetAside,
} from './finances.ts';

describe('dueDates', () => {
  it('falls on the last day of shorter months (same as the database)', () => {
    expect(dueDates('monthly', '2031-01-31', '2031-01-01', '2031-05-31')).toEqual([
      '2031-01-31',
      '2031-02-28',
      '2031-03-31',
      '2031-04-30',
      '2031-05-31',
    ]);
    expect(dueDates('monthly', '2031-12-29', '2032-02-01', '2032-03-31')).toEqual([
      '2032-02-29',
      '2032-03-29',
    ]);
  });

  it('repeats weekly from the start date', () => {
    expect(dueDates('weekly', '2031-01-03', '2031-01-05', '2031-01-31')).toEqual([
      '2031-01-10',
      '2031-01-17',
      '2031-01-24',
      '2031-01-31',
    ]);
    expect(dueDates('weekly', '2031-01-03', '2030-12-01', '2031-01-10')).toEqual([
      '2031-01-03',
      '2031-01-10',
    ]);
  });

  it('is empty before the start or for an empty range', () => {
    expect(dueDates('monthly', '2031-06-01', '2031-01-01', '2031-05-31')).toEqual([]);
    expect(dueDates('weekly', '2031-01-01', '2031-02-01', '2031-01-31')).toEqual([]);
  });
});

describe('nextDueDate', () => {
  it('finds the next payment', () => {
    expect(nextDueDate('monthly', '2026-01-01', '2026-11-02')).toBe('2026-12-01');
    expect(nextDueDate('monthly', '2026-01-01', '2026-12-01')).toBe('2026-12-01');
    expect(nextDueDate('weekly', '2026-11-06', '2026-11-10')).toBe('2026-11-13');
    expect(nextDueDate('weekly', '2027-01-01', '2026-11-10')).toBe('2027-01-01');
  });
});

describe('estimated tax', () => {
  it('maps dates to the IRS payment periods', () => {
    expect(taxQuarterFor('2026-02-10')).toMatchObject({ quarter: 1, due: '2026-04-15' });
    expect(taxQuarterFor('2026-05-31')).toMatchObject({ quarter: 2, due: '2026-06-15' });
    expect(taxQuarterFor('2026-06-01')).toMatchObject({ quarter: 3, due: '2026-09-15' });
    expect(taxQuarterFor('2026-12-31')).toMatchObject({
      quarter: 4,
      from: '2026-09-01',
      due: '2027-01-15',
    });
  });

  it('finds the next payment due, including January for last year', () => {
    expect(nextTaxDue('2027-01-10')).toMatchObject({ quarter: 4, year: 2026, due: '2027-01-15' });
    expect(nextTaxDue('2027-01-16')).toMatchObject({ quarter: 1, year: 2027 });
    expect(nextTaxDue('2026-09-15')).toMatchObject({ quarter: 3 });
  });

  it('sets aside a share of profit, nothing on a loss', () => {
    expect(taxSetAside(250_000, 25)).toBe(62_500);
    expect(taxSetAside(2_501, 22.5)).toBe(563);
    expect(taxSetAside(-1_000, 25)).toBe(0);
  });

  it('parses percentages', () => {
    expect(parsePercent('25')).toBe(25);
    expect(parsePercent(' 22.5% ')).toBe(22.5);
    expect(parsePercent('0')).toBe(0);
    expect(parsePercent('61')).toBeNull();
    expect(parsePercent('abc')).toBeNull();
    expect(parsePercent('2.55')).toBeNull();
  });
});

describe('misc', () => {
  it('knows the categories', () => {
    expect(isExpenseCategory('tools')).toBe(true);
    expect(isExpenseCategory('rent')).toBe(false);
  });

  it('turns weekly rent into a monthly figure', () => {
    expect(monthlyCost('weekly', 25_000)).toBe(108_333);
    expect(monthlyCost('monthly', 90_000)).toBe(90_000);
  });
});
