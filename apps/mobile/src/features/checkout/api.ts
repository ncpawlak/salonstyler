import type {
  CheckoutPaidResponse,
  CheckoutRequest,
  ConnectionTokenResponse,
  CreateIntentResponse,
  RefundResponse,
} from '@chairside/payments';
import {
  payCheckoutOffline,
  startCheckout,
  updateCheckout,
  type ChairsideClient,
  type CheckoutItemInput,
  type CheckoutWithItems,
} from '@chairside/db';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';

import { PaymentsRequestError, readFunctionError } from '@/features/payments/api';
import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

type CheckoutAction = CheckoutRequest['action'];
export type CheckoutResponse<A extends CheckoutAction> = A extends 'connection_token'
  ? ConnectionTokenResponse
  : A extends 'create_intent'
    ? CreateIntentResponse | CheckoutPaidResponse
    : A extends 'refund'
      ? RefundResponse
      : CheckoutPaidResponse;

/** Calls the `checkout` Edge Function, which holds the Stripe secret key server-side. */
export async function invokeCheckout<R extends CheckoutRequest>(
  client: ChairsideClient,
  request: R,
): Promise<CheckoutResponse<R['action']>> {
  const { data, error } = await client.functions.invoke<CheckoutResponse<R['action']>>('checkout', {
    body: request,
  });
  if (error) throw await readFunctionError(error);
  if (!data) throw new PaymentsRequestError('invalid_response', 'Empty response from checkout');
  return data;
}

/** Edge Function errors and the checkout RPCs' exceptions are both written for people. */
export function checkoutErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return 'Something went wrong. Try again.';
}

export const checkoutKey = (appointmentId: string) => ['checkout', appointmentId] as const;

/** The appointment's checkout, drafted from its services on first open. */
export function useCheckout(appointmentId: string) {
  return useQuery({
    queryKey: checkoutKey(appointmentId),
    queryFn: () => startCheckout(supabase, appointmentId),
    staleTime: Infinity,
    retry: false,
  });
}

/** Refreshes everything a payment changes: the appointment status, payouts and lists. */
export function useInvalidateAfterPayment() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['appointments', salon.id] }),
      queryClient.invalidateQueries({ queryKey: ['payout-summary', salon.id] }),
      queryClient.invalidateQueries({ queryKey: ['paid-checkouts', salon.id] }),
      queryClient.invalidateQueries({ queryKey: ['payments', salon.id] }),
    ]);
}

export function useSaveCheckout(appointmentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { checkoutId: string; items: CheckoutItemInput[]; tipCents: number }) =>
      updateCheckout(supabase, input.checkoutId, input.items, input.tipCents),
    onSuccess: (checkout) => queryClient.setQueryData(checkoutKey(appointmentId), checkout),
  });
}

export function usePayOffline(appointmentId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateAfterPayment();
  return useMutation({
    mutationFn: (input: { checkoutId: string; method: 'cash' | 'other' }) =>
      payCheckoutOffline(supabase, input.checkoutId, input.method),
    onSuccess: (paid) => {
      queryClient.setQueryData<CheckoutWithItems>(checkoutKey(appointmentId), (prev) =>
        prev ? { ...prev, ...paid } : prev,
      );
      void invalidate();
    },
  });
}

/** Public link to the receipt page; works on the web build without signing in. */
export function receiptUrl(token: string): string {
  const configured = process.env.EXPO_PUBLIC_WEB_URL?.replace(/\/+$/, '');
  if (configured) return `${configured}/receipt/${token}`;
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return `${window.location.origin}/receipt/${token}`;
  }
  return Linking.createURL(`/receipt/${token}`);
}

/** "sms:" / "mailto:" links that prefill the receipt link for the client. */
export function receiptShareLinks(input: {
  url: string;
  salonName: string;
  phone?: string | null;
  email?: string | null;
}) {
  const body = `Thanks for visiting ${input.salonName}! Your receipt: ${input.url}`;
  // iOS expects `&body=` after the recipient; Android and web use `?body=`.
  const sep = Platform.OS === 'ios' ? '&' : '?';
  return {
    sms: `sms:${input.phone ?? ''}${sep}body=${encodeURIComponent(body)}`,
    email: `mailto:${input.email ?? ''}?subject=${encodeURIComponent(
      `Your receipt from ${input.salonName}`,
    )}&body=${encodeURIComponent(body)}`,
  };
}
