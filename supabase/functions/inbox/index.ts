// Inbox agent: the endpoint the salon's iOS Shortcut forwards keyword texts to
// (docs/spikes/ios-shortcut-keyword-bridge.md). The model only interprets the message; the
// scheduling engine in @chairside/core picks the slot, and Postgres holds it as a `requested`
// appointment for the stylist to approve. Nothing is ever sent back to the client (draft mode).
//
// POST /functions/v1/inbox   X-Bridge-Token: csb_…   (no user JWT: verify_jwt = false)
//   { "sender": "Karina M.", "senderPhone": "+1 555…", "text": "Chairside can I get…",
//     "receivedAt": "2026-12-01T14:03:22-05:00", "bridgeVersion": "1" }
// → 200 { ok, status: "captured" | "duplicate" | "ignored" | "test", requestId?, reply? }
//   `reply` only in auto-reply mode: the Shortcut texts it back to the sender.
//   Empty text (a hand run) or "<keyword> test" records a bridge test; nothing is captured.
//   401 unknown token · 429 rate limited / AI budget · 409 no AI provider
//
// Local development only: CHAIRSIDE_AI_DEMO=1 parses with rules instead of the salon's model.
// It is ignored unless SUPABASE_URL points at a local stack.
import { createClient } from '@supabase/supabase-js';

import {
  authenticateBridgeToken,
  createSupabaseInboxPort,
  markBridgeTested,
} from '@chairside/ai/inbox/supabase-port.ts';
import { handleInboxRequest } from '@chairside/ai/inbox/handler.ts';
import type { ChairsideClient } from '@chairside/db';

import { error, json, readJson, serviceAiDeps } from '../_shared/ai-deps.ts';

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
  if (req.method !== 'POST') return error(405, 'method_not_allowed', 'Use POST');

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return error(500, 'misconfigured', 'Supabase environment is not configured');
  }
  const parsed = await readJson(req);
  if (parsed instanceof Response) return parsed;

  // The bridge token is the only credential; the salon comes from it, never from the body.
  const serviceClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const db = serviceClient as unknown as ChairsideClient;

  try {
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
