// Inbox agent: the endpoint the salon's iOS Shortcut forwards keyword texts to
// (docs/spikes/ios-shortcut-keyword-bridge.md). The model only interprets the message; the
// scheduling engine in @chairside/core picks the slot, and Postgres holds it as a `requested`
// appointment for the stylist to approve. Replies (#7) are drafted by the model but only leave
// through the stylist's Send tap, or, with the opt-in auto-send, in `replies` for the Shortcut.
//
// POST /functions/v1/inbox   X-Bridge-Token: csb_…   (no user JWT: verify_jwt = false)
//   { "sender": "Karina M.", "senderPhone": "+1 555…", "text": "Chairside can I get…",
//     "receivedAt": "2026-12-01T14:03:22-05:00", "bridgeVersion": "3" }
//   or { "action": "outbox" } to collect queued replies (#7)
// → 200 { ok, status: "captured" | "duplicate" | "ignored" | "test" | "confirmed" | "outbox",
//         requestId?, reply?, replies: [{ id, to, text }] }
//   `reply` only in the bridge's auto-reply mode (#6): the Shortcut texts it back to the sender.
//   `replies`: approved confirmations queued by auto-send (#7), only for Shortcut v3+ or an outbox
//   call; the Shortcut texts each one with Send Message.
//   Empty text (a hand run) or "<keyword> test" records a bridge test; nothing is captured.
//   401 unknown token · 429 rate limited / AI budget · 409 no AI provider
//
// Manual capture (#2, Bridge E): the app posts a pasted or shared message, or a screenshot of the
// thread, with the stylist's JWT instead of a bridge token. A vision model transcribes the
// screenshot; the result goes through the same pipeline and lands in the same approval list.
//   Authorization: Bearer <user JWT>
//   { "action": "capture", "salonId": "…", "source": "paste" | "share" | "screenshot",
//     "text"?: "…", "sender"?: "…", "senderPhone"?: "…",
//     "image"?: { "mimeType": "image/jpeg", "data": "<base64>" } }
// → 200 { ok, status, requestId?, source, read? } · 401 not signed in · 403 not a member
//   409 no AI provider · 422 no message in the screenshot · 429 AI budget
//
// Local development only: CHAIRSIDE_AI_DEMO=1 parses with rules instead of the salon's model (and
// reads every screenshot as a fixed Instagram DM).
// It is ignored unless SUPABASE_URL points at a local stack.
import { createClient } from '@supabase/supabase-js';

import {
  authenticateBridgeToken,
  createSupabaseInboxPort,
  markBridgeTested,
} from '@chairside/ai/inbox/supabase-port.ts';
import { handleInboxRequest } from '@chairside/ai/inbox/handler.ts';
import { handleManualCapture, isManualCapture } from '@chairside/ai/inbox/manual.ts';
import type { ChairsideClient } from '@chairside/db';

import {
  aiRequestContext,
  corsHeaders,
  error,
  json,
  readJson,
  serviceAiDeps,
} from '../_shared/ai-deps.ts';

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
  // The app's manual capture runs in browsers too (web build).
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return error(405, 'method_not_allowed', 'Use POST');

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return error(500, 'misconfigured', 'Supabase environment is not configured');
  }
  const parsed = await readJson(req);
  if (parsed instanceof Response) return parsed;

  // For the bridge, its token is the only credential: the salon comes from it, never from the body.
  const serviceClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const db = serviceClient as unknown as ChairsideClient;

  try {
    if (!req.headers.get('X-Bridge-Token') && isManualCapture(parsed.body)) {
      // Signed-in stylist: membership is checked against their JWT; writes use the service port.
      const ctx = await aiRequestContext(req);
      if (ctx instanceof Response) return ctx;
      const result = await handleManualCapture(parsed.body, {
        ...ctx.deps,
        markTested: (salonId) => markBridgeTested(db, salonId),
        createPort: (salonId) => createSupabaseInboxPort(db, salonId),
        demo: demoEnabled(),
      });
      if (result.status === 500) {
        console.error('inbox capture failed', result.body.error.message);
        return error(500, 'internal', 'Something went wrong');
      }
      return json(result.status, result.body);
    }

    const result = await handleInboxRequest(req.headers.get('X-Bridge-Token'), parsed.body, {
      ...serviceAiDeps(serviceClient, null),
      authenticate: (token, meta) => authenticateBridgeToken(db, token, meta),
      markTested: (salonId) => markBridgeTested(db, salonId),
      createPort: (salonId) => createSupabaseInboxPort(db, salonId),
      demo: demoEnabled(),
    });
    if (result.status === 500) {
      console.error('inbox failed', result.body.error.message);
      return error(500, 'internal', 'Something went wrong');
    }
    return json(result.status, result.body);
  } catch (e) {
    console.error('inbox failed', e instanceof Error ? e.message : e);
    return error(500, 'internal', 'Something went wrong');
  }
});
