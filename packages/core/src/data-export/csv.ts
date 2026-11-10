import type { ExportTable, ExportValue } from './types.ts';

/** Phone numbers and plain numbers are safe; anything else starting with these may be a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;
const NUMERIC_OR_PHONE = /^[+-]?[\d\s().-]+$/;

function cell(value: ExportValue | undefined): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Spreadsheet formula injection (OWASP): a client note like `=HYPERLINK(...)` must not run when
  // the owner opens the CSV. data.json keeps the exact value; this only affects the CSV view.
  if (typeof value === 'string' && FORMULA_START.test(text) && !NUMERIC_OR_PHONE.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV (CRLF rows, header first). JSON and array columns are written as JSON text. */
export function tableToCsv(table: ExportTable): string {
  const lines = [table.columns.map((c) => cell(c)).join(',')];
  for (const row of table.rows) lines.push(table.columns.map((c) => cell(row[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** Parses RFC 4180 CSV into rows of strings (used by tests and by anyone re-reading the CSVs). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
