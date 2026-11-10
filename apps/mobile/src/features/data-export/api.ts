import {
  DATA_EXPORT_BUCKET,
  restoreUploadPath,
  type DataExportRequest,
  type DataExportResponse,
  type DataImportResponse,
} from '@chairside/db/data-export';

import { readFunctionError } from '@/features/payments/api';
import { supabase } from '@/lib/supabase';

async function invokeDataExport<T>(body: DataExportRequest): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>('data-export', { body });
  if (error) throw await readFunctionError(error);
  return data as T;
}

/** Builds the zip, emails the owner a 24-hour link and returns a 1-hour link to share now. */
export const exportSalonData = (salonId: string) =>
  invokeDataExport<DataExportResponse>({ action: 'export', salonId });

const isZip = (bytes: Uint8Array) => bytes[0] === 0x50 && bytes[1] === 0x4b;

/** Uploads an export (zip or data.json) to the salon's private folder and restores it. */
export async function restoreSalonData(
  salonId: string,
  file: { name: string; bytes: Uint8Array },
): Promise<DataImportResponse> {
  const path = restoreUploadPath(salonId, file.name);
  const { error } = await supabase.storage.from(DATA_EXPORT_BUCKET).upload(path, file.bytes, {
    contentType: isZip(file.bytes) ? 'application/zip' : 'application/json',
    upsert: false,
  });
  if (error) throw error;
  return invokeDataExport<DataImportResponse>({ action: 'import', salonId, path });
}

const LABELS: [table: string, one: string, many: string][] = [
  ['clients', 'client', 'clients'],
  ['appointments', 'appointment', 'appointments'],
  ['services', 'service', 'services'],
  ['payments', 'payment', 'payments'],
  ['client_formulas', 'formula', 'formulas'],
  ['client_photos', 'photo', 'photos'],
  ['products', 'product', 'products'],
  ['expenses', 'expense', 'expenses'],
];

/** "12 clients · 40 appointments · …" for the tables owners care about most. */
export function summarizeCounts(counts: Record<string, number>): string {
  return LABELS.filter(([t]) => counts[t] !== undefined)
    .map(([t, one, many]) => `${counts[t]} ${counts[t] === 1 ? one : many}`)
    .join(' · ');
}
