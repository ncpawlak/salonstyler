import type Stripe from 'stripe';
import { z } from 'zod';

import { MIN_CARD_AMOUNT_CENTS } from '../checkout.ts';
import { STRIPE_NOT_CONFIGURED_MESSAGE } from './connect.ts';
import { redactStripeSecrets, type StripeClient } from './stripe.ts';
import type { PaymentStatus, PaymentUpsert } from './webhook.ts';

export const checkoutRequestSchema = z.discriminatedUnion('action', [
  /** Stripe Terminal connection token + Location for the Tap to Pay reader. Any member. */
  z.object({ action: z.literal('connection_token'), salonId: z.uuid() }),
  /** Creates (or reuses) the card_present PaymentIntent for the amount due. Any member. */
  z.object({ action: z.literal('create_intent'), checkoutId: z.uuid() }),
  /**
   * Test mode only: runs the payment on a server-side simulated reader and taps a test card.
   * Used on web and on devices without the Tap to Pay entitlement.
   */
  z.object({
    action: z.literal('simulate'),
    checkoutId: z.uuid(),
    card: z.enum(['success', 'declined']).default('success'),
  }),
  /** Confirms the PaymentIntent succeeded and marks the checkout paid. Any member. */
  z.object({ action: z.literal('complete'), checkoutId: z.uuid() }),
  /** Full or partial refund of a paid card checkout. Owner only. */
  z.object({
    action: z.literal('refund'),
    checkoutId: z.uuid(),
    amountCents: z.int().positive().optional(),
  }),
]);
export type CheckoutRequest = z.input<typeof checkoutRequestSchema>;

export interface CheckoutRecord {
  id: string;
  salon_id: string;
  appointment_id: string | null;
  status: 'open' | 'paid' | 'canceled';
  method: 'card' | 'cash' | 'other' | null;
  currency: string;
  amount_due_cents: number;
  stripe_payment_intent_id: string | null;
}

export interface CheckoutAccount {
  stripe_account_id: string;
  charges_enabled: boolean;
  terminal_location_id: string | null;
}

export interface CheckoutServiceDeps {
  getMemberRole(salonId: string): Promise<'owner' | 'stylist' | null>;
  getSalonName(salonId: string): Promise<string | null>;
  loadCheckout(checkoutId: string): Promise<CheckoutRecord | null>;
  loadAccount(salonId: string): Promise<CheckoutAccount | null>;
  saveLocation(salonId: string, locationId: string): Promise<void>;
  setPaymentIntent(checkoutId: string, paymentIntentId: string): Promise<void>;
  /** Marks the checkout paid (idempotent) and completes the appointment. */
  completeCheckout(
    checkoutId: string,
    paymentIntentId: string,
    card: { brand: string | null; last4: string | null },
  ): Promise<CheckoutRecord>;
  upsertPayment(row: PaymentUpsert): Promise<void>;
  /** null when STRIPE_SECRET_KEY is not configured. */
  stripe: StripeClient | null;
  /** True for sk_test_ keys. Simulated readers only exist in test mode. */
  testMode: boolean;
  /** Optional fixed Location (tml_...) instead of creating one per salon. */
  terminalLocationId?: string;
  /** Injected so tests don't wait. */
  sleep?: (ms: number) => Promise<void>;
}

export type CheckoutErrorBody = { error: { code: string; message: string } };
export type ConnectionTokenResponse = { secret: string; locationId: string; onBehalfOf: string };
export type CreateIntentResponse = {
  paymentIntentId: string;
  clientSecret: string;
  amountCents: number;
  currency: string;
};
export type CheckoutPaidResponse = { checkout: CheckoutRecord };
export type RefundResponse = { refundId: string; amountCents: number; status: PaymentStatus };

export type CheckoutServiceResult =
  | {
      status: 200;
      body: ConnectionTokenResponse | CreateIntentResponse | CheckoutPaidResponse | RefundResponse;
    }
  | { status: 400 | 402 | 403 | 404 | 409 | 502 | 503; body: CheckoutErrorBody };

const fail = (
  status: Exclude<CheckoutServiceResult['status'], 200>,
  code: string,
  message: string,
): CheckoutServiceResult => ({ status, body: { error: { code, message } } });

/** Stripe Terminal test cards. */
const TEST_CARDS = { success: '4242424242424242', declined: '4000000000000002' } as const;

