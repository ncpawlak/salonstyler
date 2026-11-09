import type { CheckoutWithItems } from '@chairside/db/checkout';
import { getAppointment, listAppointments } from '@chairside/db/appointments';
import {
  getRebookStats,
  listServiceRebookIntervals,
  rebookFromCheckout,
  setServiceRebookInterval,
  skipRebook,
  type RebookFromCheckoutInput,
} from '@chairside/db/rebook';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

import { appointmentsKey, clientsKey } from '../appointments/api';
import { checkoutKey } from '../checkout/api';

/** Under the service menu's key, so saving a service refreshes it too. */
const intervalsKey = (salonId: string) => ['service-menu', salonId, 'rebook-intervals'] as const;
const statsKey = (salonId: string) => ['rebook-stats', salonId] as const;

export function useAppointmentDetail(appointmentId: string | null | undefined) {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: [...appointmentsKey(salon.id), 'one', appointmentId],
    queryFn: () => getAppointment(supabase, appointmentId!),
    enabled: !!appointmentId,
  });
}

/** The calendar around the suggested dates; waits until the range is known. */
export function useAppointmentsBetween(range: { from: string; to: string } | null) {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: [...appointmentsKey(salon.id), range?.from, range?.to],
    queryFn: () => listAppointments(supabase, salon.id, range!),
    enabled: !!range,
  });
}

export function useServiceRebookIntervals() {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: intervalsKey(salon.id),
    queryFn: () => listServiceRebookIntervals(supabase, salon.id),
  });
}

export function useSetServiceRebookInterval() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { serviceId: string; days: number | null }) =>
      setServiceRebookInterval(supabase, input.serviceId, input.days),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: intervalsKey(salon.id) }),
  });
}

/** The rebook rate over the last 30 days. */
export function useRebookStats() {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: statsKey(salon.id),
    queryFn: () => getRebookStats(supabase, salon.id),
  });
}

function useAfterRebook(appointmentId: string) {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return {
    patchCheckout: (patch: Partial<CheckoutWithItems>) =>
      queryClient.setQueryData<CheckoutWithItems>(checkoutKey(appointmentId), (prev) =>
        prev ? { ...prev, ...patch } : prev,
      ),
    invalidate: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: appointmentsKey(salon.id) }),
        queryClient.invalidateQueries({ queryKey: clientsKey(salon.id) }),
        queryClient.invalidateQueries({ queryKey: statsKey(salon.id) }),
      ]),
  };
}

/** Books the next visit from the checkout of `appointmentId`. */
export function useRebookFromCheckout(appointmentId: string) {
  const after = useAfterRebook(appointmentId);
  return useMutation({
    mutationFn: (input: RebookFromCheckoutInput) => rebookFromCheckout(supabase, input),
    onSuccess: (appointment) =>
      after.patchCheckout({ rebook_appointment_id: appointment.id, rebook_declined_at: null }),
    // Refresh on failure too: a conflict means our copy of the calendar is stale.
    onSettled: after.invalidate,
  });
}

export function useSkipRebook(appointmentId: string) {
  const after = useAfterRebook(appointmentId);
  return useMutation({
    mutationFn: (checkoutId: string) => skipRebook(supabase, checkoutId),
    onSuccess: () => after.patchCheckout({ rebook_declined_at: new Date().toISOString() }),
    onSettled: after.invalidate,
  });
}
