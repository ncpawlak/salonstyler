/**
 * Appointments export → future appointments to book. Cancelled / no-show / past rows are skipped.
 * Exports list one row per service, so consecutive rows for the same client and day merge into
 * one appointment. Each appointment gets a stable `key` (the export's appointment ID when there is
 * one) so re-importing the same file books nothing twice.
 */
import { layoutService } from '../availability/segments.ts';
import {
  formatClock,
  formatLocalDate,
  parseLocalDate,
  toIso,
  zonedToUtc,
} from '../availability/time.ts';
import type { PlacedSegmentKind, ServiceSegment } from '../availability/types.ts';
import { type ImportIssue, cellReader, clientMatchKeys, readClientName } from './clients.ts';
import type { ColumnMapping } from './fields.ts';
import {
  formatPhone,
  normalizeEmail,
  parseDateTime,
  parseDuration,
  parseMoneyCents,
  parseTimeOfDay,
} from './normalize.ts';
import type { ImportTable } from './table.ts';

export interface ImportedAppointmentService {
  /** Service name as written in the export. */
  name: string;
  /** Minutes after local midnight. */
  startMinutes: number;
  /** Length from the export (end − start, or the duration column), when known. */
  minutes: number | null;
}

export interface ImportedAppointment {
  key: string;
  /** Local `YYYY-MM-DD`. */
  date: string;
  startMinutes: number;
  /** UTC ISO start in the salon's time zone. */
  startsAt: string;
  client: { name: string; phone: string | null; email: string | null };
  services: ImportedAppointmentService[];
  priceCents: number | null;
  notes: string | null;
  rows: number[];
}

