// Shared wiring for the AI Edge Functions: the caller's user-scoped client (RLS), the service
// client (Vault key + usage metering), and the dependencies the AI handlers need.
import { createClient } from '@supabase/supabase-js';

import type { AiServiceDeps } from '@chairside/ai/server/handler.ts';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export const error = (status: number, code: string, message: string) =>
  json(status, { error: { code, message } });

export interface AiRequestContext {
  /** Carries the caller's JWT: every query is subject to RLS. */
  userClient: ReturnType<typeof createClient>;
  userId: string;
  deps: AiServiceDeps;
}

/** Authenticates the request. Returns a Response to send back on failure. */
export async function aiRequestContext(req: Request): Promise<AiRequestContext | Response> {
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

  // User-scoped client: membership checks and all salon data go through RLS.
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
      return ((data as { role?: string } | null)?.role as 'owner' | 'stylist' | undefined) ?? null;
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

  return { userClient, userId: user.id, deps };
}

export async function readJson(req: Request): Promise<{ body: unknown } | Response> {
  try {
    return { body: await req.json() };
  } catch {
    return error(400, 'invalid_request', 'Body must be JSON');
  }
}
