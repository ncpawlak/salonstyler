import { z } from 'zod';

import { type PaymentsStatus, paymentsStatus } from '../status.ts';
import {
  accountSnapshot,
  redactStripeSecrets,
  type StripeAccountSnapshot,
  type StripeConnectClient,
} from './stripe.ts';

const returnUrlSchema = z
  .url({ protocol: /^https?$/, error: 'Return URL must be an http(s) URL' })
  .max(2000);

export const paymentsRequestSchema = z.discriminatedUnion('action', [
  /** Re-syncs the account from Stripe (e.g. after returning from onboarding). Any member. */
  z.object({ action: z.literal('status'), salonId: z.uuid() }),
  /** Creates the Express account if needed and returns a hosted onboarding link. Owner only. */
  z.object({
    action: z.literal('onboard'),
    salonId: z.uuid(),
    /** Where Stripe sends the user back. Falls back to the server's PAYMENTS_RETURN_URL. */
    returnUrl: returnUrlSchema.optional(),
  }),
  /** One-time login link to the Stripe Express dashboard (payouts, bank). Owner only. */
  z.object({ action: z.literal('dashboard'), salonId: z.uuid() }),
]);
export type PaymentsRequest = z.infer<typeof paymentsRequestSchema>;

export type StripeAccountRecord = StripeAccountSnapshot & { salon_id: string; updated_at: string };

export interface PaymentsServiceDeps {
  getMemberRole(salonId: string): Promise<'owner' | 'stylist' | null>;
  getSalonName(salonId: string): Promise<string | null>;
  loadAccount(salonId: string): Promise<StripeAccountRecord | null>;
  saveAccount(salonId: string, snapshot: StripeAccountSnapshot): Promise<StripeAccountRecord>;
  /** null when STRIPE_SECRET_KEY is not configured. */
  stripe: StripeConnectClient | null;
  /** https URL used when the client doesn't send one (native apps can't use custom schemes). */
  defaultReturnUrl?: string;
  /** Two-letter country for new accounts. Defaults to the platform's country. */
  country?: string;
}

export type PaymentsErrorBody = { error: { code: string; message: string } };
export type PaymentsAccountResponse = {
  configured: boolean;
  status: PaymentsStatus;
  account: StripeAccountRecord | null;
};
export type PaymentsLinkResponse = { url: string; account: StripeAccountRecord | null };

export type PaymentsServiceResult =
  | { status: 200; body: PaymentsAccountResponse | PaymentsLinkResponse }
  | { status: 400 | 403 | 409 | 502 | 503; body: PaymentsErrorBody };

const fail = (
  status: Exclude<PaymentsServiceResult['status'], 200>,
  code: string,
  message: string,
): PaymentsServiceResult => ({ status, body: { error: { code, message } } });

export const STRIPE_NOT_CONFIGURED_MESSAGE =
  'Payments aren’t set up on the server yet: STRIPE_SECRET_KEY is missing. See supabase/README.md → Payments.';

/** Beauty and barber shops. */
const SALON_MCC = '7230';

function stripeFailure(error: unknown): PaymentsServiceResult {
  const message = error instanceof Error ? error.message : String(error);
  return fail(502, 'stripe_error', redactStripeSecrets(message));
}

function withQuery(url: string, key: string, value: string): string {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

export async function handlePaymentsRequest(
  rawBody: unknown,
  deps: PaymentsServiceDeps,
): Promise<PaymentsServiceResult> {
  const parsed = paymentsRequestSchema.safeParse(rawBody);
  if (!parsed.success) return fail(400, 'invalid_request', z.prettifyError(parsed.error));
  const request = parsed.data;
  const { stripe } = deps;

  const role = await deps.getMemberRole(request.salonId);
  if (!role) return fail(403, 'forbidden', 'You are not a member of this salon');

  if (request.action === 'status') {
    let account = await deps.loadAccount(request.salonId);
    if (account && stripe) {
      try {
        const fresh = await stripe.accounts.retrieve(account.stripe_account_id);
        account = await deps.saveAccount(request.salonId, accountSnapshot(fresh));
      } catch (error) {
        return stripeFailure(error);
      }
    }
    return {
      status: 200,
      body: { configured: !!stripe, status: paymentsStatus(account), account },
    };
  }

  if (role !== 'owner') return fail(403, 'forbidden', 'Only the salon owner can manage payments');
  if (!stripe) return fail(503, 'stripe_not_configured', STRIPE_NOT_CONFIGURED_MESSAGE);

  if (request.action === 'dashboard') {
    const account = await deps.loadAccount(request.salonId);
    if (!account?.details_submitted) {
      return fail(409, 'not_onboarded', 'Finish Stripe setup before opening the dashboard');
    }
    try {
      const link = await stripe.accounts.createLoginLink(account.stripe_account_id);
      return { status: 200, body: { url: link.url, account } };
    } catch (error) {
      return stripeFailure(error);
    }
  }

  const returnUrl = request.returnUrl ?? deps.defaultReturnUrl;
  if (!returnUrl) {
    return fail(400, 'invalid_request', 'A return URL is required to start Stripe onboarding');
  }

  try {
    let account = await deps.loadAccount(request.salonId);
    if (!account) {
      const name = await deps.getSalonName(request.salonId);
      const created = await stripe.accounts.create(
        {
          type: 'express',
          ...(deps.country ? { country: deps.country } : {}),
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
          business_profile: {
            mcc: SALON_MCC,
            ...(name ? { name } : {}),
            product_description: 'Hair salon services',
          },
          metadata: { salon_id: request.salonId },
        },
        // A double tap or retry must not create a second account for the same salon.
        { idempotencyKey: `chairside-connect-account-${request.salonId}` },
      );
      account = await deps.saveAccount(request.salonId, accountSnapshot(created));
    }
    const link = await stripe.accountLinks.create({
      account: account.stripe_account_id,
      type: 'account_onboarding',
      refresh_url: withQuery(returnUrl, 'stripe', 'refresh'),
      return_url: withQuery(returnUrl, 'stripe', 'return'),
    });
    return { status: 200, body: { url: link.url, account } };
  } catch (error) {
    return stripeFailure(error);
  }
}
