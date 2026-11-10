import type {
  DepositPageResponse,
  DepositRefundResponse,
  DepositStartResponse,
} from '@chairside/payments';
import {
  cancelAppointmentWithPolicy,
  getAppointmentDeposit,
  getCancellationQuote,
  getDepositPayToken,
  getDepositSettings,
  getServiceDeposit,
  updateDepositSettings,
  updateServiceDeposit,
  type DepositSettings,
  type ServiceDepositFields,
} from '@chairside/db/deposits';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';

import { appointmentsKey } from '@/features/appointments/api';
import { PaymentsRequestError, readFunctionError } from '@/features/payments/api';
import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

const settingsKey = (salonId: string) => ['deposit-settings', salonId] as const;
const serviceKey = (serviceId: string) => ['service-deposit', serviceId] as const;
export const depositKey = (appointmentId: string) => ['deposit', appointmentId] as const;

/** Calls the `deposits` Edge Function (pay page, Stripe Checkout, refunds). */
async function invokeDeposits<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>('deposits', { body });
  if (error) throw await readFunctionError(error);
  if (!data) throw new PaymentsRequestError('invalid_response', 'Empty response from deposits');
  return data;
}

export const depositsApi = {
  page: (token: string) => invokeDeposits<DepositPageResponse>({ action: 'page', token }),
  start: (token: string, returnUrl: string) =>
    invokeDeposits<DepositStartResponse>({ action: 'start', token, returnUrl }),
  status: (token: string) => invokeDeposits<DepositPageResponse>({ action: 'status', token }),
  refund: (depositId: string) =>
    invokeDeposits<DepositRefundResponse>({ action: 'refund', depositId }),
};

/** Public link to a deposit's pay page; works on the web build without signing in. */
export function payUrl(token: string): string {
  const configured = process.env.EXPO_PUBLIC_WEB_URL?.replace(/\/+$/, '');
  if (configured) return `${configured}/pay/${token}`;
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return `${window.location.origin}/pay/${token}`;
  }
  return Linking.createURL(`/pay/${token}`);
}

/** "sms:" link that prefills the pay link for the client. */
export function payLinkSms(input: { url: string; salonName: string; phone?: string | null }) {
  const body = `${input.salonName}: to lock in your appointment, please pay the deposit here: ${input.url}`;
  // iOS expects `&body=` after the recipient; Android and web use `?body=`.
  const sep = Platform.OS === 'ios' ? '&' : '?';
  return `sms:${input.phone ?? ''}${sep}body=${encodeURIComponent(body)}`;
}

export function useDepositSettings(salonId: string) {
  return useQuery({
    queryKey: settingsKey(salonId),
    queryFn: () => getDepositSettings(supabase, salonId),
  });
}

export function useUpdateDepositSettings(salonId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: Partial<DepositSettings>) =>
      updateDepositSettings(supabase, salonId, changes),
    onSuccess: (data) => queryClient.setQueryData(settingsKey(salonId), data),
  });
}

export function useServiceDeposit(serviceId: string | null) {
  return useQuery({
    queryKey: serviceKey(serviceId ?? 'new'),
    queryFn: () => getServiceDeposit(supabase, serviceId!),
    enabled: !!serviceId,
  });
}

export function useUpdateServiceDeposit(serviceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: ServiceDepositFields) =>
      updateServiceDeposit(supabase, serviceId, changes),
    onSuccess: (data) => queryClient.setQueryData(serviceKey(serviceId), data),
  });
}

export function useAppointmentDeposit(appointmentId: string) {
  return useQuery({
    queryKey: depositKey(appointmentId),
    queryFn: () => getAppointmentDeposit(supabase, appointmentId),
  });
}

export function usePayToken(appointmentId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...depositKey(appointmentId), 'token'],
    queryFn: () => getDepositPayToken(supabase, appointmentId),
    enabled,
  });
}

export function useCancellationQuote(appointmentId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...depositKey(appointmentId), 'quote'],
    queryFn: () => getCancellationQuote(supabase, appointmentId),
    enabled,
  });
}

function useInvalidateDeposit(appointmentId: string) {
  const queryClient = useQueryClient();
  const salon = useCurrentSalon();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: depositKey(appointmentId) }),
      queryClient.invalidateQueries({ queryKey: appointmentsKey(salon.id) }),
    ]);
}

export function useRefundDeposit(appointmentId: string) {
  const invalidate = useInvalidateDeposit(appointmentId);
  return useMutation({
    mutationFn: (depositId: string) => depositsApi.refund(depositId),
    onSettled: invalidate,
  });
}

/**
 * Cancels by the policy (or the salon's override), then refunds a `refund_due` deposit right
 * away. If the refund can't go through (e.g. Stripe isn't set up) the deposit stays `refund_due`
 * and the sheet offers the refund again.
 */
export function useCancelWithPolicy(appointmentId: string) {
  const invalidate = useInvalidateDeposit(appointmentId);
  return useMutation({
    mutationFn: async (deposit?: 'refund' | 'keep') => {
      const result = await cancelAppointmentWithPolicy(supabase, appointmentId, { deposit });
      let refundError: string | null = null;
      if (result.deposit?.status === 'refund_due') {
        try {
          await depositsApi.refund(result.deposit.id);
        } catch (e) {
          refundError = e instanceof Error ? e.message : String(e);
        }
      }
      return { ...result, refundError };
    },
    onSettled: invalidate,
  });
}
