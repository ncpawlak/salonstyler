import type { AiErrorBody } from '@chairside/ai';
import {
  type ClientEmailSettings,
  getClientEmailSettings,
  getReminderQueue,
  type ManageBookingRequest,
  type ManageCancelResponse,
  type ManageRescheduleResponse,
  type ManageSlotsResponse,
  type ManageViewResponse,
  markTextReminderSent,
  updateClientEmailSettings,
} from '@chairside/db/client-self-service';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';

import { AiRequestError } from '@/features/ai-settings/api';
import { supabase } from '@/lib/supabase';

export { AiRequestError as ManageRequestError };

// --- Settings → Client emails ----------------------------------------------------------------

const settingsKey = (salonId: string) => ['client-email-settings', salonId] as const;

export function useClientEmailSettings(salonId: string) {
  return useQuery({
    queryKey: settingsKey(salonId),
    queryFn: () => getClientEmailSettings(supabase, salonId),
  });
}

export function useUpdateClientEmailSettings(salonId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: Partial<ClientEmailSettings>) =>
      updateClientEmailSettings(supabase, salonId, changes),
    onSuccess: (data) => queryClient.setQueryData(settingsKey(salonId), data),
  });
}

// --- Reminder queue (Today) ------------------------------------------------------------------

const queueKey = (salonId: string) => ['reminder-queue', salonId] as const;

/** Tomorrow's confirmed clients, to text a reminder from the stylist's phone. */
export function useReminderQueue(salonId: string) {
  return useQuery({
    queryKey: queueKey(salonId),
    queryFn: () => getReminderQueue(supabase, salonId),
  });
}

export function useMarkTextReminderSent(salonId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ appointmentId, sent }: { appointmentId: string; sent: boolean }) =>
      markTextReminderSent(supabase, appointmentId, sent),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queueKey(salonId) }),
  });
}

/** Where manage links point: the configured web app, this page's origin, or a deep link. */
export function webOrigin(): string {
  const configured = process.env.EXPO_PUBLIC_WEB_URL?.replace(/\/+$/, '');
  if (configured) return configured;
  if (Platform.OS === 'web' && typeof window !== 'undefined') return window.location.origin;
  return Linking.createURL('/').replace(/\/+$/, '');
}

// --- The client's manage link (/m/{token}, signed out) ---------------------------------------

async function readError(error: unknown): Promise<AiRequestError> {
  const context = (error as { context?: unknown }).context;
  if (context instanceof Response) {
    try {
      const body = (await context.json()) as Partial<AiErrorBody>;
      if (body.error) return new AiRequestError(body.error.code, body.error.message);
    } catch {
      // fall through
    }
  }
  return new AiRequestError('network', 'Can’t reach the salon right now. Check your connection.');
}

async function invoke<T>(body: ManageBookingRequest): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>('manage-booking', { body });
  if (error) throw await readError(error);
  if (!data) throw new AiRequestError('invalid_response', 'Empty response from the salon');
  return data;
}

/** Calls the `manage-booking` Edge Function. The token is the only credential. */
export function manageBookingApi(token: string) {
  return {
    view: () => invoke<ManageViewResponse>({ action: 'view', token }),
    slots: (date: string) => invoke<ManageSlotsResponse>({ action: 'slots', token, date }),
    cancel: () => invoke<ManageCancelResponse>({ action: 'cancel', token }),
    reschedule: (start: string) =>
      invoke<ManageRescheduleResponse>({ action: 'reschedule', token, start }),
  };
}
