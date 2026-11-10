import type { ChairsideClient } from '@chairside/db';
import { DATA_EXPORT_BUCKET, exportSalonData, importSalonData } from '@chairside/db/data-export';
import { EXPORT_FILE_SOURCES } from '@chairside/core/data-export';

import { photoContentType } from './handler.ts';
import type { DataExportEmail, DataExportPort } from './types.ts';

/**
 * Point a signed URL at `publicUrl`. Locally the functions runtime reaches the API as
 * `http://kong:8000`, which a browser or an email reader can't open.
 */
export function publicSignedUrl(signedUrl: string, publicUrl: string | null | undefined): string {
  if (!publicUrl) return signedUrl;
  const signed = new URL(signedUrl);
  const base = new URL(publicUrl);
  signed.protocol = base.protocol;
  signed.host = base.host;
  return signed.toString();
}

async function bytesOf(blob: Blob | null): Promise<Uint8Array | null> {
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/**
 * `user` carries the caller's JWT (RPC owner checks, storage RLS on the restore upload);
 * `service` is the service-role client for photos, receipts and the exports bucket.
 */
export function createSupabaseDataExportPort(
  user: ChairsideClient,
  service: ChairsideClient,
  sendExportEmail: ((email: DataExportEmail) => Promise<void>) | null,
  publicUrl?: string | null,
): DataExportPort {
  const exportsBucket = () => service.storage.from(DATA_EXPORT_BUCKET);
  // The service client bypasses storage RLS, so only the buckets the export knows about.
  const files = (bucket: string) => {
    if (!EXPORT_FILE_SOURCES.some((s) => s.bucket === bucket)) {
      throw new Error(`Bucket ${bucket} is not part of the export`);
    }
    return service.storage.from(bucket);
  };

  return {
    exportSalon: (salonId) => exportSalonData(user, salonId),

    importSalon: (salonId, doc) => importSalonData(user, salonId, doc),

    async readUpload(path) {
      const { data, error } = await user.storage.from(DATA_EXPORT_BUCKET).download(path);
      if (error) return null;
      return bytesOf(data);
    },

    async hitRateLimit(key, limit, windowSeconds) {
      const { data, error } = await service.rpc('hit_rate_limit', {
        p_key: key,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      });
      if (error) throw error;
      return data;
    },

    async readFile(bucket, path) {
      const { data, error } = await files(bucket).download(path);
      if (error) return null;
      return bytesOf(data);
    },

    async writeFile(bucket, path, bytes) {
      const { error } = await files(bucket).upload(path, bytes, {
        contentType: photoContentType(path),
        upsert: false,
      });
      if (error) throw error;
    },

    async signFile(bucket, path, expiresInSeconds) {
      const { data, error } = await files(bucket).createSignedUrl(path, expiresInSeconds);
      if (error) throw error;
      return publicSignedUrl(data.signedUrl, publicUrl);
    },

    async saveExport(path, bytes) {
      const { error } = await exportsBucket().upload(path, bytes, {
        contentType: 'application/zip',
        upsert: false,
      });
      if (error) throw error;
    },

    async signExport(path, expiresInSeconds, downloadName) {
      const { data, error } = await exportsBucket().createSignedUrl(path, expiresInSeconds, {
        download: downloadName,
      });
      if (error) throw error;
      return publicSignedUrl(data.signedUrl, publicUrl);
    },

    async listExports(folder) {
      const { data, error } = await exportsBucket().list(folder, { limit: 1000 });
      if (error) throw error;
      return (data ?? []).flatMap((f) =>
        f.id !== null && f.created_at
          ? [{ path: `${folder}/${f.name}`, createdAt: f.created_at }]
          : [],
      );
    },

    async removeExports(paths) {
      const { error } = await exportsBucket().remove(paths);
      if (error) throw error;
    },

    sendExportEmail,
  };
}
