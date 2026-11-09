import type { ChairsideClient } from '@chairside/db';
import { listAppointments } from '@chairside/db/appointments';
import {
  cancelBookingByToken,
  getManageBooking,
  rescheduleBookingByToken,
} from '@chairside/db/client-self-service';

import { createSupabaseAssistantPort } from '../assistant/supabase-port.ts';
import type { ManageBookingPort } from './types.ts';

/** `service` must be a service-role client: the manage-link RPCs refuse anything else. */
export function createSupabaseManageBookingPort(service: ChairsideClient): ManageBookingPort {
  return {
    getBooking: (token) => getManageBooking(service, token),

    getSchedule: (salonId, range) =>
      createSupabaseAssistantPort(service, salonId).getSchedule(range),

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

    cancel: (token) => cancelBookingByToken(service, token),

    reschedule: (token, segments) => rescheduleBookingByToken(service, token, segments),
  };
}
