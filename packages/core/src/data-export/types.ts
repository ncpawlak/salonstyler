/**
 * The shape `public.export_salon_data` returns (supabase/migrations/20261109470000_data_export.sql).
 * `data.json` in the archive is exactly this document; the CSVs are a human-friendly view of it.
 */

export const EXPORT_FORMAT = 'chairside-export';
export const EXPORT_VERSION = 1;

/**
 * Storage files referenced by exported rows. Each is copied into the archive under
 * `{folder}/{storage path}` and re-uploaded on restore with the path's ids remapped.
 * A feature whose table points at a storage object adds one entry here.
 */
export interface ExportFileSource {
  table: string;
  column: string;
  bucket: string;
  folder: string;
}

export const EXPORT_FILE_SOURCES: readonly ExportFileSource[] = [
  { table: 'client_photos', column: 'storage_path', bucket: 'client-photos', folder: 'photos' },
  { table: 'expenses', column: 'receipt_path', bucket: 'receipts', folder: 'receipts' },
];

export type ExportValue = string | number | boolean | null | ExportValue[] | ExportObject;
export interface ExportObject {
  [key: string]: ExportValue;
}

export interface ExportTable {
  columns: string[];
  rows: Record<string, ExportValue>[];
}

export interface ExportMember {
  user_id: string;
  role: 'owner' | 'stylist';
  email: string | null;
}

export interface SalonExport {
  format: typeof EXPORT_FORMAT;
  version: number;
  exported_at: string;
  salon: { id: string; name: string; slug: string; timezone: string };
  members: ExportMember[];
  /** Every registered salon-owned table, parents before children. */
  tables: Record<string, ExportTable>;
}

/** A storage file inside the archive, at `{folder of its bucket}/{path}`. */
export interface ArchiveFile {
  bucket: string;
  path: string;
  bytes: Uint8Array;
}

/** A file that didn't fit in the archive: listed in `links.csv` with a signed URL. */
export interface FileLink {
  bucket: string;
  path: string;
  url: string;
}
