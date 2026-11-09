import type Stripe from 'stripe';

import { accountSnapshot, type StripeAccountSnapshot, type StripeEventVerifier } from './stripe.ts';

export type PaymentStatus =
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'partially_refunded'
  | 'refunded';

/** Columns written to `public.payments`, keyed by `stripe_payment_intent_id`. */
export interface PaymentUpsert {
  salon_id: string;
  stripe_payment_intent_id: string;
  stripe_charge_id: string | null;
  stripe_account_id: string | null;
  amount_cents: number;
  /** Omitted for PaymentIntent events so a refund already recorded is never reset. */
  amount_refunded_cents?: number;
  currency: string;
  status: PaymentStatus;
  appointment_id?: string | null;
  description?: string | null;
  failure_message?: string | null;
  livemode: boolean;
}

export interface PaymentsStore {
  /** Updates the account row for this Stripe account; returns its salon id, or null if unknown. */
  updateAccount(snapshot: StripeAccountSnapshot): Promise<string | null>;
  salonIdForAccount(stripeAccountId: string): Promise<string | null>;
  getPaymentStatus(paymentIntentId: string): Promise<PaymentStatus | null>;
  upsertPayment(row: PaymentUpsert): Promise<void>;
  /**
   * Marks a checkout paid by card (idempotent; also completes its appointment). Must ignore
   * checkouts that don't belong to `salonId`.
   */
  completeCheckout(salonId: string, checkoutId: string, paymentIntentId: string): Promise<void>;
  /**
   * Records a paid deposit (`public.mark_deposit_paid`, idempotent). Must ignore deposits that
   * don't belong to `salonId`.
   */
  markDepositPaid(
    salonId: string,
    depositId: string,
    paymentIntentId: string,
    customerId: string | null,
    paymentMethodId: string | null,
  ): Promise<void>;
}

export interface StripeWebhookDeps {
  verify: StripeEventVerifier;
  store: PaymentsStore;
}

export type StripeWebhookResult = {
  status: 200 | 400;
  body: { received: true; handled: boolean; note?: string } | { error: string };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PAYMENT_INTENT_EVENTS: Record<string, PaymentStatus> = {
  'payment_intent.processing': 'processing',
  'payment_intent.succeeded': 'succeeded',
  'payment_intent.payment_failed': 'failed',
  'payment_intent.canceled': 'canceled',
};

export const HANDLED_STRIPE_EVENTS = [
  'account.updated',
  ...Object.keys(PAYMENT_INTENT_EVENTS),
  'charge.refunded',
] as const;

const idOf = (value: string | { id: string } | null | undefined): string | null =>
  value == null ? null : typeof value === 'string' ? value : value.id;

const uuidOrNull = (value: string | undefined): string | null =>
  value && UUID.test(value) ? value.toLowerCase() : null;

type AccountRef = string | { id: string } | null | undefined;
interface Destination {
  on_behalf_of?: AccountRef;
  transfer_data?: { destination: AccountRef } | null;
  metadata?: Record<string, string> | null;
}

/**
 * Which salon a payment belongs to. Events from a connected account (direct charges) are trusted
 * only by that account's mapping. Platform events (destination charges) use the destination
 * account, then our own `metadata.salon_id`.
 */
async function resolveSalon(
  event: Stripe.Event,
  object: Destination,
  store: PaymentsStore,
): Promise<{ salonId: string | null; accountId: string | null }> {
  if (event.account) {
    return { salonId: await store.salonIdForAccount(event.account), accountId: event.account };
  }
  const accountId = idOf(object.on_behalf_of) ?? idOf(object.transfer_data?.destination);
  if (accountId) return { salonId: await store.salonIdForAccount(accountId), accountId };
  return { salonId: uuidOrNull(object.metadata?.salon_id), accountId: null };
}

const ok = (handled: boolean, note?: string): StripeWebhookResult => ({
  status: 200,
  body: { received: true, handled, ...(note ? { note } : {}) },
});

/**
 * Handles one Stripe webhook delivery. Store errors propagate so the caller returns 5xx and
 * Stripe retries; every write is an idempotent upsert, so redeliveries are harmless.
 */
export async function handleStripeWebhook(
  payload: string,
  signature: string | null,
  deps: StripeWebhookDeps,
): Promise<StripeWebhookResult> {
  if (!signature) return { status: 400, body: { error: 'Missing Stripe-Signature header' } };

  let event: Stripe.Event;
  try {
    event = await deps.verify(payload, signature);
  } catch {
    return { status: 400, body: { error: 'Invalid signature' } };
  }

  if (event.type === 'account.updated') {
    const salonId = await deps.store.updateAccount(accountSnapshot(event.data.object));
    return salonId ? ok(true) : ok(false, 'unknown account');
  }

  const piStatus = PAYMENT_INTENT_EVENTS[event.type];
  if (piStatus) {
    const intent = event.data.object as Stripe.PaymentIntent;
    const { salonId, accountId } = await resolveSalon(event, intent, deps.store);
    if (!salonId) return ok(false, 'no salon for payment');

    const existing = await deps.store.getPaymentStatus(intent.id);
    // Events can arrive out of order: a late `succeeded` must not undo a recorded refund.
    const status =
      existing === 'refunded' || existing === 'partially_refunded' ? existing : piStatus;

    await deps.store.upsertPayment({
      salon_id: salonId,
      stripe_payment_intent_id: intent.id,
      stripe_charge_id: idOf(intent.latest_charge),
      stripe_account_id: accountId,
      amount_cents: intent.amount_received || intent.amount,
      currency: intent.currency,
      status,
      appointment_id: uuidOrNull(intent.metadata?.appointment_id),
      description: intent.description ?? null,
      failure_message: piStatus === 'failed' ? (intent.last_payment_error?.message ?? null) : null,
      livemode: event.livemode,
    });
    // Backstop for Tap to Pay: if the app lost connection before calling `complete`, the
    // checkout still closes once Stripe reports the payment.
    const checkoutId = uuidOrNull(intent.metadata?.checkout_id);
    if (piStatus === 'succeeded' && checkoutId && !event.account) {
      await deps.store.completeCheckout(salonId, checkoutId, intent.id);
    }
    // Backstop for deposits: the client may close the tab before the pay page checks in.
    const depositId = uuidOrNull(intent.metadata?.deposit_id);
    if (
      piStatus === 'succeeded' &&
      intent.metadata?.purpose === 'deposit' &&
      depositId &&
      !event.account
    ) {
      await deps.store.markDepositPaid(
        salonId,
        depositId,
        intent.id,
        idOf(intent.customer),
        idOf(intent.payment_method),
      );
    }
    return ok(true);
  }

  if (event.type === 'charge.refunded') {
    const charge = event.data.object;
    const paymentIntentId = idOf(charge.payment_intent);
    if (!paymentIntentId) return ok(false, 'charge has no payment intent');
    const { salonId, accountId } = await resolveSalon(event, charge, deps.store);
    if (!salonId) return ok(false, 'no salon for payment');

    await deps.store.upsertPayment({
      salon_id: salonId,
      stripe_payment_intent_id: paymentIntentId,
      stripe_charge_id: charge.id,
      stripe_account_id: accountId,
      amount_cents: charge.amount_captured || charge.amount,
      amount_refunded_cents: charge.amount_refunded,
      currency: charge.currency,
      status: charge.refunded ? 'refunded' : 'partially_refunded',
      livemode: event.livemode,
    });
    return ok(true);
  }

  return ok(false, `ignored ${event.type}`);
}
