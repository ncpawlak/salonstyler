import {
  type BookingPageSettings,
  getBookingPageSettings,
  updateBookingPageSettings,
} from '@chairside/db';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';

const key = (salonId: string) => ['booking-page-settings', salonId] as const;

export function useBookingPageSettings(salonId: string) {
  return useQuery({
    queryKey: key(salonId),
    queryFn: () => getBookingPageSettings(supabase, salonId),
  });
}

export function useUpdateBookingPageSettings(salonId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: Partial<BookingPageSettings>) =>
      updateBookingPageSettings(supabase, salonId, changes),
    onSuccess: (data) => queryClient.setQueryData(key(salonId), data),
  });
}

/** Public link to the salon's booking page; works on the web build without signing in. */
export function bookingPageUrl(slug: string): string {
  const configured = process.env.EXPO_PUBLIC_WEB_URL?.replace(/\/+$/, '');
  if (configured) return `${configured}/b/${slug}`;
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return `${window.location.origin}/b/${slug}`;
  }
  return Linking.createURL(`/b/${slug}`);
}
