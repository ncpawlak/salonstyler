// Minimal iCalendar (RFC 5545) invites for client emails: one VEVENT per appointment, with a
// stable UID and an increasing SEQUENCE so calendar apps update (or cancel) the same event.

export interface IcsEvent {
  uid: string;
  /** 0 for the first invite; each move or cancellation must be higher than the last. */
  sequence: number;
  method: 'REQUEST' | 'CANCEL';
  start: Date;
  end: Date;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  organizer?: { name: string; email: string };
  attendee?: { name?: string; email: string };
  /** DTSTAMP; defaults to now. */
  now?: Date;
}

/** 20261115T150000Z */
export function icsDate(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** Escapes TEXT values (RFC 5545 §3.3.11). */
export function icsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Quoted parameter values (CN=...) can't contain quotes or control characters. */
function icsParam(value: string): string {
  return `"${value.replace(/["\r\n\t]/g, ' ').trim()}"`;
}

/** Folds a content line to 75 octets per line (RFC 5545 §3.1), never splitting a UTF-8 char. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  const parts: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const bytes = enc.encode(ch).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (size + bytes > limit) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += bytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export function buildIcs(event: IcsEvent): string {
  const cancelled = event.method === 'CANCEL';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Chairside//Appointments//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${event.method}`,
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `SEQUENCE:${Math.max(0, Math.floor(event.sequence))}`,
    `DTSTAMP:${icsDate(event.now ?? new Date())}`,
    `DTSTART:${icsDate(event.start)}`,
    `DTEND:${icsDate(event.end)}`,
    `SUMMARY:${icsText(event.summary)}`,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
  ];
  if (event.description) lines.push(`DESCRIPTION:${icsText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${icsText(event.location)}`);
  if (event.url) lines.push(`URL:${event.url}`);
  if (event.organizer) {
    lines.push(`ORGANIZER;CN=${icsParam(event.organizer.name)}:mailto:${event.organizer.email}`);
  }
  if (event.attendee) {
    const cn = event.attendee.name ? `;CN=${icsParam(event.attendee.name)}` : '';
    lines.push(`ATTENDEE${cn};ROLE=REQ-PARTICIPANT;RSVP=FALSE:mailto:${event.attendee.email}`);
  }
  if (!cancelled) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${icsText(event.summary)}`,
      'TRIGGER:-PT1H',
      'END:VALARM',
    );
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
