/**
 * The fields an import understands, and the column mapping (field → column index) that the LLM
 * proposes and the owner confirms. `guessColumnMapping` is the deterministic fallback used when AI
 * isn't set up (and to pre-fill the manual mapping screen).
 */
import type { ImportTable } from './table.ts';

export type ImportKind = 'clients' | 'appointments';

export interface ImportField {
  key: string;
  label: string;
  /** Shown to the model and in the mapping screen. */
  description: string;
}

export const CLIENT_FIELDS = [
  { key: 'fullName', label: 'Full name', description: 'Whole name in one column' },
  { key: 'firstName', label: 'First name', description: 'Given name' },
  { key: 'lastName', label: 'Last name', description: 'Family name' },
  { key: 'phone', label: 'Mobile phone', description: 'Cell / mobile number (preferred)' },
  { key: 'altPhone', label: 'Other phone', description: 'Home, day or work phone' },
  { key: 'email', label: 'Email', description: 'Email address' },
  { key: 'birthday', label: 'Birthday', description: 'Date of birth, with or without year' },
  { key: 'tags', label: 'Tags', description: 'Labels / customer type / groups' },
  { key: 'lastVisit', label: 'Last visit', description: 'Date of the most recent visit' },
  { key: 'noShows', label: 'No-shows', description: 'Number of no-show appointments' },
  { key: 'notes', label: 'Notes', description: 'Customer notes or alerts' },
] as const satisfies readonly ImportField[];

export const APPOINTMENT_FIELDS = [
  { key: 'date', label: 'Date', description: 'Appointment date (may include the time)' },
  { key: 'startTime', label: 'Start time', description: 'Start time of the service' },
  { key: 'endTime', label: 'End time', description: 'End time of the service' },
  { key: 'duration', label: 'Duration', description: 'Length in minutes or h:mm' },
  { key: 'fullName', label: 'Client name', description: 'Customer full name' },
  { key: 'firstName', label: 'Client first name', description: 'Customer given name' },
  { key: 'lastName', label: 'Client last name', description: 'Customer family name' },
  { key: 'phone', label: 'Client phone', description: 'Customer phone number' },
  { key: 'email', label: 'Client email', description: 'Customer email address' },
  { key: 'service', label: 'Service', description: 'Service name' },
  { key: 'status', label: 'Status', description: 'Booked / confirmed / cancelled / no show…' },
  { key: 'price', label: 'Price', description: 'Service price' },
  { key: 'notes', label: 'Notes', description: 'Appointment notes' },
  { key: 'appointmentId', label: 'Appointment ID', description: 'Unique booking number' },
] as const satisfies readonly ImportField[];

export type ClientFieldKey = (typeof CLIENT_FIELDS)[number]['key'];
export type AppointmentFieldKey = (typeof APPOINTMENT_FIELDS)[number]['key'];
export type ImportFieldKey<K extends ImportKind> = K extends 'clients'
  ? ClientFieldKey
  : AppointmentFieldKey;

/** Field key → 0-based column index. Unmapped fields are absent. */
export type ColumnMapping<K extends ImportKind = ImportKind> = Partial<
  Record<ImportFieldKey<K>, number>
>;

export function importFields(kind: ImportKind): readonly ImportField[] {
  return kind === 'clients' ? CLIENT_FIELDS : APPOINTMENT_FIELDS;
}

const SYNONYMS: Record<ImportKind, Record<string, string[]>> = {
  clients: {
    fullName: ['name', 'fullname', 'customer', 'customername', 'client', 'clientname'],
    firstName: ['firstname', 'first', 'fname', 'givenname', 'customerfirstname'],
    lastName: ['lastname', 'last', 'lname', 'surname', 'familyname', 'customerlastname'],
    phone: ['cellphone', 'mobilephone', 'mobile', 'cell', 'cellnumber', 'mobilenumber', 'phone'],
    altPhone: ['homephone', 'dayphone', 'workphone', 'nightphone', 'otherphone', 'eveningphone'],
    email: ['email', 'emailaddress', 'customeremail', 'mail'],
    birthday: ['birthday', 'birthdate', 'dob', 'dateofbirth', 'bday'],
    tags: ['tags', 'tag', 'customertags', 'customertype', 'groups', 'labels', 'type'],
    lastVisit: ['lastvisit', 'lastvisitdate', 'lastappointment', 'lastappointmentdate', 'lastappt'],
    noShows: ['noshows', 'noshow', 'noshowcount', 'totalnoshows', 'noshowappointments'],
    notes: ['notes', 'note', 'customernotes', 'comments', 'alerts', 'customeralert'],
  },
  appointments: {
    date: ['date', 'appointmentdate', 'apptdate', 'servicedate', 'day', 'startdate'],
    startTime: ['starttime', 'time', 'start', 'appointmenttime', 'appttime', 'from'],
    endTime: ['endtime', 'end', 'to', 'finish'],
    duration: ['duration', 'durationmin', 'durationmins', 'minutes', 'length', 'durationminutes'],
    fullName: ['customer', 'customername', 'client', 'clientname', 'name', 'fullname'],
    firstName: ['firstname', 'customerfirstname', 'clientfirstname'],
    lastName: ['lastname', 'customerlastname', 'clientlastname'],
    phone: ['phone', 'customerphone', 'cellphone', 'mobile', 'mobilephone', 'clientphone'],
    email: ['email', 'customeremail', 'clientemail', 'emailaddress'],
    service: ['service', 'servicename', 'services', 'servicedescription', 'item', 'treatment'],
    status: ['status', 'appointmentstatus', 'apptstatus', 'state'],
    price: ['price', 'serviceprice', 'amount', 'total', 'cost'],
    notes: ['notes', 'note', 'appointmentnotes', 'comments'],
    appointmentId: ['appointmentid', 'apptid', 'bookingid', 'confirmationnumber', 'appointmentno'],
  },
};

