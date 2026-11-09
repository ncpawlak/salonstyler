// Chairside AI gateway. All LLM traffic goes through here so provider keys stay server-side:
// the key is read from Supabase Vault with the service role and is never returned to clients.
//
// POST /functions/v1/ai  (Authorization: Bearer <user JWT>)
//   { "action": "test", "salonId": "...", "provider"?, "model"?, "apiKey"? }
//   { "action": "chat", "salonId": "...", "messages": [...], "tools"?: [...] }
import { handleAiRequest } from '@chairside/ai/server/handler.ts';

import { aiRequestContext, corsHeaders, error, json, readJson } from '../_shared/ai-deps.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return error(405, 'method_not_allowed', 'Use POST');

  const ctx = await aiRequestContext(req);
  if (ctx instanceof Response) return ctx;
  const parsed = await readJson(req);
  if (parsed instanceof Response) return parsed;

  try {
    const result = await handleAiRequest(parsed.body, ctx.deps);
    return json(result.status, result.body);
  } catch (e) {
    console.error('ai function failed', e instanceof Error ? e.message : e);
    return error(500, 'internal', 'Something went wrong');
  }
});