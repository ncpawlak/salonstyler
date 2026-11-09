import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

/**
 * Streams appointment and client changes for the current salon and refreshes the affected
 * queries, so Today, the calendar, the Inbox badge and search stay live across devices. Realtime
 * applies RLS, so only rows from salons the user belongs to arrive. Bursts (a booking writes the
 * row a few times) are coalesced into one refetch.
 */
export function useSalonRealtime() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();

  useEffect(() => {
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      for (const root of pending)
        void queryClient.invalidateQueries({ queryKey: [root, salon.id] });
      pending.clear();
    };
    const schedule = (...roots: string[]) => {
      for (const r of roots) pending.add(r);
      timer ??= setTimeout(flush, 250);
    };

    const filter = `salon_id=eq.${salon.id}`;
    const channel = supabase
      .channel(`salon:${salon.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'appointments', filter }, () =>
        schedule('appointments', 'search'),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'clients', filter }, () =>
        schedule('clients', 'search', 'appointments'),
      )
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [salon.id, queryClient]);
}
