import type { ChairsideClient, Json } from '@chairside/db';
import { listServiceRebookIntervals } from '@chairside/db/rebook';

import { createSupabaseAssistantPort } from '../assistant/supabase-port.ts';
import type { AutoSchedulePort, StoredCapturedRequest } from './auto-schedule.ts';
import type {
  CaptureInput,
  CaptureResult,
  InboxBridge,
  InboxPort,
  QueuedReply,
} from './handler.ts';
import { INBOX_HOURLY_LIMIT } from './handler.ts';
import { phonesMatch } from './text.ts';

/** A claimed reply not completed within this long (e.g. the function crashed) is claimed again. */
const CLAIM_TIMEOUT_MS = 2 * 60_000;

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
    getAppointment: base.getAppointment,
    getClient: base.getClient,
    getReplyContext: base.getReplyContext,

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

    async findOpenOffer(phone, sinceIso) {
      const { data, error } = await client
        .from('client_replies')
        .select(
          'to_phone, captured_request_id, request:captured_requests!client_replies_request_fkey(id, status, appointment_id, appointment:appointments!captured_requests_appointment_fkey(id, status))',
        )
        .eq('salon_id', salonId)
        .eq('kind', 'offer')
        .eq('status', 'sent')
        .gte('sent_at', sinceIso)
        .order('sent_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      for (const row of data) {
        const req = row.request;
        if (!phonesMatch(row.to_phone, phone) || req?.status !== 'pending') continue;
        const appt = req.appointment;
        if (appt && ['held', 'requested'].includes(appt.status)) {
          return { requestId: req.id, appointmentId: appt.id };
        }
      }
      return null;
    },

    async confirmAppointment(appointmentId) {
      await base.setStatus(appointmentId, 'confirmed');
    },

    async claimQueuedReplies(limit) {
      const { data: settings, error: settingsError } = await client
        .from('settings')
        .select('auto_send_replies')
        .eq('salon_id', salonId)
        .single();
      if (settingsError) throw settingsError;
      if (!settings.auto_send_replies) return [];
      const stale = new Date(Date.now() - CLAIM_TIMEOUT_MS).toISOString();
      const { data: due, error } = await client
        .from('client_replies')
        .select('id')
        .eq('salon_id', salonId)
        .or(`status.eq.queued,and(status.eq.sending,claimed_at.lt.${stale})`)
        .order('created_at')
        .limit(limit);
      if (error) throw error;
      if (due.length === 0) return [];
      // Claim atomically: a concurrent call only gets rows this update didn't take.
      const { data: claimed, error: claimError } = await client
        .from('client_replies')
        .update({ status: 'sending', claimed_at: new Date().toISOString() })
        .eq('salon_id', salonId)
        .in(
          'id',
          due.map((r) => r.id),
        )
        .or(`status.eq.queued,and(status.eq.sending,claimed_at.lt.${stale})`)
        .select('id, kind, to_phone, captured_request_id, appointment_id, client_id');
      if (claimError) throw claimError;
      return claimed
        .filter((r) => r.to_phone)
        .map((r): QueuedReply => ({
          id: r.id,
          kind: r.kind as QueuedReply['kind'],
          toPhone: r.to_phone!,
          capturedRequestId: r.captured_request_id,
          appointmentId: r.appointment_id,
          clientId: r.client_id,
        }));
    },

    async completeReply(id, body, source) {
      const { error } = await client
        .from('client_replies')
        .update({ status: 'sent', body, source, sent_at: new Date().toISOString() })
        .eq('salon_id', salonId)
        .eq('id', id)
        .eq('status', 'sending');
      if (error) throw error;
    },
  };
}

/**
 * Auto-Schedule's data access (#84): the inbox port plus the stored request, the client's
 * duration overrides and the services' rebook intervals. Service role, filtered by `salonId`
 * (the caller's membership is checked before this is created).
 */
export function createSupabaseAutoSchedulePort(
  client: ChairsideClient,
  salonId: string,
): AutoSchedulePort {
  const base = createSupabaseAssistantPort(client, salonId);
  return {
    ...createSupabaseInboxPort(client, salonId),
    clientOverrides: base.clientOverrides,
    serviceRebookIntervals: () => listServiceRebookIntervals(client, salonId),
    async getCapturedRequest(id) {
      const { data, error } = await client
        .from('captured_requests')
        .select(
          'id, status, intent, message, parsed, client_id, appointment_id, target_appointment_id, received_at',
        )
        .eq('salon_id', salonId)
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        id: data.id,
        status: data.status,
        intent: data.intent,
        message: data.message,
        parsed: (data.parsed ?? {}) as StoredCapturedRequest['parsed'],
        clientId: data.client_id,
        appointmentId: data.appointment_id,
        targetAppointmentId: data.target_appointment_id,
        receivedAt: data.received_at,
      };
    },
  };
}
/**
 * Looks up a bridge token (service role), counts the call against its hourly limit, and records
 * the Shortcut version it reported.
 */
export async function authenticateBridgeToken(
  client: ChairsideClient,
  token: string,
  meta: { bridgeVersion?: string | null } = {},
  hourlyLimit = INBOX_HOURLY_LIMIT,
): Promise<InboxBridge | null> {
  const { data, error } = await client.rpc('inbox_bridge_for_token', {
    p_token: token,
    p_hourly_limit: hourlyLimit,
    ...(meta.bridgeVersion ? { p_bridge_version: meta.bridgeVersion } : {}),
  });
  if (error) throw error;
  const row = data[0];
  return row
    ? {
        salonId: row.salon_id,
        keyword: row.keyword,
        rateLimited: row.rate_limited,
        autoReply: row.auto_reply,
        salonName: row.salon_name,
      }
    : null;
}

/** Records a test message / hand run of the Shortcut (service role). */
export async function markBridgeTested(client: ChairsideClient, salonId: string): Promise<void> {
  const { error } = await client
    .from('inbox_bridges')
    .update({ last_test_at: new Date().toISOString() })
    .eq('salon_id', salonId);
  if (error) throw error;
}
