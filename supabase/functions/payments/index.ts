// Chairside payments: Stripe Connect Express onboarding and account status for a salon.
// STRIPE_SECRET_KEY is a function secret; it never reaches the app.
//
// POST /functions/v1/payments  (Authorization: Bearer <user JWT>)
//   { "action": "status",    "salonId": "..." }                    any member; re-syncs from Stripe
//   { "action": "onboard",   "salonId": "...", "returnUrl"?: "..." } owner; hosted onboarding link
//   { "action": "dashboard", "salonId": "..." }                     owner; Express dashboard link
import { createClient } from '@supabase/supabase-js';

import {
  createStripeClient,
  handlePaymentsRequest,
  type PaymentsServiceDeps,
  type StripeAccountRecord,
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

const ACCOUNT_COLUMNS =
  'salon_id, stripe_account_id, details_submitted, charges_enabled, payouts_enabled, requirements_due, disabled_reason, country, default_currency, updated_at';

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
    return error(401, 'unauthorized', 'Sign in to manage payments');
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
  if (userError || !user) return error(401, 'unauthorized', 'Sign in to manage payments');

  // Service client: the only path that can write stripe_accounts.
  const serviceClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const secretKey = Deno.env.get('STRIPE_SECRET_KEY')?.trim();

  const deps: PaymentsServiceDeps = {
    stripe: secretKey ? createStripeClient(secretKey) : null,
    defaultReturnUrl: Deno.env.get('PAYMENTS_RETURN_URL') || undefined,
    country: Deno.env.get('STRIPE_CONNECT_COUNTRY') || undefined,
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
      const { data, error } = await userClient
        .from('salons')
        .select('name')
        .eq('id', salonId)
        .maybeSingle();
      if (error) throw error;
      return data?.name ?? null;
    },
    async loadAccount(salonId) {
      const { data, error } = await serviceClient
        .from('stripe_accounts')
        .select(ACCOUNT_COLUMNS)
        .eq('salon_id', salonId)
        .maybeSingle<StripeAccountRecord>();
      if (error) throw error;
      return data;
    },
    async saveAccount(salonId, snapshot) {
      const { data, error } = await serviceClient
        .from('stripe_accounts')
        .upsert({ salon_id: salonId, ...snapshot }, { onConflict: 'salon_id' })
        .select(ACCOUNT_COLUMNS)
        .single<StripeAccountRecord>();
      if (error) throw error;
      return data;
    },
  };

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return error(400, 'invalid_request', 'Body must be JSON');
  }

  try {
    const result = await handlePaymentsRequest(body, deps);
    return json(result.status, result.body);
  } catch (e) {
    console.error('payments function failed', e instanceof Error ? e.message : e);
    return error(500, 'internal', 'Something went wrong');
  }
});
