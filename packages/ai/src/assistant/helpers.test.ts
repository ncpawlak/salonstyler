import { describe, expect, it } from 'vitest';

import { CLIENTS, COLOR, CUT, KARINA, MENU } from './fake-salon.ts';
import { nameMatchScore, normalizeName, rankByName } from './fuzzy.ts';
import { menuSummary, resolveItems, usualItems } from './menu.ts';

describe('fuzzy client matching', () => {
  it('normalizes accents, case and punctuation', () => {
    expect(normalizeName('  Zoë  O’Brien-Smith ')).toBe('zoe o brien smith');
  });

  it('scores exact, first-name, prefix and typo matches in that order', () => {
    const exact = nameMatchScore('karina lopez', 'Karina Lopez');
    const first = nameMatchScore('karina', 'Karina Lopez');
    const prefix = nameMatchScore('kari', 'Karina Lopez');
    const typo = nameMatchScore('karena', 'Karina Lopez');
    expect(exact).toBe(1);
    expect(first).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(typo);
    expect(typo).toBeGreaterThan(0.55);
    expect(nameMatchScore('bob', 'Karina Lopez')).toBeLessThan(0.55);
  });

  it('ranks clients and drops non-matches', () => {
    const ranked = rankByName('karina', CLIENTS);
    expect(ranked[0]!.item.id).toBe(KARINA);
    expect(ranked.map((r) => r.item.name)).not.toContain('Maria Garcia');
    expect(rankByName('zzz', CLIENTS)).toEqual([]);
  });
});

describe('menu helpers', () => {
  it('resolves a service with a variant into engine input and a snapshot', () => {
    const r = resolveItems(MENU, [{ serviceId: COLOR, variantId: 'v-long' }]);
    expect(r.totalMinutes).toBe(150);
    expect(r.snapshots).toEqual([
      expect.objectContaining({ serviceId: COLOR, variantId: 'v-long', variantName: 'Long hair' }),
    ]);
    expect(r.summary).toContain('All-over Color');
  });

  it('chains several items', () => {
    const r = resolveItems(MENU, [{ serviceId: COLOR }, { serviceId: CUT }]);
    expect(r.totalMinutes).toBe(180);
    expect(r.snapshots).toHaveLength(2);
  });

  it('rejects unknown services', () => {
    expect(() => resolveItems(MENU, [{ serviceId: 'nope' }])).toThrow(/list_services/);
  });

  it('picks the most frequent past service set, ignoring cancelled visits', () => {
    const snap = (id: string) => ({ serviceId: id, name: id });
    expect(
      usualItems(MENU, [
        { startsAt: '2026-10-01T00:00:00Z', status: 'cancelled', services: [snap(CUT)] },
        { startsAt: '2026-09-01T00:00:00Z', status: 'completed', services: [snap(COLOR)] },
        { startsAt: '2026-08-01T00:00:00Z', status: 'cancelled', services: [snap(CUT)] },
        { startsAt: '2026-07-01T00:00:00Z', status: 'completed', services: [snap(CUT)] },
        { startsAt: '2026-06-01T00:00:00Z', status: 'completed', services: [snap(COLOR)] },
      ]),
    ).toEqual([{ serviceId: COLOR, variantId: null }]);
    expect(usualItems(MENU, [])).toBeNull();
  });

  it('summarizes the menu for the model', () => {
    const list = menuSummary(MENU);
    expect(list.map((s) => s.name)).toEqual(["Women's Haircut", 'All-over Color']);
  });
});
