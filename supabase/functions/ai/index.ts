// Chairside AI gateway. All LLM traffic goes through here so provider keys stay server-side:
// the key is read from Supabase Vault with the service role and is never returned to clients.
//
// POST /functions/v1/ai  (Authorization: Bearer <user JWT>)
//   { "action": "test", "salonId": "...", "provider"?, "model"?, "apiKey"? }
//   { "action": "chat", "salonId": "...", "messages": [...], "tools"?: [...] }
import { createClient } from '@supabase/supabase-js';

import { type AiServiceDeps, handleAiRequest } from '@chairside/ai/server/handler.ts';

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
    return error(401, 'unauthorized', 'Sign in to use AI features');
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
  if (userError || !user) return error(401, 'unauthorized', 'Sign in to use AI features');

  // Service client: the only path that can read the decrypted key or write usage rows.
  const serviceClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const deps: AiServiceDeps = {
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
    async loadConfig(salonId) {
      const { data, error } = await serviceClient
        .rpc('get_ai_provider_secret', { p_salon_id: salonId })
        .maybeSingle<{
          provider: 'openai' | 'anthropic' | 'gemini';
          model: string;
          api_key: string;
          monthly_token_budget: number;
        }>();
      if (error) throw error;
      if (!data) return null;
      return {
        provider: data.provider,
        model: data.model,
        apiKey: data.api_key,
        monthlyTokenBudget: Number(data.monthly_token_budget),
      };
    },
    async tokensUsedThisMonth(salonId) {
      const { data, error } = await serviceClient.rpc('ai_tokens_used_this_month', {
        p_salon_id: salonId,
      });
      if (error) throw error;
      return Number(data ?? 0);
    },
    async recordUsage(entry) {
      const { error } = await serviceClient.from('ai_usage').insert({
        salon_id: entry.salonId,
        user_id: user.id,
        provider: entry.provider,
        model: entry.model,
        purpose: entry.purpose,
        input_tokens: entry.inputTokens,
        output_tokens: entry.outputTokens,
      });
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
    const result = await handleAiRequest(body, deps);
    return json(result.status, result.body);
  } catch (e) {
    console.error('ai function failed', e instanceof Error ? e.message : e);
    return error(500, 'internal', 'Something went wrong');
  }
});
