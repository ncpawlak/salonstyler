import type { SalonExport } from '@chairside/core/data-export';

import type { ChairsideClient, Json } from './index.ts';

/**
 * Full data export (#46). Both RPCs are owner-only and scoped to one salon; the Edge Function
 * (supabase/functions/data-export) wraps them with the zip, photos, email and signed links.
 * See supabase/docs/data-export.md.
 */

/** Private bucket: `{salonId}/{file}.zip` exports and `{salonId}/uploads/…` restore uploads. */
export const DATA_EXPORT_BUCKET = 'data-exports';

export interface SalonImportResult {
  /** Old id → new id for every uuid the import rewrote (salon, members, rows). */
  ids: Record<string, string>;
  /** Rows restored per table. */
  counts: Record<string, number>;
}

export async function exportSalonData(
  client: ChairsideClient,
  salonId: string,
): Promise<SalonExport> {
  const { data, error } = await client.rpc('export_salon_data', { p_salon_id: salonId });
  if (error) throw error;
  return data as unknown as SalonExport;
}

/** Restores an export into `salonId`, which must be new and empty (the RPC refuses otherwise). */
export async function importSalonData(
  client: ChairsideClient,
  salonId: string,
  doc: SalonExport,
): Promise<SalonImportResult> {
  const { data, error } = await client.rpc('import_salon_data', {
    p_salon_id: salonId,
    p_export: doc as unknown as Json,
  });
  if (error) throw error;
  return data as unknown as SalonImportResult;
}

/** Where the app uploads a file to restore; the owner-only storage policy allows only this path. */
export function restoreUploadPath(salonId: string, fileName: string, stamp = Date.now()): string {
  const safe = fileName.replace(/[^A-Za-z0-9._-]+/g, '-').slice(-80) || 'export.zip';
  return `${salonId}/uploads/${stamp}-${safe}`;
}

/** `data-export` Edge Function requests and responses. */
export type DataExportRequest =
  { action: 'export'; salonId: string } | { action: 'import'; salonId: string; path: string };

export interface DataExportResponse {
  /** Signed download link for the share sheet. */
  url: string;
  expiresAt: string;
  fileName: string;
  /** The address the (longer-lived) link was emailed to, or null when email isn't set up. */
  emailedTo: string | null;
  counts: Record<string, number>;
  photos: { included: number; linked: number; missing: number };
}

export interface DataImportResponse {
  counts: Record<string, number>;
  photos: { restored: number; failed: number };
}

export interface DataExportErrorBody {
  error: { code: string; message: string };
}
