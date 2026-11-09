import type { ImportedSegment } from '@chairside/core';

import type { AppointmentServiceSnapshot } from './appointments.ts';
import type { Json } from './database.types.ts';
import type { ChairsideClient } from './index.ts';

/** One normalized client row for `import_clients` (built by `buildClientImport` in core). */
export interface ImportClientInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  /** `YYYY-MM-DD`; year 1604 means "year unknown". */
  birthday?: string | null;
  tags?: string[];
  lastVisitOn?: string | null;
  noShowCount?: number;
  notes?: string | null;
}

export type ImportClientStatus = 'created' | 'updated' | 'unchanged' | 'invalid';

export interface ImportClientsResult {
  created: number;
  updated: number;
  unchanged: number;
  invalid: number;
  results: { index: number; status: ImportClientStatus; clientId?: string; message?: string }[];
}

/** Max rows per `import_clients` call (the RPC rejects more). */
export const IMPORT_CLIENTS_BATCH = 500;

/** Creates or fills in clients; re-sending the same rows is a no-op. Dedupes on email/phone/name. */
export async function importClients(
  client: ChairsideClient,
  salonId: string,
  clients: ImportClientInput[],
): Promise<ImportClientsResult> {
  const { data, error } = await client.rpc('import_clients', {
    p_salon_id: salonId,
    p_clients: clients as unknown as Json,
  });
  if (error) throw error;
  return data as unknown as ImportClientsResult;
}

export interface ImportAppointmentInput {
  /** Stable key from the export (e.g. `vagaro:id:123`); already-imported keys are skipped. */
  key: string;
  clientId?: string | null;
  segments: ImportedSegment[];
  services?: AppointmentServiceSnapshot[];
  priceCents?: number | null;
  notes?: string | null;
}

export type ImportAppointmentStatus = 'booked' | 'duplicate' | 'past' | 'conflict' | 'invalid';

export interface ImportAppointmentConflict {
  appointmentId: string;
  startsAt: string;
  clientName: string | null;
}

export interface ImportAppointmentsResult {
  booked: number;
  duplicate: number;
  past: number;
  conflict: number;
  invalid: number;
  results: {
    index: number;
    status: ImportAppointmentStatus;
    appointmentId?: string;
    message?: string;
    conflict?: ImportAppointmentConflict | null;
  }[];
}

/** Max rows per `import_appointments` call (the RPC rejects more). */
export const IMPORT_APPOINTMENTS_BATCH = 200;

export interface ClientContact {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
}

/** Every client's name/phone/email (paged past the 1000-row API limit), for import previews. */
export async function listClientContacts(
  client: ChairsideClient,
  salonId: string,
): Promise<ClientContact[]> {
  const page = 1000;
  const out: ClientContact[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await client
      .from('clients')
      .select('id, name, phone, email')
      .eq('salon_id', salonId)
      .order('created_at')
      .order('id')
      .range(from, from + page - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < page) return out;
  }
}

/**
 * Books imported appointments as confirmed on the caller's calendar. Overlaps come back as
 * `conflict` rows (with the clashing appointment) rather than failing the batch.
 */
export async function importAppointments(
  client: ChairsideClient,
  salonId: string,
  appointments: ImportAppointmentInput[],
): Promise<ImportAppointmentsResult> {
  const { data, error } = await client.rpc('import_appointments', {
    p_salon_id: salonId,
    p_appointments: appointments as unknown as Json,
  });
  if (error) throw error;
  return data as unknown as ImportAppointmentsResult;
}