const SIMULATED_READER = 'simulated_wisepos_e';

function stripeFailure(error: unknown): CheckoutServiceResult {
  const message = error instanceof Error ? error.message : String(error);
  return fail(502, 'stripe_error', redactStripeSecrets(message));
}

const idOf = (value: string | { id: string } | null | undefined): string | null =>
  value == null ? null : typeof value === 'string' ? value : value.id;

/** Card brand/last4 from the charge (card_present for Tap to Pay, card for some test flows). */
export function cardDetails(intent: Stripe.PaymentIntent): {
  brand: string | null;
  last4: string | null;
} {
  const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
  const details = charge?.payment_method_details;
  const card = details?.card_present ?? details?.card ?? null;
  return { brand: card?.brand ?? null, last4: card?.last4 ?? null };
}

function locationAddress(
  account: Stripe.Account,
): Stripe.Terminal.LocationCreateParams.Address | null {
  const candidates = [
    account.company?.address,
    account.individual?.address,
    account.business_profile?.support_address,
  ];
  for (const a of candidates) {
    if (a?.line1 && a.country) {
      return {
        line1: a.line1,
        country: a.country,
        ...(a.line2 ? { line2: a.line2 } : {}),
        ...(a.city ? { city: a.city } : {}),
        ...(a.state ? { state: a.state } : {}),
        ...(a.postal_code ? { postal_code: a.postal_code } : {}),
      };
    }
  }
  return null;
}

export async function handleCheckoutRequest(
  rawBody: unknown,
  deps: CheckoutServiceDeps,
): Promise<CheckoutServiceResult> {
  const parsed = checkoutRequestSchema.safeParse(rawBody);
  if (!parsed.success) return fail(400, 'invalid_request', z.prettifyError(parsed.error));
  const request = parsed.data;

  let checkout: CheckoutRecord | null = null;
  const salonId =
    request.action === 'connection_token'
      ? request.salonId
      : (checkout = await deps.loadCheckout(request.checkoutId))?.salon_id;
  if (!salonId) return fail(404, 'not_found', 'Checkout not found');

  const role = await deps.getMemberRole(salonId);
  if (!role) return fail(403, 'forbidden', 'You are not a member of this salon');
  if (request.action === 'refund' && role !== 'owner') {
    return fail(403, 'forbidden', 'Only the salon owner can refund payments');
  }

  const { stripe } = deps;
  if (!stripe) return fail(503, 'stripe_not_configured', STRIPE_NOT_CONFIGURED_MESSAGE);

  const account = await deps.loadAccount(salonId);
  if (!account?.charges_enabled) {
    return fail(
      409,
      'payments_not_enabled',
      'Card payments aren’t enabled yet. Finish Stripe setup in Settings → Payments.',
    );
  }

  try {
    switch (request.action) {
      case 'connection_token': {
        const locationId = await ensureLocation(salonId, account, deps, stripe);
        if (!locationId) {
          return fail(
            409,
            'location_address_missing',
            'Add a business address in Stripe before taking in-person payments.',
          );
        }
        const token = await stripe.terminal.connectionTokens.create({ location: locationId });
        return {
          status: 200,
          body: { secret: token.secret, locationId, onBehalfOf: account.stripe_account_id },
        };
      }
      case 'create_intent':
        return await createIntent(checkout!, account, deps, stripe);
      case 'simulate': {
        if (!deps.testMode) {
          return fail(409, 'live_mode', 'Simulated readers only work with Stripe test keys.');
        }
        const created = await createIntent(checkout!, account, deps, stripe);
        if (created.status !== 200 || !('paymentIntentId' in created.body)) return created;
        const intentId = created.body.paymentIntentId;
        return await simulateTap(checkout!, account, intentId, request.card, deps, stripe);
      }
      case 'complete':
        return await completeFromStripe(checkout!, account, deps, stripe);
      case 'refund':
        return await refund(checkout!, account, request.amountCents, deps, stripe);
    }
  } catch (error) {
    return stripeFailure(error);
  }
}

