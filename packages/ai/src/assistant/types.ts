import type {
  BookingRules,
  BookingSegment,
  ClientServiceOverride,
  WorkHours,
} from '@chairside/core';
import type {
  AppointmentServiceSnapshot,
  AppointmentStatus,
  AppointmentWithDetails,
  ServiceMenu,
} from '@chairside/db';

/** One picked menu item: a service (optionally with a variant) or a combo. */
export interface BookingItem {
  serviceId: string;
  variantId?: string | null;
}

export interface AssistantClient {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
}

export interface ClientVisit {
  startsAt: string;
  status: AppointmentStatus;
  services: AppointmentServiceSnapshot[];
}

export interface SalonSchedule {
  salonName: string;
  hours: WorkHours;
  rules: BookingRules;
  holdExpiryHours: number;
}

/**
 * Everything the assistant's tools read or write. In production this is backed by a user-scoped
 * Supabase client, so RLS limits every call to the caller's salon; tests use an in-memory fake.
 */
export interface AssistantPort {
  getSchedule(range: { from: string; to: string }): Promise<SalonSchedule>;
  getMenu(): Promise<ServiceMenu>;
  listClients(): Promise<AssistantClient[]>;
  getClient(id: string): Promise<AssistantClient | null>;
  /** Most recent first. */
  clientVisits(clientId: string, limit: number): Promise<ClientVisit[]>;
  /** Per-service duration overrides ("Karina's color +20m"), applied to every booking. */
  clientOverrides(clientId: string): Promise<ClientServiceOverride[]>;
  /** Attaches a note or color formula the owner pasted to the client's profile. */
  addClientNote(input: {
    clientId: string;
    kind: 'note' | 'formula';
    text: string;
  }): Promise<{ id: string }>;
  /** Active appointments overlapping `[from, to)` (ISO). */
  listAppointments(range: { from: string; to: string }): Promise<AppointmentWithDetails[]>;
  getAppointment(id: string): Promise<AppointmentWithDetails | null>;
  bookHeld(input: {
    clientId: string;
    segments: BookingSegment[];
    services: AppointmentServiceSnapshot[];
    priceCents: number | null;
    notes: string;
  }): Promise<{ id: string; holdExpiresAt: string | null }>;
  setStatus(id: string, status: 'confirmed' | 'cancelled', reason?: string): Promise<void>;
  createClient(input: { name: string; phone?: string | null }): Promise<AssistantClient>;
  audit(action: string, details: Record<string, unknown>): Promise<void>;
}

export interface SlotOption {
  /** Client start, ISO UTC. Pass back to `propose_booking` unchanged. */
  start: string;
  end: string;
  /** e.g. "1:30 PM" in the salon's time zone. */
  time: string;
  requiresApproval: boolean;
}

export interface SlotDay {
  date: string;
  /** e.g. "Fri, Dec 18". */
  label: string;
  dayOffset: number;
  slots: SlotOption[];
}

export interface SlotsCard {
  type: 'slots';
  client: { id: string; name: string } | null;
  items: BookingItem[];
  serviceSummary: string;
  requestedDate: string;
  days: SlotDay[];
}

export interface DraftCard {
  type: 'draft';
  appointmentId: string;
  client: { id: string; name: string };
  items: BookingItem[];
  start: string;
  end: string;
  /** e.g. "Fri, Dec 18 · 1:30 PM". */
  label: string;
  serviceSummary: string;
  status: 'held' | 'confirmed' | 'cancelled';
  holdExpiresAt: string | null;
  requiresApproval: boolean;
}

export interface ClientNotFoundCard {
  type: 'client_not_found';
  query: string;
  /** Close-but-not-confident matches. */
  suggestions: { id: string; name: string }[];
}

/**
 * "I'm running 15 late": a preview of the cascade. Nothing moves until the owner opens the
 * Running late sheet from the card, reviews the texts and taps Update.
 */
export interface RunningLateCard {
  type: 'running_late';
  delayMinutes: number;
  /** Squeeze plan from `planRunningLate`; the sheet recomputes and offers the other options. */
  moves: { appointmentId: string; clientName: string; from: string; to: string; label: string }[];
  /** Clients the delay doesn't reach. */
  unchangedCount: number;
  overtimeMinutes: number;
}

/** Structured output the app renders next to the assistant's text. */
export type AssistantCard = SlotsCard | DraftCard | ClientNotFoundCard | RunningLateCard;
