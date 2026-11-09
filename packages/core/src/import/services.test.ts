import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  type ServiceImportRow,
  importedServiceColor,
  importedServiceSegments,
  looksLikeMenuText,
  parseDurationText,
  parseMenuText,
  parsePriceText,
  planServiceImport,
  sanitizeExtractedServices,
  serviceImportIssues,
  serviceImportPayload,
  serviceNameKey,
  servicesToArchive,
} from './index.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const row = (over: Partial<ServiceImportRow> = {}): ServiceImportRow => ({
  key: 'row-0',
  name: 'Root Touch-Up',
  category: 'Color',
  durationMinutes: 90,
  priceCents: 8500,
  processingMinutes: null,
  description: null,
  match: null,
  action: 'add',
  ...over,
});

describe('parseDurationText / parsePriceText', () => {
  it.each([
    ['45 min', 45],
    ['1 hr 30 min', 90],
    ['1h30m', 90],
    ['2 hrs', 120],
    ['1.5 hours', 90],
    ['90', 90],
    ['Duration: 1 hour 15 minutes', 75],
    [60, 60],
    ['soon', null],
    [null, null],
  ])('duration %j → %j', (raw, minutes) => expect(parseDurationText(raw)).toBe(minutes));

  it.each([
    ['$65.00', 6500],
    ['$85.00+', 8500],
    ['from $120', 12000],
    ['$60 - $80', 6000],
    ['$1,250', 125000],
    ['65', 6500],
    [42.5, 4250],
    ['Price varies', null],
    [-5, null],
  ])('price %j → %j', (raw, cents) => expect(parsePriceText(raw)).toBe(cents));
});

describe('serviceNameKey', () => {
  it('ignores case, apostrophes, accents and punctuation', () => {
    expect(serviceNameKey('Women’s Haircut')).toBe(serviceNameKey('womens  haircut'));
    expect(serviceNameKey('Toner / Gloss')).toBe('toner gloss');
    expect(serviceNameKey('Cut & Blow-dry')).toBe('cut and blow dry');
    expect(serviceNameKey('Ombré')).toBe('ombre');
  });
});

describe('sanitizeExtractedServices', () => {
  it('cleans and bounds untrusted model output', () => {
    const out = sanitizeExtractedServices({
      services: [
        { name: '  • Women’s Haircut ', category: 'Hair', durationMinutes: 45, price: 65 },
        { name: 'Root Touch-Up', duration: '1 hr 30 min', price: '$85+', processingMinutes: 35 },
        { name: 'womens haircut', durationMinutes: 60, price: 70 },
        { name: '', durationMinutes: 30 },
        { name: '$$$', durationMinutes: 30 },
        { name: 'Marathon', durationMinutes: 2000, price: -1 },
        { name: 'Gloss', durationMinutes: 30, processingMinutes: 29 },
        { name: 'Cents', durationMinutes: 30, priceCents: 4500 },
        'junk',
        null,
      ],
    });
    expect(out).toEqual([
      {
        name: 'Women’s Haircut',
        category: 'Hair',
        durationMinutes: 45,
        priceCents: 6500,
        processingMinutes: null,
        description: null,
      },
      {
        name: 'Root Touch-Up',
        category: null,
        durationMinutes: 90,
        priceCents: 8500,
        processingMinutes: 35,
        description: null,
      },
      {
        name: 'Marathon',
        category: null,
        durationMinutes: null,
        priceCents: null,
        processingMinutes: null,
        description: null,
      },
      {
        name: 'Gloss',
        category: null,
        durationMinutes: 30,
        priceCents: null,
        processingMinutes: null,
        description: null,
      },
      {
        name: 'Cents',
        category: null,
        durationMinutes: 30,
        priceCents: 4500,
        processingMinutes: null,
        description: null,
      },
    ]);
  });

  it('accepts a bare array, ignores anything else and caps the list', () => {
    expect(sanitizeExtractedServices([{ name: 'Cut', durationMinutes: 30 }])).toHaveLength(1);
    expect(sanitizeExtractedServices('nope')).toEqual([]);
    const many = Array.from({ length: 400 }, (_, i) => ({ name: `Service ${i}` }));
    expect(sanitizeExtractedServices(many)).toHaveLength(150);
  });
});

