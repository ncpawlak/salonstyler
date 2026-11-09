import type Stripe from 'stripe';
import { z } from 'zod';

import { STRIPE_NOT_CONFIGURED_MESSAGE } from './connect.ts';
import { redactStripeSecrets, type StripeClient } from './stripe.ts';
import type { PaymentUpsert } from './webhook.ts';

/**
 * Deposits (#12): the client's pay page (`/pay/<token>`) and refunds. Payment uses Stripe-hosted
 * Checkout as a destination charge to the salon's connected account, and saves the card
 * (`setup_future_usage: off_session`) for no-show fees.
 */
export const depositsRequestSchema = z.discriminatedUnion('action', [
  /** What the pay page shows. Anyone with the token. */
  z.object({ action: z.literal('page'), token: z.string().regex(/^[0-9a-f]{64}$/) }),
  /** Starts (or resumes) Stripe Checkout and returns its URL. Anyone with the token. */
  z.object({
    action: z.literal('start'),
    token: z.string().regex(/^[0-9a-f]{64}$/),
    returnUrl: z.url({ protocol: /^https?$/ }),
  }),
  /** After Checkout redirects back: records the payment if Stripe says it's paid. */
  z.object({ action: z.literal('status'), token: z.string().regex(/^[0-9a-f]{64}$/) }),
  /**
   * Refunds a deposit through Stripe. `refund_due` deposits: any member (or the service role,
   * e.g. the client's manage link). Paid or kept deposits: the owner only.
   */
  z.object({
    action: z.literal('refund'),
    depositId: z.uuid(),
    amountCents: z.int().positive().optional(),
  }),
]);
export type DepositsRequest = z.input<typeof depositsRequestSchema>;

export type DepositStatus = 'pending' | 'paid' | 'refund_due' | 'refunded' | 'kept' | 'canceled';

/** `public.deposit_pay_page`. */
export interface DepositPayPage {
  depositId: string;
  status: DepositStatus;
  amountCents: number;
  currency: string;
  salonName: string;
  salonSlug: string;
  timezone: string;
  appointmentStatus: string;
  startsAt: string;
  holdExpiresAt: string | null;
  services: string | null;
  windowHours: number;
  freeUntil: string;
}

export interface DepositRecord {
  id: string;
  salon_id: string;
  appointment_id: string;
  status: DepositStatus;
  amount_cents: number;
  refunded_cents: number;
  currency: string;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
}

export interface DepositAccount {
  stripe_account_id: string;
  charges_enabled: boolean;
}

export interface DepositsServiceDeps {
  loadPage(token: string): Promise<DepositPayPage | null>;
  loadDeposit(depositId: string): Promise<DepositRecord | null>;
  loadAccount(salonId: string): Promise<DepositAccount | null>;
  setCheckoutSession(depositId: string, sessionId: string): Promise<void>;
  /** `public.mark_deposit_paid` (idempotent). */
  markPaid(
    depositId: string,
    paymentIntentId: string,
    customerId: string | null,
    paymentMethodId: string | null,
  ): Promise<DepositRecord>;
  /** `public.mark_deposit_refunded`. */
  markRefunded(
    depositId: string,
    refundedCents: number,
    resolution: string | null,
  ): Promise<DepositRecord>;
  upsertPayment(row: PaymentUpsert): Promise<void>;
  /** The signed-in caller's role in the salon; null for anonymous or non-members. */
  getMemberRole(salonId: string): Promise<'owner' | 'stylist' | null>;
  /** True when the caller presented the service-role key (trusted server code, e.g. #10). */
  isServiceRole: boolean;
  /** null when STRIPE_SECRET_KEY is not configured. */
  stripe: StripeClient | null;
  /** When set, Checkout may only return to this origin (e.g. https://app.chairside.example). */
  webBaseUrl?: string;
  now?: () => Date;
}

export type DepositsErrorBody = { error: { code: string; message: string } };
export type DepositPageResponse = { page: DepositPayPage; stripeReady: boolean };
export type DepositStartResponse = { url: string };
export type DepositRefundResponse = {
  deposit: Pick<DepositRecord, 'id' | 'status' | 'refunded_cents'>;
  refundId: string;
};

export type DepositsServiceResult =
  | { status: 200; body: DepositPageResponse | DepositStartResponse | DepositRefundResponse }
  | { status: 400 | 403 | 404 | 409 | 502 | 503; body: DepositsErrorBody };

const fail = (
  status: Exclude<DepositsServiceResult['status'], 200>,
  code: string,
  message: string,
): DepositsServiceResult => ({ status, body: { error: { code, message } } });

