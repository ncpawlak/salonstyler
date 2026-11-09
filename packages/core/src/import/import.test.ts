import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  type ColumnMapping,
  buildAppointmentImport,
  buildClientImport,
  formatPhone,
  guessColumnMapping,
  matchServiceName,
  missingRequiredFields,
  normalizeName,
  parseCsv,
  parseCsvTable,
  parseDateString,
  parseDuration,
  parseMoneyCents,
  parseTags,
  parseTimeOfDay,
  phoneKey,
  planImportedSegments,
  previewClientMatches,
  redactSample,
  redactedColumnSamples,
  sanitizeColumnMapping,
  tableFromRows,
} from './index.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const NY = 'America/New_York';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, newlines in quotes, CRLF and BOM', () => {
    const rows = parseCsv('\uFEFFa,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n1,,3');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
      ['1', '', '3'],
    ]);
  });

  it('detects semicolon and tab delimiters', () => {
    expect(parseCsv('a;b;c\n1;2;3')[1]).toEqual(['1', '2', '3']);
    expect(parseCsv('a\tb\n1,5\t2')[1]).toEqual(['1,5', '2']);
  });
});

describe('tableFromRows', () => {
  it('skips title rows, blank rows and repeated headers', () => {
    const t = tableFromRows([
      ['Customer List'],
      ['Generated today', ''],
      [],
      ['First', 'Last', 'Phone', ''],
      ['Ann', 'Lee', '555'],
      ['', '', ''],
      ['First', 'Last', 'Phone'],
      ['Bo', 'Ng', ''],
    ]);
    expect(t.headers).toEqual(['First', 'Last', 'Phone']);
    expect(t.rows).toEqual([
      ['Ann', 'Lee', '555'],
      ['Bo', 'Ng', ''],
    ]);
    expect(t.rowNumbers).toEqual([5, 8]);
  });
});

describe('column mapping', () => {
  it('guesses a Vagaro customer export', () => {
    const t = parseCsvTable(fixture('vagaro-customers.csv'));
    const m = guessColumnMapping('clients', t.headers);
    const col = (h: string) => t.headers.indexOf(h);
    expect(m).toEqual({
      firstName: col('First Name'),
      lastName: col('Last Name'),
      email: col('Email'),
      phone: col('Cell Phone'),
      altPhone: col('Day Phone'),
      birthday: col('Birthday'),
      lastVisit: col('Last Visit'),
      noShows: col('No Shows'),
      tags: col('Tags'),
      notes: col('Customer Notes'),
    });
    expect(missingRequiredFields('clients', m)).toEqual([]);
  });

  it('guesses a Vagaro appointments export', () => {
    const t = parseCsvTable(fixture('vagaro-appointments.csv'));
    const m = guessColumnMapping('appointments', t.headers);
    const col = (h: string) => t.headers.indexOf(h);
    expect(m).toMatchObject({
      date: col('Appointment Date'),
      startTime: col('Start Time'),
      endTime: col('End Time'),
      fullName: col('Customer'),
      phone: col('Cell Phone'),
      email: col('Email'),
      service: col('Service'),
      status: col('Status'),
      price: col('Price'),
      notes: col('Appointment Notes'),
    });
    expect(missingRequiredFields('appointments', m)).toEqual([]);
  });

  it('sanitizes model output', () => {
    const m = sanitizeColumnMapping('clients', ['Name', 'Phone', 'Email'], {
      fullName: 0,
      phone: 0,
      email: 7,
      bogus: 1,
      notes: '2',
      tags: 1.5,
    });
    expect(m).toEqual({ fullName: 0 });
    expect(missingRequiredFields('appointments', {})).toHaveLength(3);
  });

  it('redacts samples before they reach the model', () => {
    expect(redactSample('Avery Brooks')).toBe('Axxxx Bxxxxx');
    expect(redactSample('(555) 201-3344')).toBe('(###) ###-####');
    expect(redactSample('avery.brooks@example.com')).toBe('x***@example.com');
    expect(redactSample('10:30 AM')).toBe('##:## AM');
    const t = parseCsvTable('Name,Phone\nAnn Lee,5551234567\n,\nBo Ng,');
    expect(redactedColumnSamples(t)).toEqual([['Axx Lxx', 'Bo Ng'], ['##########']]);
  });
});