async function ensureLocation(
  salonId: string,
  account: CheckoutAccount,
  deps: CheckoutServiceDeps,
  stripe: StripeClient,
): Promise<string | null> {
  if (account.terminal_location_id) return account.terminal_location_id;
  if (deps.terminalLocationId) return deps.terminalLocationId;
  const connected = await stripe.accounts.retrieve(account.stripe_account_id);
  const address = locationAddress(connected);
  if (!address) return null;
  const name =
    (await deps.getSalonName(salonId)) ?? connected.business_profile?.name ?? 'Chairside salon';
  const location = await stripe.terminal.locations.create(
    { display_name: name, address, metadata: { salon_id: salonId } },
    { idempotencyKey: `chairside-terminal-location-${salonId}` },
  );
  await deps.saveLocation(salonId, location.id);
  return location.id;
}

async function createIntent(
  checkout: CheckoutRecord,
  account: CheckoutAccount,
  deps: CheckoutServiceDeps,
  stripe: StripeClient,
): Promise<CheckoutServiceResult> {
  if (checkout.status === 'paid') return { status: 200, body: { checkout } };
  if (checkout.status !== 'open') return fail(409, 'checkout_closed', 'This checkout is closed');
  if (checkout.amount_due_cents < MIN_CARD_AMOUNT_CENTS) {
    return fail(
      409,
      'amount_too_small',
      'Card payments need at least 0.50. Take this one as cash or other.',
    );
  }

  if (checkout.stripe_payment_intent_id) {
    const existing = await stripe.paymentIntents.retrieve(checkout.stripe_payment_intent_id);
    if (existing.status === 'succeeded') {
      return completeFromStripe(checkout, account, deps, stripe);
    }
    const reusable =
      existing.amount === checkout.amount_due_cents &&
      existing.currency === checkout.currency &&
      (existing.status === 'requires_payment_method' ||
        existing.status === 'requires_confirmation');
    if (reusable && existing.client_secret) {
      return {
        status: 200,
        body: {
          paymentIntentId: existing.id,
          clientSecret: existing.client_secret,
          amountCents: existing.amount,
          currency: existing.currency,
        },
      };
    }
    if (existing.status !== 'canceled') await stripe.paymentIntents.cancel(existing.id);
  }

  const intent = await stripe.paymentIntents.create(
    {
      amount: checkout.amount_due_cents,
      currency: checkout.currency,
      allowed_payment_method_types: ['card_present'],
      capture_method: 'automatic',
      on_behalf_of: account.stripe_account_id,
      transfer_data: { destination: account.stripe_account_id },
      description: 'Salon checkout',
      metadata: {
        salon_id: checkout.salon_id,
        checkout_id: checkout.id,
        ...(checkout.appointment_id ? { appointment_id: checkout.appointment_id } : {}),
      },
    },
    // A double tap must not create two intents; the previous PI id makes the key change after a
    // cancel, so returning to an earlier amount doesn't replay a canceled intent.
    {
      idempotencyKey: `chairside-checkout-${checkout.id}-${checkout.amount_due_cents}-${
        checkout.stripe_payment_intent_id ?? 'first'
      }`,
    },
  );
  await deps.setPaymentIntent(checkout.id, intent.id);
  checkout.stripe_payment_intent_id = intent.id;
  if (!intent.client_secret) return fail(502, 'stripe_error', 'PaymentIntent has no secret');
  return {
    status: 200,
    body: {
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret,
      amountCents: intent.amount,
      currency: intent.currency,
    },
  };
}

async function simulatedReader(locationId: string, stripe: StripeClient): Promise<string> {
  const { data } = await stripe.terminal.readers.list({
    location: locationId,
    device_type: SIMULATED_READER,
    limit: 1,
  });
  if (data[0]) return data[0].id;
  const reader = await stripe.terminal.readers.create({
    registration_code: 'simulated-wpe',
    location: locationId,
    label: 'Chairside simulated reader',
  });
  return reader.id;
}

