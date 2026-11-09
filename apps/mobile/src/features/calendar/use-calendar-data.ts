import {
  addDays,
  parseLocalDate,
  rangeUtilization,
  summarizeUtilization,
  zonedToUtc,
} from '@chairside/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { useAppointments } from '@/features/appointments/api';
import { useWorkHours } from '@/features/hours/use-work-hours';
import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

/**
 * Utilization for every salon-local date in `[from, to]`, computed on the client from the same
 * appointments query the day view uses.
 */
export function useRangeUtilization(from: string, to: string) {
  const salon = useCurrentSalon();
  const workHours = useWorkHours(salon.id);
  const hours = workHours.data?.hours;
  const tz = hours?.timeZone ?? salon.timezone;

  const range = useMemo(
    () => ({
      from: new Date(zonedToUtc(parseLocalDate(from), 0, tz)).toISOString(),
      to: new Date(zonedToUtc(addDays(parseLocalDate(to), 1), 0, tz)).toISOString(),
    }),
    [from, to, tz],
  );
  const appointments = useAppointments(range);

  const days = useMemo(
    () =>
      hours && appointments.data ? rangeUtilization(hours, from, to, appointments.data) : null,
    [hours, appointments.data, from, to],
  );
  const summary = useMemo(() => (days ? summarizeUtilization(days) : null), [days]);

  return {
    days,
    summary,
    timeZone: tz,
    isLoading: workHours.isLoading || appointments.isLoading,
    isError: workHours.isError || appointments.isError,
    refetch: () => {
      void workHours.refetch();
      void appointments.refetch();
    },
  };
}

/**
 * Refreshes every appointments query for the salon when a booking is created, moved or cancelled
 * anywhere (another device, the booking page, the assistant). RLS scopes what Realtime delivers.
 */
export function useAppointmentsRealtime() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      // A booking writes the row more than once; coalesce the burst into one refetch.
      clearTimeout(timer);
      timer = setTimeout(
        () => queryClient.invalidateQueries({ queryKey: ['appointments', salon.id] }),
        250,
      );
    };
    const channel = supabase
      .channel(`calendar-appointments-${salon.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'appointments', filter: `salon_id=eq.${salon.id}` },
        refresh,
      )
      .subscribe();
    return () => {
      clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [salon.id, queryClient]);
}
