// Full data export (issue #46). An owner taps "Export" in Settings: Postgres returns every
// registered salon-owned table (owner-only RPC, this salon only), @chairside/core zips it as
// data.json + one CSV per table + client photos, the zip goes to the private `data-exports`
// bucket and the owner gets a signed link (1 hour in the app's share sheet, 24 hours by email).
// "Restore" reads an uploaded export back into a new, empty salon.
//
// POST /functions/v1/data-export                Authorization: Bearer <owner JWT>
//   { action: "export", salonId }
//   { action: "import", salonId, path }         path = "{salonId}/uploads/…" (uploaded by the app)
// Secrets: the email ones from the notifier (EMAIL_FROM, PUBLIC_APP_URL and RESEND_API_KEY or
// SMTP_*) to email the link. See supabase/docs/data-export.md.
import { createClient } from '@supabase/supabase-js';

import { handleDataExportRequest } from '@chairside/ai/data-export/handler.ts';
import { createSupabaseDataExportPort } from '@chairside/ai/data-export/supabase-port.ts';
import type { DataExportEmail } from '@chairside/ai/data-export/types.ts';
import type { ChairsideClient } from '@chairside/db';
import {
  emailConfigFromEnv,
  type SmtpConn,
  type SmtpConnector,
} from '@chairside/notifications/server/client-email.ts';
import { renderDataExportEmail } from '@chairside/notifications/server/data-export-email.ts';

// Not _shared/ai-deps.ts: that pulls in the AI server graph this function doesn't need.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const error = (status: number, code: string, message: string) =>
  json(status, { error: { code, message } });

const smtpConnector: SmtpConnector = {
  async connect({ hostname, port, tls }): Promise<SmtpConn> {
    return tls ? await Deno.connectTls({ hostname, port }) : await Deno.connect({ hostname, port });
  },
  async startTls(conn, hostname): Promise<SmtpConn> {
    return await Deno.startTls(conn as Deno.TcpConn, { hostname });
  },
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return error(405, 'method_not_allowed', 'Use POST');

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return error(500, 'misconfigured', 'Supabase environment is not configured');
  }

  const authorization = req.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return error(401, 'unauthorized', 'Sign in to export your data');
  }
  const user = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await user.auth.getUser(
    authorization.slice('Bearer '.length),
  );
  const caller = userData?.user;
  if (userError || !caller) return error(401, 'unauthorized', 'Sign in to export your data');

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return error(400, 'invalid_request', 'Body must be JSON');
  }

  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const email = emailConfigFromEnv(Deno.env.toObject(), { connector: smtpConnector });
  const sendExportEmail = email
    ? async (message: DataExportEmail) => {
        const rendered = renderDataExportEmail(message);
        await email.transport({ from: email.from, to: message.to, ...rendered });
      }
    : null;

  try {
    const result = await handleDataExportRequest(
      body,
      { userId: caller.id, email: caller.email ?? null },
      {
        port: createSupabaseDataExportPort(
          user as unknown as ChairsideClient,
          service as unknown as ChairsideClient,
          sendExportEmail,
          Deno.env.get('PUBLIC_SUPABASE_URL'),
        ),
      },
    );
    if (result.status === 500) {
      console.error('data-export failed', result.body.error.message);
      return error(500, 'internal', 'Something went wrong');
    }
    return json(result.status, result.body);
  } catch (e) {
    console.error('data-export failed', e instanceof Error ? e.message : e);
    return error(500, 'internal', 'Something went wrong');
  }
});
