import Stripe from 'stripe';

import type { StripeAccountState } from '../status.ts';

/** Pinned so webhook payloads and responses keep the shape this code was written against. */
export const STRIPE_API_VERSION = '2026-10-28.endive';

/**
 * The slice of the Stripe SDK this package uses. The real client satisfies it; tests pass a mock.
 */
export interface StripeConnectClient {
  accounts: {
    create(
      params: Stripe.AccountCreateParams,
      options?: { idempotencyKey?: string },
    ): Promise<Stripe.Account>;
    retrieve(id: string): Promise<Stripe.Account>;
    createLoginLink(id: string): Promise<{ url: string }>;
  };
  accountLinks: {
    create(params: Stripe.AccountLinkCreateParams): Promise<{ url: string; expires_at: number }>;
  };
}

type IdempotentOptions = { idempotencyKey?: string };

/** Subset of the test-helper params (the SDK doesn't re-export the TestHelpers namespace). */
export interface PresentPaymentMethodParams {
  type?: 'card_present';
  card_present?: { number?: string };
}

/** Terminal / checkout slice (Tap to Pay, simulated readers, refunds). */
export interface StripeCheckoutClient {
  paymentIntents: {
    create(
      params: Stripe.PaymentIntentCreateParams,
      options?: IdempotentOptions,
    ): Promise<Stripe.PaymentIntent>;
    retrieve(id: string, params?: { expand?: string[] }): Promise<Stripe.PaymentIntent>;
    cancel(id: string): Promise<Stripe.PaymentIntent>;
  };
  refunds: {
    create(params: Stripe.RefundCreateParams, options?: IdempotentOptions): Promise<Stripe.Refund>;
  };
  terminal: {
    connectionTokens: { create(params: { location?: string }): Promise<{ secret: string }> };
    locations: {
      create(
        params: Stripe.Terminal.LocationCreateParams,
        options?: IdempotentOptions,
      ): Promise<{ id: string }>;
    };
    readers: {
      list(params: Stripe.Terminal.ReaderListParams): Promise<{ data: Stripe.Terminal.Reader[] }>;
      create(params: Stripe.Terminal.ReaderCreateParams): Promise<Stripe.Terminal.Reader>;
      cancelAction(id: string): Promise<unknown>;
      processPaymentIntent(
        id: string,
        params: Stripe.Terminal.ReaderProcessPaymentIntentParams,
      ): Promise<Stripe.Terminal.Reader>;
      /** Test mode only: taps a test card on a simulated reader. */
      presentPaymentMethod(
        id: string,
        params: PresentPaymentMethodParams,
      ): Promise<Stripe.Terminal.Reader>;
    };
  };
}

export type StripeClient = StripeConnectClient & StripeCheckoutClient;

/** Uses fetch + Web Crypto so the same code runs in Deno (Edge Functions) and Node (tests). */
export function createStripeClient(secretKey: string): StripeClient {
  const stripe = new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
    appInfo: { name: 'Chairside' },
  });
  return {
    accounts: {
      create: (params, options) => stripe.accounts.create(params, options),
      retrieve: (id) => stripe.accounts.retrieve(id),
      createLoginLink: (id) => stripe.accounts.createLoginLink(id),
    },
    accountLinks: { create: (params) => stripe.accountLinks.create(params) },
    paymentIntents: {
      create: (params, options) => stripe.paymentIntents.create(params, options),
      retrieve: (id, params) => stripe.paymentIntents.retrieve(id, params),
      cancel: (id) => stripe.paymentIntents.cancel(id),
    },
    refunds: { create: (params, options) => stripe.refunds.create(params, options) },
    terminal: {
      connectionTokens: { create: (params) => stripe.terminal.connectionTokens.create(params) },
      locations: {
        create: (params, options) => stripe.terminal.locations.create(params, options),
      },
      readers: {
        list: async (params) => ({ data: (await stripe.terminal.readers.list(params)).data }),
        create: (params) => stripe.terminal.readers.create(params),
        cancelAction: (id) => stripe.terminal.readers.cancelAction(id),
        processPaymentIntent: (id, params) =>
          stripe.terminal.readers.processPaymentIntent(id, params),
        presentPaymentMethod: (id, params) =>
          stripe.testHelpers.terminal.readers.presentPaymentMethod(id, params),
      },
    },
  };
}

export type StripeEventVerifier = (payload: string, signature: string) => Promise<Stripe.Event>;

/** Verifies the `Stripe-Signature` header (HMAC + 5-minute tolerance) and parses the event. */
/**
 * Verifies the Stripe-Signature header. `webhookSecrets` may hold several comma-separated
 * `whsec_…` values: the platform ("Your account") and "Connected accounts" destinations each
 * have their own signing secret but can share one endpoint.
 */
export function createWebhookVerifier(webhookSecrets: string): StripeEventVerifier {
  const secrets = webhookSecrets
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (secrets.length === 0) throw new Error('No Stripe webhook secret configured');
  const cryptoProvider = Stripe.createSubtleCryptoProvider();
  return async (payload, signature) => {
    let lastError: unknown;
    for (const secret of secrets) {
      try {
        return await Stripe.webhooks.constructEventAsync(
          payload,
          signature,
          secret,
          undefined,
          cryptoProvider,
        );
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError;
  };
}

export type StripeAccountSnapshot = StripeAccountState & {
  country: string | null;
  default_currency: string | null;
};

export function accountSnapshot(account: Stripe.Account): StripeAccountSnapshot {
  const requirements = account.requirements;
  const due = new Set([...(requirements?.past_due ?? []), ...(requirements?.currently_due ?? [])]);
  return {
    stripe_account_id: account.id,
    details_submitted: account.details_submitted ?? false,
    charges_enabled: account.charges_enabled ?? false,
    payouts_enabled: account.payouts_enabled ?? false,
    requirements_due: [...due].sort(),
    disabled_reason: requirements?.disabled_reason ?? null,
    country: account.country ?? null,
    default_currency: account.default_currency ?? null,
  };
}

const SECRET_PATTERN = /\b(sk|rk|whsec)_(test|live)?_?[A-Za-z0-9]{6,}/g;

/** Defensive: never echo a Stripe key or webhook secret back to a client or log. */
export function redactStripeSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, (match) => `${match.split('_')[0]}_…`);
}
