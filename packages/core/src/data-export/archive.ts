import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';

import { tableToCsv } from './csv.ts';
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  PHOTO_PATH_COLUMN,
  PHOTO_TABLE,
  type ArchiveFile,
  type PhotoLink,
  type SalonExport,
} from './types.ts';

export class ExportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportFormatError';
  }
}

/** Row counts per table, in export order. */
export function exportCounts(doc: SalonExport): Record<string, number> {
  return Object.fromEntries(Object.entries(doc.tables).map(([name, t]) => [name, t.rows.length]));
}

/** Storage paths of every client photo in the export that belongs to `salonId`. */
export function exportPhotoPaths(doc: SalonExport, salonId: string = doc.salon.id): string[] {
  const rows = doc.tables[PHOTO_TABLE]?.rows ?? [];
  return rows
    .map((row) => row[PHOTO_PATH_COLUMN])
    .filter(
      (p): p is string => typeof p === 'string' && p.startsWith(`${salonId}/`) && !p.includes('..'),
    );
}

export function exportReadme(doc: SalonExport, extras: { links: number } = { links: 0 }): string {
  const counts = exportCounts(doc);
  const width = Math.max(...Object.keys(counts).map((n) => n.length), 5);
  const lines = [
    `Chairside export: ${doc.salon.name}`,
    `Exported ${doc.exported_at} (format ${doc.format} v${doc.version})`,
    '',
    'What is in here',
    '  data.json   Everything, exactly. Chairside restores from this file (Settings > Export',
    '              your data > Restore, into a new, empty salon).',
    '  csv/        One CSV per table for spreadsheets and other apps. Values that look like',
    "              spreadsheet formulas start with an apostrophe (') so they can't run.",
    '              JSON columns (like formula details) are written as JSON text.',
    '  members.csv Who had access (by email) and their role.',
    '  photos/     Client photos, in the same folders as storage_path in csv/client_photos.csv.',
  ];
  if (extras.links > 0) {
    lines.push(
      `              ${extras.links} photo(s) didn't fit; photos/links.csv has download links`,
      '              that expire in 24 hours.',
    );
  }
  lines.push(
    '',
    'Left out on purpose: private links (booking, receipt, deposit and waitlist tokens),',
    'payment-provider credentials, AI keys, push tokens and delivery queues.',
    '',
    'Rows per table',
    ...Object.entries(counts).map(([name, n]) => `  ${name.padEnd(width)}  ${n}`),
    '',
  );
  return lines.join('\r\n');
}

/** Builds the zip: README.txt, data.json, csv/*.csv, members.csv and photos/. */
export function buildExportArchive(input: {
  doc: SalonExport;
  photos?: ArchiveFile[];
  photoLinks?: PhotoLink[];
}): Uint8Array {
  const { doc, photos = [], photoLinks = [] } = input;
  const files: Zippable = {
    'README.txt': strToU8(exportReadme(doc, { links: photoLinks.length })),
    'data.json': strToU8(JSON.stringify(doc, null, 2)),
    'members.csv': strToU8(
      tableToCsv({
        columns: ['user_id', 'role', 'email'],
        rows: doc.members.map((m) => ({ ...m })),
      }),
    ),
  };
  for (const [name, table] of Object.entries(doc.tables)) {
    files[`csv/${name}.csv`] = strToU8(tableToCsv(table));
  }
  // Photos are already compressed: store them as-is.
  for (const photo of photos) files[`photos/${photo.path}`] = [photo.bytes, { level: 0 }];
  if (photoLinks.length > 0) {
    files['photos/links.csv'] = strToU8(
      tableToCsv({
        columns: ['storage_path', 'url'],
        rows: photoLinks.map((l) => ({ storage_path: l.path, url: l.url })),
      }),
    );
  }
  return zipSync(files, { level: 6 });
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export function parseExportJson(text: string): SalonExport {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ExportFormatError("That file isn't a Chairside export");
  }
  const d = doc as Partial<SalonExport> | null;
  if (!d || d.format !== EXPORT_FORMAT || typeof d.tables !== 'object' || !d.salon) {
    throw new ExportFormatError("That file isn't a Chairside export");
  }
  if (d.version !== EXPORT_VERSION) {
    throw new ExportFormatError('This export was made by a newer version of Chairside');
  }
  return d as SalonExport;
}

/** Reads an export zip (or a bare data.json) back into the document and its photos. */
export function readExportArchive(bytes: Uint8Array): { doc: SalonExport; photos: ArchiveFile[] } {
  if (!isZip(bytes)) return { doc: parseExportJson(strFromU8(bytes)), photos: [] };
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (f) =>
        f.name === 'data.json' || (f.name.startsWith('photos/') && f.name !== 'photos/links.csv'),
    });
  } catch {
    throw new ExportFormatError("That zip couldn't be opened");
  }
  const data = entries['data.json'];
  if (!data) throw new ExportFormatError('That zip has no data.json');
  const doc = parseExportJson(strFromU8(data));
  const known = new Set(exportPhotoPaths(doc));
  const photos: ArchiveFile[] = [];
  for (const [name, content] of Object.entries(entries)) {
    const path = name.slice('photos/'.length);
    if (name.startsWith('photos/') && known.has(path) && content.length > 0) {
      photos.push({ path, bytes: content });
    }
  }
  return { doc, photos };
}
