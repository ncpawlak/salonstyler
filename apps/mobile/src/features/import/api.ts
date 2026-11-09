import {
  guessColumnMapping,
  parseCsvTable,
  redactedColumnSamples,
  tableFromRows,
  type ColumnMapping,
  type ImportKind,
  type ImportTable,
} from '@chairside/core';
import {
  IMPORT_APPOINTMENTS_BATCH,
  IMPORT_CLIENTS_BATCH,
  importAppointments,
  importClients,
  listClientContacts,
  type ImportAppointmentInput,
  type ImportAppointmentsResult,
  type ImportClientInput,
  type ImportClientsResult,
} from '@chairside/db/import';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

import { AiRequestError, invokeAi } from '../ai-settings/api';
import { appointmentsKey, clientsKey } from '../appointments/api';
import { chunk } from './plan';
import { isZip, readXlsxRows } from './xlsx';

export interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

/** Parses a picked .csv / .xlsx into a table (header row auto-detected). */
export function readImportFile(file: PickedFile): ImportTable {
  if (isZip(file.bytes)) return tableFromRows(readXlsxRows(file.bytes));
  if (/\.xls$/i.test(file.name)) {
    throw new Error('Old .xls files aren’t supported. Export as Excel (.xlsx) or CSV instead.');
  }
  return parseCsvTable(new TextDecoder('utf-8').decode(file.bytes));
}

export type MappingSource = 'ai' | 'demo' | 'manual';

export interface ProposedMapping {
  mapping: ColumnMapping;
  source: MappingSource;
  /** Why AI wasn't used (shown above the manual mapping). */
  notice?: string;
}

function fallbackNotice(error: unknown): string {
  const code = error instanceof AiRequestError ? error.code : 'network';
  if (code === 'not_configured') {
    return 'AI isn’t set up, so columns were matched by their headers. Check them below.';
  }
  if (code === 'budget_exceeded') {
    return 'This month’s AI budget is used up, so columns were matched by their headers. Check them below.';
  }
  return 'AI couldn’t map the columns right now, so they were matched by their headers. Check them below.';
}

/**
 * Asks the salon's AI (server-side, redacted samples only) to map the columns; falls back to the
 * header-based guess when AI isn't set up or fails. The owner confirms either way.
 */
export async function proposeColumnMapping(
  salonId: string,
  kind: ImportKind,
  table: ImportTable,
): Promise<ProposedMapping> {
  const headers = table.headers.slice(0, 100).map((h) => h.slice(0, 120));
  try {
    const res = await invokeAi(supabase, {
      action: 'map_columns',
      salonId,
      kind,
      headers,
      samples: redactedColumnSamples(table).slice(0, 100),
    });
    return { mapping: res.mapping, source: res.source };
  } catch (e) {
    return {
      mapping: guessColumnMapping(kind, table.headers),
      source: 'manual',
      notice: fallbackNotice(e),
    };
  }
}

export function useClientContacts(enabled: boolean) {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: [...clientsKey(salon.id), 'contacts'],
    queryFn: () => listClientContacts(supabase, salon.id),
    enabled,
  });
}

export function useInvalidateAfterImport() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: appointmentsKey(salon.id) }),
      queryClient.invalidateQueries({ queryKey: clientsKey(salon.id) }),
    ]);
}

type Progress = (done: number, total: number) => void;

/** Imports clients in RPC-sized batches; result indexes refer to `clients`. */
export async function runClientImport(
  salonId: string,
  clients: readonly ImportClientInput[],
  onProgress?: Progress,
): Promise<ImportClientsResult> {
  const total: ImportClientsResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    invalid: 0,
    results: [],
  };
  let offset = 0;
  for (const batch of chunk(clients, IMPORT_CLIENTS_BATCH)) {
    const r = await importClients(supabase, salonId, batch);
    total.created += r.created;
    total.updated += r.updated;
    total.unchanged += r.unchanged;
    total.invalid += r.invalid;
    total.results.push(...r.results.map((x) => ({ ...x, index: x.index + offset })));
    offset += batch.length;
    onProgress?.(offset, clients.length);
  }
  return total;
}

/** Books appointments in RPC-sized batches; result indexes refer to `appointments`. */
export async function runAppointmentImport(
  salonId: string,
  appointments: readonly ImportAppointmentInput[],
  onProgress?: Progress,
): Promise<ImportAppointmentsResult> {
  const total: ImportAppointmentsResult = {
    booked: 0,
    duplicate: 0,
    past: 0,
    conflict: 0,
    invalid: 0,
    results: [],
  };
  let offset = 0;
  for (const batch of chunk(appointments, IMPORT_APPOINTMENTS_BATCH)) {
    const r = await importAppointments(supabase, salonId, batch);
    total.booked += r.booked;
    total.duplicate += r.duplicate;
    total.past += r.past;
    total.conflict += r.conflict;
    total.invalid += r.invalid;
    total.results.push(...r.results.map((x) => ({ ...x, index: x.index + offset })));
    offset += batch.length;
    onProgress?.(offset, appointments.length);
  }
  return total;
}

/** Reads a picked file's bytes (works for web blob: URLs and native file:// URIs). */
export async function readPickedBytes(uri: string, file?: Blob | null): Promise<Uint8Array> {
  const buffer = file ? await file.arrayBuffer() : await (await fetch(uri)).arrayBuffer();
  return new Uint8Array(buffer);
}