const idOf = (value: string | { id: string } | null | undefined): string | null =>
  value == null ? null : typeof value === 'string' ? value : value.id;

/** Checkout Sessions must expire 30 minutes to 24 hours from now; follow the hold when we can. */
export function checkoutExpiry(holdExpiresAt: string | null, now: Date): number {
  const min = now.getTime() + 31 * 60_000;
  const max = now.getTime() + 23.5 * 3_600_000;
  const hold = holdExpiresAt ? new Date(holdExpiresAt).getTime() : max;
  return Math.floor(Math.max(min, Math.min(hold, max)) / 1000);
}

function returnUrlAllowed(returnUrl: string, webBaseUrl: string | undefined): boolean {
  if (!webBaseUrl) return true;
  try {
    return new URL(returnUrl).origin === new URL(webBaseUrl).origin;
  } catch {
    return false;
  }
}

export async function handleDepositsRequest(
  rawBody: unknown,
  deps: DepositsServiceDeps,
): Promise<DepositsServiceResult> {
  const parsed = depositsRequestSchema.safeParse(rawBody);
  if (!parsed.success) return fail(400, 'invalid_request', z.prettifyError(parsed.error));
  const request = parsed.data;

  try {
    if (request.action === 'refund') return await refundRequest(request, deps);

    const page = await deps.loadPage(request.token);
    if (!page) return fail(404, 'not_found', 'This payment link isn’t valid.');
    const deposit = await deps.loadDeposit(page.depositId);
    if (!deposit) return fail(404, 'not_found', 'This payment link isn’t valid.');
    const account = await deps.loadAccount(deposit.salon_id);
    const stripeReady = Boolean(deps.stripe && account?.charges_enabled);

    switch (request.action) {
      case 'page':
        return { status: 200, body: { page, stripeReady } };
      case 'status': {
        if (deps.stripe && deposit.status === 'pending' && deposit.stripe_checkout_session_id) {
          const session = await deps.stripe.checkout.sessions.retrieve(
            deposit.stripe_checkout_session_id,
            { expand: ['payment_intent'] },
          );
          if (session.payment_status === 'paid') {
            await recordPaid(deposit, session, account, deps);
          }
        }
        const fresh = (await deps.loadPage(request.token)) ?? page;
        return { status: 200, body: { page: fresh, stripeReady } };
      }
      case 'start': {
        if (!deps.stripe) return fail(503, 'stripe_not_configured', STRIPE_NOT_CONFIGURED_MESSAGE);
        if (!account?.charges_enabled) {
          return fail(409, 'payments_not_enabled', 'This salon can’t take card payments yet.');
        }
        if (deposit.status !== 'pending' || page.appointmentStatus !== 'held') {
          return fail(409, 'not_payable', 'This deposit can no longer be paid.');
        }
        if (!returnUrlAllowed(request.returnUrl, deps.webBaseUrl)) {
          return fail(400, 'invalid_request', 'Unexpected return URL');
        }
        return await startCheckout(deposit, page, account, request.returnUrl, deps, deps.stripe);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(502, 'stripe_error', redactStripeSecrets(message));
  }
}

async function startCheckout(
  deposit: DepositRecord,
  page: DepositPayPage,
  account: DepositAccount,
  returnUrl: string,
  deps: DepositsServiceDeps,
  stripe: StripeClient,
): Promise<DepositsServiceResult> {
  if (deposit.stripe_checkout_session_id) {
    const existing = await stripe.checkout.sessions.retrieve(deposit.stripe_checkout_session_id);
    if (existing.status === 'open' && existing.url) {
      return { status: 200, body: { url: existing.url } };
    }
    if (existing.payment_status === 'paid') {
      return { status: 200, body: { url: returnUrl } };
    }
  }

  const metadata = {
    purpose: 'deposit',
    salon_id: deposit.salon_id,
    appointment_id: deposit.appointment_id,
    deposit_id: deposit.id,
  };
  const url = new URL(returnUrl);
  url.searchParams.set('paid', '1');
  const cancelUrl = new URL(returnUrl);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_creation: 'always',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: deposit.currency,
          unit_amount: deposit.amount_cents,
          product_data: {
            name: `Deposit · ${page.salonName}`,
            ...(page.services ? { description: page.services } : {}),
          },
        },
      },
    ],
    payment_intent_data: {
      on_behalf_of: account.stripe_account_id,
      transfer_data: { destination: account.stripe_account_id },
      // Saved for no-show / late-cancellation fees under the salon's policy.
      setup_future_usage: 'off_session',
      description: `Deposit · ${page.salonName}`,
      metadata,
    },
    metadata,
    success_url: url.toString(),
    cancel_url: cancelUrl.toString(),
    expires_at: checkoutExpiry(page.holdExpiresAt, deps.now?.() ?? new Date()),
  });
  if (!session.url) return fail(502, 'stripe_error', 'Stripe did not return a Checkout URL');
  await deps.setCheckoutSession(deposit.id, session.id);
  return { status: 200, body: { url: session.url } };
}

