import { strToU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { buildExportArchive, type SalonExport } from '@chairside/core/data-export';

import {
  DATA_EXPORT_LIMITS,
  EMAIL_LINK_SECONDS,
  EXPORT_RETENTION_MS,
  handleDataExportRequest,
  SHARE_LINK_SECONDS,
} from './handler.ts';
import type {
  DataExportEmail,
  DataExportPort,
  DataExportResponse,
  DataImportResponse,
} from './types.ts';

const SALON = '00000000-0000-4000-8000-000000000001';
const NEW_SALON = '00000000-0000-4000-8000-0000000000b1';
const OTHER_SALON = '00000000-0000-4000-8000-0000000000x1'.replace('x', 'f');
const CLIENT = '00000000-0000-4000-8000-000000000101';
const NEW_CLIENT = '00000000-0000-4000-8000-0000000001b1';
const USER = '00000000-0000-4000-8000-00000000aaaa';
const NOW = Date.parse('2026-11-09T12:00:00Z');

function doc(): SalonExport {
  const photo = (name: string, salon = SALON) => ({
    id: CLIENT,
    salon_id: SALON,
    client_id: CLIENT,
    storage_path: `${salon}/${CLIENT}/${name}`,
  });
  return {
    format: 'chairside-export',
    version: 1,
    exported_at: '2026-11-09T12:00:00Z',
    salon: { id: SALON, name: 'Studio A', slug: 'studio-a', timezone: 'America/Denver' },
    members: [{ user_id: USER, role: 'owner', email: 'owner@example.com' }],
    tables: {
      clients: { columns: ['id', 'full_name'], rows: [{ id: CLIENT, full_name: 'Ana' }] },
      client_photos: {
        columns: ['id', 'salon_id', 'client_id', 'storage_path'],
        rows: [photo('a.jpg'), photo('b.png'), photo('gone.jpg'), photo('x.jpg', OTHER_SALON)],
      },
    },
  };
}

interface Fake {
  port: DataExportPort;
  exportsBucket: Map<string, { bytes: Uint8Array; createdAt: string }>;
  photos: Map<string, Uint8Array>;
  emails: DataExportEmail[];
  photoReads: string[];
  signed: { path: string; seconds: number; name?: string }[];
  imported: { salonId: string; doc: SalonExport }[];
  rateKeys: string[];
}

function fakePort(
  options: {
    allowed?: boolean;
    exportError?: unknown;
    email?: boolean;
    uploads?: Record<string, Uint8Array>;
  } = {},
): Fake {
  const photos = new Map<string, Uint8Array>([
    [`${SALON}/${CLIENT}/a.jpg`, new Uint8Array(10).fill(1)],
    [`${SALON}/${CLIENT}/b.png`, new Uint8Array(10).fill(2)],
    [`${OTHER_SALON}/${CLIENT}/x.jpg`, new Uint8Array(10).fill(9)],
  ]);
  const exportsBucket = new Map<string, { bytes: Uint8Array; createdAt: string }>();
  for (const [path, bytes] of Object.entries(options.uploads ?? {})) {
    exportsBucket.set(path, { bytes, createdAt: new Date(NOW).toISOString() });
  }
  const fake: Fake = {
    exportsBucket,
    photos,
    emails: [],
    photoReads: [],
    signed: [],
    imported: [],
    rateKeys: [],
    port: {
      async exportSalon(salonId) {
        if (options.exportError) throw options.exportError;
        return { ...doc(), salon: { ...doc().salon, id: salonId } };
      },
      async importSalon(salonId, d) {
        fake.imported.push({ salonId, doc: d });
        return { ids: { [SALON]: NEW_SALON, [CLIENT]: NEW_CLIENT }, counts: { clients: 1 } };
      },
      async readUpload(path) {
        return exportsBucket.get(path)?.bytes ?? null;
      },
      async hitRateLimit(key) {
        fake.rateKeys.push(key);
        return options.allowed ?? true;
      },
      async readPhoto(path) {
        fake.photoReads.push(path);
        return photos.get(path) ?? null;
      },
      async writePhoto(path, bytes) {
        if (photos.has(path)) throw new Error('exists');
        photos.set(path, bytes);
      },
      async signPhoto(path, seconds) {
        fake.signed.push({ path, seconds });
        return `https://signed/photo/${path}`;
      },
      async saveExport(path, bytes) {
        exportsBucket.set(path, { bytes, createdAt: new Date(NOW).toISOString() });
      },
      async signExport(path, seconds, name) {
        fake.signed.push({ path, seconds, name });
        return `https://signed/${path}?ttl=${seconds}`;
      },
      async listExports(folder) {
        return [...exportsBucket.entries()]
          .filter(([p]) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes('/'))
          .map(([path, f]) => ({ path, createdAt: f.createdAt }));
      },
      async removeExports(paths) {
        for (const p of paths) exportsBucket.delete(p);
      },
      sendExportEmail:
        options.email === false
          ? null
          : async (email) => {
              fake.emails.push(email);
            },
    },
  };
  return fake;
}

const caller = { userId: USER, email: 'owner@example.com' };
const deps = (fake: Fake, extra: { photoBudgetBytes?: number } = {}) => ({
  port: fake.port,
  now: () => NOW,
  randomId: () => 'abc',
  ...extra,
});

describe('export', () => {
  it('zips this salon only, stores it under the salon folder, signs and emails links', async () => {
    const fake = fakePort();
    const old = `${SALON}/${NOW - EXPORT_RETENTION_MS - 1}-old.zip`;
    fake.exportsBucket.set(old, {
      bytes: new Uint8Array(),
      createdAt: new Date(NOW - EXPORT_RETENTION_MS - 1).toISOString(),
    });
    const staleUpload = `${SALON}/uploads/old.zip`;
    fake.exportsBucket.set(staleUpload, {
      bytes: new Uint8Array(),
      createdAt: new Date(NOW - EXPORT_RETENTION_MS - 1).toISOString(),
    });

    const result = await handleDataExportRequest(
      { action: 'export', salonId: SALON },
      caller,
      deps(fake),
    );

    expect(result.status).toBe(200);
    const body = result.body as DataExportResponse;
    const path = `${SALON}/${NOW}-abc.zip`;
    expect(body).toEqual({
      url: `https://signed/${path}?ttl=${SHARE_LINK_SECONDS}`,
      expiresAt: new Date(NOW + SHARE_LINK_SECONDS * 1000).toISOString(),
      fileName: 'chairside-export-studio-a-2026-11-09.zip',
      emailedTo: 'owner@example.com',
      counts: { clients: 1, client_photos: 4 },
      photos: { included: 2, linked: 0, missing: 1 },
    });
    // Never touches another salon's photo, even when a row points at it.
    expect(fake.photoReads).not.toContain(`${OTHER_SALON}/${CLIENT}/x.jpg`);
    expect(fake.emails).toEqual([
      {
        to: 'owner@example.com',
        salonName: 'Studio A',
        url: `https://signed/${path}?ttl=${EMAIL_LINK_SECONDS}`,
        expiresAt: new Date(NOW + EMAIL_LINK_SECONDS * 1000).toISOString(),
        fileName: 'chairside-export-studio-a-2026-11-09.zip',
        counts: { clients: 1, client_photos: 4 },
      },
    ]);
    expect(fake.exportsBucket.has(old)).toBe(false);
    expect(fake.exportsBucket.has(staleUpload)).toBe(false);
    const entries = Object.keys(unzipSync(fake.exportsBucket.get(path)!.bytes));
    expect(entries).toContain(`photos/${SALON}/${CLIENT}/a.jpg`);
    expect(entries).toContain('csv/clients.csv');
    expect(fake.rateKeys).toEqual([`data-export:${USER}`]);
  });

  it('links photos past the zip budget instead of loading them', async () => {
    const fake = fakePort({ email: false });
    const result = await handleDataExportRequest(
      { action: 'export', salonId: SALON },
      caller,
      deps(fake, { photoBudgetBytes: 15 }),
    );
    const body = result.body as DataExportResponse;
    expect(body.photos).toEqual({ included: 1, linked: 2, missing: 0 });
    expect(body.emailedTo).toBeNull();
    const entries = unzipSync(fake.exportsBucket.get(`${SALON}/${NOW}-abc.zip`)!.bytes);
    expect(Object.keys(entries)).toContain('photos/links.csv');
    expect(fake.signed.filter((s) => s.path.endsWith('.jpg') || s.path.endsWith('.png'))).toEqual([
      { path: `${SALON}/${CLIENT}/b.png`, seconds: EMAIL_LINK_SECONDS },
      { path: `${SALON}/${CLIENT}/gone.jpg`, seconds: EMAIL_LINK_SECONDS },
    ]);
  });

  it('maps the owner check and the rate limit', async () => {
    const denied = await handleDataExportRequest(
      { action: 'export', salonId: SALON },
      caller,
      deps(fakePort({ exportError: { code: '42501', message: 'no' } })),
    );
    expect(denied).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });

    const limited = await handleDataExportRequest(
      { action: 'export', salonId: SALON },
      caller,
      deps(fakePort({ allowed: false })),
    );
    expect(limited.status).toBe(429);
    expect(DATA_EXPORT_LIMITS.export.limit).toBeGreaterThan(0);

    const bad = await handleDataExportRequest(
      { action: 'export', salonId: 'x' },
      caller,
      deps(fakePort()),
    );
    expect(bad.status).toBe(400);
  });
});

