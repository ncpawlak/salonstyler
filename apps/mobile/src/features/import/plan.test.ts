import type { ImportedAppointment } from '@chairside/core';
import type { MenuService, ServiceMenu } from '@chairside/db';
import { describe, expect, it } from 'vitest';

import {
  BLOCK_TIME,
  appointmentClients,
  appointmentPayload,
  chunk,
  defaultServiceChoices,
  importedServiceNames,
  serviceKey,
} from './plan';

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
    service('color', {
      name: 'Root touch-up',
      priceCents: 9500,
      segments: [
        { kind: 'busy', minutes: 30 },
        { kind: 'processing', minutes: 35 },
        { kind: 'style', minutes: 30 },
      ],
      bufferAfterMinutes: 10,
    }),
    service('blowout', {
      name: 'Blowout',
      priceCents: 4500,
      segments: [{ kind: 'busy', minutes: 45 }],
    }),
  ],
  combos: [],
  addons: [],
};

const TZ = 'America/Chicago';

const appt = (over: Partial<ImportedAppointment>): ImportedAppointment => ({
  key: 'k1',
  date: '2026-12-03',
  startMinutes: 9 * 60,
  startsAt: '2026-12-03T15:00:00.000Z',
  client: { name: 'Avery Lane', phone: '(312) 555-0142', email: null },
  services: [{ name: 'Root Touch-Up', startMinutes: 9 * 60, minutes: 90 }],
  priceCents: null,
  notes: null,
  rows: [2],
  ...over,
});

describe('importedServiceNames', () => {
  it('groups names, counts them and matches menu items', () => {
    const names = importedServiceNames(
      [
        appt({ services: [{ name: 'Blowout', startMinutes: 600, minutes: 45 }] }),
        appt({ services: [{ name: 'blowout ', startMinutes: 600, minutes: 45 }] }),
        appt({ services: [{ name: 'Scalp Detox Ritual', startMinutes: 600, minutes: 60 }] }),
      ],
      menu,
    );
    expect(names.map((n) => [n.name, n.count, n.matchedId])).toEqual([
      ['Blowout', 2, 'blowout'],
      ['Scalp Detox Ritual', 1, null],
    ]);
    expect(defaultServiceChoices(names)).toEqual({
      blowout: 'blowout',
      scalpdetoxritual: BLOCK_TIME,
    });
  });
});

describe('appointmentClients', () => {
  it('dedupes people by phone/email and skips unnamed bookings', () => {
    const { clients, indexOf } = appointmentClients([
      appt({ key: 'a' }),
      appt({
        key: 'b',
        client: { name: 'Avery L.', phone: '312-555-0142', email: 'avery@example.com' },
      }),
      appt({ key: 'c', client: { name: 'Avery Lane', phone: null, email: 'AVERY@example.com' } }),
      appt({ key: 'd', client: { name: '', phone: null, email: null } }),
      appt({ key: 'e', client: { name: 'Jordan Pike', phone: null, email: null } }),
      appt({ key: 'f', client: { name: 'jordan pike', phone: null, email: null } }),
    ]);
    expect(indexOf).toEqual([0, 0, 0, -1, 1, 1]);
    expect(clients).toEqual([
      { name: 'Avery Lane', phone: '(312) 555-0142', email: 'avery@example.com' },
      { name: 'Jordan Pike', phone: null, email: null },
    ]);
  });
});

describe('appointmentPayload', () => {
  it('uses the menu timeline for matched services', () => {
    const a = appt({});
    const p = appointmentPayload(a, menu, { [serviceKey('Root Touch-Up')]: 'color' }, 'c1', TZ);
    expect(p.clientId).toBe('c1');
    expect(p.segments.map((s) => s.kind)).toEqual(['busy', 'processing', 'style', 'buffer']);
    expect(p.segments[0]).toMatchObject({
      start: '2026-12-03T15:00:00.000Z',
      label: 'Root touch-up',
    });
    expect(p.segments.at(-1)!.end).toBe('2026-12-03T16:45:00.000Z');
    expect(p.services).toEqual([expect.objectContaining({ serviceId: 'color' })]);
    expect(p.priceCents).toBe(9500);
  });

  it('blocks the export length for unmatched services and keeps the export price', () => {
    const a = appt({
      priceCents: 12000,
      services: [{ name: 'Scalp Detox Ritual', startMinutes: 9 * 60, minutes: 75 }],
    });
    const p = appointmentPayload(a, menu, {}, null, TZ);
    expect(p.segments).toEqual([
      {
        kind: 'busy',
        start: '2026-12-03T15:00:00.000Z',
        end: '2026-12-03T16:15:00.000Z',
        label: 'Scalp Detox Ritual',
      },
    ]);
    expect(p.services).toEqual([{ serviceId: '', name: 'Scalp Detox Ritual' }]);
    expect(p.priceCents).toBe(12000);
  });

  it('chains back-to-back services and drops the menu price when one is unmatched', () => {
    const a = appt({
      services: [
        { name: 'Root Touch-Up', startMinutes: 9 * 60, minutes: 90 },
        { name: 'Mystery', startMinutes: 9 * 60 + 30, minutes: 30 },
      ],
    });
    const p = appointmentPayload(a, menu, { [serviceKey('Root Touch-Up')]: 'color' }, null, TZ);
    const last = p.segments.at(-1)!;
    // Can't start before the previous service (with its buffer) finishes.
    expect(last).toMatchObject({ start: '2026-12-03T16:45:00.000Z', label: 'Mystery' });
    expect(p.priceCents).toBeNull();
  });

  it('blocks an hour when the export has no service', () => {
    const p = appointmentPayload(appt({ services: [] }), menu, {}, null, TZ);
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0]!.end).toBe('2026-12-03T16:00:00.000Z');
    expect(p.services).toEqual([{ serviceId: '', name: 'Imported appointment' }]);
  });
});

describe('chunk', () => {
  it('splits into batches', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
});
