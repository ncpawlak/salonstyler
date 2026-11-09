import {
  resolveService,
  suggestDurationOverride,
  type ClientServiceOverride,
  type DurationSample,
  type OverrideSuggestion,
} from '@chairside/core';
import type { ClientVisit, ServiceMenu } from '@chairside/db';

import { resolveMenuCombo } from '../services/menu';

export interface ServiceOverrideSuggestion extends OverrideSuggestion {
  serviceId: string;
  serviceName: string;
  currentDeltaMinutes: number;
}

/** A visit that actually happened (or is confirmed and over), so its booked length is real. */
function isKept(visit: ClientVisit, now: number): boolean {
  return (
    visit.status === 'completed' ||
    (visit.status === 'confirmed' && Date.parse(visit.endsAt) <= now)
  );
}

/**
 * How much longer than the menu each past single-item visit was booked for, grouped by menu item.
 * Multi-item visits are skipped: their time can't be attributed to one service.
 */
export function durationSamples(
  menu: ServiceMenu,
  visits: readonly ClientVisit[],
  now: number = Date.now(),
): Map<string, DurationSample[]> {
  const out = new Map<string, DurationSample[]>();
  for (const visit of visits) {
    if (visit.services.length !== 1 || !isKept(visit, now)) continue;
    const snap = visit.services[0]!;
    const service = menu.services.find((s) => s.id === snap.serviceId);
    const combo = service ? undefined : menu.combos.find((c) => c.id === snap.serviceId);
    let standard: number;
    try {
      if (service) {
        const variant = service.variants.find((v) => v.id === snap.variantId) ?? null;
        standard = resolveService(service, { variant }).totalMinutes;
      } else if (combo) {
        standard = resolveMenuCombo(menu, combo).totalMinutes;
      } else continue;
    } catch {
      continue;
    }
    const booked = (Date.parse(visit.endsAt) - Date.parse(visit.startsAt)) / 60_000;
    const samples = out.get(snap.serviceId) ?? [];
    samples.push({ startsAt: visit.startsAt, deltaMinutes: booked - standard });
    out.set(snap.serviceId, samples);
  }
  return out;
}

/** "Her last 3 colors ran +20m: save it?" suggestions, one per menu item at most. */
export function overrideSuggestions(
  menu: ServiceMenu,
  visits: readonly ClientVisit[],
  overrides: readonly ClientServiceOverride[],
  now: number = Date.now(),
): ServiceOverrideSuggestion[] {
  const out: ServiceOverrideSuggestion[] = [];
  for (const [serviceId, samples] of durationSamples(menu, visits, now)) {
    const def =
      menu.services.find((s) => s.id === serviceId) ?? menu.combos.find((c) => c.id === serviceId);
    if (!def || def.archivedAt) continue;
    const currentDeltaMinutes = overrides.find((o) => o.serviceId === serviceId)?.deltaMinutes ?? 0;
    const suggestion = suggestDurationOverride(samples, { currentDeltaMinutes });
    if (suggestion)
      out.push({ ...suggestion, serviceId, serviceName: def.name, currentDeltaMinutes });
  }
  return out;
}