export interface AppointmentImportPlan {
  appointments: ImportedAppointment[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
  skipped: { cancelled: number; past: number };
}

const SKIP_STATUS = /cancel|no[\s-]?show|deleted|declined|denied|rejected|removed/i;

export interface AppointmentImportOptions {
  timeZone: string;
  /** Appointments starting before this instant are skipped. */
  now: number;
}

export function buildAppointmentImport(
  table: ImportTable,
  mapping: ColumnMapping,
  { timeZone, now }: AppointmentImportOptions,
): AppointmentImportPlan {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const skipped = { cancelled: 0, past: 0 };
  const appointments: ImportedAppointment[] = [];
  // Open group per client+date so later service rows can attach to it.
  const open = new Map<string, { appt: ImportedAppointment; endMinutes: number | null }>();
  const byId = new Map<string, ImportedAppointment>();

  table.rows.forEach((row, i) => {
    const rowNumber = table.rowNumbers[i] ?? i + 2;
    const cell = cellReader(row, mapping);
    const fail = (message: string) => errors.push({ row: rowNumber, message });

    if (SKIP_STATUS.test(cell('status'))) {
      skipped.cancelled++;
      return;
    }

    const when = parseDateTime(cell('date'));
    if (!when || when.noYear)
      return fail(cell('date') ? `Couldn't read date “${cell('date')}”` : 'No date');
    const startMinutes = cell('startTime')
      ? parseTimeOfDay(cell('startTime'))
      : (when.minutes ?? null);
    if (startMinutes === null)
      return fail(
        cell('startTime') ? `Couldn't read time “${cell('startTime')}”` : 'No start time',
      );

    let endMinutes: number | null = null;
    if (cell('endTime')) {
      const end =
        parseTimeOfDay(cell('endTime')) ?? parseDateTime(cell('endTime'))?.minutes ?? null;
      if (end === null)
        warnings.push({ row: rowNumber, message: `Couldn't read end time “${cell('endTime')}”` });
      else endMinutes = end > startMinutes ? end : null;
    }
    const duration = parseDuration(cell('duration'));
    const minutes = endMinutes !== null ? endMinutes - startMinutes : duration;

    const name = readClientName(cell);
    if (!name) return fail('No client name');
    const client = {
      name,
      phone: formatPhone(cell('phone')),
      email: normalizeEmail(cell('email')),
    };

    const date = when.date;
    const dateStr = formatLocalDate(date);
    const startMs = zonedToUtc(date, startMinutes, timeZone);
    if (startMs < now) {
      skipped.past++;
      return;
    }

    const service: ImportedAppointmentService = {
      name: cell('service').replace(/\s+/g, ' ').slice(0, 120),
      startMinutes,
      minutes,
    };
    const price = parseMoneyCents(cell('price'));
    const notes = cell('notes').slice(0, 2000) || null;
    const extId = cell('appointmentId');
    const clientKey = clientMatchKeys(client)[0]!;
    const groupKey = `${dateStr}|${clientKey}`;

    const join = (appt: ImportedAppointment) => {
      if (service.name) appt.services.push(service);
      if (price !== null) appt.priceCents = (appt.priceCents ?? 0) + price;
      if (notes && !appt.notes?.includes(notes))
        appt.notes = [appt.notes, notes].filter(Boolean).join('\n').slice(0, 2000);
      appt.rows.push(rowNumber);
    };

    const sameId = extId ? byId.get(extId) : undefined;
    if (sameId) return join(sameId);
    const prev = open.get(groupKey);
    // A row continues the previous one when it starts where (or before) that one ends.
    if (
      prev &&
      !extId &&
      (startMinutes === prev.appt.startMinutes ||
        (prev.endMinutes !== null && startMinutes <= prev.endMinutes))
    ) {
      join(prev.appt);
      if (minutes !== null)
        prev.endMinutes = Math.max(prev.endMinutes ?? 0, startMinutes + minutes);
      return;
    }

    const appt: ImportedAppointment = {
      key: extId
        ? `vagaro:id:${extId}`.slice(0, 200)
        : `vagaro:${dateStr}T${formatClock(startMinutes)}|${clientKey}`.slice(0, 200),
      date: dateStr,
      startMinutes,
      startsAt: toIso(startMs),
      client,
      services: service.name ? [service] : [],
      priceCents: price,
      notes,
      rows: [rowNumber],
    };
    appointments.push(appt);
    if (extId) byId.set(extId, appt);
    open.set(groupKey, { appt, endMinutes: minutes !== null ? startMinutes + minutes : null });
  });

  appointments.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return { appointments, errors, warnings, skipped };
}

const serviceWords = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Finds the menu service an export's service name refers to: exact (case/punctuation-insensitive)
 * name match, else the single menu service whose name contains or is contained in it.
 */
export function matchServiceName<T extends { id: string; name: string }>(
  name: string,
  menu: readonly T[],
): T | null {
  const n = serviceWords(name);
  if (!n) return null;
  const exact = menu.filter((s) => serviceWords(s.name) === n);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;
  const partial = menu.filter((s) => {
    const m = serviceWords(s.name);
    return m.length >= 4 && n.length >= 4 && (n.includes(m) || m.includes(n));
  });
  return partial.length === 1 ? partial[0]! : null;
}

/** Default length of a "block the time" service with no end time or duration in the export. */
export const DEFAULT_BLOCK_MINUTES = 60;

export interface ImportedSegment {
  kind: PlacedSegmentKind;
  start: string;
  end: string;
  label?: string;
}

/**
 * Lays an imported appointment's services out on the calendar. Each part is either a menu service
 * (`segments` + buffers) or a plain busy block. A part starts at its row's start time, or right
 * after the previous part if they would overlap.
 */
export function planImportedSegments(
  appt: Pick<ImportedAppointment, 'date' | 'startMinutes'>,
  parts: readonly {
    startMinutes?: number;
    segments: ServiceSegment[];
    bufferBeforeMinutes?: number;
    bufferAfterMinutes?: number;
    label?: string;
  }[],
  timeZone: string,
): ImportedSegment[] {
  const date = parseLocalDate(appt.date);
  const out: ImportedSegment[] = [];
  let cursor = zonedToUtc(date, appt.startMinutes, timeZone);
  for (const [i, part] of parts.entries()) {
    const wanted = zonedToUtc(date, part.startMinutes ?? appt.startMinutes, timeZone);
    const start = Math.max(wanted, cursor);
    const timed = layoutService(
      {
        segments: part.segments,
        bufferBeforeMinutes: i === 0 ? part.bufferBeforeMinutes : 0,
        bufferAfterMinutes: part.bufferAfterMinutes,
      },
      start,
    );
    for (const t of timed) {
      out.push({
        kind: t.kind,
        start: toIso(t.start),
        end: toIso(t.end),
        ...(part.label && t.kind !== 'buffer' ? { label: part.label.slice(0, 40) } : {}),
      });
    }
    cursor = timed[timed.length - 1]!.end;
  }
  return out;
}

export const blockSegments = (minutes: number | null): ServiceSegment[] => [
  { kind: 'busy', minutes: minutes ?? DEFAULT_BLOCK_MINUTES },
];
