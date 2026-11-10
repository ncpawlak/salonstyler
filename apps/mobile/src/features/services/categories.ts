import {
  addServiceCategory,
  deleteServiceCategory,
  renameServiceCategory,
  reorderServiceCategories,
} from '@chairside/db/service-categories';
import type { ServiceMenu } from '@chairside/db/services';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

import { menuKey } from './data';

export type CategoryAction =
  | { type: 'add'; name: string }
  | { type: 'rename'; from: string; to: string }
  | { type: 'delete'; name: string; moveTo?: string }
  | { type: 'reorder'; names: string[] };

/** Add / rename / remove (merge) / reorder categories. Owners only (enforced by the RPCs). */
export function useCategoryAction() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  const key = menuKey(salon.id);
  return useMutation({
    mutationFn: (action: CategoryAction) => {
      switch (action.type) {
        case 'add':
          return addServiceCategory(supabase, salon.id, action.name);
        case 'rename':
          return renameServiceCategory(supabase, salon.id, action.from, action.to);
        case 'delete':
          return deleteServiceCategory(supabase, salon.id, action.name, action.moveTo);
        case 'reorder':
          return reorderServiceCategories(supabase, salon.id, action.names);
      }
    },
    onMutate: async (action) => {
      if (action.type !== 'reorder') return;
      // Move rows right away; the refetch confirms.
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ServiceMenu>(key);
      if (previous)
        queryClient.setQueryData<ServiceMenu>(key, { ...previous, categories: action.names });
      return { previous };
    },
    onError: (_e, _action, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}
