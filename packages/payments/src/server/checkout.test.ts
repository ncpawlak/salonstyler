import type Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type CheckoutAccount,
  type CheckoutRecord,
  type CheckoutServiceDeps,
  handleCheckoutRequest,
} from './checkout.ts';
import { STRIPE_NOT_CONFIGURED_MESSAGE } from './connect.ts';
import type { PresentPaymentMethodParams, StripeClient } from './stripe.ts';
import type { PaymentUpsert } from './webhook.ts';

const SALON = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const CHECKOUT = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const APPOINTMENT = '0b5f2a4e-1c3d-4e5f-9a8b-7c6d5e4f3a2b';
const ACCOUNT = 'acct_1TestSalonA0001';

function intent(overrides: Partial<Stripe.PaymentIntent> = {}): Stripe.PaymentIntent {
  return {
    id: 'pi_3TestCheckout0001',
    object: 'payment_intent',
    amount: 16500,
    amount_received: 0,
    currency: 'usd',
    status: 'requires_payment_method',
    client_secret: 'pi_3TestCheckout0001_secret_abc',
    livemode: false,
    description: 'Salon checkout',
    latest_charge: null,
    last_payment_error: null,
    metadata: { checkout_id: CHECKOUT },
    ...overrides,
  } as Stripe.PaymentIntent;
}

function succeeded(): Stripe.PaymentIntent {
  return intent({
    status: 'succeeded',
    amount_received: 16500,
    latest_charge: {
      id: 'ch_3TestCheckout0001',
      amount_refunded: 0,
      refunded: false,
      payment_method_details: { card_present: { brand: 'visa', last4: '4242' } },
    } as unknown as Stripe.Charge,
  });
}

function mockStripe() {
  let current = intent();
  const stripe = {
    accounts: {
      create: vi.fn(),
      retrieve: vi.fn(
        async () =>
          ({
            id: ACCOUNT,
            business_profile: { name: 'Studio A' },
            company: {
              address: {
                line1: '1 Main St',
                city: 'Austin',
                state: 'TX',
                postal_code: '78701',
                country: 'US',
              },
            },
          }) as unknown as Stripe.Account,
      ),
      createLoginLink: vi.fn(),
    },
    accountLinks: { create: vi.fn() },
    paymentIntents: {
      create: vi.fn(async () => (current = intent())),
      retrieve: vi.fn(async () => current),
      cancel: vi.fn(async () => (current = intent({ status: 'canceled' }))),
    },
    refunds: {
      create: vi.fn(async (params: Stripe.RefundCreateParams) => {
        const amount = params.amount ?? 16500;
        const base = succeeded();
        current = {
          ...base,
          latest_charge: {
            ...(base.latest_charge as Stripe.Charge),
            amount_refunded: amount,
            refunded: amount >= 16500,
          },
        } as Stripe.PaymentIntent;
        return { id: 're_test_1', amount } as Stripe.Refund;
      }),
    },
    terminal: {
      connectionTokens: { create: vi.fn(async () => ({ secret: 'pst_test_secret' })) },
      locations: { create: vi.fn(async () => ({ id: 'tml_TestLocation' })) },
      readers: {
        list: vi.fn(async () => ({ data: [] as Stripe.Terminal.Reader[] })),
        create: vi.fn(async () => ({ id: 'tmr_TestSim' }) as Stripe.Terminal.Reader),
        cancelAction: vi.fn(async () => ({})),
        processPaymentIntent: vi.fn(async () => ({ id: 'tmr_TestSim' }) as Stripe.Terminal.Reader),
        presentPaymentMethod: vi.fn(async (_id: string, params: PresentPaymentMethodParams) => {
          current =
            params.card_present?.number === '4242424242424242'
              ? succeeded()
              : intent({
                  last_payment_error: {
                    message: 'Your card was declined.',
                  } as Stripe.PaymentIntent.LastPaymentError,
                });
          return { id: 'tmr_TestSim' } as Stripe.Terminal.Reader;
        }),
      },
    },
  };
  return {
    stripe,
    setIntent: (pi: Stripe.PaymentIntent) => {
      current = pi;
    },
  };
}

let checkout: CheckoutRecord;
let account: CheckoutAccount | null;
let role: 'owner' | 'stylist' | null;
let payments: PaymentUpsert[];
let completed: { id: string; pi: string; card: { brand: string | null; last4: string | null } }[];
let mock: ReturnType<typeof mockStripe>;
let deps: CheckoutServiceDeps;

