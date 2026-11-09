import type { ChairsideClient, Json } from '@chairside/db';

import { createSupabaseAssistantPort } from '../assistant/supabase-port.ts';
import type { CaptureInput, CaptureResult, InboxBridge, InboxPort } from './handler.ts';
import { INBOX_HOURLY_LIMIT } from './handler.ts';

/**
 * The inbox agent's data access over a **service-role** client (there is no signed-in user: the
 * caller is the salon's iOS Shortcut). Every read is filtered by `salonId`, which comes from the
 * verified bridge token, never from the request body.
 */
export function createSupabaseInboxPort(client: ChairsideClient, salonId: string): InboxPort {
  const base = createSupabaseAssistantPort(client, salonId);
  return {
    getSchedule: base.getSchedule,
    getMenu: base.getMenu,
    listClients: base.listClients,
    clientVisits: base.clientVisits,
    listAppointments: base.listAppointments,

    async findCaptured(dedupeKey) {
      const { data, error } = await client
        .from('captured_requests')
        .select('id')
        .eq('salon_id', salonId)
        .eq('dedupe_key', dedupeKey)
        .maybeSingle();
      if (error) throw error;
      return data?.id ?? null;
    },

    async capture(input: CaptureInput): Promise<CaptureResult> {
      const { data, error } = await client.rpc('capture_inbox_request', {
        p_salon_id: salonId,
        p_request: JSON.parse(JSON.stringify(input)) as Json,
      });
      if (error) throw error;
      return data as unknown as CaptureResult;
    },
  };
}

/** Looks up a bridge token (service role) and counts the call against its hourly limit. */
export async function authenticateBridgeToken(
  client: ChairsideClient,
  token: string,
  hourlyLimit = INBOX_HOURLY_LIMIT,
): Promise<InboxBridge | null> {
  const { data, error } = await client.rpc('inbox_bridge_for_token', {
    p_token: token,
    p_hourly_limit: hourlyLimit,
  });
  if (error) throw error;
  const row = data[0];
  return row
    ? { salonId: row.salon_id, keyword: row.keyword, rateLimited: row.rate_limited }
    : null;
}
