import {
  buildExportArchive,
  exportCounts,
  exportPhotoPaths,
  ExportFormatError,
  readExportArchive,
  remapUuids,
  type ArchiveFile,
  type PhotoLink,
} from '@chairside/core/data-export';
import type {
  DataExportErrorBody,
  DataExportResponse,
  DataImportResponse,
} from '@chairside/db/data-export';
import { z } from 'zod';

import type { DataExportPort } from './types.ts';

export const DATA_EXPORT_LIMITS = {
  export: { limit: 5, windowSeconds: 3600 },
  import: { limit: 5, windowSeconds: 3600 },
} as const;

/** The in-app share link is short-lived; the emailed one lasts a day, then the file is purged. */
export const SHARE_LINK_SECONDS = 60 * 60;
export const EMAIL_LINK_SECONDS = 24 * 60 * 60;
export const EXPORT_RETENTION_MS = EMAIL_LINK_SECONDS * 1000;
/** Photos copied into the zip; the rest are listed in photos/links.csv (Edge memory is finite). */
export const PHOTO_ZIP_BUDGET_BYTES = 64 * 1024 * 1024;

export const dataExportRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('export'), salonId: z.uuid() }),
  z.object({ action: z.literal('import'), salonId: z.uuid(), path: z.string().min(1).max(300) }),
]);

export interface DataExportCaller {
  userId: string;
  email: string | null;
}

export interface DataExportDeps {
  port: DataExportPort;
  now?: () => number;
  randomId?: () => string;
  photoBudgetBytes?: number;
}

export type DataExportResult =
  | { status: 200; body: DataExportResponse | DataImportResponse }
  | { status: 400 | 403 | 404 | 409 | 429 | 500; body: DataExportErrorBody };

const fail = (
  status: Exclude<DataExportResult['status'], 200>,
  code: string,
  message: string,
): DataExportResult => ({ status, body: { error: { code, message } } });

/** Postgres errors the RPCs raise on purpose carry a message meant for the owner. */
function fromDatabase(e: unknown): DataExportResult | null {
  const err = e as { code?: string; message?: string } | null;
  const message = err?.message ?? 'Something went wrong';
  switch (err?.code) {
    case '42501':
      return fail(403, 'forbidden', 'Only the salon owner can export or restore its data');
    case '22023':
    case '23503':
      return fail(400, 'invalid_export', message);
    case '55000':
    case '23505':
      return fail(409, 'not_empty', message);
    default:
      return null;
  }
}

function slugFile(slug: string, now: number): string {
  const day = new Date(now).toISOString().slice(0, 10);
  return `chairside-export-${slug.replace(/[^a-z0-9-]/gi, '') || 'salon'}-${day}.zip`;
}

function defaultRandomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const PHOTO_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};

export function photoContentType(path: string): string {
  return PHOTO_TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'image/jpeg';
}

/** Deletes exports and restore uploads older than the retention window. */
async function purgeOld(port: DataExportPort, salonId: string, now: number): Promise<void> {
  const cutoff = now - EXPORT_RETENTION_MS;
  const files = [
    ...(await port.listExports(salonId)),
    ...(await port.listExports(`${salonId}/uploads`)),
  ];
  const stale = files
    .filter((f) => f.path.startsWith(`${salonId}/`) && Date.parse(f.createdAt) < cutoff)
    .map((f) => f.path);
  if (stale.length > 0) await port.removeExports(stale);
}

