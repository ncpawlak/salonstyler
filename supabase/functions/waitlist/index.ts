// Waitlist auto-fill (issue #21). When an appointment is cancelled, Postgres records a freed slot
// and pokes this function. @chairside/core works out which waitlisted clients' services fit the
// slot (the model is never involved), Postgres stores the offers as drafts for the stylist (or
// sends them when auto-offer is on), and the first client to claim the slot on /w/{token} books it.
//
// POST /functions/v1/waitlist   (verify_jwt = false: signed-out clients use /w/{token})
//   { action: "process" }                       x-notifier-secret: <NOTIFIER_SECRET> (Postgres)
//   { action: "process", salonId }              Authorization: Bearer <member JWT> ("Check now")
//   { action: "send_offer", offerId, via }      Authorization: Bearer <member JWT>
//   { action: "join", slug, date, … }           Authorization: Bearer <verified client JWT>
//   { action: "view" | "accept" | "leave", token, … }
// Secrets: NOTIFIER_SECRET; the email ones from the notifier (EMAIL_FROM, PUBLIC_APP_URL and
// RESEND_API_KEY or SMTP_*) to email offers. See supabase/docs/waitlist.md.
import { createClient } from '@supabase/supabase-js';

import { handleWaitlistRequest } from '@chairside/ai/waitlist/handler.ts';
import { createSupabaseWaitlistPort } from '@chairside/ai/waitlist/supabase-port.ts';
import type { ChairsideClient } from '@chairside/db';
import type { SentWaitlistOffer } from '@chairside/db/waitlist';
import {
  emailConfigFromEnv,
  type SmtpConn,
  type SmtpConnector,
} from '@chairside/notifications/server/client-email.ts';
import { renderWaitlistOfferEmail } from '@chairside/notifications/server/waitlist-email.ts';

import { corsHeaders, error, json, readJson } from '../_shared/ai-deps.ts';

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
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return error(500, 'misconfigured', 'Supabase environment is not configured');
  }
  const parsed = await readJson(req);
  if (parsed instanceof Response) return parsed;

  const secret = Deno.env.get('NOTIFIER_SECRET') ?? '';
  const trusted = secret !== '' && safeEqual(req.headers.get('x-notifier-secret') ?? '', secret);

  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as ChairsideClient;

  const email = emailConfigFromEnv(Deno.env.toObject(), { connector: smtpConnector });
  const sendOfferEmail = email
    ? async (offer: SentWaitlistOffer) => {
        if (!offer.email) return;
        const rendered = renderWaitlistOfferEmail(offer, { appUrl: email.appUrl });
        const name = offer.clientName?.replace(/[<>"\r\n]/g, '');
        await email.transport({
          from: email.from,
          to: name ? `${name} <${offer.email}>` : offer.email,
          ...rendered,
        });
      }
    : null;

  try {
    const result = await handleWaitlistRequest(
      parsed.body,
      { ip: clientIp(req), accessToken: userToken(req), trusted },
      { port: createSupabaseWaitlistPort(service, sendOfferEmail) },
    );
    if (result.status === 500) {
      console.error('waitlist failed', result.body.error.message);
      return error(500, 'internal', 'Something went wrong');
    }
    return json(result.status, result.body);
  } catch (e) {
    console.error('waitlist failed', e instanceof Error ? e.message : e);
    return error(500, 'internal', 'Something went wrong');
  }
});
