// Public booking page API: /b/{salon-slug} on the web app. Strangers browse the salon's online
// menu, get open times from the scheduling engine, chat with a read-only concierge, verify their
// email with a code and book. The model only interprets; @chairside/core picks every slot, and
// Postgres (book_public_appointment) re-checks it under the no-overlap constraint.
//
// POST /functions/v1/public-booking   (verify_jwt = false: signed-out clients call it)
//   { action: "page" | "slots" | "send_code" | "book" | "my_bookings" | "chat", slug, … }
//   Authorization: Bearer <client access token>   (book / my_bookings / chat, after the code)
// Every action is rate limited per IP (plus per email, phone, user or salon where it matters).
// Only service-role RPCs touch data, and they return the salon's page, busy time without names,
// and the verified caller's own bookings: never other clients.
//
// Local development only: CHAIRSIDE_AI_DEMO=1 uses a scripted concierge instead of the salon's
// key. It is ignored unless SUPABASE_URL points at a local stack.
import { createClient } from '@supabase/supabase-js';

import { DemoConciergeProvider } from '@chairside/ai/public-booking/demo-provider.ts';
import { handlePublicBookingRequest } from '@chairside/ai/public-booking/handler.ts';
import { createSupabasePublicBookingPort } from '@chairside/ai/public-booking/supabase-port.ts';
import type { ChairsideClient } from '@chairside/db';

import { corsHeaders, error, json, readJson, serviceAiDeps } from '../_shared/ai-deps.ts';

const LOCAL_HOSTS = new Set(['kong', 'localhost', '127.0.0.1', 'host.docker.internal']);

function demoEnabled(): boolean {
  if (Deno.env.get('CHAIRSIDE_AI_DEMO') !== '1') return false;
  try {
    return LOCAL_HOSTS.has(new URL(Deno.env.get('SUPABASE_URL') ?? '').hostname);
  } catch {
    return false;
  }
}

/** The bearer token if it is a signed-in user's JWT (not the anon/publishable key). */
function userToken(req: Request): string | null {
  const header = req.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      role?: string;
    };
    return claims.role === 'authenticated' ? token : null;
  } catch {
    return null;
  }
}

/** The caller's IP: Cloudflare's header on hosted Supabase, else the first X-Forwarded-For hop. */
function clientIp(req: Request): string {
  const cloudflare = req.headers.get('CF-Connecting-IP')?.trim();
  if (cloudflare) return cloudflare;
  const forwarded = req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim();
  return forwarded || req.headers.get('X-Real-IP') || 'unknown';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return error(405, 'method_not_allowed', 'Use POST');

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return error(500, 'misconfigured', 'Supabase environment is not configured');
  }
  const parsed = await readJson(req);
  if (parsed instanceof Response) return parsed;

  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const serviceClient = createClient(supabaseUrl, serviceKey, options);
  // Sends sign-in codes like the app's own sign-in screen does.
  const authClient = createClient(supabaseUrl, anonKey, options);

  try {
    const demo = demoEnabled();
    const result = await handlePublicBookingRequest(
      parsed.body,
      { ip: clientIp(req), accessToken: userToken(req) },
      {
        ...serviceAiDeps(serviceClient, null),
        port: createSupabasePublicBookingPort(
          serviceClient as unknown as ChairsideClient,
          authClient as unknown as ChairsideClient,
        ),
        ...(demo ? { demoProvider: () => new DemoConciergeProvider() } : {}),
      },
    );
    if (result.status === 500) {
      console.error('public-booking failed', result.body.error.message);
      return error(500, 'internal', 'Something went wrong');
    }
    return json(result.status, result.body);
  } catch (e) {
    console.error('public-booking failed', e instanceof Error ? e.message : e);
    return error(500, 'internal', 'Something went wrong');
  }
});