describe('parseMenuText', () => {
  it('reads a copied Vagaro menu (stacked name / duration / price lines)', () => {
    const menu = parseMenuText(fixture('vagaro-service-menu.txt'));
    expect(menu.map((s) => [s.category, s.name, s.durationMinutes, s.priceCents])).toEqual([
      ['Hair Services', "Women's Haircut", 45, 6500],
      ['Hair Services', "Men's Haircut", 30, 3500],
      ['Hair Services', 'Kids Cut (12 & under)', 20, 2500],
      ['Color', 'Root Touch-Up', 90, 8500],
      ['Color', 'Full Highlights', 150, 16500],
      ['Color', 'Balayage', 180, 21000],
      ['Color', 'Toner / Gloss', 45, 4500],
      ['Styling', 'Blowout', 45, 4500],
      ['Styling', 'Special Occasion Updo', 60, 8500],
    ]);
    expect(menu[0]!.description).toBe('Includes shampoo and blow-dry.');
    expect(menu[3]!.processingMinutes).toBe(35);
  });

  it('reads one service per line', () => {
    const menu = parseMenuText(
      [
        'CUTS',
        "Women's cut · 45 min · $65",
        "Men's cut - 30 mins - $35",
        'Bang trim (15 min) $10',
        'COLOR',
        'Single process | 1h 45m | from $95',
      ].join('\n'),
    );
    expect(menu.map((s) => [s.category, s.name, s.durationMinutes, s.priceCents])).toEqual([
      ['CUTS', "Women's cut", 45, 6500],
      ['CUTS', "Men's cut", 30, 3500],
      ['CUTS', 'Bang trim', 15, 1000],
      ['COLOR', 'Single process', 105, 9500],
    ]);
  });

  it('finds nothing in text that is not a menu', () => {
    expect(parseMenuText('Welcome to our salon!\nWe love hair.')).toEqual([]);
    expect(looksLikeMenuText('Welcome to our salon! Call us.')).toBe(false);
    expect(looksLikeMenuText(fixture('vagaro-service-menu.txt'))).toBe(true);
  });
});

describe('planServiceImport', () => {
  const existing = [
    { id: 'a', name: "Women's cut & style" },
    { id: 'b', name: 'Blowout' },
    { id: 'c', name: 'Balayage', archivedAt: '2026-11-01T00:00:00Z' },
  ];

  it('marks services already on the menu as skip, new ones as add', () => {
    const rows = planServiceImport(
      sanitizeExtractedServices([
        { name: 'blowout', durationMinutes: 45 },
        { name: 'Balayage', durationMinutes: 180 },
        { name: "Women's Haircut", durationMinutes: 45 },
      ]),
      existing,
    );
    expect(rows.map((r) => [r.name, r.match?.id ?? null, r.action])).toEqual([
      ['blowout', 'b', 'skip'],
      ['Balayage', null, 'add'],
      ["Women's Haircut", null, 'add'],
    ]);
  });

  it('is idempotent: importing what was just saved adds nothing', () => {
    const extracted = parseMenuText(fixture('vagaro-service-menu.txt'));
    const saved = extracted.map((s, i) => ({ id: `s${i}`, name: s.name }));
    expect(planServiceImport(extracted, saved).every((r) => r.action === 'skip')).toBe(true);
  });
});

describe('serviceImportIssues', () => {
  it('requires a name and a duration that fits the segment limits', () => {
    expect(serviceImportIssues(row())).toEqual([]);
    expect(serviceImportIssues(row({ name: ' ', durationMinutes: null }))).toEqual([
      'Add a name',
      'Add a duration',
    ]);
    expect(serviceImportIssues(row({ durationMinutes: 721 }))).toEqual([
      'Duration must be 1 minute to 12 hours',
    ]);
    expect(serviceImportIssues(row({ processingMinutes: 89 }))).toEqual([
      'Processing must leave hands-on time before and after it',
    ]);
    expect(serviceImportIssues(row({ processingMinutes: 0 }))).toEqual([]);
  });
});

