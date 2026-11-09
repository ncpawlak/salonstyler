// Chairside checkout: card payments for a salon checkout through Stripe Terminal.
// STRIPE_SECRET_KEY is a function secret; it never reaches the app.
//
// POST /functions/v1/checkout  (Authorization: Bearer <user JWT>)
//   { "action": "connection_token", "salonId": "..." }   Tap to Pay reader token + Location
//   { "action": "create_intent",    "checkoutId": "..." } card_present PaymentIntent (client secret)
//   { "action": "simulate",         "checkoutId": "...", "card"?: "success" | "declined" }
//                                                          test mode: simulated reader taps a card
//   { "action": "complete",         "checkoutId": "..." } confirm with Stripe, mark checkout paid
//   { "action": "refund",           "checkoutId": "...", "amountCents"?: n }   owner only
import { createClient } from '@supabase/supabase-js';

import {
  type CheckoutRecord,
  type CheckoutServiceDeps,
  createStripeClient,
  handleCheckoutRequest,
} from '@chairside/payments/server/index.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const error = (status: number, code: string, message: string) =>
  json(status, { error: { code, message } });

const CHECKOUT_COLUMNS =
  'id, salon_id, appointment_id, status, method, currency, amount_due_cents, stripe_payment_intent_id';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return error(405, 'method_not_allowed', 'Use POST');

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return error(500, 'misconfigured', 'Supabase environment is not configured');
  }

  const authorization = req.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return error(401, 'unauthorized', 'Sign in to take payments');
  }

  // User-scoped client: membership checks go through RLS on salon_members.
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser(
    authorization.slice('Bearer '.length),
  );
  const user = userData?.user;
  if (userError || !user) return error(401, 'unauthorized', 'Sign in to take payments');

  // Service client: checkouts, payments and stripe_accounts are not writable by app users.
  const serviceClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const secretKey = Deno.env.get('STRIPE_SECRET_KEY')?.trim();

  const deps: CheckoutServiceDeps = {
    stripe: secretKey ? createStripeClient(secretKey) : null,
    testMode: !!secretKey?.startsWith('sk_test_') || !!secretKey?.startsWith('rk_test_'),
    terminalLocationId: Deno.env.get('STRIPE_TERMINAL_LOCATION_ID') || undefined,
    async getMemberRole(salonId) {
      const { data, error } = await userClient
        .from('salon_members')
        .select('role')
        .eq('salon_id', salonId)
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) throw error;
      return (data?.role as 'owner' | 'stylist' | undefined) ?? null;
    },
    async getSalonName(salonId) {
      const { data, error } = await serviceClient
        .from('salons')
        .select('name')
        .eq('id', salonId)
        .maybeSingle();
      if (error) throw error;
      return data?.name ?? null;
    },
    async loadCheckout(checkoutId) {
      const { data, error } = await serviceClient
        .from('checkouts')
        .select(CHECKOUT_COLUMNS)
        .eq('id', checkoutId)
        .maybeSingle<CheckoutRecord>();
      if (error) throw error;
      return data;
    },
    async loadAccount(salonId) {
      const { data, error } = await serviceClient
        .from('stripe_accounts')
        .select('stripe_account_id, charges_enabled, terminal_location_id')
        .eq('salon_id', salonId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    async saveLocation(salonId, locationId) {
      const { error } = await serviceClient
        .from('stripe_accounts')
        .update({ terminal_location_id: locationId })
        .eq('salon_id', salonId);
      if (error) throw error;
    },
    async setPaymentIntent(checkoutId, paymentIntentId) {
      const { error } = await serviceClient
        .from('checkouts')
        .update({ stripe_payment_intent_id: paymentIntentId })
        .eq('id', checkoutId)
        .eq('status', 'open');
      if (error) throw error;
    },
    async completeCheckout(checkoutId, paymentIntentId, card) {
      const { data, error } = await serviceClient
        .rpc('complete_card_checkout', {
          p_checkout_id: checkoutId,
          p_payment_intent_id: paymentIntentId,
          ...(card.brand ? { p_card_brand: card.brand } : {}),
          ...(card.last4 ? { p_card_last4: card.last4 } : {}),
        })
        .select(CHECKOUT_COLUMNS)
        .single<CheckoutRecord>();
      if (error) throw error;
      return data;
    },
    async upsertPayment(row) {
      const { error } = await serviceClient
        .from('payments')
        .upsert(row, { onConflict: 'stripe_payment_intent_id' });
      if (error) throw error;
    },
  };

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return error(400, 'invalid_request', 'Body must be JSON');
  }

  try {
    const result = await handleCheckoutRequest(body, deps);
    return json(result.status, result.body);
  } catch (e) {
    console.error('checkout function failed', e instanceof Error ? e.message : e);
    return error(500, 'internal', 'Something went wrong');
  }
});
