import { strFromU8, strToU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  buildExportArchive,
  exportCounts,
  exportFiles,
  ExportFormatError,
  parseCsv,
  readExportArchive,
  remapUuids,
  tableToCsv,
  type SalonExport,
} from './index.ts';

const SALON = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const OTHER = '99999999-9999-4999-8999-999999999999';

function sampleExport(): SalonExport {
  return {
    format: 'chairside-export',
    version: 1,
    exported_at: '2026-11-09T12:00:00Z',
    salon: { id: SALON, name: 'Studio "A"', slug: 'studio-a', timezone: 'America/Denver' },
    members: [{ user_id: CLIENT, role: 'owner', email: 'owner@example.com' }],
    tables: {
      clients: {
        columns: ['id', 'salon_id', 'full_name', 'phone', 'notes', 'tags'],
        rows: [
          {
            id: CLIENT,
            salon_id: SALON,
            full_name: 'Ana, "The" Client',
            phone: '+1 (555) 010-2000',
            notes: '=HYPERLINK("http://evil")\nline two',
            tags: ['vip', 'color'],
          },
        ],
      },
      client_photos: {
        columns: ['id', 'salon_id', 'client_id', 'storage_path'],
        rows: [
          {
            id: OTHER,
            salon_id: SALON,
            client_id: CLIENT,
            storage_path: `${SALON}/${CLIENT}/a.jpg`,
          },
          {
            id: OTHER,
            salon_id: SALON,
            client_id: CLIENT,
            storage_path: `${OTHER}/${CLIENT}/x.jpg`,
          },
          { id: OTHER, salon_id: SALON, client_id: CLIENT, storage_path: `${SALON}/../x.jpg` },
        ],
      },
      client_formulas: {
        columns: ['id', 'details', 'amount'],
        rows: [{ id: OTHER, details: { bowls: [{ grams: 30 }] }, amount: -5 }],
      },
      expenses: {
        columns: ['id', 'salon_id', 'receipt_path'],
        rows: [
          { id: OTHER, salon_id: SALON, receipt_path: `${SALON}/r.jpg` },
          { id: OTHER, salon_id: SALON, receipt_path: null },
        ],
      },
    },
  };
}

describe('tableToCsv', () => {
  it('quotes, escapes, neutralises formulas and keeps phones and numbers', () => {
    const doc = sampleExport();
    const rows = parseCsv(tableToCsv(doc.tables.clients!));
    expect(rows[0]).toEqual(['id', 'salon_id', 'full_name', 'phone', 'notes', 'tags']);
    expect(rows[1]).toEqual([
      CLIENT,
      SALON,
      'Ana, "The" Client',
      '+1 (555) 010-2000',
      `'=HYPERLINK("http://evil")\nline two`,
      '["vip","color"]',
    ]);
    const formulas = parseCsv(tableToCsv(doc.tables.client_formulas!));
    expect(formulas[1]).toEqual([OTHER, '{"bowls":[{"grams":30}]}', '-5']);
  });

  it('writes nulls as empty cells and ends with CRLF', () => {
    const csv = tableToCsv({ columns: ['a', 'b'], rows: [{ a: null, b: true }] });
    expect(csv).toBe('a,b\r\n,true\r\n');
  });
});

describe('remapUuids', () => {
  it('rewrites known ids case-insensitively and leaves the rest', () => {
    const next = '33333333-3333-4333-8333-333333333333';
    expect(remapUuids(`${SALON.toUpperCase()}/${CLIENT}/a.jpg`, { [SALON]: next })).toBe(
      `${next}/${CLIENT}/a.jpg`,
    );
  });
});

describe('archive', () => {
  it('only lists photos and receipts inside the salon folder', () => {
    expect(exportFiles(sampleExport())).toEqual([
      { bucket: 'client-photos', path: `${SALON}/${CLIENT}/a.jpg` },
      { bucket: 'receipts', path: `${SALON}/r.jpg` },
    ]);
  });

  it('round-trips the document, photos and receipts through the zip', () => {
    const doc = sampleExport();
    const photo = {
      bucket: 'client-photos',
      path: `${SALON}/${CLIENT}/a.jpg`,
      bytes: new Uint8Array([1, 2, 3]),
    };
    const receipt = { bucket: 'receipts', path: `${SALON}/r.jpg`, bytes: new Uint8Array([4]) };
    const zip = buildExportArchive({
      doc,
      files: [photo, receipt],
      links: [{ bucket: 'client-photos', path: 'p.jpg', url: 'https://x/p' }],
    });

    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual([
      'README.txt',
      'csv/client_formulas.csv',
      'csv/client_photos.csv',
      'csv/clients.csv',
      'csv/expenses.csv',
      'data.json',
      'links.csv',
      'members.csv',
      `photos/${SALON}/${CLIENT}/a.jpg`,
      `receipts/${SALON}/r.jpg`,
    ]);
    const readme = strFromU8(entries['README.txt']!);
    expect(readme).toContain('Studio "A"');
    expect(readme).toContain('1 file(s)');
    expect(readme).toMatch(/clients\s+1/);

    const back = readExportArchive(zip);
    expect(back.doc).toEqual(doc);
    expect(back.files).toEqual([photo, receipt]);
    expect(exportCounts(back.doc)).toEqual({
      clients: 1,
      client_photos: 3,
      client_formulas: 1,
      expenses: 2,
    });
  });

  it('accepts a bare data.json and rejects anything else', () => {
    const doc = sampleExport();
    expect(readExportArchive(strToU8(JSON.stringify(doc))).doc).toEqual(doc);
    expect(() => readExportArchive(strToU8('{"format":"other"}'))).toThrow(ExportFormatError);
    expect(() => readExportArchive(strToU8('not json'))).toThrow(ExportFormatError);
    expect(() => readExportArchive(strToU8(JSON.stringify({ ...doc, version: 2 })))).toThrow(
      /newer version/,
    );
    expect(() => readExportArchive(new Uint8Array([0x50, 0x4b, 1, 2]))).toThrow(ExportFormatError);
  });
});
