import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';

import {
  handlePaymentsRequest,
  type PaymentsServiceDeps,
  STRIPE_NOT_CONFIGURED_MESSAGE,
  type StripeAccountRecord,
} from './connect.ts';
import type { StripeAccountSnapshot, StripeConnectClient } from './stripe.ts';

const SALON = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const RETURN_URL = 'http://localhost:8081/settings/payments';

function stripeAccount(overrides: Partial<Stripe.Account> = {}): Stripe.Account {
  return {
    id: 'acct_1TestSalonA0001',
    object: 'account',
    country: 'US',
    default_currency: 'usd',
    details_submitted: false,
    charges_enabled: false,
    payouts_enabled: false,
    requirements: {
      currently_due: ['external_account'],
      past_due: [],
      disabled_reason: 'requirements.past_due',
    },
    ...overrides,
  } as Stripe.Account;
}

function mockStripe(account = stripeAccount()) {
  return {
    accounts: {
      create: vi.fn<StripeConnectClient['accounts']['create']>(async () => account),
      retrieve: vi.fn<StripeConnectClient['accounts']['retrieve']>(async () => account),
      createLoginLink: vi.fn<StripeConnectClient['accounts']['createLoginLink']>(async () => ({
        url: 'https://connect.stripe.com/express/login/test',
      })),
    },
    accountLinks: {
      create: vi.fn<StripeConnectClient['accountLinks']['create']>(async () => ({
        url: 'https://connect.stripe.com/setup/e/acct_1TestSalonA0001/test',
        expires_at: 1794243000,
      })),
    },
  } satisfies StripeConnectClient;
}

function setup(
  options: {
    role?: 'owner' | 'stylist' | null;
    stripe?: StripeConnectClient | null;
    saved?: StripeAccountRecord | null;
  } = {},
) {
  let saved = options.saved ?? null;
  const stripe = options.stripe === undefined ? mockStripe() : options.stripe;
  const saveAccount = vi.fn(async (salonId: string, snapshot: StripeAccountSnapshot) => {
    saved = { ...snapshot, salon_id: salonId, updated_at: '2026-11-09T18:00:00Z' };
    return saved;
  });
  const deps: PaymentsServiceDeps = {
    getMemberRole: async () => (options.role === undefined ? 'owner' : options.role),
    getSalonName: async () => 'Salon A',
    loadAccount: async () => saved,
    saveAccount,
    stripe,
  };
  return { deps, stripe, saveAccount, saved: () => saved };
}

const savedRecord = (overrides: Partial<StripeAccountRecord> = {}): StripeAccountRecord => ({
  salon_id: SALON,
  stripe_account_id: 'acct_1TestSalonA0001',
  details_submitted: false,
  charges_enabled: false,
  payouts_enabled: false,
  requirements_due: ['external_account'],
  disabled_reason: null,
  country: 'US',
  default_currency: 'usd',
  updated_at: '2026-11-09T17:00:00Z',
  ...overrides,
});

describe('handlePaymentsRequest: validation and access', () => {
  it('rejects malformed requests', async () => {
    const { deps } = setup();
    const res = await handlePaymentsRequest({ action: 'onboard', salonId: 'nope' }, deps);
    expect(res.status).toBe(400);
  });

  it('rejects non-http return URLs', async () => {
    const { deps } = setup();
    const res = await handlePaymentsRequest(
      { action: 'onboard', salonId: SALON, returnUrl: 'javascript:alert(1)' },
      deps,
    );
    expect(res.status).toBe(400);
  });

  it('rejects non-members', async () => {
    const { deps } = setup({ role: null });
    const res = await handlePaymentsRequest({ action: 'status', salonId: SALON }, deps);
    expect(res).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
  });

  it('only lets owners start onboarding', async () => {
    const { deps, stripe } = setup({ role: 'stylist' });
    const res = await handlePaymentsRequest(
      { action: 'onboard', salonId: SALON, returnUrl: RETURN_URL },
      deps,
    );
    expect(res.status).toBe(403);
    expect(stripe?.accounts.create).not.toHaveBeenCalled();
  });
});

