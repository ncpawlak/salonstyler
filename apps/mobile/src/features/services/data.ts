import { listServiceMenu, saveService, type SaveServiceInput } from '@chairside/db/services';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

export { resolveMenuCombo } from './menu';

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

export function formatPrice(cents: number | null): string {
  if (cents == null) return 'Price varies';
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}