describe('importedServiceSegments', () => {
  it('builds one hands-on block, or apply → process → rinse & style', () => {
    expect(importedServiceSegments(45)).toEqual([{ kind: 'busy', minutes: 45 }]);
    expect(importedServiceSegments(90, 35)).toEqual([
      { kind: 'busy', minutes: 28, label: 'Apply' },
      { kind: 'processing', minutes: 35, label: 'Process' },
      { kind: 'style', minutes: 27, label: 'Rinse & style' },
    ]);
    expect(importedServiceSegments(3, 1).map((s) => s.minutes)).toEqual([1, 1, 1]);
  });
});

describe('serviceImportPayload', () => {
  const existing = {
    id: 'svc-1',
    name: 'Root touch-up',
    category: 'Color',
    description: 'Roots only',
    priceCents: 6500,
    colorTag: 'purple' as const,
    segments: [
      { kind: 'busy' as const, minutes: 30, label: 'Apply' },
      { kind: 'processing' as const, minutes: 35, label: 'Process' },
      { kind: 'style' as const, minutes: 25, label: 'Rinse & style' },
    ],
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 10,
    consultationRequired: false,
    bookableOnline: true,
    newClientsOnly: false,
    variants: [{ name: 'Long', deltaMinutes: 15 }],
  };

  it('builds a new service', () => {
    expect(serviceImportPayload(row({ category: null, processingMinutes: 35 }))).toEqual({
      name: 'Root Touch-Up',
      category: 'Other',
      description: null,
      priceCents: 8500,
      colorTag: 'purple',
      segments: importedServiceSegments(90, 35),
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      consultationRequired: false,
      bookableOnline: true,
      newClientsOnly: false,
      variants: [],
    });
  });

  it('updates price and keeps the existing timeline when the length matches', () => {
    const p = serviceImportPayload(row({ action: 'update' }), existing);
    expect(p).toMatchObject({ id: 'svc-1', name: 'Root touch-up', priceCents: 8500 });
    expect(p.segments).toBe(existing.segments);
    expect(p.variants).toBe(existing.variants);
    expect(p.bufferAfterMinutes).toBe(10);
  });

  it('rebuilds the timeline when the length changes', () => {
    const p = serviceImportPayload(row({ action: 'update', durationMinutes: 60 }), existing);
    expect(p.segments).toEqual([{ kind: 'busy', minutes: 60 }]);
  });

  it('refuses rows with issues', () => {
    expect(() => serviceImportPayload(row({ durationMinutes: null }))).toThrow('Add a duration');
    expect(() => serviceImportPayload(row({ action: 'update' }))).toThrow('missing');
  });
});

describe('importedServiceColor', () => {
  it('picks a color from the category, then the name', () => {
    expect(importedServiceColor('Color', 'Gloss')).toBe('purple');
    expect(importedServiceColor(null, "Men's Haircut")).toBe('blue');
    expect(importedServiceColor('Hair Services', 'Blowout')).toBe('pink');
    expect(importedServiceColor(null, 'Consultation')).toBe('gray');
  });
});

describe('servicesToArchive', () => {
  it('hides unmatched services and the combos that use them', () => {
    const rows = [
      row({ match: { id: 'cut', name: 'Cut' }, action: 'skip' }),
      row({ match: { id: 'color', name: 'Color' }, action: 'update' }),
      row({ match: { id: 'gloss', name: 'Gloss' }, action: 'add' }),
    ];
    const menu = {
      services: [
        { id: 'cut', name: 'Cut' },
        { id: 'color', name: 'Color' },
        { id: 'gloss', name: 'Gloss' },
        { id: 'perm', name: 'Perm' },
        { id: 'old', name: 'Old', archivedAt: '2026-01-01' },
      ],
      combos: [
        { id: 'c1', name: 'Color + cut', items: [{ serviceId: 'color' }, { serviceId: 'cut' }] },
        { id: 'c2', name: 'Perm + cut', items: [{ serviceId: 'perm' }, { serviceId: 'cut' }] },
      ],
    };
    expect(servicesToArchive(rows, menu)).toEqual(['gloss', 'perm', 'c2']);
  });
});
