import {
  formatDuration,
  formatOverride,
  overrideFor,
  resolveCombo,
  resolveService,
  type ClientServiceOverride,
  type ResolvedService,
} from '@chairside/core';
import type { AppointmentServiceSnapshot } from '@chairside/db/appointments';
import type { MenuService, ServiceMenu } from '@chairside/db/services';

import type { BookingItem, ClientVisit } from './types.ts';

export interface ResolvedItems {
  service: ResolvedService;
  snapshots: AppointmentServiceSnapshot[];
  summary: string;
  totalMinutes: number;
  /** Net minutes added by the client's duration overrides (0 when none apply). */
  clientAdjustmentMinutes: number;
}

/**
 * Resolves picked menu items into the single `ServiceRequest` the engine books (several items are
 * chained like a combo). Mirrors the app's booking sheet so both book identical segments. The
 * client's duration overrides (`client_service_overrides`) are applied per item.
 */
export function resolveItems(
  menu: ServiceMenu,
  items: readonly BookingItem[],
  overrides: readonly ClientServiceOverride[] = [],
): ResolvedItems {
  if (items.length === 0) throw new Error('Pick at least one service');
  const byId = new Map<string, MenuService>(menu.services.map((s) => [s.id, s]));
  const parts = items.map((item) => {
    const service = byId.get(item.serviceId);
    const combo = service ? undefined : menu.combos.find((c) => c.id === item.serviceId);
    if ((!service && !combo) || (service ?? combo)!.archivedAt) {
      throw new Error(`Unknown service ${item.serviceId}. Call list_services for valid ids.`);
    }
    if (service) {
      const variant = item.variantId
        ? (service.variants.find((v) => v.id === item.variantId) ?? null)
        : null;
      const clientAdjustment = overrideFor(overrides, service.id);
      return {
        adjustment: clientAdjustment?.deltaMinutes ?? 0,
        resolved: resolveService(service, { variant, clientAdjustment }),
        snapshot: {
          serviceId: service.id,
          name: service.name,
          variantId: variant?.id ?? null,
          variantName: variant?.name ?? null,
          colorTag: service.colorTag,
        },
      };
    }
    const clientAdjustment = overrideFor(overrides, combo!.id);
    const resolved = resolveCombo(
      combo!.items.map((i) => {
        const s = byId.get(i.serviceId);
        if (!s) throw new Error('Combo references a missing service');
        return { service: s, replacesPreviousFinish: i.replacesPreviousFinish };
      }),
      { priceCents: combo!.priceCents, clientAdjustment },
    );
    return {
      adjustment: clientAdjustment?.deltaMinutes ?? 0,
      resolved,
      snapshot: {
        serviceId: combo!.id,
        name: combo!.name,
        variantId: null,
        variantName: null,
        colorTag: combo!.colorTag,
      },
    };
  });
  const service =
    parts.length === 1
      ? parts[0]!.resolved
      : resolveCombo(parts.map((p) => ({ service: p.resolved })));
  const names = parts.map((p) =>
    p.snapshot.variantName ? `${p.snapshot.name} (${p.snapshot.variantName})` : p.snapshot.name,
  );
  const adjustment = parts.reduce((n, p) => n + p.adjustment, 0);
  const note = adjustment ? ` (incl. ${formatOverride(adjustment)} for this client)` : '';
  return {
    service,
    snapshots: parts.map((p) => p.snapshot),
    summary: `${names.join(' + ')} · ${formatDuration(service.totalMinutes)}${note}`,
    totalMinutes: service.totalMinutes,
    clientAdjustmentMinutes: adjustment,
  };
}

/**
 * The client's usual booking: the most frequent service set among recent kept visits (ties go to
 * the most recent). Only items still on the menu count. Null when there's no usable history.
 */
export function usualItems(
  menu: ServiceMenu,
  visits: readonly ClientVisit[],
): BookingItem[] | null {
  const live = new Set(
    [...menu.services, ...menu.combos].filter((s) => !s.archivedAt).map((s) => s.id),
  );
  const counts = new Map<string, { items: BookingItem[]; count: number; order: number }>();
  visits.forEach((visit, order) => {
    if (visit.status === 'cancelled' || visit.status === 'no_show') return;
    const items = visit.services
      .filter((s) => live.has(s.serviceId))
      .map((s) => ({ serviceId: s.serviceId, variantId: s.variantId ?? null }));
    if (items.length === 0) return;
    const key = items.map((i) => `${i.serviceId}:${i.variantId ?? ''}`).join('|');
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { items, count: 1, order });
  });
  const best = [...counts.values()].sort((a, b) => b.count - a.count || a.order - b.order)[0];
  return best?.items ?? null;
}

/** Compact menu for the model: ids, names, durations, variants. */
export function menuSummary(menu: ServiceMenu) {
  const live = <T extends { archivedAt: string | null }>(xs: T[]) =>
    xs.filter((x) => !x.archivedAt);
  return [
    ...live(menu.services).map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      minutes: resolveService(s).totalMinutes,
      variants: s.variants.map((v) => ({ id: v.id, name: v.name })),
    })),
    ...live(menu.combos).map((c) => {
      let minutes: number | null = null;
      try {
        minutes = resolveItems(menu, [{ serviceId: c.id }]).totalMinutes;
      } catch {
        // A combo whose parts were removed; still list it so the model can mention it.
      }
      return { id: c.id, name: c.name, category: c.category, minutes, variants: [], combo: true };
    }),
  ];
}