describe('onboard', () => {
  it('explains clearly when Stripe is not configured', async () => {
    const { deps } = setup({ stripe: null });
    const res = await handlePaymentsRequest(
      { action: 'onboard', salonId: SALON, returnUrl: RETURN_URL },
      deps,
    );
    expect(res).toEqual({
      status: 503,
      body: { error: { code: 'stripe_not_configured', message: STRIPE_NOT_CONFIGURED_MESSAGE } },
    });
    expect(STRIPE_NOT_CONFIGURED_MESSAGE).toContain('STRIPE_SECRET_KEY');
  });

  it('creates an Express account once and returns a hosted onboarding link', async () => {
    const { deps, stripe, saved } = setup();
    const res = await handlePaymentsRequest(
      { action: 'onboard', salonId: SALON, returnUrl: RETURN_URL },
      deps,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      url: 'https://connect.stripe.com/setup/e/acct_1TestSalonA0001/test',
    });
    expect(stripe!.accounts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'express',
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        business_profile: expect.objectContaining({ name: 'Salon A', mcc: '7230' }),
        metadata: { salon_id: SALON },
      }),
      { idempotencyKey: `chairside-connect-account-${SALON}` },
    );
    expect(stripe!.accountLinks.create).toHaveBeenCalledWith({
      account: 'acct_1TestSalonA0001',
      type: 'account_onboarding',
      refresh_url: `${RETURN_URL}?stripe=refresh`,
      return_url: `${RETURN_URL}?stripe=return`,
    });
    expect(saved()).toMatchObject({
      salon_id: SALON,
      stripe_account_id: 'acct_1TestSalonA0001',
      requirements_due: ['external_account'],
    });
  });

  it('reuses the existing account to continue onboarding', async () => {
    const { deps, stripe } = setup({ saved: savedRecord() });
    const res = await handlePaymentsRequest(
      { action: 'onboard', salonId: SALON, returnUrl: RETURN_URL },
      deps,
    );
    expect(res.status).toBe(200);
    expect(stripe!.accounts.create).not.toHaveBeenCalled();
    expect(stripe!.accountLinks.create).toHaveBeenCalledOnce();
  });

  it('falls back to the server return URL', async () => {
    const { deps, stripe } = setup();
    deps.defaultReturnUrl = 'https://chairside.app/settings/payments';
    await handlePaymentsRequest({ action: 'onboard', salonId: SALON }, deps);
    expect(stripe!.accountLinks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        return_url: 'https://chairside.app/settings/payments?stripe=return',
      }),
    );
  });

  it('requires some return URL', async () => {
    const { deps } = setup();
    const res = await handlePaymentsRequest({ action: 'onboard', salonId: SALON }, deps);
    expect(res.status).toBe(400);
  });

  it('reports Stripe errors without leaking secrets', async () => {
    const stripe = mockStripe();
    stripe.accounts.create.mockRejectedValue(
      new Error('Invalid API Key provided: sk_test_abcdef123456789'),
    );
    const { deps } = setup({ stripe });
    const res = await handlePaymentsRequest(
      { action: 'onboard', salonId: SALON, returnUrl: RETURN_URL },
      deps,
    );
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('abcdef123456789');
  });
});

describe('status', () => {
  it('returns not_connected without calling Stripe', async () => {
    const { deps, stripe } = setup();
    const res = await handlePaymentsRequest({ action: 'status', salonId: SALON }, deps);
    expect(res).toEqual({
      status: 200,
      body: { configured: true, status: 'not_connected', account: null },
    });
    expect(stripe!.accounts.retrieve).not.toHaveBeenCalled();
  });

  it('works for stylists and when Stripe is not configured', async () => {
    const { deps } = setup({ role: 'stylist', stripe: null, saved: savedRecord() });
    const res = await handlePaymentsRequest({ action: 'status', salonId: SALON }, deps);
    expect(res).toMatchObject({ status: 200, body: { configured: false, status: 'onboarding' } });
  });

  it('re-syncs the account from Stripe and reports Payments enabled', async () => {
    const enabled = stripeAccount({
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
      requirements: { currently_due: [], past_due: [], disabled_reason: null } as never,
    });
    const { deps, saveAccount } = setup({ stripe: mockStripe(enabled), saved: savedRecord() });
    const res = await handlePaymentsRequest({ action: 'status', salonId: SALON }, deps);
    expect(res).toMatchObject({
      status: 200,
      body: { status: 'enabled', account: { charges_enabled: true, payouts_enabled: true } },
    });
    expect(saveAccount).toHaveBeenCalledOnce();
  });
});

describe('dashboard', () => {
  it('needs a submitted account', async () => {
    const { deps } = setup({ saved: savedRecord() });
    const res = await handlePaymentsRequest({ action: 'dashboard', salonId: SALON }, deps);
    expect(res.status).toBe(409);
  });

  it('returns a login link for owners', async () => {
    const { deps } = setup({ saved: savedRecord({ details_submitted: true }) });
    const res = await handlePaymentsRequest({ action: 'dashboard', salonId: SALON }, deps);
    expect(res).toMatchObject({
      status: 200,
      body: { url: 'https://connect.stripe.com/express/login/test' },
    });
  });
});
