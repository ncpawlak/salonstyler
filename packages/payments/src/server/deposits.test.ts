import type Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkoutExpiry,
  handleDepositsRequest,
  type DepositPayPage,
  type DepositRecord,
  type DepositsServiceDeps,
} from './deposits.ts';
import type { StripeClient } from './stripe.ts';
import type { PaymentUpsert } from './webhook.ts';

const SALON = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const APPT = '0b5f2a4e-1c3d-4e5f-9a8b-7c6d5e4f3a2b';
const DEPOSIT = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const TOKEN = 'a'.repeat(64);
const ACCOUNT = 'acct_1TestSalonA0001';
const NOW = new Date('2026-11-10T12:00:00Z');

function makeDeps() {
  const deposit: DepositRecord = {
    id: DEPOSIT,
    salon_id: SALON,
    appointment_id: APPT,
    status: 'pending',
    amount_cents: 5000,
    refunded_cents: 0,
    currency: 'usd',
    stripe_checkout_session_id: null,
    stripe_payment_intent_id: null,
  };
  const page: DepositPayPage = {
    depositId: DEPOSIT,
    status: 'pending',
    amountCents: 5000,
    currency: 'usd',
    salonName: 'Studio A',
    salonSlug: 'studio-a',
    timezone: 'America/Chicago',
    appointmentStatus: 'held',
    startsAt: '2026-11-20T15:00:00Z',
    holdExpiresAt: '2026-11-10T12:45:00Z',
    services: 'Color',
    windowHours: 24,
    freeUntil: '2026-11-19T15:00:00Z',
  };
  const payments: PaymentUpsert[] = [];
  const stripe = {
    checkout: {
      sessions: {
        create: vi.fn(async () => ({ id: 'cs_test_1', url: 'https://checkout.stripe.test/cs_1' })),
        retrieve: vi.fn(async (): Promise<Partial<Stripe.Checkout.Session>> => ({
          id: 'cs_test_1',
          status: 'complete',
          payment_status: 'paid',
          livemode: false,
          customer: 'cus_1',
          payment_intent: {
            id: 'pi_dep_1',
            payment_method: 'pm_1',
            latest_charge: 'ch_1',
            amount_received: 5000,
          } as Stripe.PaymentIntent,
        })),
      },
    },
    refunds: {
      create: vi.fn(async (params: Stripe.RefundCreateParams) => ({
        id: 're_1',
        amount: params.amount ?? 0,
        charge: 'ch_1',
      })),
    },
  };
  const deps: DepositsServiceDeps = {
    loadPage: vi.fn(async (token: string) => (token === TOKEN ? { ...page } : null)),
    loadDeposit: vi.fn(async (id: string) => (id === DEPOSIT ? { ...deposit } : null)),
    loadAccount: vi.fn(async () => ({ stripe_account_id: ACCOUNT, charges_enabled: true })),
    setCheckoutSession: vi.fn(async (_id: string, sessionId: string) => {
      deposit.stripe_checkout_session_id = sessionId;
    }),
    markPaid: vi.fn(async (_id: string, pi: string) => {
      deposit.status = page.appointmentStatus === 'held' ? 'paid' : 'refund_due';
      deposit.stripe_payment_intent_id = pi;
      page.status = deposit.status;
      page.appointmentStatus = deposit.status === 'paid' ? 'confirmed' : page.appointmentStatus;
      return { ...deposit };
    }),
    markRefunded: vi.fn(async (_id: string, cents: number) => {
      deposit.status = 'refunded';
      deposit.refunded_cents = cents;
      return { ...deposit };
    }),
    upsertPayment: vi.fn(async (row: PaymentUpsert) => {
      payments.push(row);
    }),
    getMemberRole: vi.fn(async () => 'owner' as const),
    isServiceRole: false,
    stripe: stripe as unknown as StripeClient,
    webBaseUrl: 'https://app.chairside.test',
    now: () => NOW,
  };
  return { deps, deposit, page, payments, stripe };
}