beforeEach(() => {
  checkout = {
    id: CHECKOUT,
    salon_id: SALON,
    appointment_id: APPOINTMENT,
    status: 'open',
    method: null,
    currency: 'usd',
    amount_due_cents: 16500,
    stripe_payment_intent_id: null,
  };
  account = { stripe_account_id: ACCOUNT, charges_enabled: true, terminal_location_id: null };
  role = 'stylist';
  payments = [];
  completed = [];
  mock = mockStripe();
  deps = {
    getMemberRole: async () => role,
    getSalonName: async () => 'Studio A',
    loadCheckout: async (id) => (id === CHECKOUT ? { ...checkout } : null),
    loadAccount: async () => account,
    saveLocation: vi.fn(async (_salon, id) => {
      if (account) account.terminal_location_id = id;
    }),
    setPaymentIntent: async (_id, pi) => {
      checkout.stripe_payment_intent_id = pi;
    },
    completeCheckout: async (id, pi, card) => {
      completed.push({ id, pi, card });
      checkout = { ...checkout, status: 'paid', method: 'card', stripe_payment_intent_id: pi };
      return checkout;
    },
    upsertPayment: async (row) => {
      payments.push(row);
    },
    stripe: mock.stripe as unknown as StripeClient,
    testMode: true,
    sleep: async () => undefined,
  };
});

describe('access', () => {
  it('validates the request', async () => {
    const res = await handleCheckoutRequest({ action: 'create_intent', checkoutId: 'x' }, deps);
    expect(res.status).toBe(400);
  });

  it('404s an unknown checkout', async () => {
    const res = await handleCheckoutRequest({ action: 'create_intent', checkoutId: SALON }, deps);
    expect(res.status).toBe(404);
  });

  it('rejects non-members', async () => {
    role = null;
    const res = await handleCheckoutRequest(
      { action: 'create_intent', checkoutId: CHECKOUT },
      deps,
    );
    expect(res.status).toBe(403);
  });

  it('reports a missing Stripe key as 503', async () => {
    deps.stripe = null;
    const res = await handleCheckoutRequest(
      { action: 'create_intent', checkoutId: CHECKOUT },
      deps,
    );
    expect(res).toEqual({
      status: 503,
      body: { error: { code: 'stripe_not_configured', message: STRIPE_NOT_CONFIGURED_MESSAGE } },
    });
  });

  it('needs charges enabled on the salon account', async () => {
    account = { stripe_account_id: ACCOUNT, charges_enabled: false, terminal_location_id: null };
    const res = await handleCheckoutRequest(
      { action: 'create_intent', checkoutId: CHECKOUT },
      deps,
    );
    expect(res).toMatchObject({ status: 409, body: { error: { code: 'payments_not_enabled' } } });
  });
});

describe('connection_token', () => {
  it('creates the salon Location once from the Stripe business address', async () => {
    const res = await handleCheckoutRequest({ action: 'connection_token', salonId: SALON }, deps);
    expect(res).toEqual({
      status: 200,
      body: { secret: 'pst_test_secret', locationId: 'tml_TestLocation', onBehalfOf: ACCOUNT },
    });
    expect(mock.stripe.terminal.locations.create).toHaveBeenCalledWith(
      expect.objectContaining({
        display_name: 'Studio A',
        address: expect.objectContaining({ line1: '1 Main St', country: 'US' }),
      }),
      { idempotencyKey: `chairside-terminal-location-${SALON}` },
    );
    await handleCheckoutRequest({ action: 'connection_token', salonId: SALON }, deps);
    expect(mock.stripe.terminal.locations.create).toHaveBeenCalledTimes(1);
  });

  it('uses a configured Location when given', async () => {
    deps.terminalLocationId = 'tml_Fixed';
    const res = await handleCheckoutRequest({ action: 'connection_token', salonId: SALON }, deps);
    expect(res).toMatchObject({ status: 200, body: { locationId: 'tml_Fixed' } });
    expect(mock.stripe.terminal.locations.create).not.toHaveBeenCalled();
  });
});

describe('create_intent', () => {
  it('creates a card_present destination charge for the amount due', async () => {
    const res = await handleCheckoutRequest(
      { action: 'create_intent', checkoutId: CHECKOUT },
      deps,
    );
    expect(res).toEqual({
      status: 200,
      body: {
        paymentIntentId: 'pi_3TestCheckout0001',
        clientSecret: 'pi_3TestCheckout0001_secret_abc',
        amountCents: 16500,
        currency: 'usd',
      },
    });
    expect(mock.stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 16500,
        allowed_payment_method_types: ['card_present'],
        on_behalf_of: ACCOUNT,
        transfer_data: { destination: ACCOUNT },
        metadata: { salon_id: SALON, checkout_id: CHECKOUT, appointment_id: APPOINTMENT },
      }),
      { idempotencyKey: `chairside-checkout-${CHECKOUT}-16500-first` },
    );
    expect(checkout.stripe_payment_intent_id).toBe('pi_3TestCheckout0001');
  });

  it('reuses a matching open intent and replaces one whose amount changed', async () => {
    await handleCheckoutRequest({ action: 'create_intent', checkoutId: CHECKOUT }, deps);
    await handleCheckoutRequest({ action: 'create_intent', checkoutId: CHECKOUT }, deps);
    expect(mock.stripe.paymentIntents.create).toHaveBeenCalledTimes(1);

    checkout.amount_due_cents = 20000;
    await handleCheckoutRequest({ action: 'create_intent', checkoutId: CHECKOUT }, deps);
    expect(mock.stripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_3TestCheckout0001');
    expect(mock.stripe.paymentIntents.create).toHaveBeenCalledTimes(2);
  });

  it('refuses amounts under the card minimum', async () => {
    checkout.amount_due_cents = 40;
    const res = await handleCheckoutRequest(
      { action: 'create_intent', checkoutId: CHECKOUT },
      deps,
    );
    expect(res).toMatchObject({ status: 409, body: { error: { code: 'amount_too_small' } } });
  });
});