describe('buildClientImport', () => {
  const t = parseCsvTable(fixture('vagaro-customers.csv'));
  const plan = buildClientImport(t, guessColumnMapping('clients', t.headers));
  const byName = (n: string) => plan.clients.find((c) => c.name === n)!;

  it('normalizes and merges duplicate rows', () => {
    expect(plan.clients.map((c) => c.name)).toEqual([
      'Avery Brooks',
      'Jordan Ellis',
      'Morgan Patel',
      'Riley Chen',
      'Casey Nguyen',
      'Sam "Sammy" Ortiz',
      'Taylor Kim',
      'Jamie Rivera',
    ]);
    expect(plan.mergedRows).toBe(1);
    expect(byName('Avery Brooks')).toEqual({
      name: 'Avery Brooks',
      phone: '(555) 201-3344',
      email: 'avery.brooks@example.com',
      birthday: '1604-03-14',
      tags: ['VIP', 'Color', 'Balayage'],
      lastVisitOn: '2026-11-02',
      noShowCount: 1,
      notes: 'Prefers cool tones; sensitive scalp',
      rows: [5, 11],
    });
    expect(byName('Jordan Ellis')).toMatchObject({
      email: 'jordan.ellis@example.com',
      phone: '(555) 201-7788',
      birthday: '1990-07-02',
    });
    expect(byName('Morgan Patel').phone).toBe('(555) 201-9911');
    expect(byName('Riley Chen').phone).toBe('(555) 201-4455');
    expect(byName('Sam "Sammy" Ortiz')).toMatchObject({
      birthday: '1985-04-09',
      tags: ['Cut', 'Men'],
    });
  });

  it('reports rows it cannot use and values it ignored', () => {
    expect(plan.errors).toEqual([{ row: 13, message: 'No name' }]);
    expect(plan.warnings).toEqual([
      { row: 12, message: "Couldn't read birthday \u201c13/40/1999\u201d" },
      { row: 14, message: 'Ignored email \u201cnot-an-email\u201d' },
    ]);
    expect(byName('Taylor Kim').birthday).toBeNull();
  });

  it('previews matches against existing clients', () => {
    const preview = previewClientMatches(plan.clients, [
      { id: 'c1', name: 'Avery B', phone: '555-201-3344', email: null },
      { id: 'c2', name: 'jamie rivera', phone: null, email: null },
      { id: 'c3', name: 'Jordan', phone: null, email: 'Jordan.Ellis@example.com' },
    ]);
    expect([...preview.matched.entries()]).toEqual([
      [0, 'c1'],
      [1, 'c3'],
    ]);
    expect(preview.newCount).toBe(6);
  });
});

describe('buildAppointmentImport', () => {
  const t = parseCsvTable(fixture('vagaro-appointments.csv'));
  const mapping = guessColumnMapping('appointments', t.headers);
  const now = Date.parse('2026-11-09T20:00:00Z');
  const plan = buildAppointmentImport(t, mapping, { timeZone: NY, now });

  it('skips past and cancelled rows and groups multi-service visits', () => {
    expect(plan.skipped).toEqual({ cancelled: 2, past: 1 });
    expect(plan.errors).toEqual([]);
    expect(
      plan.appointments.map((a) => [a.startsAt, a.client.name, a.services.map((s) => s.name)]),
    ).toEqual([
      ['2026-12-03T14:00:00.000Z', 'Avery Brooks', ['Root Touch-Up', 'Blowout']],
      ['2026-12-03T16:00:00.000Z', 'Jordan Ellis', ["Women's Haircut"]],
      ['2026-12-04T19:00:00.000Z', 'Sam Ortiz', ["Men's Cut"]],
      ['2026-12-05T18:00:00.000Z', 'Riley Chen', ['Keratin Smoothing Treatment']],
      ['2026-12-08T20:00:00.000Z', 'Pat Example', ['Scalp Detox Ritual']],
    ]);
    const avery = plan.appointments[0]!;
    expect(avery).toMatchObject({
      key: 'vagaro:2026-12-03T09:00|e:avery.brooks@example.com',
      date: '2026-12-03',
      priceCents: 13000,
      notes: 'Formula on file',
      rows: [5, 6],
    });
    expect(avery.services.map((s) => s.minutes)).toEqual([90, 45]);
  });

  it('produces the same keys on re-import', () => {
    const again = buildAppointmentImport(t, mapping, { timeZone: NY, now });
    expect(again.appointments.map((a) => a.key)).toEqual(plan.appointments.map((a) => a.key));
    expect(new Set(plan.appointments.map((a) => a.key)).size).toBe(plan.appointments.length);
  });

  it('uses appointment ids and date-time cells', () => {
    const table = parseCsvTable(
      [
        'Appt #,When,Client,Service,Duration',
        'A1,2026-12-01 9:00 AM,Ann Lee,Cut,45',
        'A1,2026-12-01 9:45 AM,Ann Lee,Gloss,0:30',
        'A2,46360.375,Bo Ng,Cut,1h',
        'A3,Dec 2 2026,Bo Ng,Cut,',
        'A4,someday,Bo Ng,Cut,',
      ].join('\n'),
    );
    const m: ColumnMapping<'appointments'> = {
      appointmentId: 0,
      date: 1,
      fullName: 2,
      service: 3,
      duration: 4,
    };
    const p = buildAppointmentImport(table, m, { timeZone: 'America/Chicago', now });
    expect(p.appointments.map((a) => [a.key, a.startsAt, a.services.length])).toEqual([
      ['vagaro:id:A1', '2026-12-01T15:00:00.000Z', 2],
      ['vagaro:id:A2', '2026-12-04T15:00:00.000Z', 1],
    ]);
    expect(p.errors).toEqual([
      { row: 5, message: 'No start time' },
      { row: 6, message: "Couldn't read date \u201csomeday\u201d" },
    ]);
  });
});

