import {
  listServiceMenu,
  saveService,
  type MenuService,
  type SaveServiceInput,
  type ServiceMenu,
} from '@chairside/db';
import { resolveCombo, type ResolvedService } from '@chairside/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

const menuKey = (salonId: string) => ['service-menu', salonId] as const;

/** The current salon's menu (services, combos, add-ons). New salons start with the starter menu. */
export function useServiceMenu() {
  const salon = useCurrentSalon();
  const query = useQuery({
    queryKey: menuKey(salon.id),
    queryFn: () => listServiceMenu(supabase, salon.id),
  });
  return { ...query, canEdit: salon.role === 'owner' };
}

export function useSaveService() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (service: SaveServiceInput) => saveService(supabase, salon.id, service),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: menuKey(salon.id) }),
  });
}

/** Resolves a saved combo against the menu's services. */
export function resolveMenuCombo(
  menu: ServiceMenu,
  combo: ServiceMenu['combos'][number],
): ResolvedService {
  const byId = new Map<string, MenuService>(menu.services.map((s) => [s.id, s]));
  return resolveCombo(
    combo.items.map((i) => {
      const service = byId.get(i.serviceId);
      if (!service) throw new Error('Combo references a missing service');
      return { service, replacesPreviousFinish: i.replacesPreviousFinish };
    }),
    { priceCents: combo.priceCents },
  );
}

export function formatPrice(cents: number | null): string {
  if (cents == null) return 'Price varies';
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}
