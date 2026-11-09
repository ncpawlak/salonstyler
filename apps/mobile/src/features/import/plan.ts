import {
  blockSegments,
  clientMatchKeys,
  matchServiceName,
  normalizeHeader,
  planImportedSegments,
  type ImportedAppointment,
  type ImportedClient,
} from '@chairside/core';
import type {
  AppointmentServiceSnapshot,
  ImportAppointmentInput,
  ImportClientInput,
  ServiceMenu,
} from '@chairside/db';

import { resolveSelection } from '../appointments/selection';

/** What an imported service name books as: a menu service/combo id, or `block` (time only). */
export type ServiceChoice = string | typeof BLOCK_TIME;
export const BLOCK_TIME = 'block';

export interface MenuItem {
  id: string;
  name: string;
}

export function menuItems(menu: ServiceMenu): MenuItem[] {
  return [...menu.services, ...menu.combos].map(({ id, name }) => ({ id, name }));
}

export const serviceKey = (name: string) => normalizeHeader(name);

export interface ImportedServiceName {
  /** `serviceKey(name)`; key of `choices`. */
  key: string;
  name: string;
  count: number;
  /** Menu item it matched automatically, if any. */
  matchedId: string | null;
}

/** Distinct service names in the export, most common first, with their automatic match. */
export function importedServiceNames(
  appointments: readonly ImportedAppointment[],
  menu: ServiceMenu,
): ImportedServiceName[] {
  const items = menuItems(menu);
  const byKey = new Map<string, ImportedServiceName>();
  for (const a of appointments) {
    for (const s of a.services) {
      if (!s.name.trim()) continue;
      const key = serviceKey(s.name);
      const found = byKey.get(key);
      if (found) found.count++;
      else byKey.set(key, { key, name: s.name, count: 1, matchedId: null });
    }
  }
  for (const entry of byKey.values())
    entry.matchedId = matchServiceName(entry.name, items)?.id ?? null;
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Initial choices: the automatic match, else block the time. */
export function defaultServiceChoices(
  names: readonly ImportedServiceName[],
): Record<string, ServiceChoice> {
  return Object.fromEntries(names.map((n) => [n.key, n.matchedId ?? BLOCK_TIME]));
}

export function clientPayload(c: ImportedClient): ImportClientInput {
  return {
    name: c.name,
    phone: c.phone,
    email: c.email,
    birthday: c.birthday,
    tags: c.tags,
    lastVisitOn: c.lastVisitOn,
    ...(c.noShowCount != null ? { noShowCount: c.noShowCount } : {}),
    notes: c.notes,
  };
}

/**
 * The distinct people booked in the export (to upsert via `import_clients` before booking), and
 * for each appointment the index of its person in that list (or -1 when it has no name).
 */
export function appointmentClients(appointments: readonly ImportedAppointment[]): {
  clients: ImportClientInput[];
  indexOf: number[];
} {
  const clients: ImportClientInput[] = [];
  const byKey = new Map<string, number>();
  const indexOf = appointments.map((a) => {
    if (!a.client.name.trim()) return -1;
    const keys = clientMatchKeys(a.client);
    const existing = keys.map((k) => byKey.get(k)).find((i) => i !== undefined);
    if (existing !== undefined) {
      const c = clients[existing]!;
      c.phone ??= a.client.phone;
      c.email ??= a.client.email;
      for (const k of clientMatchKeys({
        name: c.name,
        phone: c.phone ?? null,
        email: c.email ?? null,
      }))
        byKey.set(k, existing);
      return existing;
    }
    clients.push({ name: a.client.name, phone: a.client.phone, email: a.client.email });
    for (const k of keys) byKey.set(k, clients.length - 1);
    return clients.length - 1;
  });
  return { clients, indexOf };
}

/** Lays out one imported appointment as `import_appointments` input. */
export function appointmentPayload(
  appt: ImportedAppointment,
  menu: ServiceMenu,
  choices: Readonly<Record<string, ServiceChoice>>,
  clientId: string | null,
  timeZone: string,
): ImportAppointmentInput {
  const parts: Parameters<typeof planImportedSegments>[1][number][] = [];
  const snapshots: AppointmentServiceSnapshot[] = [];
  let menuPrice: number | null = 0;
  for (const s of appt.services) {
    const choice = choices[serviceKey(s.name)] ?? BLOCK_TIME;
    const resolved =
      choice === BLOCK_TIME
        ? null
        : resolveSelection(menu, { items: [{ serviceId: choice }], adjustMinutes: 0 });
    if (resolved) {
      parts.push({
        startMinutes: s.startMinutes,
        segments: resolved.service.segments,
        bufferBeforeMinutes: resolved.service.bufferBeforeMinutes,
        bufferAfterMinutes: resolved.service.bufferAfterMinutes,
        label: resolved.snapshots[0]!.name,
      });
      snapshots.push(...resolved.snapshots);
      menuPrice =
        menuPrice !== null && resolved.service.priceCents !== null
          ? menuPrice + resolved.service.priceCents
          : null;
    } else {
      const name = s.name.trim() || 'Imported appointment';
      parts.push({ startMinutes: s.startMinutes, segments: blockSegments(s.minutes), label: name });
      snapshots.push({ serviceId: '', name });
      menuPrice = null;
    }
  }
  if (!parts.length) {
    parts.push({ segments: blockSegments(null), label: 'Imported appointment' });
    snapshots.push({ serviceId: '', name: 'Imported appointment' });
    menuPrice = null;
  }
  return {
    key: appt.key,
    clientId,
    segments: planImportedSegments(appt, parts, timeZone),
    services: snapshots,
    priceCents: appt.priceCents ?? menuPrice,
    notes: appt.notes,
  };
}

/** Splits `items` into chunks of `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