describe('import', () => {
  const upload = `${NEW_SALON}/uploads/1-export.zip`;
  const zip = () =>
    buildExportArchive({
      doc: doc(),
      photos: [
        { path: `${SALON}/${CLIENT}/a.jpg`, bytes: new Uint8Array([7]) },
        { path: `${SALON}/${CLIENT}/b.png`, bytes: new Uint8Array([8]) },
      ],
    });

  it('restores rows, moves photos to the new ids and removes the upload', async () => {
    const fake = fakePort({ uploads: { [upload]: zip() } });
    fake.photos.set(`${NEW_SALON}/${NEW_CLIENT}/b.png`, new Uint8Array([0]));
    const result = await handleDataExportRequest(
      { action: 'import', salonId: NEW_SALON, path: upload },
      caller,
      deps(fake),
    );
    expect(result.status).toBe(200);
    expect(result.body as DataImportResponse).toEqual({
      counts: { clients: 1 },
      photos: { restored: 1, failed: 1 },
    });
    expect(fake.imported).toEqual([{ salonId: NEW_SALON, doc: doc() }]);
    expect(fake.photos.get(`${NEW_SALON}/${NEW_CLIENT}/a.jpg`)).toEqual(new Uint8Array([7]));
    expect(fake.exportsBucket.has(upload)).toBe(false);
  });

  it('only reads uploads inside the salon upload folder', async () => {
    const fake = fakePort({ uploads: { [`${SALON}/uploads/x.zip`]: zip() } });
    for (const path of [
      `${SALON}/uploads/x.zip`,
      `${NEW_SALON}/x.zip`,
      `${NEW_SALON}/uploads/../x`,
    ]) {
      const result = await handleDataExportRequest(
        { action: 'import', salonId: NEW_SALON, path },
        caller,
        deps(fake),
      );
      expect(result.status).toBe(400);
    }
    expect(fake.imported).toEqual([]);
  });

  it('rejects files that are not exports and a missing upload', async () => {
    const fake = fakePort({ uploads: { [upload]: strToU8('hello') } });
    const bad = await handleDataExportRequest(
      { action: 'import', salonId: NEW_SALON, path: upload },
      caller,
      deps(fake),
    );
    expect(bad).toMatchObject({ status: 400, body: { error: { code: 'invalid_export' } } });

    const gone = await handleDataExportRequest(
      { action: 'import', salonId: NEW_SALON, path: `${NEW_SALON}/uploads/none.zip` },
      caller,
      deps(fake),
    );
    expect(gone.status).toBe(404);
  });

  it('passes the database refusal through', async () => {
    const fake = fakePort({ uploads: { [upload]: zip() } });
    fake.port.importSalon = async () => {
      throw { code: '55000', message: 'Restore only works into a new, empty salon' };
    };
    const result = await handleDataExportRequest(
      { action: 'import', salonId: NEW_SALON, path: upload },
      caller,
      deps(fake),
    );
    expect(result).toEqual({
      status: 409,
      body: { error: { code: 'not_empty', message: 'Restore only works into a new, empty salon' } },
    });
  });
});

describe('publicSignedUrl', () => {
  it('moves a local kong URL onto the public API origin, keeping the token', async () => {
    const { publicSignedUrl } = await import('./supabase-port.ts');
    const signed =
      'http://kong:8000/storage/v1/object/sign/data-exports/s/x.zip?token=abc&download=x.zip';
    expect(publicSignedUrl(signed, 'http://127.0.0.1:54321')).toBe(
      'http://127.0.0.1:54321/storage/v1/object/sign/data-exports/s/x.zip?token=abc&download=x.zip',
    );
    expect(publicSignedUrl(signed, undefined)).toBe(signed);
  });
});
