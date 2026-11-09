import type { MenuService, ServiceMenu } from '@chairside/db/services';
import { describe, expect, it } from 'vitest';

import { resolveSelection, selectionFromSnapshots } from './selection';

const service = (id: string, over: Partial<MenuService>): MenuService => ({
  id,
  isCombo: false,
  position: 0,
  archivedAt: null,
  name: id,
  category: 'Hair',
  priceCents: 5000,
  colorTag: 'blue',
  segments: [{ kind: 'busy', minutes: 30 }],
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  consultationRequired: false,
  bookableOnline: true,
  newClientsOnly: false,
  variants: [],
  ...over,
});

const menu: ServiceMenu = {
  services: [
    service('cut', {
      name: "Women's cut",
      colorTag: 'pink',
      segments: [{ kind: 'busy', minutes: 45 }],
      variants: [{ id: 'long', name: 'Long hair', deltaMinutes: 15 }],
      bufferAfterMinutes: 10,
    }),
    service('color', {
      name: 'Root touch-up',
      colorTag: 'purple',
      segments: [
        { kind: 'busy', minutes: 30 },
        { kind: 'processing', minutes: 35 },
        { kind: 'style', minutes: 30 },
      ],
    }),
  ],
  combos: [
    {
      id: 'combo',
      isCombo: true,
      position: 0,
      archivedAt: null,
      name: 'Color + cut',
      category: 'Hair',
      priceCents: 12000,
      colorTag: 'teal',
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      consultationRequired: false,
      bookableOnline: true,
      newClientsOnly: false,
      variants: [],
      items: [
        { serviceId: 'color', replacesPreviousFinish: false },
        { serviceId: 'cut', replacesPreviousFinish: true },
      ],
    },
  ],
  addons: [],
};

describe('resolveSelection', () => {
  it('returns null for nothing picked', () => {
    expect(resolveSelection(menu, { items: [], adjustMinutes: 0 })).toBeNull();
  });

  it('applies a variant and snapshots the pick', () => {
    const r = resolveSelection(menu, {
      items: [{ serviceId: 'cut', variantId: 'long' }],
      adjustMinutes: 0,
    })!;
    expect(r.totalMinutes).toBe(60);
    expect(r.service.bufferAfterMinutes).toBe(10);
    expect(r.snapshots).toEqual([
      {
        serviceId: 'cut',
        name: "Women's cut",
        variantId: 'long',
        variantName: 'Long hair',
        colorTag: 'pink',
      },
    ]);
    expect(r.colorTag).toBe('pink');
  });

  it('chains several services and resolves combos', () => {
    const r = resolveSelection(menu, {
      items: [{ serviceId: 'color' }, { serviceId: 'combo' }],
      adjustMinutes: 0,
    })!;
    expect(r.service.segments.map((s) => s.kind)).toEqual([
      'busy',
      'processing',
      'style',
      'busy',
      'processing',
      'busy',
    ]);
    expect(r.summary).toBe('Root touch-up + Color + cut · 3h25');
  });

  it('adjusts the last hands-on segment', () => {
    const r = resolveSelection(menu, { items: [{ serviceId: 'color' }], adjustMinutes: 15 })!;
    expect(r.totalMinutes).toBe(110);
    expect(r.service.overrides).toEqual([{ index: 2, deltaMinutes: 15 }]);
  });

  it('round-trips snapshots back to a selection', () => {
    const r = resolveSelection(menu, {
      items: [{ serviceId: 'cut', variantId: 'long' }],
      adjustMinutes: 0,
    })!;
    expect(selectionFromSnapshots(r.snapshots)).toEqual({
      items: [{ serviceId: 'cut', variantId: 'long' }],
      adjustMinutes: 0,
    });
  });

  it("applies the client's saved duration overrides automatically", () => {
    // Karina: color +20m (spread over hands-on time), combo -10m.
    const overrides = [
      { serviceId: 'color', deltaMinutes: 20 },
      { serviceId: 'combo', deltaMinutes: -10, segmentIndex: 0 },
    ];
    const color = resolveSelection(
      menu,
      { items: [{ serviceId: 'color' }], adjustMinutes: 0 },
      overrides,
    )!;
    expect(color.totalMinutes).toBe(95 + 20);
    expect(color.clientAdjustmentMinutes).toBe(20);
    expect(color.service.segments.find((s) => s.kind === 'processing')!.minutes).toBe(35);
    expect(color.summary).toBe('Root touch-up · 1h55');

    const cut = resolveSelection(
      menu,
      { items: [{ serviceId: 'cut' }], adjustMinutes: 0 },
      overrides,
    )!;
    expect(cut.totalMinutes).toBe(45);
    expect(cut.clientAdjustmentMinutes).toBe(0);

    const combo = resolveSelection(
      menu,
      { items: [{ serviceId: 'combo' }], adjustMinutes: 5 },
      overrides,
    )!;
    const plain = resolveSelection(menu, { items: [{ serviceId: 'combo' }], adjustMinutes: 5 })!;
    expect(combo.totalMinutes).toBe(plain.totalMinutes - 10);
    expect(combo.service.segments[0]!.minutes).toBe(plain.service.segments[0]!.minutes - 10);
  });
});