let ctx: ReturnType<typeof makeDeps>;
beforeEach(() => {
  ctx = makeDeps();
});

describe('page', () => {
  it('shows the deposit and whether Stripe is ready', async () => {
    const res = await handleDepositsRequest({ action: 'page', token: TOKEN }, ctx.deps);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: { amountCents: 5000 }, stripeReady: true });
  });

  it('works without Stripe (stripeReady false)', async () => {
    ctx.deps.stripe = null;
    const res = await handleDepositsRequest({ action: 'page', token: TOKEN }, ctx.deps);
    expect(res.body).toMatchObject({ stripeReady: false });
  });

  it('rejects malformed and unknown tokens', async () => {
    expect((await handleDepositsRequest({ action: 'page', token: 'x' }, ctx.deps)).status).toBe(
      400,
    );
    expect(
      (await handleDepositsRequest({ action: 'page', token: 'b'.repeat(64) }, ctx.deps)).status,
    ).toBe(404);
  });
});

describe('start', () => {
  const start = { action: 'start', token: TOKEN, returnUrl: 'https://app.chairside.test/pay/x' };

  it('creates a destination-charge Checkout Session that saves the card', async () => {
    const res = await handleDepositsRequest(start, ctx.deps);
    expect(res).toEqual({ status: 200, body: { url: 'https://checkout.stripe.test/cs_1' } });
    const calls = ctx.stripe.checkout.sessions.create.mock.calls as unknown as [
      Stripe.Checkout.SessionCreateParams,
    ][];
    const params = calls[0]![0];
    expect(params).toMatchObject({
      mode: 'payment',
      customer_creation: 'always',
      payment_intent_data: {
        on_behalf_of: ACCOUNT,
        transfer_data: { destination: ACCOUNT },
        setup_future_usage: 'off_session',
        metadata: { purpose: 'deposit', deposit_id: DEPOSIT, appointment_id: APPT },
      },
      success_url: 'https://app.chairside.test/pay/x?paid=1',
      // Follows the 45-minute hold.
      expires_at: Math.floor(Date.parse('2026-11-10T12:45:00Z') / 1000),
    });
    expect(params.line_items?.[0]?.price_data).toMatchObject({
      currency: 'usd',
      unit_amount: 5000,
    });
    expect(ctx.deposit.stripe_checkout_session_id).toBe('cs_test_1');
  });

  it('reuses an open session', async () => {
    ctx.deposit.stripe_checkout_session_id = 'cs_test_1';
    ctx.stripe.checkout.sessions.retrieve.mockResolvedValueOnce({
      status: 'open',
      url: 'https://checkout.stripe.test/existing',
    } as never);
    const res = await handleDepositsRequest(start, ctx.deps);
    expect(res.body).toEqual({ url: 'https://checkout.stripe.test/existing' });
    expect(ctx.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('returns 503 when Stripe is not configured', async () => {
    ctx.deps.stripe = null;
    const res = await handleDepositsRequest(start, ctx.deps);
    expect(res).toMatchObject({ status: 503, body: { error: { code: 'stripe_not_configured' } } });
  });

  it('refuses released holds and foreign return URLs', async () => {
    ctx.page.appointmentStatus = 'cancelled';
    expect((await handleDepositsRequest(start, ctx.deps)).status).toBe(409);
    ctx.page.appointmentStatus = 'held';
    const evil = { ...start, returnUrl: 'https://evil.test/pay' };
    expect((await handleDepositsRequest(evil, ctx.deps)).status).toBe(400);
  });
});

describe('status', () => {
  it('records a paid session and the payment row', async () => {
    ctx.deposit.stripe_checkout_session_id = 'cs_test_1';
    const res = await handleDepositsRequest({ action: 'status', token: TOKEN }, ctx.deps);
    expect(ctx.deps.markPaid).toHaveBeenCalledWith(DEPOSIT, 'pi_dep_1', 'cus_1', 'pm_1');
    expect(ctx.payments[0]).toMatchObject({
      stripe_payment_intent_id: 'pi_dep_1',
      appointment_id: APPT,
      amount_cents: 5000,
      status: 'succeeded',
      stripe_account_id: ACCOUNT,
    });
    expect(res.body).toMatchObject({ page: { status: 'paid', appointmentStatus: 'confirmed' } });
    expect(ctx.stripe.refunds.create).not.toHaveBeenCalled();
  });

  it('refunds at once when the hold was released before payment', async () => {
    ctx.deposit.stripe_checkout_session_id = 'cs_test_1';
    ctx.page.appointmentStatus = 'cancelled';
    await handleDepositsRequest({ action: 'status', token: TOKEN }, ctx.deps);
    expect(ctx.stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: 'pi_dep_1', amount: 5000, reverse_transfer: true }),
      expect.anything(),
    );
    expect(ctx.deposit.status).toBe('refunded');
  });

  it('does nothing while unpaid', async () => {
    const res = await handleDepositsRequest({ action: 'status', token: TOKEN }, ctx.deps);
    expect(res.status).toBe(200);
    expect(ctx.deps.markPaid).not.toHaveBeenCalled();
  });
});

describe('refund', () => {
  beforeEach(() => {
    ctx.deposit.status = 'refund_due';
    ctx.deposit.stripe_payment_intent_id = 'pi_dep_1';
  });

  it('refunds a refund_due deposit for any member', async () => {
    ctx.deps.getMemberRole = vi.fn(async () => 'stylist' as const);
    const res = await handleDepositsRequest({ action: 'refund', depositId: DEPOSIT }, ctx.deps);
    expect(res).toMatchObject({
      status: 200,
      body: { deposit: { status: 'refunded', refunded_cents: 5000 }, refundId: 're_1' },
    });
  });

  it('only owners refund a paid or kept deposit', async () => {
    ctx.deposit.status = 'kept';
    ctx.deps.getMemberRole = vi.fn(async () => 'stylist' as const);
    expect(
      (await handleDepositsRequest({ action: 'refund', depositId: DEPOSIT }, ctx.deps)).status,
    ).toBe(403);
    ctx.deps.getMemberRole = vi.fn(async () => 'owner' as const);
    const res = await handleDepositsRequest(
      { action: 'refund', depositId: DEPOSIT, amountCents: 2000 },
      ctx.deps,
    );
    expect(res.status).toBe(200);
    expect(ctx.deps.markRefunded).toHaveBeenCalledWith(DEPOSIT, 2000, 'salon_refund');
  });

  it('hides deposits from non-members but trusts the service role', async () => {
    ctx.deps.getMemberRole = vi.fn(async () => null);
    expect(
      (await handleDepositsRequest({ action: 'refund', depositId: DEPOSIT }, ctx.deps)).status,
    ).toBe(404);
    ctx.deps.isServiceRole = true;
    expect(
      (await handleDepositsRequest({ action: 'refund', depositId: DEPOSIT }, ctx.deps)).status,
    ).toBe(200);
  });

  it('refuses deposits with nothing to refund', async () => {
    ctx.deposit.status = 'pending';
    expect(
      (await handleDepositsRequest({ action: 'refund', depositId: DEPOSIT }, ctx.deps)).status,
    ).toBe(409);
  });
});

describe('checkoutExpiry', () => {
  it('stays within Stripe’s 30 minutes to 24 hours', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    const s = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    expect(checkoutExpiry('2026-11-10T12:10:00Z', now)).toBe(s('2026-11-10T12:31:00Z'));
    expect(checkoutExpiry('2026-11-10T20:00:00Z', now)).toBe(s('2026-11-10T20:00:00Z'));
    expect(checkoutExpiry('2026-11-13T12:00:00Z', now)).toBe(s('2026-11-11T11:30:00Z'));
    expect(checkoutExpiry(null, now)).toBe(s('2026-11-11T11:30:00Z'));
  });
});
