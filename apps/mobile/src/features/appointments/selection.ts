import {
  formatDuration,
  resolveCombo,
  resolveService,
  type ResolvedService,
  type ServiceColorTag,
} from '@chairside/core';
import type { AppointmentServiceSnapshot, ServiceMenu } from '@chairside/db';

import { resolveMenuCombo } from '../services/menu';

/** One picked menu item: a service (optionally with a variant) or a combo. */
export interface BookingItem {
  serviceId: string;
  variantId?: string | null;
}

export interface BookingSelection {
  items: BookingItem[];
  /** Extra (or fewer) hands-on minutes, applied to the last busy/style segment. */
  adjustMinutes: number;
}

export interface ResolvedSelection {
  service: ResolvedService;
  snapshots: AppointmentServiceSnapshot[];
  colorTag: ServiceColorTag;
  /** Client minutes including the adjustment. */
  totalMinutes: number;
  summary: string;
}

/**
 * Resolves picked services into the single `ServiceRequest` the engine books, reusing the core
 * resolvers (several items are chained like a combo). Returns null for an empty selection.
 */
export function resolveSelection(
  menu: ServiceMenu,
  selection: BookingSelection,
): ResolvedSelection | null {
  const parts: { resolved: ResolvedService; snapshot: AppointmentServiceSnapshot }[] = [];
  for (const item of selection.items) {
    const service = menu.services.find((s) => s.id === item.serviceId);
    const combo = service ? undefined : menu.combos.find((c) => c.id === item.serviceId);
    const def = service ?? combo;
    if (!def) continue;
    const variant = service?.variants.find((v) => v.id === item.variantId) ?? null;
    parts.push({
      resolved: service ? resolveService(service, { variant }) : resolveMenuCombo(menu, combo!),
      snapshot: {
        serviceId: def.id,
        name: def.name,
        variantId: variant?.id ?? null,
        variantName: variant?.name ?? null,
        colorTag: def.colorTag,
      },
    });
  }
  if (parts.length === 0) return null;

  const base =
    parts.length === 1
      ? parts[0]!.resolved
      : resolveCombo(parts.map((p) => ({ service: p.resolved })));
  let service: ResolvedService = base;
  if (selection.adjustMinutes) {
    let index = base.segments.length - 1;
    while (index > 0 && base.segments[index]!.kind === 'processing') index--;
    service = { ...base, overrides: [{ index, deltaMinutes: selection.adjustMinutes }] };
  }
  const totalMinutes = base.totalMinutes + selection.adjustMinutes;
  return {
    service,
    snapshots: parts.map((p) => p.snapshot),
    colorTag: (parts[0]!.snapshot.colorTag as ServiceColorTag | null) ?? 'gray',
    totalMinutes,
    summary: `${parts.map((p) => p.snapshot.name).join(' + ')} · ${formatDuration(totalMinutes)}`,
  };
}

/** Rebuilds a selection from an appointment's snapshot (for editing its services). */
export function selectionFromSnapshots(
  snapshots: readonly AppointmentServiceSnapshot[],
): BookingSelection {
  return {
    items: snapshots.map((s) => ({ serviceId: s.serviceId, variantId: s.variantId ?? null })),
    adjustMinutes: 0,
  };
}
