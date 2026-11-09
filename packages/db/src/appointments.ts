import type { BookingSegment } from '@chairside/core';
import type { QueryData } from '@supabase/supabase-js';

import type { Json } from './database.types.ts';
import type {
  Appointment,
  AppointmentSource,
  AppointmentStatus,
  ChairsideClient,
  ClientRow,
} from './index.ts';

/** What was booked, snapshotted on the appointment so menu edits don't rewrite history. */
export interface AppointmentServiceSnapshot {
  /** `services.id` of the service or combo. */
  serviceId: string;
  name: string;
  variantId?: string | null;
  variantName?: string | null;
  addonIds?: string[];
  colorTag?: string | null;
}

export interface AppointmentWithDetails extends Omit<Appointment, 'services'> {
  services: AppointmentServiceSnapshot[];
  client: Pick<ClientRow, 'id' | 'name' | 'phone' | 'notes'> | null;
  /** Ordered, including buffers; ISO UTC. */
  segments: (BookingSegment & { label: string | null })[];
}

/** Statuses that still occupy the calendar. */
export const ACTIVE_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  'held',
  'requested',
  'confirmed',
  'completed',
];

/** Converts a Postgres timestamptz text (`2026-03-06 15:00:00+00`) to ISO UTC. */
function pgTimestampToIso(text: string): string {
  const m =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)([+-]\d{2})(?::?(\d{2}))?$/.exec(
      text.trim(),
    );
  const ms = m ? Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4] ?? '00'}`) : Date.parse(text);
  if (Number.isNaN(ms)) throw new Error(`Unrecognised timestamp: ${text}`);
  return new Date(ms).toISOString();
}

/** Parses a `tstzrange` as returned by PostgREST, e.g. `["2026-03-06 15:00:00+00","…")`. */
export function parseTstzRange(range: unknown): { start: string; end: string } {
  const m = typeof range === 'string' ? /^[[(]"?([^",]+)"?,"?([^",]+)"?[)\]]$/.exec(range) : null;
  if (!m) throw new Error(`Unrecognised tstzrange: ${String(range)}`);
  return { start: pgTimestampToIso(m[1]!), end: pgTimestampToIso(m[2]!) };
}

/**
 * Appointments overlapping `[from, to)` (ISO), with client and segments. Cancelled and no-show
 * appointments are excluded unless `includeInactive`.
 */
export async function listAppointments(
  client: ChairsideClient,
  salonId: string,
  range: { from: string; to: string },
  options: { includeInactive?: boolean } = {},
): Promise<AppointmentWithDetails[]> {
  let query = selectAppointments(client)
    .eq('salon_id', salonId)
    .lt('starts_at', range.to)
    // Buffers can extend past the client span; an hour of slack covers them.
    .gt('ends_at', new Date(Date.parse(range.from) - 3_600_000).toISOString())
    .order('starts_at');
  if (!options.includeInactive) query = query.in('status', [...ACTIVE_APPOINTMENT_STATUSES]);
  const { data, error } = await query;
  if (error) throw error;
  return data.map(toAppointmentWithDetails);
}

/** Booking requests awaiting the stylist's approve/decline that haven't already ended. */
export async function listPendingRequests(
  client: ChairsideClient,
  salonId: string,
  now: Date = new Date(),
): Promise<AppointmentWithDetails[]> {
  const { data, error } = await selectAppointments(client)
    .eq('salon_id', salonId)
    .eq('status', 'requested')
    .gt('ends_at', now.toISOString())
    .order('starts_at')
    .limit(50);
  if (error) throw error;
  return data.map(toAppointmentWithDetails);
}

/** A single appointment with client and segments, or null if it's gone / not visible. */
export async function getAppointment(
  client: ChairsideClient,
  appointmentId: string,
): Promise<AppointmentWithDetails | null> {
  const { data, error } = await selectAppointments(client).eq('id', appointmentId).maybeSingle();
  if (error) throw error;
  return data ? toAppointmentWithDetails(data) : null;
}

function selectAppointments(client: ChairsideClient) {
  return client.from('appointments').select(
    `*,
       client:clients(id, name, phone, notes),
       segments:appointment_segments(kind, label, range, position)`,
  );
}

type AppointmentQueryRow = QueryData<ReturnType<typeof selectAppointments>>[number];

function toAppointmentWithDetails({
  segments,
  services,
  ...row
}: AppointmentQueryRow): AppointmentWithDetails {
  return {
    ...row,
    services: (Array.isArray(services) ? services : []) as unknown as AppointmentServiceSnapshot[],
    segments: [...segments]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ kind: s.kind, label: s.label, ...parseTstzRange(s.range) })),
  };
}

export interface BookAppointmentInput {
  salonId: string;
  clientId: string;
  /** From `planBooking(...)`, including buffers. */
  segments: readonly BookingSegment[];
  services?: readonly AppointmentServiceSnapshot[];
  /** Default `confirmed`. `held` expires after `settings.hold_expiry_hours`. */
  status?: Extract<AppointmentStatus, 'held' | 'requested' | 'confirmed'>;
  source?: AppointmentSource;
  priceCents?: number | null;
  notes?: string | null;
}

/** Books through the `book_appointment` RPC. Overlapping busy time fails with code `23P01`. */
export async function bookAppointment(
  client: ChairsideClient,
  input: BookAppointmentInput,
): Promise<Appointment> {
  const { data, error } = await client.rpc('book_appointment', {
    p_salon_id: input.salonId,
    p_client_id: input.clientId,
    p_segments: input.segments as unknown as Json,
    p_services: (input.services ?? []) as unknown as Json,
    p_status: input.status ?? 'confirmed',
    p_source: input.source ?? 'owner',
    ...(input.priceCents != null ? { p_price_cents: input.priceCents } : {}),
    ...(input.notes ? { p_notes: input.notes } : {}),
  });
  if (error) throw error;
  return data;
}

/** Moves an appointment and/or replaces its services and duration. */
export async function rescheduleAppointment(
  client: ChairsideClient,
  appointmentId: string,
  segments: readonly BookingSegment[],
  changes?: { services: readonly AppointmentServiceSnapshot[]; priceCents?: number | null },
): Promise<Appointment> {
  const { data, error } = await client.rpc('reschedule_appointment', {
    p_appointment_id: appointmentId,
    p_segments: segments as unknown as Json,
    ...(changes
      ? {
          p_services: changes.services as unknown as Json,
          ...(changes.priceCents != null ? { p_price_cents: changes.priceCents } : {}),
        }
      : {}),
  });
  if (error) throw error;
  return data;
}

export interface ApplyRunningLateInput {
  salonId: string;
  delayMinutes: number;
  /** `ripple` / `shift_all` / `move_one` from `planRunningLate`, recorded in the audit log. */
  strategy?: string | null;
  /** New segments per appointment, including buffers (from `planRunningLate(...).moves`). */
  moves: readonly { appointmentId: string; segments: readonly BookingSegment[] }[];
}

/**
 * Applies a "running late" cascade atomically via `apply_running_late`: every appointment moves
 * together, so back-to-back appointments can shift without colliding with each other mid-way.
 */
export async function applyRunningLate(
  client: ChairsideClient,
  input: ApplyRunningLateInput,
): Promise<Appointment[]> {
  const { data, error } = await client.rpc('apply_running_late', {
    p_salon_id: input.salonId,
    p_delay_minutes: input.delayMinutes,
    p_moves: input.moves.map((m) => ({
      appointmentId: m.appointmentId,
      segments: m.segments.map(({ kind, start, end }) => ({ kind, start, end })),
    })) as unknown as Json,
    ...(input.strategy ? { p_strategy: input.strategy } : {}),
  });
  if (error) throw error;
  return data;
}

/** Confirm, complete, mark no-show, cancel (with optional reason), or undo complete/no-show. */
export async function setAppointmentStatus(
  client: ChairsideClient,
  appointmentId: string,
  status: AppointmentStatus,
  reason?: string,
): Promise<Appointment> {
  const { data, error } = await client.rpc('set_appointment_status', {
    p_appointment_id: appointmentId,
    p_status: status,
    ...(reason ? { p_reason: reason } : {}),
  });
  if (error) throw error;
  return data;
}

/** True for the exclusion-constraint error raised when busy time would double-book. */
export function isBookingConflictError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23P01';
}

/** Salon clients by name, optionally filtered by a name/phone/email search. */
export async function listClients(
  client: ChairsideClient,
  salonId: string,
  search?: string,
  limit = 50,
): Promise<ClientRow[]> {
  let query = client.from('clients').select('*').eq('salon_id', salonId);
  const term = search?.trim().replace(/[%,()*\\]/g, ' ');
  if (term) query = query.or(`name.ilike.*${term}*,phone.ilike.*${term}*,email.ilike.*${term}*`);
  const { data, error } = await query.order('name').limit(limit);
  if (error) throw error;
  return data;
}

export interface AddClientInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
}

/** Quick-create from the booking flow (full profiles come later). */
export async function addClient(
  client: ChairsideClient,
  salonId: string,
  input: AddClientInput,
): Promise<ClientRow> {
  const blank = (v?: string | null) => (v?.trim() ? v.trim() : null);
  const { data, error } = await client
    .from('clients')
    .insert({
      salon_id: salonId,
      name: input.name.trim(),
      phone: blank(input.phone),
      email: blank(input.email),
      notes: blank(input.notes),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** `settings.hold_expiry_hours`: how long a held slot stays reserved before the cron releases it. */
export async function updateHoldExpiryHours(
  client: ChairsideClient,
  salonId: string,
  hours: number,
): Promise<number> {
  const { data, error } = await client
    .from('settings')
    .update({ hold_expiry_hours: hours })
    .eq('salon_id', salonId)
    .select('hold_expiry_hours')
    .single();
  if (error) throw error;
  return data.hold_expiry_hours;
}
