import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Stripe from 'stripe';
import { beforeEach, describe, expect, it } from 'vitest';

import { createWebhookVerifier, type StripeAccountSnapshot } from './stripe.ts';
import {
  handleStripeWebhook,
  type PaymentStatus,
  type PaymentsStore,
  type PaymentUpsert,
  type StripeWebhookDeps,
} from './webhook.ts';

const SECRET = 'whsec_test_chairside_fixture_secret';
const SALON_A = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const ACCOUNT_A = 'acct_1TestSalonA0001';
const CHECKOUT = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';

type Fixture = Record<string, unknown> & { type: string; account?: string; data: { object: any } };

function fixture(name: string): Fixture {
  const path = fileURLToPath(new URL(`../../fixtures/events/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

/** Signs exactly like Stripe does, using the SDK's own test helper. */
async function signed(event: unknown, secret = SECRET) {
  const payload = JSON.stringify(event);
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret });
  return { payload, signature };
}

class MemoryStore implements PaymentsStore {
  accounts = new Map<string, { salonId: string; snapshot?: StripeAccountSnapshot }>([
    [ACCOUNT_A, { salonId: SALON_A }],
  ]);
  payments = new Map<string, PaymentUpsert>();
  completed: [string, string, string][] = [];
  deposits: [string, string, string, string | null, string | null][] = [];

  async markDepositPaid(
    salonId: string,
    depositId: string,
    paymentIntentId: string,
    customerId: string | null,
    paymentMethodId: string | null,
  ) {
    this.deposits.push([salonId, depositId, paymentIntentId, customerId, paymentMethodId]);
  }

  async completeCheckout(salonId: string, checkoutId: string, paymentIntentId: string) {
    this.completed.push([salonId, checkoutId, paymentIntentId]);
  }
  async updateAccount(snapshot: StripeAccountSnapshot) {
    const row = this.accounts.get(snapshot.stripe_account_id);
    if (!row) return null;
    row.snapshot = snapshot;
    return row.salonId;
  }
  async salonIdForAccount(id: string) {
    return this.accounts.get(id)?.salonId ?? null;
  }
  async getPaymentStatus(id: string): Promise<PaymentStatus | null> {
    return this.payments.get(id)?.status ?? null;
  }
  async upsertPayment(row: PaymentUpsert) {
    const prev = this.payments.get(row.stripe_payment_intent_id);
    const defined = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
    this.payments.set(row.stripe_payment_intent_id, {
      amount_refunded_cents: 0,
      ...prev,
      ...defined,
    } as PaymentUpsert);
  }
}

let store: MemoryStore;
let deps: StripeWebhookDeps;

beforeEach(() => {
  store = new MemoryStore();
  deps = { verify: createWebhookVerifier(SECRET), store };
});

async function deliver(event: unknown) {
  const { payload, signature } = await signed(event);
  return handleStripeWebhook(payload, signature, deps);
}

describe('signature verification', () => {
  it('rejects a missing signature', async () => {
    const res = await handleStripeWebhook('{}', null, deps);
    expect(res.status).toBe(400);
  });

  it('rejects a payload signed with another secret', async () => {
    const { payload, signature } = await signed(fixture('account.updated.enabled'), 'whsec_other');
    const res = await handleStripeWebhook(payload, signature, deps);
    expect(res).toEqual({ status: 400, body: { error: 'Invalid signature' } });
    expect(store.accounts.get(ACCOUNT_A)?.snapshot).toBeUndefined();
  });

  it('rejects a tampered payload', async () => {
    const { payload, signature } = await signed(fixture('account.updated.onboarding'));
    const tampered = payload.replace('"charges_enabled":false', '"charges_enabled":true');
    const res = await handleStripeWebhook(tampered, signature, deps);
    expect(res.status).toBe(400);
  });

  it('rejects a stale signature (replay outside the tolerance)', async () => {
    const payload = JSON.stringify(fixture('account.updated.enabled'));
    const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: SECRET,
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    });
    const res = await handleStripeWebhook(payload, signature, deps);
    expect(res.status).toBe(400);
  });

  it('accepts any of several comma-separated secrets (platform + Connect destinations)', async () => {
    deps.verify = createWebhookVerifier(`whsec_platform_destination, ${SECRET}`);
    expect((await deliver(fixture('account.updated.enabled'))).status).toBe(200);

    const { payload, signature } = await signed(fixture('account.updated.enabled'), 'whsec_other');
    expect((await handleStripeWebhook(payload, signature, deps)).status).toBe(400);
  });
});

describe('account.updated', () => {
  it('records onboarding progress and outstanding requirements', async () => {
    const res = await deliver(fixture('account.updated.onboarding'));
    expect(res).toEqual({ status: 200, body: { received: true, handled: true } });
    expect(store.accounts.get(ACCOUNT_A)?.snapshot).toEqual({
      stripe_account_id: ACCOUNT_A,
      details_submitted: false,
      charges_enabled: false,
      payouts_enabled: false,
      requirements_due: [
        'external_account',
        'individual.verification.document',
        'tos_acceptance.date',
      ],
      disabled_reason: 'requirements.past_due',
      country: 'US',
      default_currency: 'usd',
    });
  });

  it('marks charges and payouts enabled', async () => {
    await deliver(fixture('account.updated.enabled'));
    expect(store.accounts.get(ACCOUNT_A)?.snapshot).toMatchObject({
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
      requirements_due: [],
    });
  });

  it('acknowledges but ignores accounts it does not know', async () => {
    const event = fixture('account.updated.enabled');
    event.account = 'acct_1Unknown';
    event.data.object.id = 'acct_1Unknown';
    const res = await deliver(event);
    expect(res).toMatchObject({ status: 200, body: { handled: false } });
  });
});

describe('payments', () => {
  it('records a successful payment against the connected salon', async () => {
    await deliver(fixture('payment_intent.succeeded'));
    expect(store.payments.get('pi_3TestTapToPay0001')).toEqual({
      salon_id: SALON_A,
      stripe_payment_intent_id: 'pi_3TestTapToPay0001',
      stripe_charge_id: 'ch_3TestTapToPay0001',
      stripe_account_id: ACCOUNT_A,
      amount_cents: 18500,
      amount_refunded_cents: 0,
      currency: 'usd',
      status: 'succeeded',
      appointment_id: '0b5f2a4e-1c3d-4e5f-9a8b-7c6d5e4f3a2b',
      description: 'Balayage + toner',
      failure_message: null,
      livemode: false,
    });
  });

  it('records a failed payment with the decline message', async () => {
    await deliver(fixture('payment_intent.payment_failed'));
    expect(store.payments.get('pi_3TestDeclined0001')).toMatchObject({
      status: 'failed',
      amount_cents: 6500,
      failure_message: 'Your card has insufficient funds.',
      appointment_id: null,
    });
  });

  it('records refunds and does not let a late success event undo them', async () => {
    await deliver(fixture('payment_intent.succeeded'));
    await deliver(fixture('charge.refunded.partial'));
    expect(store.payments.get('pi_3TestTapToPay0001')).toMatchObject({
      status: 'partially_refunded',
      amount_refunded_cents: 5000,
    });

    await deliver(fixture('payment_intent.succeeded'));
    expect(store.payments.get('pi_3TestTapToPay0001')).toMatchObject({
      status: 'partially_refunded',
      amount_refunded_cents: 5000,
    });

    const full = fixture('charge.refunded.partial');
    full.data.object.amount_refunded = 18500;
    full.data.object.refunded = true;
    await deliver(full);
    expect(store.payments.get('pi_3TestTapToPay0001')).toMatchObject({
      status: 'refunded',
      amount_refunded_cents: 18500,
    });
  });

  it('is idempotent when Stripe redelivers an event', async () => {
    await deliver(fixture('payment_intent.succeeded'));
    await deliver(fixture('payment_intent.succeeded'));
    expect(store.payments.size).toBe(1);
  });

  it('closes the checkout for a platform (destination) charge with checkout metadata', async () => {
    const event = fixture('payment_intent.succeeded');
    delete event.account;
    event.data.object.on_behalf_of = ACCOUNT_A;
    event.data.object.transfer_data = { destination: ACCOUNT_A };
    event.data.object.metadata.checkout_id = CHECKOUT;
    await deliver(event);
    expect(store.completed).toEqual([[SALON_A, CHECKOUT, 'pi_3TestTapToPay0001']]);
  });

  it('does not close checkouts from failed payments or connected-account events', async () => {
    const failed = fixture('payment_intent.payment_failed');
    failed.data.object.metadata = { checkout_id: CHECKOUT };
    await deliver(failed);
    const direct = fixture('payment_intent.succeeded');
    direct.data.object.metadata.checkout_id = CHECKOUT;
    await deliver(direct);
    expect(store.completed).toEqual([]);
  });

  it('records a deposit paid through hosted Checkout (destination charge)', async () => {
    const event = fixture('payment_intent.succeeded');
    delete event.account;
    event.data.object.on_behalf_of = ACCOUNT_A;
    event.data.object.transfer_data = { destination: ACCOUNT_A };
    event.data.object.customer = 'cus_TestClient01';
    event.data.object.payment_method = 'pm_TestCard01';
    event.data.object.metadata = { purpose: 'deposit', deposit_id: CHECKOUT };
    await deliver(event);
    expect(store.deposits).toEqual([
      [SALON_A, CHECKOUT, 'pi_3TestTapToPay0001', 'cus_TestClient01', 'pm_TestCard01'],
    ]);
  });

  it('does not record deposits from failed payments or connected-account events', async () => {
    const failed = fixture('payment_intent.payment_failed');
    failed.data.object.metadata = { purpose: 'deposit', deposit_id: CHECKOUT };
    await deliver(failed);
    const direct = fixture('payment_intent.succeeded');
    direct.data.object.metadata = { purpose: 'deposit', deposit_id: CHECKOUT };
    await deliver(direct);
    expect(store.deposits).toEqual([]);
  });

  it('ignores salon metadata on connected-account events (only the account mapping counts)', async () => {
    const event = fixture('payment_intent.succeeded');
    event.account = 'acct_1SomeoneElse';
    const res = await deliver(event);
    expect(res).toMatchObject({ body: { handled: false, note: 'no salon for payment' } });
    expect(store.payments.size).toBe(0);
  });

  it('maps platform destination charges via transfer_data.destination', async () => {
    const event = fixture('payment_intent.succeeded');
    delete event.account;
    event.data.object.transfer_data = { destination: ACCOUNT_A };
    event.data.object.metadata = { salon_id: '00000000-0000-4000-8000-000000000000' };
    await deliver(event);
    expect(store.payments.get('pi_3TestTapToPay0001')).toMatchObject({
      salon_id: SALON_A,
      stripe_account_id: ACCOUNT_A,
    });
  });

  it('falls back to metadata.salon_id for platform events without a destination', async () => {
    const event = fixture('payment_intent.succeeded');
    delete event.account;
    await deliver(event);
    expect(store.payments.get('pi_3TestTapToPay0001')).toMatchObject({
      salon_id: SALON_A,
      stripe_account_id: null,
    });
  });
});

describe('other events', () => {
  it('acknowledges unhandled event types', async () => {
    const res = await deliver(fixture('customer.created'));
    expect(res).toEqual({
      status: 200,
      body: { received: true, handled: false, note: 'ignored customer.created' },
    });
  });

  it('lets store failures propagate so Stripe retries', async () => {
    store.upsertPayment = async () => {
      throw new Error('db down');
    };
    await expect(deliver(fixture('payment_intent.succeeded'))).rejects.toThrow('db down');
  });
});
