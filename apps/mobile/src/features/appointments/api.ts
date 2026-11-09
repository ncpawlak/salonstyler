import { bookingErrorMessage, type BookingSegment } from '@chairside/core';
import type { AppointmentStatus } from '@chairside/db';
import {
  addClient,
  applyRunningLate,
  bookAppointment,
  listAppointments,
  listClients,
  rescheduleAppointment,
  setAppointmentStatus,
  type AddClientInput,
  type AppointmentServiceSnapshot,
  type ApplyRunningLateInput,
  type BookAppointmentInput,
} from '@chairside/db/appointments';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

export const appointmentsKey = (salonId: string) => ['appointments', salonId] as const;
/** Prefix for every client query (list, profile, visits...), so one invalidation refreshes all. */
export const clientsKey = (salonId: string) => ['clients', salonId] as const;

/** Appointments overlapping `[from, to)` (ISO). Refreshes every minute so expired holds drop off. */
export function useAppointments(range: { from: string; to: string }) {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: [...appointmentsKey(salon.id), range.from, range.to],
    queryFn: () => listAppointments(supabase, salon.id, range),
    refetchInterval: 60_000,
  });
}

function useInvalidateAppointments() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  // Client profiles show visit history and stats, so they refresh with the calendar.
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: appointmentsKey(salon.id) }),
      queryClient.invalidateQueries({ queryKey: clientsKey(salon.id) }),
    ]);
}

/** Turns RPC errors (e.g. the overlap constraint) into a message for the UI. */
export function errorMessage(error: unknown): string {
  return bookingErrorMessage(error as { code?: string; message?: string } | null);
}

export function useBookAppointment() {
  const salon = useCurrentSalon();
  const invalidate = useInvalidateAppointments();
  return useMutation({
    mutationFn: (input: Omit<BookAppointmentInput, 'salonId'>) =>
      bookAppointment(supabase, { ...input, salonId: salon.id }),
    // Refresh on failure too: a conflict means our copy of the calendar is stale.
    onSettled: invalidate,
  });
}

export function useRescheduleAppointment() {
  const invalidate = useInvalidateAppointments();
  return useMutation({
    mutationFn: (input: {
      id: string;
      segments: readonly BookingSegment[];
      services?: readonly AppointmentServiceSnapshot[];
      priceCents?: number | null;
    }) =>
      rescheduleAppointment(
        supabase,
        input.id,
        input.segments,
        input.services ? { services: input.services, priceCents: input.priceCents } : undefined,
      ),
    onSettled: invalidate,
  });
}

/** Moves every appointment of a "running late" cascade in one transaction. */
export function useApplyRunningLate() {
  const salon = useCurrentSalon();
  const invalidate = useInvalidateAppointments();
  return useMutation({
    mutationFn: (input: Omit<ApplyRunningLateInput, 'salonId'>) =>
      applyRunningLate(supabase, { ...input, salonId: salon.id }),
    onSettled: invalidate,
  });
}

export function useSetAppointmentStatus() {
  const invalidate = useInvalidateAppointments();
  return useMutation({
    mutationFn: (input: { id: string; status: AppointmentStatus; reason?: string }) =>
      setAppointmentStatus(supabase, input.id, input.status, input.reason),
    onSettled: invalidate,
  });
}

export function useClients(search: string) {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: [...clientsKey(salon.id), search.trim()],
    queryFn: () => listClients(supabase, salon.id, search),
    placeholderData: (previous) => previous,
  });
}

export function useAddClient() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AddClientInput) => addClient(supabase, salon.id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: clientsKey(salon.id) }),
  });
}