export const normalizeHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Header-synonym matching: exact matches first, then headers containing a synonym (longest
 * synonym wins). A column is used for at most one field.
 */
export function guessColumnMapping<K extends ImportKind>(
  kind: K,
  headers: readonly string[],
): ColumnMapping<K> {
  const synonyms = SYNONYMS[kind];
  const normalized = headers.map(normalizeHeader);
  const used = new Set<number>();
  const mapping: Record<string, number> = {};

  for (const [field, words] of Object.entries(synonyms)) {
    for (const w of words) {
      const i = normalized.findIndex((h, idx) => h === w && !used.has(idx));
      if (i >= 0) {
        mapping[field] = i;
        used.add(i);
        break;
      }
    }
  }
  const candidates: { field: string; col: number; len: number }[] = [];
  for (const [field, words] of Object.entries(synonyms)) {
    if (field in mapping) continue;
    // "Customer Since" is not a name when First/Last Name columns exist.
    if (field === 'fullName' && ('firstName' in mapping || 'lastName' in mapping)) continue;
    for (const w of words) {
      if (w.length < 4) continue;
      normalized.forEach((h, col) => {
        if (!used.has(col) && h.includes(w)) candidates.push({ field, col, len: w.length });
      });
    }
  }
  candidates.sort((a, b) => b.len - a.len);
  for (const c of candidates) {
    if (c.field in mapping || used.has(c.col)) continue;
    mapping[c.field] = c.col;
    used.add(c.col);
  }
  return mapping as ColumnMapping<K>;
}

/** Drops unknown fields, out-of-range columns and columns claimed twice (first one wins). */
export function sanitizeColumnMapping<K extends ImportKind>(
  kind: K,
  headers: readonly string[],
  raw: Record<string, unknown>,
): ColumnMapping<K> {
  const keys = new Set(importFields(kind).map((f) => f.key));
  const used = new Set<number>();
  const out: Record<string, number> = {};
  for (const field of importFields(kind).map((f) => f.key)) {
    const v = raw[field];
    if (!keys.has(field) || typeof v !== 'number' || !Number.isInteger(v)) continue;
    if (v < 0 || v >= headers.length || used.has(v)) continue;
    out[field] = v;
    used.add(v);
  }
  return out as ColumnMapping<K>;
}

/** What still has to be mapped before the preview can run. Empty = ready. */
export function missingRequiredFields(kind: ImportKind, mapping: ColumnMapping): string[] {
  const m = mapping as Record<string, number | undefined>;
  const has = (k: string) => m[k] !== undefined;
  const missing: string[] = [];
  const hasName = has('fullName') || has('firstName') || has('lastName');
  if (kind === 'clients') {
    if (!hasName) missing.push('a name column');
    return missing;
  }
  if (!has('date')) missing.push('the date');
  if (!hasName && !has('phone') && !has('email')) missing.push('the client name');
  if (!has('service') && !has('endTime') && !has('duration')) {
    missing.push('the service (or an end time / duration)');
  }
  return missing;
}

/**
 * Masks sample values before they leave the device for the model: letters after the first of each
 * word become `x`, digits become `#`, and email local parts are hidden. Enough to tell a phone
 * from a date from a name, without sending the client's data.
 */
export function redactSample(value: string): string {
  const v = value.trim().slice(0, 40);
  const email = /^[^@\s]+@([^@\s]+)$/.exec(v);
  if (email) return `x***@${email[1]}`;
  return v
    .replace(/\d/g, '#')
    .replace(/\p{L}+/gu, (w) => (w.length <= 2 ? w : w[0] + 'x'.repeat(w.length - 1)));
}

/** Up to `count` redacted non-empty samples per column, for the mapping prompt. */
export function redactedColumnSamples(table: ImportTable, count = 3): string[][] {
  return table.headers.map((_, col) => {
    const out: string[] = [];
    for (const row of table.rows) {
      const v = row[col]?.trim();
      if (v) out.push(redactSample(v));
      if (out.length >= count) break;
    }
    return out;
  });
}