describe('matchServiceName', () => {
  const menu = [
    { id: 'rt', name: 'Root touch-up' },
    { id: 'bo', name: 'Blowout' },
    { id: 'mc', name: "Men's cut" },
    { id: 'wc', name: "Women's cut & style" },
    { id: 'ke', name: 'Keratin / smoothing' },
    { id: 'bt', name: 'Beard trim' },
    { id: 'bf', name: 'Blowout finish' },
  ];
  it.each([
    ['Root Touch-Up', 'rt'],
    ['BLOWOUT', 'bo'],
    ["Men's Cut", 'mc'],
    ['Keratin Smoothing Treatment', 'ke'],
    ["Women's Haircut", null],
    ['Cut', null],
    ['', null],
  ])('%s → %s', (name, id) => {
    expect(matchServiceName(name, menu)?.id ?? null).toBe(id);
  });
});

describe('planImportedSegments', () => {
  it('lays services out from the export times without overlapping', () => {
    const segs = planImportedSegments(
      { date: '2026-12-03', startMinutes: 9 * 60 },
      [
        {
          startMinutes: 9 * 60,
          segments: [
            { kind: 'busy', minutes: 30 },
            { kind: 'processing', minutes: 35 },
            { kind: 'style', minutes: 30 },
          ],
          bufferAfterMinutes: 10,
          label: 'Root touch-up',
        },
        { startMinutes: 10 * 60 + 30, segments: [{ kind: 'busy', minutes: 45 }], label: 'Blowout' },
      ],
      NY,
    );
    expect(segs.map((s) => [s.kind, s.start.slice(11, 16), s.end.slice(11, 16), s.label])).toEqual([
      ['busy', '14:00', '14:30', 'Root touch-up'],
      ['processing', '14:30', '15:05', 'Root touch-up'],
      ['style', '15:05', '15:35', 'Root touch-up'],
      ['buffer', '15:35', '15:45', undefined],
      ['busy', '15:45', '16:30', 'Blowout'],
    ]);
  });
});

describe('normalizers', () => {
  it('parses phones, times, durations, money and dates', () => {
    expect(phoneKey('+1 (555) 201-3344')).toBe('5552013344');
    expect(phoneKey('201-33')).toBeNull();
    expect(formatPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
    expect(normalizeName('o\u2019brien-smith, mary ann')).toBe('Mary Ann O\u2019brien-Smith');
    expect(
      ['2:30 PM', '2:30pm', '14:30', '14:30:00', '2 p.m.', '12:05 AM', '0.5'].map(parseTimeOfDay),
    ).toEqual([870, 870, 870, 870, 840, 5, 720]);
    expect(['25:00', '13:00 PM', 'noon', '9'].map(parseTimeOfDay)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(['90', '90 min', '1h 30m', '1:30', '1.5 hours', '0', 'abc'].map(parseDuration)).toEqual([
      90,
      90,
      90,
      90,
      90,
      null,
      null,
    ]);
    expect(['$65.00', '1,250.5', '65', '-5', 'free'].map(parseMoneyCents)).toEqual([
      6500,
      125050,
      6500,
      null,
      null,
    ]);
    expect(
      [
        '2026-03-14',
        '3/14/26',
        'Mar 14, 2026',
        'Saturday, March 14, 2026',
        '14-Mar-2026',
        '2/30/2026',
      ].map(parseDateString),
    ).toEqual(['2026-03-14', '2026-03-14', '2026-03-14', '2026-03-14', '2026-03-14', null]);
    expect(parseTags('Color; VIP | color, ,New')).toEqual(['Color', 'VIP', 'New']);
  });
});
