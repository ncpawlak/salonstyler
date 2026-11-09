import {
  listPendingRequests,
  setAppointmentStatus,
  type AppointmentWithDetails,
} from '@chairside/db';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

// Under the `['appointments', salonId]` prefix so every booking change refreshes it too.
export const pendingRequestsKey = (salonId: string) =>
  ['appointments', salonId, 'requested'] as const;

/** Booking requests awaiting approve/decline (also drives the Inbox tab badge). */
export function usePendingRequests() {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: pendingRequestsKey(salon.id),
    queryFn: () => listPendingRequests(supabase, salon.id),
    refetchInterval: 60_000,
  });
}

/**
 * Approve (confirm) or decline (cancel) a request. The card leaves the stack immediately and comes
 * back if the server refuses (e.g. someone else already booked that time).
 */
export function useRespondToRequest() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  const key = pendingRequestsKey(salon.id);
  return useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) =>
      setAppointmentStatus(
        supabase,
        id,
        approve ? 'confirmed' : 'cancelled',
        approve ? undefined : 'Declined by stylist',
      ),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<AppointmentWithDetails[]>(key);
      queryClient.setQueryData<AppointmentWithDetails[]>(key, (list) =>
        list?.filter((a) => a.id !== id),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['appointments', salon.id] }),
  });
}
