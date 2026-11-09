import type { BookingSegment, ExistingAppointment } from '@chairside/core';
import type { AppointmentServiceSnapshot, ServiceMenu } from '@chairside/db';

import type { BookingItem, SalonSchedule, SlotDay } from '../assistant/types.ts';

/** What `public_booking_page` exposes about a salon: branding and booking-page text only. */
export interface PublicSalonPage {
  salonId: string;
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  enabled: boolean;
  intro: string | null;
  faq: string | null;
  /** Auto mode: Open-hours bookings confirm straight away; otherwise they're requests. */
  autoConfirm: boolean;
}

/** A menu item a client may book online (services and combos marked "bookable online"). */
export interface PublicService {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  priceCents: number | null;
  /** Client time from the engine, without variants. */
  minutes: number;
  combo: boolean;
  /** The stylist reviews these before they're confirmed. */
  consultationRequired: boolean;
  newClientsOnly: boolean;
  variants: { id: string; name: string; minutes: number }[];
}

export interface PublicVerifiedUser {
  id: string;
  email: string;
}

export interface PublicBookingInput {
  name: string;
  phone: string;
  segments: BookingSegment[];
  services: AppointmentServiceSnapshot[];
  priceCents: number | null;
  notes: string | null;
  requiresApproval: boolean;
}

export type PublicBookResult =
  | {
      ok: true;
      appointmentId: string;
      status: 'confirmed' | 'requested';
      startsAt: string;
      endsAt: string;
      clientId: string;
      clientCreated: boolean;
      clientLinked: boolean;
    }
  | { ok: false; reason: 'disabled' | 'limit' | 'conflict' };

/** One of the verified client's own upcoming bookings. */
export interface PublicClientBooking {
  id: string;
  status: 'held' | 'requested' | 'confirmed';
  startsAt: string;
  endsAt: string;
  services: string;
}

/**
 * Data access for the public booking page. Backed by a service-role client, so every method takes
 * the salon or user explicitly and returns only what a stranger on the page may see: the menu,
 * work hours and busy time (never who is booked), plus the verified caller's own bookings.
 */
export interface PublicBookingPort {
  getPage(slug: string): Promise<PublicSalonPage | null>;
  getSchedule(salonId: string, range: { from: string; to: string }): Promise<SalonSchedule>;
  getMenu(salonId: string): Promise<ServiceMenu>;
  /** Blocking time on the calendar overlapping `[from, to)`: ids and segments only. */
  listBusy(salonId: string, range: { from: string; to: string }): Promise<ExistingAppointment[]>;
  /** Counts one hit; false once `key` is over `limit` in the current window. */
  hitRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean>;
  /** Emails a sign-in code (creates the account on first use). */
  sendCode(email: string): Promise<void>;
  /** The account behind a client access token, only if its email is verified. */
  getVerifiedUser(accessToken: string): Promise<PublicVerifiedUser | null>;
  book(salonId: string, userId: string, booking: PublicBookingInput): Promise<PublicBookResult>;
  myBookings(salonId: string, userId: string): Promise<PublicClientBooking[]>;
}

export interface PublicSlotsCard {
  type: 'slots';
  items: BookingItem[];
  serviceSummary: string;
  requestedDate: string;
  /** Why the requested day has nothing (closed / full), if it doesn't. */
  requestedNote: string | null;
  days: SlotDay[];
}

/** Structured output the booking page renders next to the concierge's text. */
export type ConciergeCard = PublicSlotsCard;
