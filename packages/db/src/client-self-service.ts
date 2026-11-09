import type { ChairsideClient, Enums, Json, SalonSettings } from './index.ts';

/**
 * Client self-service (#10): the client's manage link (/m/{token}), client email settings and the
 * reminder queue. The manage link is served by the signed-out `manage-booking` Edge Function, whose
 * service-role RPCs only ever touch the one appointment behind the token.
 */

// --- Settings --------------------------------------------------------------------------------

/** Settings → Client emails & self-service. */
export type ClientEmailSettings = Pick<
  SalonSettings,
  'client_emails_enabled' | 'client_reminder_hours' | 'client_self_service_enabled'
>;

const CLIENT_EMAIL_COLUMNS =
  'client_emails_enabled, client_reminder_hours, client_self_service_enabled';

/** Lead times the settings screen offers, in hours (the database allows any 1-168, up to 3). */
export const REMINDER_HOUR_OPTIONS = [168, 72, 48, 24, 4, 2, 1] as const;
export const MAX_REMINDERS = 3;

export async function getClientEmailSettings(
  client: ChairsideClient,
  salonId: string,
): Promise<ClientEmailSettings> {
  const { data, error } = await client
    .from('settings')
    .select(CLIENT_EMAIL_COLUMNS)
    .eq('salon_id', salonId)
    .single();
  if (error) throw error;
  return data;
}

/** Owners only (RLS). */
export async function updateClientEmailSettings(
  client: ChairsideClient,
  salonId: string,
  changes: Partial<ClientEmailSettings>,
): Promise<ClientEmailSettings> {
  const { data, error } = await client
    .from('settings')
    .update(changes)
    .eq('salon_id', salonId)
    .select(CLIENT_EMAIL_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

// --- Reminder queue --------------------------------------------------------------------------

export interface ReminderQueueItem {
  appointmentId: string;
  clientId: string | null;
  clientName: string | null;
  phone: string | null;
  startsAt: string;
  services: string | null;
  manageToken: string;
  textReminderSentAt: string | null;
}

export interface ReminderQueue {
  /** Local `YYYY-MM-DD`. */
  day: string;
  items: ReminderQueueItem[];
}

/** Confirmed appointments on `day` (default: tomorrow in the salon's timezone). Members only. */
export async function getReminderQueue(
  client: ChairsideClient,
  salonId: string,
  day?: string,
): Promise<ReminderQueue> {
  const { data, error } = await client.rpc('reminder_queue', {
    p_salon_id: salonId,
    ...(day ? { p_day: day } : {}),
  });
  if (error) throw error;
  return data as unknown as ReminderQueue;
}

export async function markTextReminderSent(
  client: ChairsideClient,
  appointmentId: string,
  sent = true,
): Promise<string | null> {
  const { data, error } = await client.rpc('mark_text_reminder_sent', {
    p_appointment_id: appointmentId,
    p_sent: sent,
  });
  if (error) throw error;
  return data;
}

/** The client's manage link on the web app. */
export function manageBookingPath(token: string): string {
  return `/m/${encodeURIComponent(token)}`;
}

// --- The manage link (service role) ----------------------------------------------------------

export interface ManageSegment {
  kind: Enums<'appointment_segment_kind'>;
  label: string | null;
  start: string;
  end: string;
}

/** What `manage_booking` returns. salonId/stylistId stay inside the Edge Function. */
export interface ManageBookingRow {
  appointmentId: string;
  salonId: string;
  stylistId: string;
  status: Enums<'appointment_status'>;
  startsAt: string;
  endsAt: string;
  services: string | null;
  clientFirstName: string | null;
  salon: { name: string; slug: string; timezone: string };
  canCancel: boolean;
  canReschedule: boolean;
  /** Why the client can't change it (or policy text from #12), if any. */
  policyMessage: string | null;
  /** Late-change fee a cancellation policy would charge (0 until #12). */
  feeCents: number;
  segments: ManageSegment[];
}

export type CancelByTokenResult =
  | { ok: true; status: string; alreadyCancelled?: boolean; feeCents?: number }
  | { ok: false; reason: string; message?: string | null };

export type RescheduleByTokenResult =
  | { ok: true; startsAt: string; endsAt: string }
  | { ok: false; reason: string; message?: string | null };

/** `client` must be a service-role client (the RPC refuses anything else). */
export async function getManageBooking(
  client: ChairsideClient,
  token: string,
): Promise<ManageBookingRow | null> {
  const { data, error } = await client.rpc('manage_booking', { p_token: token });
  if (error) throw error;
  return (data as unknown as ManageBookingRow | null) ?? null;
}

export async function cancelBookingByToken(
  client: ChairsideClient,
  token: string,
): Promise<CancelByTokenResult> {
  const { data, error } = await client.rpc('cancel_booking_by_token', { p_token: token });
  if (error) throw error;
  return data as unknown as CancelByTokenResult;
}

export async function rescheduleBookingByToken(
  client: ChairsideClient,
  token: string,
  segments: ManageSegment[],
): Promise<RescheduleByTokenResult> {
  const { data, error } = await client.rpc('reschedule_booking_by_token', {
    p_token: token,
    p_segments: segments as unknown as Json,
  });
  if (error) throw error;
  return data as unknown as RescheduleByTokenResult;
}

// --- The manage-booking Edge Function's API ---------------------------------------------------

/** The appointment as the client sees it on /m/{token}: no ids beyond its own, no other clients. */
export interface ManageBookingView {
  status: ManageBookingRow['status'];
  startsAt: string;
  endsAt: string;
  services: string | null;
  clientFirstName: string | null;
  salon: { name: string; slug: string; timezone: string };
  canCancel: boolean;
  canReschedule: boolean;
  policyMessage: string | null;
  feeCents: number;
}

export interface ManageSlot {
  start: string;
  end: string;
  /** "2:30 PM" in the salon's timezone. */
  time: string;
}

export interface ManageSlotDay {
  /** Local `YYYY-MM-DD`. */
  date: string;
  label: string;
  slots: ManageSlot[];
}

export type ManageBookingRequest =
  | { action: 'view'; token: string }
  | { action: 'slots'; token: string; date: string }
  | { action: 'cancel'; token: string }
  | { action: 'reschedule'; token: string; start: string };

export type ManageViewResponse = { booking: ManageBookingView };
export type ManageSlotsResponse = { date: string; days: ManageSlotDay[] };
export type ManageCancelResponse = { booking: ManageBookingView; feeCents: number };
export type ManageRescheduleResponse = { booking: ManageBookingView };

export interface ManageErrorBody {
  error: { code: string; message: string };
}
