import type { ExistingAppointment } from '@chairside/core';
import type {
  CancelByTokenResult,
  ManageBookingRow,
  ManageSegment,
  RescheduleByTokenResult,
} from '@chairside/db/client-self-service';

import type { SalonSchedule } from '../assistant/types.ts';

/**
 * Data access for a client's manage link (/m/{token}). Backed by a service-role client; every
 * read is keyed by the token (or by the salon the token resolved to) and returns only that
 * appointment, the salon's hours and anonymous busy time.
 */
export interface ManageBookingPort {
  getBooking(token: string): Promise<ManageBookingRow | null>;
  getSchedule(salonId: string, range: { from: string; to: string }): Promise<SalonSchedule>;
  /** Blocking time on the calendar overlapping `[from, to)`: ids and segments only. */
  listBusy(salonId: string, range: { from: string; to: string }): Promise<ExistingAppointment[]>;
  /** Counts one hit; false once `key` is over `limit` in the current window. */
  hitRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean>;
  cancel(token: string): Promise<CancelByTokenResult>;
  reschedule(token: string, segments: ManageSegment[]): Promise<RescheduleByTokenResult>;
}
