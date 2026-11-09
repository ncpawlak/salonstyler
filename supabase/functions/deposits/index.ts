// Chairside deposits (#12): the public pay page for a booking deposit, hosted Stripe Checkout,
// and refunds. STRIPE_SECRET_KEY is a function secret; without it the pay page still loads and
// says card payments aren't set up (start → 503 stripe_not_configured).
//
// POST /functions/v1/deposits
//   { "action": "page",   "token": "<64 hex>" }                     anyone with the pay link
//   { "action": "start",  "token": "...", "returnUrl": "..." }      → { url } (Stripe Checkout)
//   { "action": "status", "token": "..." }                          re-syncs after Checkout returns
//   { "action": "refund", "depositId": "...", "amountCents"?: n }   salon member JWT or service role
import { createClient } from '@supabase/supabase-js';

import {
  createStripeClient,
  handleDepositsRequest,
  type DepositPayPage,
  type DepositRecord,
  type DepositsServiceDeps,
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

const DEPOSIT_COLUMNS =
  'id, salon_id, appointment_id, status, amount_cents, refunded_cents, currency, stripe_checkout_session_id, stripe_payment_intent_id';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return error(405, 'method_not_allowed', 'Use POST');

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return error(500, 'misconfigured', 'Supabase environment is not configured');
  }

  const authorization = req.headers.get('Authorization') ?? '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';

  const serviceClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const secretKey = Deno.env.get('STRIPE_SECRET_KEY')?.trim();

  const deps: DepositsServiceDeps = {
    stripe: secretKey ? createStripeClient(secretKey) : null,
    webBaseUrl: Deno.env.get('PUBLIC_WEB_URL') || undefined,
    isServiceRole: bearer !== '' && bearer === serviceKey,
    async getMemberRole(salonId) {
      // Only refunds need a signed-in member; the pay page itself is public (token-gated).
      if (!bearer) return null;
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: userData } = await userClient.auth.getUser(bearer);
      const user = userData?.user;
      if (!user) return null;
      const { data, error } = await userClient
        .from('salon_members')
        .select('role')
        .eq('salon_id', salonId)
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) throw error;
      return (data?.role as 'owner' | 'stylist' | undefined) ?? null;
    },
    async loadPage(token) {
      const { data, error } = await serviceClient.rpc('deposit_pay_page', { p_token: token });
      if (error) throw error;
      return (data as DepositPayPage | null) ?? null;
    },
    async loadDeposit(depositId) {
      const { data, error } = await serviceClient
        .from('appointment_deposits')
        .select(DEPOSIT_COLUMNS)
        .eq('id', depositId)
        .maybeSingle<DepositRecord>();
      if (error) throw error;
      return data;
    },
    async loadAccount(salonId) {
      const { data, error } = await serviceClient
        .from('stripe_accounts')
        .select('stripe_account_id, charges_enabled')
        .eq('salon_id', salonId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    async setCheckoutSession(depositId, sessionId) {
      const { error } = await serviceClient
        .from('appointment_deposits')
        .update({ stripe_checkout_session_id: sessionId })
        .eq('id', depositId);
      if (error) throw error;
    },
    async markPaid(depositId, paymentIntentId, customerId, paymentMethodId) {
      const { data, error } = await serviceClient.rpc('mark_deposit_paid', {
        p_deposit_id: depositId,
        p_payment_intent_id: paymentIntentId,
        p_customer_id: customerId ?? undefined,
        p_payment_method_id: paymentMethodId ?? undefined,
      });
      if (error) throw error;
      return data as unknown as DepositRecord;
    },
    async markRefunded(depositId, refundedCents, resolution) {
      const { data, error } = await serviceClient.rpc('mark_deposit_refunded', {
        p_deposit_id: depositId,
        p_refunded_cents: refundedCents,
        p_resolution: resolution ?? undefined,
      });
      if (error) throw error;
      return data as unknown as DepositRecord;
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
    const result = await handleDepositsRequest(body, deps);
    return json(result.status, result.body);
  } catch (e) {
    console.error('deposits function failed', e instanceof Error ? e.message : e);
    return error(500, 'internal', 'Something went wrong');
  }
});
