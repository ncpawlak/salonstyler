// Service-menu import (#16). Reads a Vagaro booking-page link (fetched here, server-side), pasted
// menu text, or a menu screenshot, and returns services for the owner to review. Nothing is
// saved here: the app saves the reviewed rows through the `save_service` RPC.
//
// POST /functions/v1/import-services  (Authorization: Bearer <user JWT>)
//   { "source": "url",   "salonId": "...", "url": "vagaro.com/your-salon" }
//   { "source": "text",  "salonId": "...", "text": "Women's Haircut 45 min $65 ..." }
//   { "source": "image", "salonId": "...", "mimeType": "image/png", "data": "<base64>" }
//
// Local development only: CHAIRSIDE_AI_DEMO=1 skips the model (sample menu for screenshots, line
// parser for text). It is ignored unless SUPABASE_URL points at a local stack.
import { handleImportServices } from '@chairside/ai/server/import-services-handler.ts';

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
    const result = await handleImportServices(parsed.body, { ...ctx.deps, demo: demoEnabled() });
    return json(result.status, result.body);
  } catch (e) {
    console.error('import-services failed', e instanceof Error ? e.message : e);
    return error(500, 'internal', 'Something went wrong');
  }
});
