/**
 * Clients export → deduplicated client records. Rows sharing an email or phone (or, with neither,
 * the same name) collapse into one client. The database repeats the same match against the
 * salon's existing clients (`import_clients`), so re-importing a file never creates duplicates.
 */
import { formatLocalDate } from '../availability/time.ts';
import type { ColumnMapping } from './fields.ts';
import {
  formatPhone,
  mergeTags,
  normalizeEmail,
  normalizeName,
  parseCount,
  parseDateTime,
  parseTags,
  phoneKey,
} from './normalize.ts';
import type { ImportTable } from './table.ts';

export interface ImportedClient {
  name: string;
  phone: string | null;
  email: string | null;
  /** `YYYY-MM-DD`; year 1604 = unknown year. */
  birthday: string | null;
  tags: string[];
  /** `YYYY-MM-DD` of the last visit in the old system. */
  lastVisitOn: string | null;
  noShowCount: number | null;
  notes: string | null;
  /** Spreadsheet rows merged into this client. */
  rows: number[];
}

export interface ImportIssue {
  row: number;
  message: string;
}

export interface ClientImportPlan {
  clients: ImportedClient[];
  /** Rows that couldn't become a client (no name). */
  errors: ImportIssue[];
  /** Values that were ignored (bad email, unreadable date…); the row still imports. */
  warnings: ImportIssue[];
  /** Rows folded into an earlier row of the same file. */
  mergedRows: number;
}

/** Keys an imported client is matched on, most specific first. */
export function clientMatchKeys(c: {
  name: string;
  phone: string | null;
  email: string | null;
}): string[] {
  const keys: string[] = [];
  const email = normalizeEmail(c.email);
  const phone = phoneKey(c.phone);
  if (email) keys.push(`e:${email}`);
  if (phone) keys.push(`p:${phone}`);
  if (!keys.length) keys.push(`n:${c.name.toLowerCase()}`);
  return keys;
}

type Cells = (field: string) => string;

export function cellReader(row: readonly string[], mapping: ColumnMapping): Cells {
  const m = mapping as Record<string, number | undefined>;
  return (field) => {
    const i = m[field];
    return i === undefined ? '' : (row[i] ?? '').trim();
  };
}

export function readClientName(cell: Cells): string | null {
  return (
    normalizeName([cell('firstName'), cell('lastName')].filter(Boolean).join(' ')) ??
    normalizeName(cell('fullName'))
  );
}

export function buildClientImport(table: ImportTable, mapping: ColumnMapping): ClientImportPlan {
  const clients: ImportedClient[] = [];
  const byKey = new Map<string, ImportedClient>();
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  let mergedRows = 0;

  table.rows.forEach((row, i) => {
    const rowNumber = table.rowNumbers[i] ?? i + 2;
    const cell = cellReader(row, mapping);
    const name = readClientName(cell);
    if (!name) {
      errors.push({ row: rowNumber, message: 'No name' });
      return;
    }
    const warn = (message: string) => warnings.push({ row: rowNumber, message });

    const rawPhone = cell('phone') || cell('altPhone');
    const phone = formatPhone(rawPhone) ?? formatPhone(cell('altPhone'));
    if (rawPhone && !phone) warn(`Ignored phone “${rawPhone}”`);
    const email = normalizeEmail(cell('email'));
    if (cell('email') && !email) warn(`Ignored email “${cell('email')}”`);

    const date = (field: string, label: string) => {
      const raw = cell(field);
      if (!raw) return null;
      const p = parseDateTime(raw);
      if (!p) warn(`Couldn't read ${label} “${raw}”`);
      return p ? formatLocalDate(p.date) : null;
    };
    const birthday = date('birthday', 'birthday');
    const lastVisitOn = date('lastVisit', 'last visit');
    const noShowCount = parseCount(cell('noShows'));
    if (cell('noShows') && noShowCount === null)
      warn(`Couldn't read no-shows “${cell('noShows')}”`);
    const notes = cell('notes').slice(0, 4000) || null;

    const incoming: ImportedClient = {
      name,
      phone,
      email,
      birthday,
      tags: parseTags(cell('tags')),
      lastVisitOn,
      noShowCount,
      notes,
      rows: [rowNumber],
    };
    const keys = clientMatchKeys(incoming);
    const existing = keys.map((k) => byKey.get(k)).find(Boolean);
    if (!existing) {
      clients.push(incoming);
      for (const k of keys) byKey.set(k, incoming);
      return;
    }
    mergedRows++;
    existing.phone ??= incoming.phone;
    existing.email ??= incoming.email;
    existing.birthday ??= incoming.birthday;
    existing.tags = mergeTags(existing.tags, incoming.tags);
    if (
      incoming.lastVisitOn &&
      (!existing.lastVisitOn || incoming.lastVisitOn > existing.lastVisitOn)
    )
      existing.lastVisitOn = incoming.lastVisitOn;
    if (incoming.noShowCount !== null)
      existing.noShowCount = Math.max(existing.noShowCount ?? 0, incoming.noShowCount);
    if (incoming.notes && !existing.notes?.includes(incoming.notes))
      existing.notes = [existing.notes, incoming.notes].filter(Boolean).join('\n').slice(0, 4000);
    existing.rows.push(rowNumber);
    for (const k of clientMatchKeys(existing)) if (!byKey.has(k)) byKey.set(k, existing);
  });

  return { clients, errors, warnings, mergedRows };
}

/** What an import would do to the salon's existing clients (preview only; the DB decides). */
export function previewClientMatches(
  incoming: readonly Pick<ImportedClient, 'name' | 'phone' | 'email'>[],
  existing: readonly { id: string; name: string; phone: string | null; email: string | null }[],
): { newCount: number; matched: Map<number, string> } {
  const index = new Map<string, string>();
  for (const c of existing)
    for (const k of clientMatchKeys(c)) if (!index.has(k)) index.set(k, c.id);
  const matched = new Map<number, string>();
  incoming.forEach((c, i) => {
    const id = clientMatchKeys(c)
      .map((k) => index.get(k))
      .find(Boolean);
    if (id) matched.set(i, id);
  });
  return { newCount: incoming.length - matched.size, matched };
}