/** Records a paid Checkout Session; refunds right away if the hold was already released. */
async function recordPaid(
  deposit: DepositRecord,
  session: Stripe.Checkout.Session,
  account: DepositAccount | null,
  deps: DepositsServiceDeps,
): Promise<void> {
  const intent = typeof session.payment_intent === 'object' ? session.payment_intent : null;
  const intentId = idOf(session.payment_intent);
  if (!intentId) return;
  const paymentMethodId = intent ? idOf(intent.payment_method) : null;
  const updated = await deps.markPaid(
    deposit.id,
    intentId,
    idOf(session.customer),
    paymentMethodId,
  );
  await deps.upsertPayment({
    salon_id: deposit.salon_id,
    stripe_payment_intent_id: intentId,
    stripe_charge_id: intent ? idOf(intent.latest_charge) : null,
    stripe_account_id: account?.stripe_account_id ?? null,
    amount_cents: intent?.amount_received || deposit.amount_cents,
    currency: deposit.currency,
    status: 'succeeded',
    appointment_id: deposit.appointment_id,
    description: 'Deposit',
    livemode: session.livemode,
  });
  if (updated.status === 'refund_due' && deps.stripe) {
    await refundDeposit({ ...updated, stripe_payment_intent_id: intentId }, undefined, deps);
  }
}

async function refundRequest(
  request: Extract<z.output<typeof depositsRequestSchema>, { action: 'refund' }>,
  deps: DepositsServiceDeps,
): Promise<DepositsServiceResult> {
  const deposit = await deps.loadDeposit(request.depositId);
  if (!deposit) return fail(404, 'not_found', 'Deposit not found');
  if (!deps.isServiceRole) {
    const role = await deps.getMemberRole(deposit.salon_id);
    if (!role) return fail(404, 'not_found', 'Deposit not found');
    if (deposit.status !== 'refund_due' && role !== 'owner') {
      return fail(403, 'forbidden', 'Only the salon owner can refund a deposit');
    }
  }
  if (
    !['refund_due', 'paid', 'kept'].includes(deposit.status) ||
    !deposit.stripe_payment_intent_id
  ) {
    return fail(409, 'not_refundable', 'This deposit has nothing to refund');
  }
  if (!deps.stripe) return fail(503, 'stripe_not_configured', STRIPE_NOT_CONFIGURED_MESSAGE);
  const result = await refundDeposit(deposit, request.amountCents, deps);
  return { status: 200, body: result };
}

/** Refunds through Stripe (reversing the salon's transfer) and records it. Reusable by #10. */
export async function refundDeposit(
  deposit: DepositRecord,
  amountCents: number | undefined,
  deps: Pick<DepositsServiceDeps, 'stripe' | 'markRefunded'>,
): Promise<DepositRefundResponse> {
  if (!deps.stripe) throw new Error(STRIPE_NOT_CONFIGURED_MESSAGE);
  if (!deposit.stripe_payment_intent_id) throw new Error('Deposit has no payment');
  const remaining = deposit.amount_cents - deposit.refunded_cents;
  const amount = Math.min(amountCents ?? remaining, remaining);
  const refund = await deps.stripe.refunds.create(
    {
      payment_intent: deposit.stripe_payment_intent_id,
      amount,
      reverse_transfer: true,
      reason: 'requested_by_customer',
      metadata: { salon_id: deposit.salon_id, deposit_id: deposit.id },
    },
    { idempotencyKey: `deposit-refund-${deposit.id}-${deposit.refunded_cents + amount}` },
  );
  const refunded = deposit.refunded_cents + refund.amount;
  const updated = await deps.markRefunded(
    deposit.id,
    refunded,
    deposit.status === 'refund_due' ? null : 'salon_refund',
  );
  // mark_deposit_refunded also updates the payments row (checkout credit); the charge.refunded
  // webhook confirms it.
  return {
    deposit: { id: updated.id, status: updated.status, refunded_cents: updated.refunded_cents },
    refundId: refund.id,
  };
}
