import {
  type AppointmentWithDetails,
  type CapturedRequestWithDetails,
  getInboxBridge,
  listCapturedRequests,
  removeInboxBridge,
  resolveCapturedRequest,
  rotateInboxBridgeToken,
  setAppointmentStatus,
  updateInboxBridgeSettings,
  updateInboxKeyword,
} from '@chairside/db';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

import { pendingRequestsKey, usePendingRequests } from '../today/api';
import { mergeInbox } from './merge';

export type { InboxItem } from './merge';

// Under the `['appointments', salonId]` prefix: approving/declining a hold changes the request too.
export const capturedRequestsKey = (salonId: string) =>
  ['appointments', salonId, 'captured'] as const;

/** Everything awaiting a decision; also drives the Inbox tab badge. */
export function useInbox() {
  const salon = useCurrentSalon();
  const captured = useQuery({
    queryKey: capturedRequestsKey(salon.id),
    queryFn: () => listCapturedRequests(supabase, salon.id),
    refetchInterval: 60_000,
  });
  const requested = usePendingRequests();
  return {
    items: captured.data && requested.data ? mergeInbox(captured.data, requested.data) : undefined,
    isPending: captured.isPending || requested.isPending,
    error: captured.error ?? requested.error,
    refetch: () => Promise.all([captured.refetch(), requested.refetch()]),
  };
}

/**
 * Approve (confirm) or decline the held slot. The card leaves the Inbox at once and comes back if
 * the server refuses; the request itself follows the appointment via a database trigger.
 */
export function useDecideRequest() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  const capturedKey = capturedRequestsKey(salon.id);
  const pendingKey = pendingRequestsKey(salon.id);
  return useMutation({
    mutationFn: ({ appointmentId, approve }: { appointmentId: string; approve: boolean }) =>
      setAppointmentStatus(
        supabase,
        appointmentId,
        approve ? 'confirmed' : 'cancelled',
        approve ? undefined : 'Declined by stylist',
      ),
    onMutate: async ({ appointmentId }) => {
      await queryClient.cancelQueries({ queryKey: ['appointments', salon.id] });
      const captured = queryClient.getQueryData<CapturedRequestWithDetails[]>(capturedKey);
      const pending = queryClient.getQueryData<AppointmentWithDetails[]>(pendingKey);
      queryClient.setQueryData<CapturedRequestWithDetails[]>(capturedKey, (list) =>
        list?.filter((r) => r.appointment_id !== appointmentId),
      );
      queryClient.setQueryData<AppointmentWithDetails[]>(pendingKey, (list) =>
        list?.filter((a) => a.id !== appointmentId),
      );
      return { captured, pending };
    },
    onError: (_error, _vars, context) => {
      if (context?.captured) queryClient.setQueryData(capturedKey, context.captured);
      if (context?.pending) queryClient.setQueryData(pendingKey, context.pending);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['appointments', salon.id] }),
  });
}

/** Dismiss a request (releasing any hold) or carry out a client's cancel request. */
export function useResolveCapturedRequest() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  const key = capturedRequestsKey(salon.id);
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'dismiss' | 'cancel_appointment' }) =>
      resolveCapturedRequest(supabase, id, action),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<CapturedRequestWithDetails[]>(key);
      queryClient.setQueryData<CapturedRequestWithDetails[]>(key, (list) =>
        list?.filter((r) => r.id !== id),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['appointments', salon.id] }),
  });
}

const bridgeKey = (salonId: string) => ['inbox-bridge', salonId] as const;

/** `pollMs` re-reads the bridge while setup waits for the Shortcut's test message. */
export function useInboxBridge(options: { pollMs?: number } = {}) {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: bridgeKey(salon.id),
    queryFn: () => getInboxBridge(supabase, salon.id),
    refetchInterval: options.pollMs ?? false,
  });
}

export function useUpdateBridgeSettings() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: { autoReply?: boolean; phone?: string | null }) =>
      updateInboxBridgeSettings(supabase, salon.id, settings),
    onSettled: () => queryClient.invalidateQueries({ queryKey: bridgeKey(salon.id) }),
  });
}

/** Rotate (or create) the bridge token; the plain token is only ever returned here. */
export function useRotateBridgeToken() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => rotateInboxBridgeToken(supabase, salon.id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: bridgeKey(salon.id) }),
  });
}

export function useUpdateBridgeKeyword() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keyword: string) => updateInboxKeyword(supabase, salon.id, keyword),
    onSettled: () => queryClient.invalidateQueries({ queryKey: bridgeKey(salon.id) }),
  });
}

export function useRemoveBridge() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => removeInboxBridge(supabase, salon.id),
    onSuccess: () => queryClient.setQueryData(bridgeKey(salon.id), null),
  });
}

/** The URL the iOS Shortcut posts to. */
export const inboxEndpoint = () =>
  `${(process.env.EXPO_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, '')}/functions/v1/inbox`;

/**
 * The published "Add to Shortcuts" link (iCloud or a hosted signed .shortcut). Unset: setup shows
 * the build-it-yourself recipe instead. See docs/shortcut-bridge.md.
 */
export const shortcutInstallUrl = () => process.env.EXPO_PUBLIC_BRIDGE_SHORTCUT_URL?.trim() || null;
