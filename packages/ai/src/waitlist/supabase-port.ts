import type { ChairsideClient } from '@chairside/db';
import { listAppointments } from '@chairside/db/appointments';
import {
  acceptWaitlistOffer,
  claimWaitlistOpenings,
  getWaitlistLink,
  joinWaitlist,
  leaveWaitlistByToken,
  saveWaitlistOffers,
  sendWaitlistOffer,
  type SentWaitlistOffer,
} from '@chairside/db/waitlist';

import { createSupabaseAssistantPort } from '../assistant/supabase-port.ts';
import type { PublicSalonPage } from '../public-booking/types.ts';
import { MAX_ACTIVE_WAITLIST_ENTRIES } from './handler.ts';
import type { WaitlistPort } from './types.ts';

/**
 * `service` must be a service-role client: the waitlist RPCs refuse anything else. Offer emails
 * are sent by `sendOfferEmail` (the Edge Function wires its transport in; null without one).
 */
export function createSupabaseWaitlistPort(
  service: ChairsideClient,
  sendOfferEmail: ((offer: SentWaitlistOffer) => Promise<void>) | null,
): WaitlistPort {
  return {
    claimOpenings: (salonId) => claimWaitlistOpenings(service, salonId),

    saveOffers: (openingId, offers) => saveWaitlistOffers(service, openingId, offers),

    getSchedule: (salonId, range) =>
      createSupabaseAssistantPort(service, salonId).getSchedule(range),

    getMenu: (salonId) => createSupabaseAssistantPort(service, salonId).getMenu(),

    clientOverrides: (salonId, clientId) =>
      createSupabaseAssistantPort(service, salonId).clientOverrides(clientId),

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

    async getPage(slug) {
      const { data, error } = await service.rpc('public_booking_page', { p_slug: slug });
      if (error) throw error;
      return (data as unknown as PublicSalonPage | null) ?? null;
    },

    async getVerifiedUser(accessToken) {
      const { data, error } = await service.auth.getUser(accessToken);
      if (error || !data.user?.email || !data.user.email_confirmed_at) return null;
      return { id: data.user.id, email: data.user.email };
    },

    join: (salonId, userId, entry) =>
      joinWaitlist(service, salonId, userId, entry, MAX_ACTIVE_WAITLIST_ENTRIES),

    getLink: (token) => getWaitlistLink(service, token),

    leave: (token) => leaveWaitlistByToken(service, token),

    accept: (token, offerId, segments) => acceptWaitlistOffer(service, token, offerId, segments),

    async memberUserId(accessToken, salonId) {
      const { data, error } = await service.auth.getUser(accessToken);
      if (error || !data.user) return null;
      const { data: member, error: memberError } = await service
        .from('salon_members')
        .select('user_id')
        .eq('salon_id', salonId)
        .eq('user_id', data.user.id)
        .maybeSingle();
      if (memberError) throw memberError;
      return member ? data.user.id : null;
    },

    async offerSalonId(offerId) {
      const { data, error } = await service
        .from('waitlist_offers')
        .select('salon_id')
        .eq('id', offerId)
        .maybeSingle();
      if (error) throw error;
      return data?.salon_id ?? null;
    },

    sendOffer: (offerId, via) => sendWaitlistOffer(service, offerId, via),

    sendOfferEmail,
  };
}
