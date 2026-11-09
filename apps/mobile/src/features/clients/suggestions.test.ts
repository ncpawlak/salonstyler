import type { ClientVisit, MenuService, ServiceMenu } from '@chairside/db';
import { describe, expect, it } from 'vitest';

import { durationSamples, overrideSuggestions } from './suggestions';

const color: MenuService = {
  id: 'color',
  isCombo: false,
  position: 0,
  archivedAt: null,
  name: 'All-over color',
  category: 'Color',
  priceCents: 12000,
  colorTag: 'purple',
  segments: [
    { kind: 'busy', minutes: 40 },
    { kind: 'processing', minutes: 35 },
    { kind: 'style', minutes: 30 },
  ],
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 10,
  consultationRequired: false,
  bookableOnline: true,
  newClientsOnly: false,
  variants: [{ id: 'long', name: 'Long hair', deltaMinutes: 15 }],
};
const menu: ServiceMenu = { services: [color], combos: [], addons: [] };
const NOW = Date.parse('2026-12-01T12:00:00Z');

const visit = (
  day: string,
  minutes: number,
  over: Partial<ClientVisit> = {},
  variantId: string | null = null,
): ClientVisit => {
  const startsAt = `2026-${day}T15:00:00.000Z`;
  return {
    id: day,
    status: 'completed',
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + minutes * 60_000).toISOString(),
    priceCents: null,
    notes: null,
    services: [{ serviceId: 'color', name: 'All-over color', variantId }],
    payments: [],
    ...over,
  };
};

describe('override suggestions', () => {
  it('measures each kept visit against the menu time (variant included)', () => {
    const samples = durationSamples(
      menu,
      [
        visit('11-01', 125),
        visit('10-01', 140, {}, 'long'),
        visit('09-01', 200, { status: 'cancelled' }),
        visit('08-01', 200, { services: [] }),
      ],
      NOW,
    );
    expect(samples.get('color')!.map((s) => s.deltaMinutes)).toEqual([20, 20]);
  });

  it("suggests Karina's +20m when her colors keep running long", () => {
    const visits = [visit('11-01', 125), visit('10-01', 130), visit('09-01', 120)];
    expect(overrideSuggestions(menu, visits, [], NOW)).toEqual([
      {
        serviceId: 'color',
        serviceName: 'All-over color',
        deltaMinutes: 20,
        visits: 3,
        currentDeltaMinutes: 0,
      },
    ]);
  });

  it('stays quiet once the override is saved, or when history is inconsistent', () => {
    const visits = [visit('11-01', 125), visit('10-01', 125)];
    expect(
      overrideSuggestions(menu, visits, [{ serviceId: 'color', deltaMinutes: 20 }], NOW),
    ).toEqual([]);
    expect(
      overrideSuggestions(
        menu,
        [visit('11-01', 135), visit('10-01', 90), visit('09-01', 105)],
        [],
        NOW,
      ),
    ).toEqual([]);
  });
});
