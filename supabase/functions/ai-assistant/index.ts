// Ask Chairside: the owner's scheduling assistant. The model only interprets the request and
// calls tools; clients, slots and bookings come from Postgres (via the caller's JWT, so RLS keeps
// everything inside their salon) and the deterministic engine in @chairside/core. The provider key
// is read from Vault server-side and never leaves this function.
//
// POST /functions/v1/ai-assistant  (Authorization: Bearer <user JWT>)
//   { "action": "status",  "salonId" }
//   { "action": "message", "salonId", "history": [...], "text": "schedule karina for dec 18" }
//   { "action": "propose", "salonId", "clientId", "start", "services"? }   (owner tapped a slot)
//   { "action": "confirm" | "discard", "salonId", "appointmentId" }        (owner tapped a draft)
//   { "action": "create_client", "salonId", "name", "phone"? }
//
// Local development only: CHAIRSIDE_AI_DEMO=1 swaps the LLM for a scripted, rule-based stand-in
// (no key, no usage). It is ignored unless SUPABASE_URL points at a local stack.
import { DemoAssistantProvider } from '@chairside/ai/assistant/demo-provider.ts';
import { createSupabaseAssistantPort } from '@chairside/ai/assistant/supabase-port.ts';
import { handleAssistantRequest } from '@chairside/ai/server/assistant-handler.ts';
import type { ChairsideClient } from '@chairside/db';

import { aiRequestContext, corsHeaders, error, json, readJson } from '../_shared/ai-deps.ts';

const LOCAL_HOSTS = new Set(['kong', 'localhost', '127.0.0.1', 'host.docker.internal']);

function demoEnabled(): boolean {
  if (Deno.env.get('CHAIRSIDE_AI_DEMO') !== '1') return false;
  try {
    return LOCAL_HOSTS.has(new URL(Deno.env.get('SUPABASE_URL') ?? '').hostname);
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return error(405, 'method_not_allowed', 'Use POST');

  const ctx = await aiRequestContext(req);
  if (ctx instanceof Response) return ctx;
  const parsed = await readJson(req);
  if (parsed instanceof Response) return parsed;

  try {
    const userClient = ctx.userClient as unknown as ChairsideClient;
    const result = await handleAssistantRequest(parsed.body, {
      ...ctx.deps,
      createPort: (salonId) => createSupabaseAssistantPort(userClient, salonId),
      ...(demoEnabled() ? { demoProvider: () => new DemoAssistantProvider() } : {}),
    });
    if (result.status === 500) {
      // Internal error details stay in the logs.
      console.error('ai-assistant failed', result.body.error.message);
      return error(500, 'internal', 'Something went wrong');
    }
    return json(result.status, result.body);
  } catch (e) {
    console.error('ai-assistant failed', e instanceof Error ? e.message : e);
    return error(500, 'internal', 'Something went wrong');
  }
});