async function simulateTap(
  checkout: CheckoutRecord,
  account: CheckoutAccount,
  paymentIntentId: string,
  card: 'success' | 'declined',
  deps: CheckoutServiceDeps,
  stripe: StripeClient,
): Promise<CheckoutServiceResult> {
  const locationId = await ensureLocation(checkout.salon_id, account, deps, stripe);
  if (!locationId) {
    return fail(
      409,
      'location_address_missing',
      'Add a business address in Stripe before taking in-person payments.',
    );
  }
  const readerId = await simulatedReader(locationId, stripe);
  // A previous abandoned attempt can leave the reader busy.
  await stripe.terminal.readers.cancelAction(readerId).catch(() => undefined);
  await stripe.terminal.readers.processPaymentIntent(readerId, {
    payment_intent: paymentIntentId,
  });
  await stripe.terminal.readers.presentPaymentMethod(readerId, {
    type: 'card_present',
    card_present: { number: TEST_CARDS[card] },
  });

  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < 10; attempt++) {
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (intent.status === 'succeeded') {
      return completeFromStripe(checkout, account, deps, stripe);
    }
    if (intent.status === 'requires_payment_method' && intent.last_payment_error) {
      return fail(
        402,
        'card_declined',
        intent.last_payment_error.message ?? 'The card was declined.',
      );
    }
    await sleep(500);
  }
  return fail(409, 'payment_pending', 'The payment is still processing. Try again in a moment.');
}

async function completeFromStripe(
  checkout: CheckoutRecord,
  account: CheckoutAccount,
  deps: CheckoutServiceDeps,
  stripe: StripeClient,
): Promise<CheckoutServiceResult> {
  if (!checkout.stripe_payment_intent_id) {
    return fail(409, 'no_payment', 'Start a card payment first');
  }
  const intent = await stripe.paymentIntents.retrieve(checkout.stripe_payment_intent_id, {
    expand: ['latest_charge'],
  });
  if (intent.metadata?.checkout_id && intent.metadata.checkout_id !== checkout.id) {
    return fail(409, 'payment_mismatch', 'This payment belongs to a different checkout');
  }
  if (intent.status !== 'succeeded') {
    return fail(409, 'payment_not_succeeded', `The payment is ${intent.status.replace(/_/g, ' ')}`);
  }
  const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
  await deps.upsertPayment({
    salon_id: checkout.salon_id,
    stripe_payment_intent_id: intent.id,
    stripe_charge_id: idOf(intent.latest_charge),
    stripe_account_id: account.stripe_account_id,
    amount_cents: intent.amount_received || intent.amount,
    ...(charge ? { amount_refunded_cents: charge.amount_refunded } : {}),
    currency: intent.currency,
    status: charge?.refunded
      ? 'refunded'
      : charge && charge.amount_refunded > 0
        ? 'partially_refunded'
        : 'succeeded',
    appointment_id: checkout.appointment_id,
    description: intent.description ?? null,
    livemode: intent.livemode,
  });
  const paid = await deps.completeCheckout(checkout.id, intent.id, cardDetails(intent));
  return { status: 200, body: { checkout: paid } };
}

async function refund(
  checkout: CheckoutRecord,
  account: CheckoutAccount,
  amountCents: number | undefined,
  deps: CheckoutServiceDeps,
  stripe: StripeClient,
): Promise<CheckoutServiceResult> {
  if (
    checkout.status !== 'paid' ||
    checkout.method !== 'card' ||
    !checkout.stripe_payment_intent_id
  ) {
    return fail(409, 'not_refundable', 'Only paid card checkouts can be refunded here');
  }
  const created = await stripe.refunds.create({
    payment_intent: checkout.stripe_payment_intent_id,
    ...(amountCents ? { amount: amountCents } : {}),
    // Pull the money back from the salon's balance, not the platform's.
    reverse_transfer: true,
    reason: 'requested_by_customer',
    metadata: { salon_id: checkout.salon_id, checkout_id: checkout.id },
  });
  const intent = await stripe.paymentIntents.retrieve(checkout.stripe_payment_intent_id, {
    expand: ['latest_charge'],
  });
  const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
  const refunded = charge?.amount_refunded ?? created.amount;
  const status: PaymentStatus =
    refunded >= (intent.amount_received || intent.amount) ? 'refunded' : 'partially_refunded';
  await deps.upsertPayment({
    salon_id: checkout.salon_id,
    stripe_payment_intent_id: intent.id,
    stripe_charge_id: idOf(intent.latest_charge),
    stripe_account_id: account.stripe_account_id,
    amount_cents: intent.amount_received || intent.amount,
    amount_refunded_cents: refunded,
    currency: intent.currency,
    status,
    appointment_id: checkout.appointment_id,
    livemode: intent.livemode,
  });
  return { status: 200, body: { refundId: created.id, amountCents: created.amount, status } };
}
