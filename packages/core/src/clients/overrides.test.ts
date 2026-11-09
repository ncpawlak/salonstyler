import { describe, expect, it } from 'vitest';

import { layoutService } from '../availability/index.ts';
import { resolveCombo, resolveService } from '../services/resolve.ts';
import { STARTER_MENU } from '../services/starter-menu.ts';
import {
  formatOverride,
  overrideFor,
  suggestDurationOverride,
  type ClientServiceOverride,
} from './overrides.ts';

const color = STARTER_MENU.services.find((s) => s.name === 'All-over color')!;
const cut = STARTER_MENU.services.find((s) => s.name === "Women's cut & style")!;

describe('client duration overrides in the resolvers', () => {
  const karina: ClientServiceOverride[] = [{ serviceId: 'color', deltaMinutes: 20 }];

  it('Karina’s color is booked +20m automatically', () => {
    const standard = resolveService(color);
    const hers = resolveService(color, { clientAdjustment: overrideFor(karina, 'color') });
    expect(hers.totalMinutes).toBe(standard.totalMinutes + 20);
    // Spread over hands-on time; processing is untouched.
    expect(hers.processingMinutes).toBe(standard.processingMinutes);
    expect(overrideFor(karina, 'cut')).toBeNull();
  });

  it('targets one segment when segmentIndex is set (e.g. longer processing)', () => {
    const r = resolveService(color, { clientAdjustment: { deltaMinutes: 15, segmentIndex: 1 } });
    expect(r.segments.map((s) => s.minutes)).toEqual([40, 50, 30]);
    expect(r.processingMinutes).toBe(50);
  });

  it('stacks with the length variant and keeps the engine in sync', () => {
    const r = resolveService(color, {
      variant: { deltaMinutes: 15 },
      clientAdjustment: { deltaMinutes: 20 },
    });
    expect(r.totalMinutes).toBe(105 + 15 + 20);
    // The engine lays out exactly the resolved segments (+ the 10m buffer after).
    const laid = layoutService(r, 0);
    expect(laid.at(-1)!.end - laid[0]!.start).toBe((140 + 10) * 60_000);
  });

  it('applies to combos', () => {
    const r = resolveCombo([{ service: color }, { service: cut, replacesPreviousFinish: true }], {
      clientAdjustment: { deltaMinutes: -10 },
    });
    const base = resolveCombo([{ service: color }, { service: cut, replacesPreviousFinish: true }]);
    expect(r.totalMinutes).toBe(base.totalMinutes - 10);
  });

  it('rejects overrides that would break the service', () => {
    expect(() =>
      resolveService(color, { clientAdjustment: { deltaMinutes: -40, segmentIndex: 0 } }),
    ).toThrow(RangeError);
    expect(() =>
      resolveService(color, { clientAdjustment: { deltaMinutes: 5, segmentIndex: 9 } }),
    ).toThrow(/out of range/);
    expect(() => resolveService(color, { clientAdjustment: { deltaMinutes: 2.5 } })).toThrow(
      /integer/,
    );
  });
});

describe('formatOverride', () => {
  it('formats signed minutes', () => {
    expect(formatOverride(20)).toBe('+20m');
    expect(formatOverride(-15)).toBe('−15m');
    expect(formatOverride(75)).toBe('+1h15');
  });
});

describe('suggestDurationOverride', () => {
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString();
  const samples = (...deltas: number[]) =>
    deltas.map((deltaMinutes, i) => ({ startsAt: at(i), deltaMinutes }));

  it('suggests the rounded median of consistent recent visits', () => {
    expect(suggestDurationOverride(samples(20, 15, 25))).toEqual({ deltaMinutes: 20, visits: 3 });
    expect(suggestDurationOverride(samples(-14, -16))).toEqual({ deltaMinutes: -15, visits: 2 });
  });

  it('needs enough, consistent and meaningful history', () => {
    expect(suggestDurationOverride(samples(30))).toBeNull();
    expect(suggestDurationOverride(samples(5, 5, 5))).toBeNull();
    expect(suggestDurationOverride(samples(30, -30, 30, -30, 0))).toBeNull();
  });

  it('only looks at the most recent visits', () => {
    // Old visits ran long; the last five are on time.
    const s = samples(40, 40, 40, 0, 0, 0, 0, 0);
    expect(suggestDurationOverride(s)).toBeNull();
    expect(suggestDurationOverride(s, { recentVisits: 8 })).toBeNull();
  });

  it('stays quiet when the saved override already matches', () => {
    expect(suggestDurationOverride(samples(20, 20), { currentDeltaMinutes: 20 })).toBeNull();
    expect(suggestDurationOverride(samples(30, 30), { currentDeltaMinutes: 20 })).toEqual({
      deltaMinutes: 30,
      visits: 2,
    });
  });
});
