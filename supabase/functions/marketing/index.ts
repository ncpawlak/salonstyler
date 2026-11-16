// Marketing (issue #27): rebook nudges, campaigns and post-visit review requests. Postgres drafts
// and queues the messages (marketing_tick, every minute) and pokes this function to deliver them;
// an hourly job asks it to scan for clients due back (the @chairside/core rebook engine decides
// who, never the model). Messages go out only to clients who opted in, each with a one-click
// unsubscribe link. Email is the only channel for now; SMS plugs in as another
// MarketingChannelSender once the salon has a number (#22).
//
// POST /functions/v1/marketing   (verify_jwt = false: clients unsubscribe signed out)
//   { action: "scan" | "send" }                     x-notifier-secret header (Postgres)
//   { action: "draft_copy", salonId, kind, brief? } a member's JWT
//   { action: "view" | "unsubscribe" | "resubscribe", token }   (/u/{token})
//   ?token=…  List-Unsubscribe=One-Click            (RFC 8058, from mail apps)
// Secrets: NOTIFIER_SECRET, the notifier's email ones (EMAIL_FROM, PUBLIC_APP_URL and
// RESEND_API_KEY or SMTP_*), and PUBLIC_FUNCTIONS_URL for the one-click header.
// See supabase/docs/marketing.md.
import { createClient } from '@supabase/supabase-js';

import { handleMarketingRequest } from '@chairside/ai/marketing/handler.ts';
import { createSupabaseMarketingPort } from '@chairside/ai/marketing/supabase-port.ts';
import type { MarketingChannelSender } from '@chairside/ai/marketing/types.ts';
import type { AiServiceDeps } from '@chairside/ai/server/handler.ts';
import type { ChairsideClient } from '@chairside/db';
import {
  emailConfigFromEnv,
  type SmtpConn,
  type SmtpConnector,
} from '@chairside/notifications/server/client-email.ts';
import { renderMarketingEmail } from '@chairside/notifications/server/marketing-email.ts';

import { aiRequestContext, corsHeaders, error, json, readJson } from '../_shared/ai-deps.ts';

const smtpConnector: SmtpConnector = {
  async connect({ hostname, port, tls }): Promise<SmtpConn> {
    return tls ? await Deno.connectTls({ hostname, port }) : await Deno.connect({ hostname, port });
  },
  async startTls(conn, hostname): Promise<SmtpConn> {
    return await Deno.startTls(conn as Deno.TcpConn, { hostname });
  },
};

/** Constant-time comparison so the secret can't be guessed byte by byte. */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** True when the bearer token is a signed-in user's JWT (not the anon/publishable key). */
function hasUserToken(req: Request): boolean {
  const header = req.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const payload = header.slice('Bearer '.length).trim().split('.')[1];
  if (!payload) return false;
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      role?: string;
    };
    return claims.role === 'authenticated';
  } catch {
    return false;
  }
}

/** The caller's IP: Cloudflare's header on hosted Supabase, else the first X-Forwarded-For hop. */
function clientIp(req: Request): string {
  const cloudflare = req.headers.get('CF-Connecting-IP')?.trim();
  if (cloudflare) return cloudflare;
  const forwarded = req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim();
  return forwarded || req.headers.get('X-Real-IP') || 'unknown';
}

/** The request body, or an RFC 8058 one-click unsubscribe (`POST ?token=…`, form body). */
async function readBody(req: Request): Promise<{ body: unknown } | Response> {
  const token = new URL(req.url).searchParams.get('token');
  if (token) {
    const form = await req.text().catch(() => '');
    if (new URLSearchParams(form).get('List-Unsubscribe') !== 'One-Click') {
      return error(400, 'invalid_request', 'Expected List-Unsubscribe=One-Click');
    }
    return { body: { action: 'unsubscribe', token } };
  }
  return await readJson(req);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return error(405, 'method_not_allowed', 'Use POST');

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return error(500, 'misconfigured', 'Supabase environment is not configured');
  }
  const parsed = await readBody(req);
  if (parsed instanceof Response) return parsed;

  const secret = Deno.env.get('NOTIFIER_SECRET') ?? '';
  const trusted = secret !== '' && safeEqual(req.headers.get('x-notifier-secret') ?? '', secret);

  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as ChairsideClient;

  // Only member requests (draft_copy) carry a user JWT; the AI wiring needs it.
  let ai: AiServiceDeps | null = null;
  if (hasUserToken(req)) {
    const context = await aiRequestContext(req);
    if (context instanceof Response) return context;
    ai = context.deps;
  }

  const channels: MarketingChannelSender[] = [];
  const email = emailConfigFromEnv(Deno.env.toObject(), { connector: smtpConnector });
  if (email) {
    const functionsUrl = Deno.env.get('PUBLIC_FUNCTIONS_URL')?.trim() || null;
    channels.push({
      channel: 'email',
      async send(message) {
        const rendered = renderMarketingEmail(message, { appUrl: email.appUrl, functionsUrl });
        const name = message.clientName?.replace(/[<>"\r\n]/g, '');
        const { id } = await email.transport({
          from: email.from,
          to: name ? `${name} <${message.to}>` : message.to,
          ...rendered,
        });
        return { providerId: id ?? undefined };
      },
    });
  }

  try {
    const result = await handleMarketingRequest(
      parsed.body,
      { ip: clientIp(req), trusted },
      { port: createSupabaseMarketingPort(service), channels, ai },
    );
    if (result.status === 500) {
      console.error('marketing failed', result.body.error.message);
      return error(500, 'internal', 'Something went wrong');
    }
    return json(result.status, result.body);
  } catch (e) {
    console.error('marketing failed', e instanceof Error ? e.message : e);
    return error(500, 'internal', 'Something went wrong');
  }
});
