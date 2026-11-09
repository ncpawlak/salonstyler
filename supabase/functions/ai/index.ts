// Chairside AI gateway. All LLM traffic goes through here so provider keys stay server-side:
// the key is read from Supabase Vault with the service role and is never returned to clients.
//
// POST /functions/v1/ai  (Authorization: Bearer <user JWT>)
//   { "action": "test", "salonId": "...", "provider"?, "model"?, "apiKey"? }
//   { "action": "chat", "salonId": "...", "messages": [...], "tools"?: [...] }
//   { "action": "map_columns", "salonId": "...", "kind": "clients", "headers": [...], "samples": [[...]] }
//
// Local development only: CHAIRSIDE_AI_DEMO=1 answers map_columns with the deterministic header
// guess (no key, no usage). It is ignored unless SUPABASE_URL points at a local stack.
import { handleAiRequest } from '@chairside/ai/server/handler.ts';

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
    const result = await handleAiRequest(parsed.body, { ...ctx.deps, demoMapping: demoEnabled() });
    return json(result.status, result.body);
  } catch (e) {
    console.error('ai function failed', e instanceof Error ? e.message : e);
    return error(500, 'internal', 'Something went wrong');
  }
});