import { describe, expect, it } from 'vitest';

import { findSlots, layoutService } from '../availability';
import type { ServiceSegment } from '../availability/types';
import {
  applyAddons,
  applyVariant,
  combineServices,
  describeSegments,
  formatDuration,
  resolveCombo,
  resolveService,
  totalMinutes,
} from './resolve';
import { STARTER_MENU } from './starter-menu';

const FULL_COLOR: ServiceSegment[] = [
  { kind: 'busy', minutes: 30, label: 'Apply' },
  { kind: 'processing', minutes: 35, label: 'Process' },
  { kind: 'style', minutes: 30, label: 'Style' },
];

const starter = (name: string) => {
  const s = STARTER_MENU.services.find((x) => x.name === name);
  if (!s) throw new Error(`missing starter service ${name}`);
  return s;
};
const addon = (name: string) => {
  const a = STARTER_MENU.addons.find((x) => x.name === name);
  if (!a) throw new Error(`missing starter add-on ${name}`);
  return a;
};
const shape = (segments: ServiceSegment[]) =>
  segments.map((s) => [s.kind[0]!.toUpperCase(), s.minutes]);

describe('formatDuration', () => {
  it.each([
    [0, '0m'],
    [45, '45m'],
    [60, '1h00'],
    [95, '1h35'],
    [170, '2h50'],
    [180, '3h00'],
    [-15, '-15m'],
  ])('%i -> %s', (m, s) => expect(formatDuration(m)).toBe(s));
});

describe('resolveService', () => {
  it('Full Color: Apply 30 → Process 35 → Style 30 is 1h35', () => {
    const r = resolveService({ segments: FULL_COLOR, bufferAfterMinutes: 10, priceCents: 12000 });
    expect(describeSegments(r.segments)).toBe('Apply 30 → Process 35 → Style 30');
    expect(r.totalMinutes).toBe(95);
    expect(formatDuration(r.totalMinutes)).toBe('1h35');
    expect(r.handsOnMinutes).toBe(60);
    expect(r.processingMinutes).toBe(35);
    expect(r.bufferAfterMinutes).toBe(10);
    expect(r.priceCents).toBe(12000);
  });

  it('does not mutate its input', () => {
    const segments = FULL_COLOR.map((s) => ({ ...s }));
    resolveService(
      { segments },
      { variant: { deltaMinutes: 30 }, overrides: [{ index: 0, deltaMinutes: 5 }] },
    );
    expect(segments).toEqual(FULL_COLOR);
  });

  it('applies variant → add-ons → per-client overrides, and sums add-on prices', () => {
    const r = resolveService(
      { segments: FULL_COLOR, priceCents: 12000 },
      {
        variant: { deltaMinutes: 15 },
        addons: [addon('Blowout finish'), addon('Toner')],
        overrides: [{ index: 1, deltaMinutes: 20 }],
      },
    );
    expect(shape(r.segments)).toEqual([
      ['B', 40],
      ['P', 55],
      ['B', 5],
      ['P', 15],
      ['S', 35],
      ['S', 15],
    ]);
    expect(r.totalMinutes).toBe(95 + 15 + 20 + 15 + 20);
    expect(r.priceCents).toBe(12000 + 2000 + 3500);
  });

  it('price is null when the service or an add-on is unpriced', () => {
    expect(resolveService({ segments: FULL_COLOR }).priceCents).toBeNull();
    expect(
      resolveService(
        { segments: FULL_COLOR, priceCents: 100 },
        { addons: [{ ...addon('Toner'), priceCents: null }] },
      ).priceCents,
    ).toBeNull();
  });

  it('produces a ServiceRequest the availability engine books as-is', () => {
    const r = resolveService({ segments: FULL_COLOR, bufferAfterMinutes: 10 });
    const t = layoutService(r, 0);
    expect(t.map((s) => [s.kind, s.start / 60_000, s.end / 60_000])).toEqual([
      ['busy', 0, 30],
      ['processing', 30, 65],
      ['style', 65, 95],
      ['buffer', 95, 105],
    ]);
    const slots = findSlots({
      service: r,
      hours: {
        timeZone: 'UTC',
        weekly: { 5: { blocks: [{ start: '09:00', end: '11:00', type: 'open' }] } },
      },
      requestedDate: '2026-03-06',
      searchRadiusDays: 0,
      now: '2026-03-01T00:00:00Z',
    });
    expect(slots[0]?.start).toBe('2026-03-06T09:00:00.000Z');
    expect(slots[0]?.end).toBe('2026-03-06T10:35:00.000Z');
  });

  it('rejects invalid services', () => {
    expect(() => resolveService({ segments: [] })).toThrow(RangeError);
    expect(() => resolveService({ segments: [{ kind: 'processing', minutes: 10 }] })).toThrow(
      /processing/,
    );
    expect(() => resolveService({ segments: FULL_COLOR, bufferBeforeMinutes: -5 })).toThrow(
      /negative/,
    );
  });
});

