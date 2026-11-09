import { describe, expect, it } from 'vitest';

import {
  formatAmount,
  PAYMENTS_STATUS_INFO,
  paymentsStatus,
  requirementLabel,
  type StripeAccountState,
} from './status.ts';

const account = (overrides: Partial<StripeAccountState> = {}): StripeAccountState => ({
  stripe_account_id: 'acct_1',
  details_submitted: false,
  charges_enabled: false,
  payouts_enabled: false,
  requirements_due: [],
  disabled_reason: null,
  ...overrides,
});

describe('paymentsStatus', () => {
  it.each([
    [null, 'not_connected'],
    [account(), 'onboarding'],
    [
      account({ details_submitted: true, requirements_due: ['external_account'] }),
      'action_required',
    ],
    [account({ details_submitted: true }), 'in_review'],
    [account({ details_submitted: true, charges_enabled: true }), 'in_review'],
    [account({ details_submitted: true, charges_enabled: true, payouts_enabled: true }), 'enabled'],
  ] as const)('%o -> %s', (input, expected) => {
    expect(paymentsStatus(input)).toBe(expected);
  });

  it('labels the enabled state exactly as the acceptance criteria say', () => {
    expect(PAYMENTS_STATUS_INFO.enabled.label).toBe('Payments enabled');
  });
});

describe('requirementLabel', () => {
  it('uses friendly labels and humanizes unknown keys', () => {
    expect(requirementLabel('external_account')).toBe('Bank account');
    expect(requirementLabel('individual.verification.document')).toBe('ID document');
    expect(requirementLabel('company.tax_id')).toBe('Tax id');
  });
});

describe('formatAmount', () => {
  it('formats minor units', () => {
    expect(formatAmount(18500, 'usd', 'en-US')).toBe('$185.00');
    expect(formatAmount(500, 'jpy', 'en-US')).toBe('¥500');
  });
});
