import type { ChairsideClient } from '@chairside/db';
import { DATA_EXPORT_BUCKET, exportSalonData, importSalonData } from '@chairside/db/data-export';
import { PHOTO_BUCKET } from '@chairside/core/data-export';

import { photoContentType } from './handler.ts';
import type { DataExportEmail, DataExportPort } from './types.ts';

async function bytesOf(blob: Blob | null): Promise<Uint8Array | null> {
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/**
 * `user` carries the caller's JWT (RPC owner checks, storage RLS on the restore upload);
 * `service` is the service-role client for photos and the exports bucket.
 */
export function createSupabaseDataExportPort(
  user: ChairsideClient,
  service: ChairsideClient,
  sendExportEmail: ((email: DataExportEmail) => Promise<void>) | null,
): DataExportPort {
  const exportsBucket = () => service.storage.from(DATA_EXPORT_BUCKET);
  const photos = () => service.storage.from(PHOTO_BUCKET);

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

    async readPhoto(path) {
      const { data, error } = await photos().download(path);
      if (error) return null;
      return bytesOf(data);
    },

    async writePhoto(path, bytes) {
      const { error } = await photos().upload(path, bytes, {
        contentType: photoContentType(path),
        upsert: false,
      });
      if (error) throw error;
    },

    async signPhoto(path, expiresInSeconds) {
      const { data, error } = await photos().createSignedUrl(path, expiresInSeconds);
      if (error) throw error;
      return data.signedUrl;
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
      return data.signedUrl;
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
