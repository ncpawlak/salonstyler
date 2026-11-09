import { resolveCombo, type ResolveComboOptions, type ResolvedService } from '@chairside/core';
import type { MenuService, ServiceMenu } from '@chairside/db';

/** Resolves a saved combo against the menu's services. */
export function resolveMenuCombo(
  menu: ServiceMenu,
  combo: ServiceMenu['combos'][number],
  options: Omit<ResolveComboOptions, 'priceCents'> = {},
): ResolvedService {
  const byId = new Map<string, MenuService>(menu.services.map((s) => [s.id, s]));
  return resolveCombo(
    combo.items.map((i) => {
      const service = byId.get(i.serviceId);
      if (!service) throw new Error('Combo references a missing service');
      return { service, replacesPreviousFinish: i.replacesPreviousFinish };
    }),
    { ...options, priceCents: combo.priceCents },
  );
}
