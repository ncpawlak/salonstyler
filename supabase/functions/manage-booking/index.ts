// A client's manage link: /m/{token} on the web app, sent in every confirmation and reminder
// email. The client sees their appointment and can cancel it or move it to another open time.
// Slots come from @chairside/core; Postgres (reschedule_booking_by_token) re-checks the shape,
// Tentative hours and the no-overlap constraint.
//
// POST /functions/v1/manage-booking   (verify_jwt = false: signed-out clients call it)
//   { action: "view" | "slots" | "cancel" | "reschedule", token, date?, start? }
// The 64-hex token is the only credential and unlocks exactly one appointment. Every action is
// rate limited per IP, and changes per token too. Responses never include other clients or
// internal ids.
import { createClient } from '@supabase/supabase-js';

import { handleManageBookingRequest } from '@chairside/ai/manage-booking/handler.ts';
import { createSupabaseManageBookingPort } from '@chairside/ai/manage-booking/supabase-port.ts';
import type { ChairsideClient } from '@chairside/db';

import { corsHeaders, error, json, readJson } from '../_shared/ai-deps.ts';

/** The caller's IP: Cloudflare's header on hosted Supabase, else the first X-Forwarded-For hop. */
function clientIp(req: Request): string {
  const cloudflare = req.headers.get('CF-Connecting-IP')?.trim();
  if (cloudflare) return cloudflare;
  const forwarded = req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim();
  return forwarded || req.headers.get('X-Real-IP') || 'unknown';
}

/**
 * Deposits (#12): a client who cancels in time gets their deposit back. The cancel RPC marks it
 * refund_due; this asks the deposits function to refund it on Stripe. Failures are logged, not
 * shown to the client: the salon still sees "Refund due" and can refund from the appointment.
 */
async function refundDepositIfDue(
  serviceClient: ReturnType<typeof createClient>,
  supabaseUrl: string,
  serviceKey: string,
  token: string,
): Promise<void> {
  try {
    const { data: appt } = await serviceClient
      .from('appointments')
      .select('id')
      .eq('manage_token', token)
      .maybeSingle();
    if (!appt) return;
    const { data: deposit } = await serviceClient
      .from('appointment_deposits')
      .select('id')
      .eq('appointment_id', (appt as { id: string }).id)
      .eq('status', 'refund_due')
      .maybeSingle();
    if (!deposit) return;
    const res = await fetch(`${supabaseUrl}/functions/v1/deposits`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'refund', depositId: (deposit as { id: string }).id }),
    });
    if (!res.ok) console.error('deposit refund failed', res.status, await res.text());
  } catch (e) {
    console.error('deposit refund failed', e instanceof Error ? e.message : e);
  }
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

  const serviceClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const basePort = createSupabaseManageBookingPort(serviceClient as unknown as ChairsideClient);
  const port: typeof basePort = {
    ...basePort,
    async cancel(token) {
      const result = await basePort.cancel(token);
      if (result.ok && !result.alreadyCancelled) {
        await refundDepositIfDue(serviceClient, supabaseUrl, serviceKey, token);
      }
      return result;
    },
  };

  try {
    const result = await handleManageBookingRequest(parsed.body, { ip: clientIp(req) }, { port });
    return json(result.status, result.body);
  } catch (e) {
    console.error('manage-booking failed', e instanceof Error ? e.message : e);
    return error(500, 'internal', 'Something went wrong');
  }
});