describe('simulate (test mode reader)', () => {
  it('taps a test card, records the payment and closes the checkout', async () => {
    const res = await handleCheckoutRequest({ action: 'simulate', checkoutId: CHECKOUT }, deps);
    expect(res).toMatchObject({ status: 200, body: { checkout: { status: 'paid' } } });
    expect(mock.stripe.terminal.readers.create).toHaveBeenCalledWith(
      expect.objectContaining({ registration_code: 'simulated-wpe', location: 'tml_TestLocation' }),
    );
    expect(completed).toEqual([
      { id: CHECKOUT, pi: 'pi_3TestCheckout0001', card: { brand: 'visa', last4: '4242' } },
    ]);
    expect(payments).toEqual([
      expect.objectContaining({
        salon_id: SALON,
        stripe_payment_intent_id: 'pi_3TestCheckout0001',
        stripe_charge_id: 'ch_3TestCheckout0001',
        status: 'succeeded',
        amount_cents: 16500,
        appointment_id: APPOINTMENT,
      }),
    ]);
  });

  it('reports a declined card without closing the checkout', async () => {
    const res = await handleCheckoutRequest(
      { action: 'simulate', checkoutId: CHECKOUT, card: 'declined' },
      deps,
    );
    expect(res).toEqual({
      status: 402,
      body: { error: { code: 'card_declined', message: 'Your card was declined.' } },
    });
    expect(completed).toEqual([]);
  });

  it('is unavailable with live keys', async () => {
    deps.testMode = false;
    const res = await handleCheckoutRequest({ action: 'simulate', checkoutId: CHECKOUT }, deps);
    expect(res).toMatchObject({ status: 409, body: { error: { code: 'live_mode' } } });
  });
});

describe('complete', () => {
  it('needs the intent to have succeeded', async () => {
    checkout.stripe_payment_intent_id = 'pi_3TestCheckout0001';
    const res = await handleCheckoutRequest({ action: 'complete', checkoutId: CHECKOUT }, deps);
    expect(res).toMatchObject({ status: 409, body: { error: { code: 'payment_not_succeeded' } } });
  });

  it('closes the checkout after a Tap to Pay payment', async () => {
    checkout.stripe_payment_intent_id = 'pi_3TestCheckout0001';
    mock.setIntent(succeeded());
    const res = await handleCheckoutRequest({ action: 'complete', checkoutId: CHECKOUT }, deps);
    expect(res).toMatchObject({ status: 200, body: { checkout: { status: 'paid' } } });
    expect(mock.stripe.paymentIntents.retrieve).toHaveBeenCalledWith('pi_3TestCheckout0001', {
      expand: ['latest_charge'],
    });
  });

  it('rejects an intent that belongs to another checkout', async () => {
    checkout.stripe_payment_intent_id = 'pi_3TestCheckout0001';
    mock.setIntent({ ...succeeded(), metadata: { checkout_id: SALON } });
    const res = await handleCheckoutRequest({ action: 'complete', checkoutId: CHECKOUT }, deps);
    expect(res).toMatchObject({ status: 409, body: { error: { code: 'payment_mismatch' } } });
  });
});

describe('refund', () => {
  beforeEach(() => {
    checkout = {
      ...checkout,
      status: 'paid',
      method: 'card',
      stripe_payment_intent_id: 'pi_3TestCheckout0001',
    };
    mock.setIntent(succeeded());
  });

  it('is owner only', async () => {
    const res = await handleCheckoutRequest({ action: 'refund', checkoutId: CHECKOUT }, deps);
    expect(res.status).toBe(403);
  });

  it('refunds part of a payment from the salon balance', async () => {
    role = 'owner';
    const res = await handleCheckoutRequest(
      { action: 'refund', checkoutId: CHECKOUT, amountCents: 5000 },
      deps,
    );
    expect(res).toEqual({
      status: 200,
      body: { refundId: 're_test_1', amountCents: 5000, status: 'partially_refunded' },
    });
    expect(mock.stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: 'pi_3TestCheckout0001',
        amount: 5000,
        reverse_transfer: true,
      }),
    );
    expect(payments.at(-1)).toMatchObject({
      status: 'partially_refunded',
      amount_refunded_cents: 5000,
    });
  });

  it('refunds the full amount by default', async () => {
    role = 'owner';
    const res = await handleCheckoutRequest({ action: 'refund', checkoutId: CHECKOUT }, deps);
    expect(res).toMatchObject({ status: 200, body: { status: 'refunded', amountCents: 16500 } });
  });

  it('does not refund cash checkouts', async () => {
    role = 'owner';
    checkout = { ...checkout, method: 'cash', stripe_payment_intent_id: null };
    const res = await handleCheckoutRequest({ action: 'refund', checkoutId: CHECKOUT }, deps);
    expect(res).toMatchObject({ status: 409, body: { error: { code: 'not_refundable' } } });
  });
});
