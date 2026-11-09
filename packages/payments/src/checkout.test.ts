import { describe, expect, it } from 'vitest';

import { cardLabel, checkoutTotals, parseAmountInput, tipForPercent } from './checkout.ts';

describe('checkoutTotals', () => {
  it('adds lines and tip, and takes off the deposit', () => {
    expect(
      checkoutTotals(
        [
          { quantity: 1, unitAmountCents: 12000 },
          { quantity: 2, unitAmountCents: 2500 },
        ],
        3400,
        5000,
      ),
    ).toEqual({ subtotalCents: 17000, tipCents: 3400, depositCents: 5000, amountDueCents: 15400 });
  });

  it('never goes below zero when the deposit covers everything', () => {
    expect(checkoutTotals([{ quantity: 1, unitAmountCents: 2000 }], 0, 5000).amountDueCents).toBe(
      0,
    );
  });
});

describe('tipForPercent', () => {
  it('rounds to whole cents', () => {
    expect(tipForPercent(16500, 20)).toBe(3300);
    expect(tipForPercent(1999, 15)).toBe(300);
  });
});

describe('parseAmountInput', () => {
  it.each([
    ['12', 1200],
    ['12.5', 1250],
    ['$12.50', 1250],
    ['12,05', 1205],
    ['0', 0],
  ])('%s -> %i', (text, cents) => {
    expect(parseAmountInput(text)).toBe(cents);
  });

  it.each(['', 'abc', '1.234', '1.2.3'])('rejects %j', (text) => {
    expect(parseAmountInput(text)).toBeNull();
  });
});

describe('cardLabel', () => {
  it('masks the card', () => {
    expect(cardLabel('visa', '4242')).toBe('Visa •••• 4242');
    expect(cardLabel('amex', null)).toBe('Amex');
    expect(cardLabel(null, null)).toBe('Card');
  });
});
