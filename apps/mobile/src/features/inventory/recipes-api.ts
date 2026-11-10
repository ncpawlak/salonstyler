import { getServiceRecipe, listServiceRecipes, setServiceRecipe } from '@chairside/db/recipes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

const recipesKey = (salonId: string) => ['service-recipes', salonId] as const;
const recipeKey = (serviceId: string) => ['service-recipe', serviceId] as const;

export function useServiceRecipes() {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: recipesKey(salon.id),
    queryFn: () => listServiceRecipes(supabase, salon.id),
  });
}

export function useServiceRecipe(serviceId: string) {
  return useQuery({
    queryKey: recipeKey(serviceId),
    queryFn: () => getServiceRecipe(supabase, serviceId),
  });
}

/** Owners only. */
export function useSetServiceRecipe(serviceId: string) {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (lines: { productId: string; quantity: number }[]) =>
      setServiceRecipe(supabase, serviceId, lines),
    onSuccess: (lines) => {
      queryClient.setQueryData(recipeKey(serviceId), lines);
      return queryClient.invalidateQueries({ queryKey: recipesKey(salon.id) });
    },
  });
}