describe('applyVariant', () => {
  it('adds +0 / +15 / +30 to busy and style segments only, in 5-minute steps', () => {
    expect(applyVariant(FULL_COLOR, 0)).toEqual(FULL_COLOR);
    expect(shape(applyVariant(FULL_COLOR, 15))).toEqual([
      ['B', 40],
      ['P', 35],
      ['S', 35],
    ]);
    expect(shape(applyVariant(FULL_COLOR, 30))).toEqual([
      ['B', 45],
      ['P', 35],
      ['S', 45],
    ]);
  });

  it('spreads proportionally and always changes the total by exactly the delta', () => {
    const balayage = starter('Balayage').segments;
    const long = applyVariant(balayage, 30);
    expect(shape(long)).toEqual([
      ['B', 90],
      ['P', 40],
      ['B', 25],
      ['S', 45],
    ]);
    for (const delta of [-10, 1, 7, 15, 30, 45, 61]) {
      const out = applyVariant(balayage, delta);
      expect(totalMinutes(out)).toBe(totalMinutes(balayage) + delta);
      expect(out[1]!.minutes).toBe(40);
    }
  });

  it('rejects variants with nothing hands-on to stretch, or that shrink a segment to zero', () => {
    expect(() => applyVariant([{ kind: 'processing', minutes: 10 }], 15)).toThrow(RangeError);
    expect(() => applyVariant([{ kind: 'busy', minutes: 10 }], -10)).toThrow(RangeError);
    expect(() => applyVariant(FULL_COLOR, 1.5)).toThrow(RangeError);
  });
});

describe('applyAddons', () => {
  it('puts before_finish add-ons before the trailing style segments, end add-ons last', () => {
    const out = applyAddons(FULL_COLOR, [addon('Blowout finish'), addon('Deep conditioning')]);
    expect(describeSegments(out)).toBe(
      'Apply 30 → Process 35 → Apply treatment 5 → Process 15 → Rinse 5 → Style 30 → Blowout 15',
    );
  });

  it('appends before_finish add-ons when the service has no finish', () => {
    expect(shape(applyAddons(starter("Men's cut").segments, [addon('Deep conditioning')]))).toEqual(
      [
        ['B', 30],
        ['B', 5],
        ['P', 15],
        ['B', 5],
      ],
    );
  });

  it('rejects a result that would end with processing', () => {
    expect(() => applyAddons(starter("Men's cut").segments, [addon('Toner')])).toThrow(
      /processing/,
    );
  });
});

describe('combos', () => {
  const balayage = starter('Balayage');
  const cut = starter("Women's cut & style");

  it("Balayage + Women's cut: the cut replaces the balayage's style, total 3h00", () => {
    const r = resolveCombo([{ service: balayage }, { service: cut, replacesPreviousFinish: true }]);
    expect(describeSegments(r.segments)).toBe('Paint 75 → Process 40 → Tone 20 → Cut & style 45');
    expect(shape(r.segments)).toEqual([
      ['B', 75],
      ['P', 40],
      ['B', 20],
      ['B', 45],
    ]);
    expect(formatDuration(r.totalMinutes)).toBe('3h00');
    expect(r.priceCents).toBe(18000 + 4500);
    expect(r.bufferBeforeMinutes).toBe(0);
    expect(r.bufferAfterMinutes).toBe(cut.bufferAfterMinutes);
  });

  it('without replacesPreviousFinish the services are simply chained', () => {
    const c = combineServices([{ service: balayage }, { service: cut }]);
    expect(totalMinutes(c.segments)).toBe(170 + 45);
  });

  it('uses the first service buffer-before and last buffer-after, and a fixed combo price', () => {
    const r = resolveCombo(
      [
        { service: { ...cut, bufferBeforeMinutes: 5 } },
        { service: balayage, replacesPreviousFinish: true },
      ],
      { priceCents: 20000, variant: { deltaMinutes: 15 } },
    );
    expect(r.bufferBeforeMinutes).toBe(5);
    expect(r.bufferAfterMinutes).toBe(10);
    expect(r.priceCents).toBe(20000);
    expect(r.totalMinutes).toBe(45 + 170 + 15);
  });

  it('matches the seeded starter combo definition', () => {
    const combo = STARTER_MENU.combos[0]!;
    const r = resolveCombo(
      combo.items.map((i) => ({
        service: starter(i.service),
        replacesPreviousFinish: i.replacesPreviousFinish,
      })),
    );
    expect(r.totalMinutes).toBe(180);
  });

  it('rejects empty combos', () => {
    expect(() => resolveCombo([])).toThrow(RangeError);
  });
});
