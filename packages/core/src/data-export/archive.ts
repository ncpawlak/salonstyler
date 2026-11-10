import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';

import { tableToCsv } from './csv.ts';
import {
  EXPORT_FILE_SOURCES,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  type ArchiveFile,
  type FileLink,
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

/** Storage files (photos, receipts) the export references that belong to `salonId`. */
export function exportFiles(
  doc: SalonExport,
  salonId: string = doc.salon.id,
): { bucket: string; path: string }[] {
  return EXPORT_FILE_SOURCES.flatMap((source) =>
    (doc.tables[source.table]?.rows ?? [])
      .map((row) => row[source.column])
      .filter(
        (p): p is string =>
          typeof p === 'string' && p.startsWith(`${salonId}/`) && !p.includes('..'),
      )
      .map((path) => ({ bucket: source.bucket, path })),
  );
}

function folderOf(bucket: string): string {
  const source = EXPORT_FILE_SOURCES.find((s) => s.bucket === bucket);
  if (!source) throw new ExportFormatError(`Unknown storage bucket ${bucket}`);
  return source.folder;
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
    '  receipts/   Expense receipts, as receipt_path in csv/expenses.csv.',
  ];
  if (extras.links > 0) {
    lines.push(
      `  links.csv   ${extras.links} file(s) didn't fit in the zip; download links that`,
      '              expire in 24 hours.',
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

/** Builds the zip: README.txt, data.json, csv/*.csv, members.csv and the storage files. */
export function buildExportArchive(input: {
  doc: SalonExport;
  files?: ArchiveFile[];
  links?: FileLink[];
}): Uint8Array {
  const { doc, files: stored = [], links = [] } = input;
  const files: Zippable = {
    'README.txt': strToU8(exportReadme(doc, { links: links.length })),
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
  // Photos and receipts are already-compressed images: store them as-is.
  for (const file of stored)
    files[`${folderOf(file.bucket)}/${file.path}`] = [file.bytes, { level: 0 }];
  if (links.length > 0) {
    files['links.csv'] = strToU8(
      tableToCsv({
        columns: ['bucket', 'storage_path', 'url'],
        rows: links.map((l) => ({ bucket: l.bucket, storage_path: l.path, url: l.url })),
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

/** Reads an export zip (or a bare data.json) back into the document and its storage files. */
export function readExportArchive(bytes: Uint8Array): { doc: SalonExport; files: ArchiveFile[] } {
  if (!isZip(bytes)) return { doc: parseExportJson(strFromU8(bytes)), files: [] };
  const folders = EXPORT_FILE_SOURCES.map((s) => `${s.folder}/`);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (f) => f.name === 'data.json' || folders.some((dir) => f.name.startsWith(dir)),
    });
  } catch {
    throw new ExportFormatError("That zip couldn't be opened");
  }
  const data = entries['data.json'];
  if (!data) throw new ExportFormatError('That zip has no data.json');
  const doc = parseExportJson(strFromU8(data));
  // Only files a row points at come back, so a hand-edited zip can't plant extra objects.
  const known = new Map(exportFiles(doc).map((f) => [`${folderOf(f.bucket)}/${f.path}`, f]));
  const files: ArchiveFile[] = [];
  for (const [name, content] of Object.entries(entries)) {
    const file = known.get(name);
    if (file && content.length > 0) files.push({ ...file, bytes: content });
  }
  return { doc, files };
}
