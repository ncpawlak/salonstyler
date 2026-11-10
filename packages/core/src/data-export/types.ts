/**
 * The shape `public.export_salon_data` returns (supabase/migrations/20261109470000_data_export.sql).
 * `data.json` in the archive is exactly this document; the CSVs are a human-friendly view of it.
 */

export const EXPORT_FORMAT = 'chairside-export';
export const EXPORT_VERSION = 1;

/** Storage bucket and table that hold client photos; the archive copies them under `photos/`. */
export const PHOTO_BUCKET = 'client-photos';
export const PHOTO_TABLE = 'client_photos';
export const PHOTO_PATH_COLUMN = 'storage_path';

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

/** A file inside the archive (photos keep their original storage path under `photos/`). */
export interface ArchiveFile {
  path: string;
  bytes: Uint8Array;
}

/** A photo that didn't fit in the archive: listed in `photos/links.csv` with a signed URL. */
export interface PhotoLink {
  path: string;
  url: string;
}
