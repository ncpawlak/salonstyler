import type { SalonExport } from '@chairside/core/data-export';
import type { SalonImportResult } from '@chairside/db/data-export';

/** What the export email says; the Edge Function renders and sends it. */
export interface DataExportEmail {
  to: string;
  salonName: string;
  url: string;
  expiresAt: string;
  fileName: string;
  counts: Record<string, number>;
}

/**
 * Data access for the `data-export` Edge Function. The RPCs and the restore upload go through the
 * caller's client (owner checks in SQL and storage RLS); photo copies, the archive upload and the
 * signed links use the service client, only ever under the caller's `{salonId}/` folder.
 */
export interface DataExportPort {
  exportSalon(salonId: string): Promise<SalonExport>;
  importSalon(salonId: string, doc: SalonExport): Promise<SalonImportResult>;
  /** The caller's restore upload, read with their own client (null when missing or not theirs). */
  readUpload(path: string): Promise<Uint8Array | null>;
  hitRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean>;
  readPhoto(path: string): Promise<Uint8Array | null>;
  writePhoto(path: string, bytes: Uint8Array): Promise<void>;
  signPhoto(path: string, expiresInSeconds: number): Promise<string>;
  saveExport(path: string, bytes: Uint8Array): Promise<void>;
  signExport(path: string, expiresInSeconds: number, downloadName: string): Promise<string>;
  /** Files directly in `folder` of the exports bucket (not sub-folders). */
  listExports(folder: string): Promise<{ path: string; createdAt: string }[]>;
  removeExports(paths: string[]): Promise<void>;
  /** Null when no email transport is configured. */
  sendExportEmail: ((email: DataExportEmail) => Promise<void>) | null;
}

export type {
  DataExportErrorBody,
  DataExportResponse,
  DataImportResponse,
} from '@chairside/db/data-export';
