import { describe, expect, it } from 'vitest';

import {
  cancellationOutcome,
  depositForServices,
  depositStatusLabel,
  policySummary,
  serviceDepositCents,
  validateServiceDeposit,
} from './index.ts';

describe('serviceDepositCents', () => {
  it('handles none, flat and percent', () => {
    expect(serviceDepositCents({ depositKind: 'none', depositValue: 0, priceCents: 5000 })).toBe(0);
    expect(serviceDepositCents({ depositKind: 'flat', depositValue: 1500, priceCents: 5000 })).toBe(
      1500,
    );
    expect(
      serviceDepositCents({ depositKind: 'percent', depositValue: 25, priceCents: 20000 }),
    ).toBe(5000);
  });

  it('rounds percent deposits and treats unpriced services as 0', () => {
    expect(serviceDepositCents({ depositKind: 'percent', depositValue: 33, priceCents: 999 })).toBe(
      330,
    );
    expect(
      serviceDepositCents({ depositKind: 'percent', depositValue: 50, priceCents: null }),
    ).toBe(0);
  });
});

describe('depositForServices', () => {
  it('sums the services (matches the SQL test: 25% of $200 + $15)', () => {
    expect(
      depositForServices([
        { depositKind: 'percent', depositValue: 25, priceCents: 20000 },
        { depositKind: 'flat', depositValue: 1500, priceCents: 0 },
        { depositKind: 'none', depositValue: 0, priceCents: 3000 },
      ]),
    ).toBe(6500);
  });

  it('skips deposits below the card minimum', () => {
    expect(
      depositForServices([{ depositKind: 'percent', depositValue: 1, priceCents: 3000 }]),
    ).toBe(0);
    expect(depositForServices([])).toBe(0);
  });
});

describe('validateServiceDeposit', () => {
  it('accepts valid settings', () => {
    expect(validateServiceDeposit('none', 0)).toBeNull();
    expect(validateServiceDeposit('flat', 50)).toBeNull();
    expect(validateServiceDeposit('percent', 100)).toBeNull();
  });

  it('rejects out-of-range values', () => {
    expect(validateServiceDeposit('flat', 49)).toMatch(/at least/);
    expect(validateServiceDeposit('percent', 0)).toMatch(/1–100/);
    expect(validateServiceDeposit('percent', 101)).toMatch(/1–100/);
    expect(validateServiceDeposit('flat', 10.5)).toMatch(/whole/);
  });
});

describe('cancellationOutcome', () => {
  const startsAt = '2026-12-01T15:00:00Z';

  it('refunds a paid deposit when cancelled before the window', () => {
    const q = cancellationOutcome({
      startsAt,
      now: new Date('2026-11-29T15:00:00Z'),
      windowHours: 24,
      depositStatus: 'paid',
    });
    expect(q).toEqual({
      freeUntil: new Date('2026-11-30T15:00:00Z'),
      late: false,
      outcome: 'refund',
    });
  });

  it('keeps it inside the window (the boundary counts as late)', () => {
    expect(
      cancellationOutcome({
        startsAt,
        now: new Date('2026-11-30T15:00:00Z'),
        windowHours: 24,
        depositStatus: 'paid',
      }).outcome,
    ).toBe('keep');
  });

  it('is free when nothing was paid', () => {
    for (const depositStatus of [null, 'pending', 'refunded', 'kept'] as const) {
      expect(
        cancellationOutcome({
          startsAt,
          now: new Date('2026-12-01T14:00:00Z'),
          windowHours: 24,
          depositStatus,
        }).outcome,
      ).toBe('free');
    }
  });
});

describe('labels', () => {
  it('summarises the policy', () => {
    expect(policySummary(24)).toMatch(/up to 24 hours before/);
    expect(policySummary(1)).toMatch(/up to 1 hour before/);
    expect(policySummary(72)).toMatch(/up to 3 days before/);
    expect(policySummary(0)).toMatch(/any time before/);
  });

  it('labels statuses', () => {
    expect(depositStatusLabel('refund_due')).toBe('Refund due');
  });
});
