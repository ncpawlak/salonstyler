// Stripe webhook endpoint (platform + Connect events). Stripe calls this without a user JWT, so
// `verify_jwt = false` in config.toml; every request is authenticated by its Stripe-Signature
// header instead (STRIPE_WEBHOOK_SECRET).
//
// Handles: account.updated, payment_intent.{processing,succeeded,payment_failed,canceled},
// charge.refunded. Everything else is acknowledged and ignored. A succeeded PaymentIntent with
// `metadata.checkout_id` also closes that checkout (backstop if the app went offline mid-tap).
import { createClient } from '@supabase/supabase-js';

import {
  createWebhookVerifier,
  handleStripeWebhook,
  type PaymentsStore,
} from '@chairside/payments/server/index.ts';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')?.trim();
  if (!supabaseUrl || !serviceKey || !webhookSecret) {
    console.error('stripe-webhook: SUPABASE_* or STRIPE_WEBHOOK_SECRET is not configured');
    return json(500, { error: 'Webhook is not configured' });
  }

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const store: PaymentsStore = {
    async updateAccount(snapshot) {
      const { data, error } = await db
        .from('stripe_accounts')
        .update(snapshot)
        .eq('stripe_account_id', snapshot.stripe_account_id)
        .select('salon_id')
        .maybeSingle();
      if (error) throw error;
      return data?.salon_id ?? null;
    },
    async salonIdForAccount(stripeAccountId) {
      const { data, error } = await db
        .from('stripe_accounts')
        .select('salon_id')
        .eq('stripe_account_id', stripeAccountId)
        .maybeSingle();
      if (error) throw error;
      return data?.salon_id ?? null;
    },
    async getPaymentStatus(paymentIntentId) {
      const { data, error } = await db
        .from('payments')
        .select('status')
        .eq('stripe_payment_intent_id', paymentIntentId)
        .maybeSingle();
      if (error) throw error;
      return data?.status ?? null;
    },
    async upsertPayment(row) {
      const { error } = await db
        .from('payments')
        .upsert(row, { onConflict: 'stripe_payment_intent_id' });
      if (error) throw error;
    },
    async completeCheckout(salonId, checkoutId, paymentIntentId) {
      const { data: checkout, error: loadError } = await db
        .from('checkouts')
        .select('id')
        .eq('id', checkoutId)
        .eq('salon_id', salonId)
        .maybeSingle();
      if (loadError) throw loadError;
      if (!checkout) return;
      const { error } = await db.rpc('complete_card_checkout', {
        p_checkout_id: checkoutId,
        p_payment_intent_id: paymentIntentId,
      });
      if (error) throw error;
    },
  };

  // The signature covers the exact bytes Stripe sent, so read the raw body (never re-serialize).
  const payload = await req.text();

  try {
    const result = await handleStripeWebhook(payload, req.headers.get('Stripe-Signature'), {
      verify: createWebhookVerifier(webhookSecret),
      store,
    });
    return json(result.status, result.body);
  } catch (e) {
    // 5xx makes Stripe retry with backoff; all writes are idempotent upserts.
    console.error('stripe-webhook failed', e instanceof Error ? e.message : e);
    return json(500, { error: 'Webhook handler failed' });
  }
});
