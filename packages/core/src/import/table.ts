/**
 * Spreadsheet text → a header row plus data rows. Deterministic: the LLM only proposes which
 * column holds which field (see `fields.ts`); every value is parsed and validated here.
 */

export interface ImportTable {
  headers: string[];
  /** Data rows, each padded/truncated to `headers.length`. */
  rows: string[][];
  /** 1-based spreadsheet row number of each data row (for messages like "Row 14: …"). */
  rowNumbers: number[];
}

export const MAX_IMPORT_ROWS = 20_000;

/** Picks `,` `;` or tab, whichever splits the first lines most consistently. */
function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/, 6).filter((l) => l.trim());
  let best = ',';
  let bestScore = -1;
  for (const d of [',', ';', '\t']) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const min = lines.length ? Math.min(...counts) : 0;
    const score = min > 0 ? min * 10 + (counts.every((c) => c === counts[0]) ? 5 : 0) : 0;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** RFC 4180 CSV (quoted fields, doubled quotes, newlines inside quotes), BOM-safe. */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const d = delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === d) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const filled = (row: readonly string[]) => row.filter((c) => c.trim() !== '').length;

/**
 * Finds the header row (exports often start with a title and a date range) and returns the data
 * below it. Blank rows and repeated header rows are dropped.
 */
export function tableFromRows(raw: readonly (readonly string[])[]): ImportTable {
  const width = Math.max(0, ...raw.slice(0, 50).map(filled));
  let headerIndex = raw.findIndex((r, i) => i < 15 && filled(r) >= Math.max(2, width * 0.6));
  if (headerIndex < 0) headerIndex = raw.findIndex((r) => filled(r) > 0);
  if (headerIndex < 0) return { headers: [], rows: [], rowNumbers: [] };

  const headerRow = raw[headerIndex]!;
  let last = headerRow.length;
  while (last > 0 && !headerRow[last - 1]!.trim()) last--;
  const headers = headerRow.slice(0, last).map((h, i) => h.trim() || `Column ${i + 1}`);
  const headerKey = headers.join('\u0000').toLowerCase();

  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  for (let i = headerIndex + 1; i < raw.length && rows.length < MAX_IMPORT_ROWS; i++) {
    const r = headers.map((_, c) => (raw[i]![c] ?? '').trim());
    if (!filled(r)) continue;
    if (r.join('\u0000').toLowerCase() === headerKey) continue;
    rows.push(r);
    rowNumbers.push(i + 1);
  }
  return { headers, rows, rowNumbers };
}

export function parseCsvTable(text: string): ImportTable {
  return tableFromRows(parseCsv(text));
}
