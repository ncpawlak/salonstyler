import { listAppointments, type ChairsideClient, type Json } from '@chairside/db';

import { createSupabaseAssistantPort } from '../assistant/supabase-port.ts';
import type {
  PublicBookResult,
  PublicBookingPort,
  PublicClientBooking,
  PublicSalonPage,
} from './types.ts';

/**
 * The public booking page's data access. `service` must be a service-role client (the RPCs refuse
 * anything else); `auth` is an anon client used only to email sign-in codes. Every read is scoped
 * to one salon and only ever returns busy time, never who it belongs to.
 */
export function createSupabasePublicBookingPort(
  service: ChairsideClient,
  auth: ChairsideClient,
): PublicBookingPort {
  return {
    async getPage(slug) {
      const { data, error } = await service.rpc('public_booking_page', { p_slug: slug });
      if (error) throw error;
      return (data as unknown as PublicSalonPage | null) ?? null;
    },

    getSchedule: (salonId, range) =>
      createSupabaseAssistantPort(service, salonId).getSchedule(range),

    getMenu: (salonId) => createSupabaseAssistantPort(service, salonId).getMenu(),

    async listBusy(salonId, range) {
      const rows = await listAppointments(service, salonId, range);
      return rows.map((row) => ({ id: row.id, segments: row.segments }));
    },

    async hitRateLimit(key, limit, windowSeconds) {
      const { data, error } = await service.rpc('hit_rate_limit', {
        p_key: key,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      });
      if (error) throw error;
      return data;
    },

    async sendCode(email) {
      const { error } = await auth.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true },
      });
      if (error) throw error;
    },

    async getVerifiedUser(accessToken) {
      const { data, error } = await service.auth.getUser(accessToken);
      if (error || !data.user?.email || !data.user.email_confirmed_at) return null;
      return { id: data.user.id, email: data.user.email };
    },

    async book(salonId, userId, booking) {
      const { data, error } = await service.rpc('book_public_appointment', {
        p_salon_id: salonId,
        p_user_id: userId,
        p_booking: JSON.parse(JSON.stringify(booking)) as Json,
      });
      if (error) throw error;
      return data as unknown as PublicBookResult;
    },

    async myBookings(salonId, userId) {
      const { data, error } = await service.rpc('public_client_bookings', {
        p_salon_id: salonId,
        p_user_id: userId,
      });
      if (error) throw error;
      return (data as unknown as PublicClientBooking[] | null) ?? [];
    },
  };
}
