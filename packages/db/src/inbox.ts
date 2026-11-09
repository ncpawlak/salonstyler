import type { QueryData } from '@supabase/supabase-js';

import type { AppointmentServiceSnapshot } from './appointments.ts';
import type { ChairsideClient, ClientRow, Tables } from './index.ts';

export type CapturedRequest = Tables<'captured_requests'>;
export type CapturedRequestIntent = CapturedRequest['intent'];
export type CapturedRequestStatus = CapturedRequest['status'];
export type InboxBridge = Tables<'inbox_bridges'>;

/** What the agent understood from the message (stored as `captured_requests.parsed`). */
export interface CapturedRequestParse {
  clientName?: string | null;
  services?: { serviceId: string; variantId?: string | null; name?: string }[];
  date?: string | null;
  timeOfDay?: string | null;
  notes?: string | null;
  /** `llm` or `demo`. */
  parser?: string;
}

export interface CapturedRequestAppointment {
  id: string;
  status: string;
  starts_at: string;
  ends_at: string;
  hold_expires_at: string | null;
  price_cents: number | null;
  services: AppointmentServiceSnapshot[];
}

export interface CapturedRequestWithDetails extends Omit<CapturedRequest, 'parsed'> {
  parsed: CapturedRequestParse;
  client: Pick<ClientRow, 'id' | 'name' | 'phone' | 'pending'> | null;
  appointment: CapturedRequestAppointment | null;
  target: CapturedRequestAppointment | null;
}

const APPOINTMENT_COLUMNS =
  'id, status, starts_at, ends_at, hold_expires_at, price_cents, services';

function selectCapturedRequests(client: ChairsideClient) {
  return client.from('captured_requests').select(
    `*,
       client:clients!captured_requests_client_fkey(id, name, phone, pending),
       appointment:appointments!captured_requests_appointment_fkey(${APPOINTMENT_COLUMNS}),
       target:appointments!captured_requests_target_fkey(${APPOINTMENT_COLUMNS})`,
  );
}

type CapturedRequestQueryRow = QueryData<ReturnType<typeof selectCapturedRequests>>[number];

function toAppointment(row: CapturedRequestQueryRow['appointment']) {
  if (!row) return null;
  return {
    ...row,
    services: (Array.isArray(row.services)
      ? row.services
      : []) as unknown as AppointmentServiceSnapshot[],
  };
}

function toCapturedRequest(row: CapturedRequestQueryRow): CapturedRequestWithDetails {
  return {
    ...row,
    parsed: (row.parsed && typeof row.parsed === 'object' && !Array.isArray(row.parsed)
      ? row.parsed
      : {}) as CapturedRequestParse,
    appointment: toAppointment(row.appointment),
    target: toAppointment(row.target),
  };
}

/** Inbox requests awaiting a decision, newest first. */
export async function listCapturedRequests(
  client: ChairsideClient,
  salonId: string,
  options: { status?: CapturedRequestStatus; limit?: number } = {},
): Promise<CapturedRequestWithDetails[]> {
  const { data, error } = await selectCapturedRequests(client)
    .eq('salon_id', salonId)
    .eq('status', options.status ?? 'pending')
    .order('received_at', { ascending: false })
    .limit(options.limit ?? 50);
  if (error) throw error;
  return data.map(toCapturedRequest);
}

/**
 * `dismiss` drops the request (and quietly releases its hold); `cancel_appointment` carries out a
 * client's cancel request. Approve/decline go through `setAppointmentStatus` on the held slot.
 */
export async function resolveCapturedRequest(
  client: ChairsideClient,
  requestId: string,
  action: 'dismiss' | 'cancel_appointment',
): Promise<CapturedRequest> {
  const { data, error } = await client.rpc('resolve_captured_request', {
    p_request_id: requestId,
    p_action: action,
  });
  if (error) throw error;
  return data;
}

/** The salon's text bridge (never includes the token itself), or null if not set up. */
export async function getInboxBridge(
  client: ChairsideClient,
  salonId: string,
): Promise<Omit<InboxBridge, 'token_hash'> | null> {
  const { data, error } = await client
    .from('inbox_bridges')
    .select(
      'salon_id, token_hint, keyword, window_started_at, window_count, last_received_at, created_at, rotated_at',
    )
    .eq('salon_id', salonId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Owner-only. Creates or replaces the bridge token; the plain token is returned only here. */
export async function rotateInboxBridgeToken(
  client: ChairsideClient,
  salonId: string,
): Promise<string> {
  const { data, error } = await client.rpc('rotate_inbox_bridge_token', { p_salon_id: salonId });
  if (error) throw error;
  return data;
}

export async function updateInboxKeyword(
  client: ChairsideClient,
  salonId: string,
  keyword: string,
): Promise<void> {
  const { error } = await client
    .from('inbox_bridges')
    .update({ keyword: keyword.trim() })
    .eq('salon_id', salonId);
  if (error) throw error;
}

/** Owner-only. Revokes the token; the Shortcut stops working until a new one is generated. */
export async function removeInboxBridge(client: ChairsideClient, salonId: string): Promise<void> {
  const { error } = await client.from('inbox_bridges').delete().eq('salon_id', salonId);
  if (error) throw error;
}
