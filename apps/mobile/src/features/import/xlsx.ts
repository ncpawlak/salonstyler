import { strFromU8, unzipSync } from 'fflate';

/** Minimal .xlsx reader: the first worksheet's cell text, as rows of strings. */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(xml: string): string {
  return xml.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Concatenated `<t>` runs (rich text has several; phonetic `<rPh>` runs are skipped). */
function textRuns(xml: string): string {
  const plain = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of plain.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) {
    out += decode(m[1] ?? '');
  }
  return out;
}

/** "AB12" → 27 (0-based column). */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.toUpperCase()) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function firstSheetPath(files: Record<string, Uint8Array>): string | null {
  const workbook = files['xl/workbook.xml'];
  const rels = files['xl/_rels/workbook.xml.rels'];
  if (workbook && rels) {
    const sheet = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(strFromU8(workbook));
    if (sheet) {
      for (const m of strFromU8(rels).matchAll(/<Relationship\b[^>]*>/g)) {
        if (!m[0].includes(`Id="${sheet[1]}"`)) continue;
        const target = /Target="([^"]+)"/.exec(m[0])?.[1];
        if (target) {
          const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
          if (files[path]) return path;
        }
      }
    }
  }
  const sheets = Object.keys(files)
    .filter((p) => /^xl\/worksheets\/[^/]+\.xml$/.test(p))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return sheets[0] ?? null;
}

/** Whether the bytes look like a zip (xlsx) rather than text. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export function readXlsxRows(bytes: Uint8Array): string[][] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) =>
        (f.name.startsWith('xl/') && f.name.endsWith('.xml')) || f.name.endsWith('.rels'),
    });
  } catch {
    throw new Error('That file isn’t a readable Excel workbook.');
  }
  const path = firstSheetPath(files);
  if (!path) throw new Error('That workbook has no sheets.');

  const shared: string[] = [];
  const sst = files['xl/sharedStrings.xml'];
  if (sst) {
    for (const m of strFromU8(sst).matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textRuns(m[1]!));
  }

  const rows: string[][] = [];
  const sheet = strFromU8(files[path]!);
  for (const rowMatch of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const attrs = rowMatch[1] ?? rowMatch[3] ?? '';
    const r = /\br="(\d+)"/.exec(attrs);
    const rowIndex = r ? Number(r[1]) - 1 : rows.length;
    while (rows.length < rowIndex) rows.push([]);
    const cells: string[] = [];
    for (const c of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const cAttrs = c[1] ?? '';
      const body = c[2] ?? '';
      const ref = /\br="([A-Z]+)\d+"/i.exec(cAttrs)?.[1];
      const col = ref ? columnIndex(ref) : cells.length;
      const type = /\bt="([^"]+)"/.exec(cAttrs)?.[1] ?? 'n';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let text = '';
      if (type === 's') text = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') text = textRuns(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
      else if (type === 'b') text = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : '';
      else text = v === undefined ? '' : decode(v);
      while (cells.length < col) cells.push('');
      cells[col] = text;
    }
    rows[rowIndex] = cells;
  }
  return rows;
}
