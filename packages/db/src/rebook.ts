import type { BookingSegment } from '@chairside/core';

import type { AppointmentServiceSnapshot } from './appointments.ts';
import type { Json } from './database.types.ts';
import type { Appointment, ChairsideClient } from './index.ts';

/** Rebook at checkout (#42): service intervals, booking the next visit, and the rebook rate. */

/** `services.rebook_interval_days` for the salon's services (null = the typical interval). */
export async function listServiceRebookIntervals(
  client: ChairsideClient,
  salonId: string,
): Promise<Map<string, number | null>> {
  const { data, error } = await client
    .from('services')
    .select('id, rebook_interval_days')
    .eq('salon_id', salonId);
  if (error) throw error;
  return new Map(data.map((s) => [s.id, s.rebook_interval_days]));
}

/** Sets how often clients usually come back for a service (owners; RLS). Null = automatic. */
export async function setServiceRebookInterval(
  client: ChairsideClient,
  serviceId: string,
  days: number | null,
): Promise<void> {
  const { error } = await client
    .from('services')
    .update({ rebook_interval_days: days })
    .eq('id', serviceId);
  if (error) throw error;
}

export interface CheckoutRebook {
  rebookAppointmentId: string | null;
  rebookDeclinedAt: string | null;
}

export async function getCheckoutRebook(
  client: ChairsideClient,
  checkoutId: string,
): Promise<CheckoutRebook> {
  const { data, error } = await client
    .from('checkouts')
    .select('rebook_appointment_id, rebook_declined_at')
    .eq('id', checkoutId)
    .single();
  if (error) throw error;
  return {
    rebookAppointmentId: data.rebook_appointment_id,
    rebookDeclinedAt: data.rebook_declined_at,
  };
}

export interface RebookFromCheckoutInput {
  checkoutId: string;
  /** From `suggestRebookSlots(...)` / `planBooking(...)`, including buffers. */
  segments: readonly BookingSegment[];
  services?: readonly AppointmentServiceSnapshot[];
  /** Default `confirmed`; `held` expires after `settings.hold_expiry_hours`. */
  status?: 'held' | 'confirmed';
  priceCents?: number | null;
}

/**
 * Books the paid checkout's client in again with the same stylist (`rebook_from_checkout`).
 * Overlapping busy time fails with code `23P01` (see `isBookingConflictError`).
 */
export async function rebookFromCheckout(
  client: ChairsideClient,
  input: RebookFromCheckoutInput,
): Promise<Appointment> {
  const { data, error } = await client.rpc('rebook_from_checkout', {
    p_checkout_id: input.checkoutId,
    p_segments: input.segments as unknown as Json,
    p_services: (input.services ?? []) as unknown as Json,
    p_status: input.status ?? 'confirmed',
    ...(input.priceCents != null ? { p_price_cents: input.priceCents } : {}),
  });
  if (error) throw error;
  return data;
}

/** "Not now": records the skip so the prompt isn't shown again for this checkout. */
export async function skipRebook(client: ChairsideClient, checkoutId: string): Promise<void> {
  const { error } = await client.rpc('skip_rebook', { p_checkout_id: checkoutId });
  if (error) throw error;
}

export interface RebookStats {
  /** Salon-local dates, inclusive. */
  from: string;
  to: string;
  /** Paid checkouts with a client. */
  checkouts: number;
  rebooked: number;
  declined: number;
  /** rebooked / checkouts (0–1); null with no checkouts. */
  rate: number | null;
}

/** The rebook rate over a date range (default: the last 30 days). */
export async function getRebookStats(
  client: ChairsideClient,
  salonId: string,
  range: { from?: string; to?: string } = {},
): Promise<RebookStats> {
  const { data, error } = await client.rpc('rebook_stats', {
    p_salon_id: salonId,
    ...(range.from ? { p_from: range.from } : {}),
    ...(range.to ? { p_to: range.to } : {}),
  });
  if (error) throw error;
  return data as unknown as RebookStats;
}
