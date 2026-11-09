import {
  getNotificationSettings,
  type NotificationSettings,
  updateNotificationSettings,
} from '@chairside/db';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Href, router } from 'expo-router';
import { useEffect } from 'react';

import { supabase } from '@/lib/supabase';

import { onNotificationEvent, pushSupported, registerForPush } from './push';

const settingsKey = (salonId: string) => ['notification-settings', salonId] as const;
const pushStatusKey = (salonId: string) => ['push-status', salonId] as const;

export function useNotificationSettings(salonId: string) {
  return useQuery({
    queryKey: settingsKey(salonId),
    queryFn: () => getNotificationSettings(supabase, salonId),
  });
}

export function useUpdateNotificationSettings(salonId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: Partial<NotificationSettings>) =>
      updateNotificationSettings(supabase, salonId, changes),
    onSuccess: (data) => {
      queryClient.setQueryData(settingsKey(salonId), data);
      // Hold expiry is also shown in Work hours → Booking rules.
      void queryClient.invalidateQueries({ queryKey: ['work-hours', salonId] });
    },
  });
}

/** This device's push registration (asks for permission when `ask`). */
export function usePushStatus(salonId: string) {
  return useQuery({
    queryKey: pushStatusKey(salonId),
    queryFn: () => registerForPush(salonId, false),
    enabled: pushSupported,
    staleTime: Infinity,
  });
}

export function useEnablePush(salonId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => registerForPush(salonId, true),
    onSuccess: (status) => queryClient.setQueryData(pushStatusKey(salonId), status),
  });
}

/**
 * Root-level wiring once signed in with a salon: registers this device's push token and reacts to
 * notification actions (refresh after Approve/Decline/Ignore, navigate for Other time/Respond).
 */
export function usePushNotifications(salonId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!pushSupported || !salonId) return;
    let cancelled = false;
    void registerForPush(salonId).then((status) => {
      if (!cancelled) queryClient.setQueryData(pushStatusKey(salonId), status);
    });
    return () => {
      cancelled = true;
    };
  }, [salonId, queryClient]);

  useEffect(() => {
    if (!pushSupported || !salonId) return;
    return onNotificationEvent((event) => {
      void queryClient.invalidateQueries({ queryKey: ['appointments', salonId] });
      // Defer so the navigator has mounted when launched from a notification.
      if (event.kind === 'open') setTimeout(() => router.push(event.href as Href), 0);
    });
  }, [salonId, queryClient]);
}
