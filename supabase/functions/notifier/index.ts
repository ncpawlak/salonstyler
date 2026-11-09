// Chairside notifier. Drains public.notifications_outbox and delivers through Expo Push.
//
// Invoked by pg_cron (private.dispatch_notifications → pg_net) every minute when something is due,
// authenticated with a shared secret rather than a user JWT:
//   POST /functions/v1/notifier   x-notifier-secret: <NOTIFIER_SECRET>
// Secrets: NOTIFIER_SECRET (must match Vault `notifier_secret`), optional EXPO_ACCESS_TOKEN.
import { createClient } from '@supabase/supabase-js';

import {
  type NotificationResult,
  type OutboxRow,
  type PushTokenRow,
  runNotifier,
} from '@chairside/notifications/server/notifier.ts';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Constant-time comparison so the secret can't be guessed byte by byte. */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const secret = Deno.env.get('NOTIFIER_SECRET');
  if (!supabaseUrl || !serviceKey || !secret) return json(500, { error: 'Notifier is not configured' });

  if (!safeEqual(req.headers.get('x-notifier-secret') ?? '', secret)) {
    return json(401, { error: 'unauthorized' });
  }

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const summary = await runNotifier({
      expoAccessToken: Deno.env.get('EXPO_ACCESS_TOKEN') ?? undefined,
      async claim(limit) {
        const { data, error } = await db.rpc('claim_notifications', { p_limit: limit });
        if (error) throw error;
        return (data ?? []) as OutboxRow[];
      },
      async tokensFor(recipients) {
        const { data, error } = await db
          .from('push_tokens')
          .select('salon_id, user_id, token')
          .in('user_id', [...new Set(recipients.map((r) => r.userId))])
          .in('salon_id', [...new Set(recipients.map((r) => r.salonId))]);
        if (error) throw error;
        return (data ?? []) as PushTokenRow[];
      },
      async deleteTokens(tokens) {
        const { error } = await db.from('push_tokens').delete().in('token', tokens);
        if (error) throw error;
      },
      async finish(results: NotificationResult[]) {
        const { error } = await db.rpc('finish_notifications', { p_results: results });
        if (error) throw error;
      },
    });
    return json(200, summary);
  } catch (err) {
    console.error('notifier failed', err);
    return json(500, { error: err instanceof Error ? err.message : 'notifier failed' });
  }
});
