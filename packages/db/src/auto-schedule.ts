import type { BookingSegment } from '@chairside/core';

import type { AppointmentServiceSnapshot } from './appointments.ts';
import type { Json } from './database.types.ts';
import type { Appointment, ChairsideClient } from './index.ts';

/** Auto-Schedule (#84): book / move a captured request's appointment at the picked slot. */

export interface ScheduleCapturedRequestInput {
  requestId: string;
  /** From the suggestion the stylist picked (engine output, including buffers). */
  segments: readonly BookingSegment[];
  services?: readonly AppointmentServiceSnapshot[] | null;
  priceCents?: number | null;
}

/**
 * Bookings: moves the request's held slot (or books a new inbox appointment) and confirms it.
 * Reschedules: moves the client's existing appointment in place and releases the held slot.
 * Either way the request is approved (deposits and opted-in auto-replies follow the usual
 * triggers). Overlapping busy time fails with `23P01` (see `isBookingConflictError`).
 */
export async function scheduleCapturedRequest(
  client: ChairsideClient,
  input: ScheduleCapturedRequestInput,
): Promise<Appointment> {
  const { data, error } = await client.rpc('schedule_captured_request', {
    p_request_id: input.requestId,
    p_segments: input.segments as unknown as Json,
    ...(input.services ? { p_services: input.services as unknown as Json } : {}),
    ...(input.priceCents != null ? { p_price_cents: input.priceCents } : {}),
  });
  if (error) throw error;
  return data;
}
