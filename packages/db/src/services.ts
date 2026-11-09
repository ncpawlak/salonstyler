import type {
  ServiceAddon,
  ServiceColorTag,
  ServiceDefinition,
  ServiceSegment,
  ServiceVariant,
} from '@chairside/core';

import type { ChairsideClient } from './index';

/** A saved (non-combo) service. */
export interface MenuService extends ServiceDefinition {
  id: string;
  isCombo: false;
  position: number;
  archivedAt: string | null;
}

export interface MenuComboItem {
  serviceId: string;
  replacesPreviousFinish: boolean;
}

/** A saved combo: resolve with `resolveCombo` from `@chairside/core`. */
export interface MenuCombo extends Omit<ServiceDefinition, 'segments'> {
  id: string;
  isCombo: true;
  position: number;
  archivedAt: string | null;
  items: MenuComboItem[];
}

export interface MenuAddon extends ServiceAddon {
  id: string;
  bookableOnline: boolean;
  position: number;
  archivedAt: string | null;
}

export interface ServiceMenu {
  services: MenuService[];
  combos: MenuCombo[];
  addons: MenuAddon[];
}

const byPosition = <T extends { position: number }>(a: T, b: T) => a.position - b.position;

const toSegments = (
  rows: { kind: ServiceSegment['kind']; minutes: number; label: string | null; position: number }[],
): ServiceSegment[] =>
  [...rows]
    .sort(byPosition)
    .map((r) =>
      r.label
        ? { kind: r.kind, minutes: r.minutes, label: r.label }
        : { kind: r.kind, minutes: r.minutes },
    );

/** The salon's whole menu (services, combos, add-ons), ordered by position. */
export async function listServiceMenu(
  client: ChairsideClient,
  salonId: string,
): Promise<ServiceMenu> {
  const [services, addons] = await Promise.all([
    client
      .from('services')
      .select(
        `*,
         segments:service_segments!service_segments_service_fkey(kind, minutes, label, position),
         variants:service_variants!service_variants_service_fkey(id, name, delta_minutes, position),
         items:service_combo_items!service_combo_items_combo_fkey(service_id, replaces_previous_finish, position)`,
      )
      .eq('salon_id', salonId)
      .order('position'),
    client
      .from('service_addons')
      .select(
        '*, segments:service_segments!service_segments_addon_fkey(kind, minutes, label, position)',
      )
      .eq('salon_id', salonId)
      .order('position'),
  ]);
  if (services.error) throw services.error;
  if (addons.error) throw addons.error;

  const menu: ServiceMenu = { services: [], combos: [], addons: [] };
  for (const row of services.data) {
    const base = {
      id: row.id,
      name: row.name,
      category: row.category,
      description: row.description,
      priceCents: row.price_cents,
      colorTag: row.color_tag as ServiceColorTag,
      bufferBeforeMinutes: row.buffer_before_minutes,
      bufferAfterMinutes: row.buffer_after_minutes,
      consultationRequired: row.consultation_required,
      bookableOnline: row.bookable_online,
      newClientsOnly: row.new_clients_only,
      position: row.position,
      archivedAt: row.archived_at,
      variants: [...row.variants]
        .sort(byPosition)
        .map((v): ServiceVariant => ({ id: v.id, name: v.name, deltaMinutes: v.delta_minutes })),
    };
    if (row.is_combo) {
      menu.combos.push({
        ...base,
        isCombo: true,
        items: [...row.items].sort(byPosition).map((i) => ({
          serviceId: i.service_id,
          replacesPreviousFinish: i.replaces_previous_finish,
        })),
      });
    } else {
      menu.services.push({ ...base, isCombo: false, segments: toSegments(row.segments) });
    }
  }
  menu.addons = addons.data.map((a) => ({
    id: a.id,
    name: a.name,
    priceCents: a.price_cents,
    placement: a.placement,
    bookableOnline: a.bookable_online,
    position: a.position,
    archivedAt: a.archived_at,
    segments: toSegments(a.segments),
  }));
  return menu;
}

export type SaveServiceInput =
  | (ServiceDefinition & { id?: string; isCombo?: false })
  | (Omit<ServiceDefinition, 'segments'> & { id?: string; isCombo: true; items: MenuComboItem[] });

/** Creates (no `id`) or replaces a service/combo atomically. Owners only. Returns its id. */
export async function saveService(
  client: ChairsideClient,
  salonId: string,
  service: SaveServiceInput,
): Promise<string> {
  const { data, error } = await client.rpc('save_service', {
    p_salon_id: salonId,
    p_service: JSON.parse(JSON.stringify(service)),
  });
  if (error) throw error;
  return data;
}

/** Creates (no `id`) or replaces an add-on atomically. Owners only. Returns its id. */
export async function saveServiceAddon(
  client: ChairsideClient,
  salonId: string,
  addon: ServiceAddon & { bookableOnline?: boolean },
): Promise<string> {
  const { data, error } = await client.rpc('save_service_addon', {
    p_salon_id: salonId,
    p_addon: JSON.parse(JSON.stringify(addon)),
  });
  if (error) throw error;
  return data;
}

/** Hides a service from booking (kept for history; combos may still reference it). */
export async function setServiceArchived(
  client: ChairsideClient,
  serviceId: string,
  archived: boolean,
): Promise<void> {
  const { error } = await client
    .from('services')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', serviceId);
  if (error) throw error;
}