async function runExport(
  salonId: string,
  caller: DataExportCaller,
  deps: DataExportDeps,
): Promise<DataExportResult> {
  const { port } = deps;
  const now = (deps.now ?? Date.now)();
  const budget = deps.photoBudgetBytes ?? PHOTO_ZIP_BUDGET_BYTES;

  // The RPC is owner-only and returns only this salon's rows.
  const doc = await port.exportSalon(salonId);
  if (doc.salon.id !== salonId) return fail(500, 'internal', 'Export returned another salon');

  const photos: ArchiveFile[] = [];
  const links: PhotoLink[] = [];
  let missing = 0;
  let used = 0;
  for (const path of exportPhotoPaths(doc, salonId)) {
    if (used < budget) {
      const bytes = await port.readPhoto(path);
      if (!bytes) {
        missing++;
        continue;
      }
      if (used + bytes.length <= budget) {
        photos.push({ path, bytes });
        used += bytes.length;
        continue;
      }
      used = budget;
    }
    try {
      links.push({ path, url: await port.signPhoto(path, EMAIL_LINK_SECONDS) });
    } catch {
      missing++;
    }
  }

  const zip = buildExportArchive({ doc, photos, photoLinks: links });
  const fileName = slugFile(doc.salon.slug, now);
  const path = `${salonId}/${now}-${(deps.randomId ?? defaultRandomId)()}.zip`;
  await port.saveExport(path, zip);

  const counts = exportCounts(doc);
  const url = await port.signExport(path, SHARE_LINK_SECONDS, fileName);
  let emailedTo: string | null = null;
  if (port.sendExportEmail && caller.email) {
    try {
      await port.sendExportEmail({
        to: caller.email,
        salonName: doc.salon.name,
        url: await port.signExport(path, EMAIL_LINK_SECONDS, fileName),
        expiresAt: new Date(now + EMAIL_LINK_SECONDS * 1000).toISOString(),
        fileName,
        counts,
      });
      emailedTo = caller.email;
    } catch (e) {
      console.error('data export email failed', e instanceof Error ? e.message : e);
    }
  }

  try {
    await purgeOld(port, salonId, now);
  } catch (e) {
    console.error('data export purge failed', e instanceof Error ? e.message : e);
  }

  return {
    status: 200,
    body: {
      url,
      expiresAt: new Date(now + SHARE_LINK_SECONDS * 1000).toISOString(),
      fileName,
      emailedTo,
      counts,
      photos: { included: photos.length, linked: links.length, missing },
    },
  };
}

async function runImport(
  salonId: string,
  path: string,
  deps: DataExportDeps,
): Promise<DataExportResult> {
  const { port } = deps;
  if (!path.startsWith(`${salonId}/uploads/`) || path.includes('..')) {
    return fail(400, 'invalid_request', 'Upload the export to this salon first');
  }
  // Read with the caller's own client: storage RLS lets only this salon's owner see it.
  const bytes = await port.readUpload(path);
  if (!bytes) return fail(404, 'not_found', 'The uploaded export is gone. Upload it again.');

  let archive: ReturnType<typeof readExportArchive>;
  try {
    archive = readExportArchive(bytes);
  } catch (e) {
    if (e instanceof ExportFormatError) return fail(400, 'invalid_export', e.message);
    throw e;
  }

  const result = await port.importSalon(salonId, archive.doc);

  let restored = 0;
  let failed = 0;
  for (const photo of archive.photos) {
    const target = remapUuids(photo.path, result.ids);
    if (!target.startsWith(`${salonId}/`) || target.includes('..')) {
      failed++;
      continue;
    }
    try {
      await port.writePhoto(target, photo.bytes);
      restored++;
    } catch (e) {
      console.error('data import photo failed', e instanceof Error ? e.message : e);
      failed++;
    }
  }
  try {
    await port.removeExports([path]);
  } catch (e) {
    console.error('data import cleanup failed', e instanceof Error ? e.message : e);
  }
  return { status: 200, body: { counts: result.counts, photos: { restored, failed } } };
}

/** POST /functions/v1/data-export for a signed-in owner. */
export async function handleDataExportRequest(
  body: unknown,
  caller: DataExportCaller,
  deps: DataExportDeps,
): Promise<DataExportResult> {
  const parsed = dataExportRequestSchema.safeParse(body);
  if (!parsed.success) return fail(400, 'invalid_request', 'Invalid request');
  const request = parsed.data;

  const limit = DATA_EXPORT_LIMITS[request.action];
  const allowed = await deps.port.hitRateLimit(
    `data-${request.action}:${caller.userId}`,
    limit.limit,
    limit.windowSeconds,
  );
  if (!allowed) return fail(429, 'rate_limited', 'Too many requests. Try again in an hour.');

  try {
    return request.action === 'export'
      ? await runExport(request.salonId, caller, deps)
      : await runImport(request.salonId, request.path, deps);
  } catch (e) {
    const known = fromDatabase(e);
    if (known) return known;
    return fail(500, 'internal', e instanceof Error ? e.message : 'Something went wrong');
  }
}
