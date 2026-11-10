import type { ChairsideClient, Enums, Json, SalonSettings, Tables } from './index.ts';

/**
 * Waitlist auto-fill (#21). Clients wait for a day (optionally a time window); when an
 * appointment on that day is cancelled, the `waitlist` Edge Function runs the scheduling engine
 * on the waiting clients' services and drafts offers for the ones that fit the freed time. The
 * stylist sends them (or turns on auto-offer), and the first client to accept on /w/{token} gets
 * the slot. Members read the tables; every change goes through an RPC.
 */

export type WaitlistEntryRow = Tables<'waitlist_entries'>;
export type WaitlistOpeningRow = Tables<'waitlist_openings'>;
export type WaitlistOfferRow = Tables<'waitlist_offers'>;
export type WaitlistEntryStatus = Enums<'waitlist_entry_status'>;
export type WaitlistOfferStatus = Enums<'waitlist_offer_status'>;

/** One picked menu item, as on the booking sheet and the public booking page. */
export interface WaitlistItem {
  serviceId: string;
  variantId?: string | null;
}

export interface WaitlistSegment {
  kind: Enums<'appointment_segment_kind'>;
  label: string | null;
  start: string;
  end: string;
}

// --- Settings --------------------------------------------------------------------------------

/** Settings → Waitlist. */
export type WaitlistSettings = Pick<
  SalonSettings,
  'waitlist_enabled' | 'waitlist_auto_offer' | 'waitlist_offer_minutes'
>;

const SETTINGS_COLUMNS = 'waitlist_enabled, waitlist_auto_offer, waitlist_offer_minutes';

/** How long a sent offer stays open, in minutes (the database allows 15-1440). */
export const OFFER_MINUTE_OPTIONS = [30, 60, 120, 240, 720] as const;

export async function getWaitlistSettings(
  client: ChairsideClient,
  salonId: string,
): Promise<WaitlistSettings> {
  const { data, error } = await client
    .from('settings')
    .select(SETTINGS_COLUMNS)
    .eq('salon_id', salonId)
    .single();
  if (error) throw error;
  return data;
}

/** Owners only (RLS). */
export async function updateWaitlistSettings(
  client: ChairsideClient,
  salonId: string,
  changes: Partial<WaitlistSettings>,
): Promise<WaitlistSettings> {
  const { data, error } = await client
    .from('settings')
    .update(changes)
    .eq('salon_id', salonId)
    .select(SETTINGS_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

// --- The stylist's waitlist ------------------------------------------------------------------

export interface WaitlistOffer {
  id: string;
  openingId: string;
  status: WaitlistOfferStatus;
  startsAt: string;
  endsAt: string;
  priceCents: number | null;
  sentVia: 'email' | 'text' | null;
  sentAt: string | null;
  expiresAt: string | null;
}

export interface WaitlistEntry {
  id: string;
  clientId: string;
  clientName: string;
  clientPhone: string | null;
  clientEmail: string | null;
  status: WaitlistEntryStatus;
  /** Local `YYYY-MM-DD`. */
  day: string;
  /** Local `HH:MM:SS`, both or neither. */
  windowStart: string | null;
  windowEnd: string | null;
  items: WaitlistItem[];
  servicesLabel: string;
  source: 'owner' | 'public';
  notes: string | null;
  appointmentId: string | null;
  createdAt: string;
  /** Drafts and sent offers still waiting on someone, soonest first. */
  offers: WaitlistOffer[];
}

const LIVE_ENTRY = ['waiting', 'offered'] as const;

/** Upcoming entries still waiting (or offered a slot), by day then join order. Members only. */
export async function listWaitlist(
  client: ChairsideClient,
  salonId: string,
  fromDay: string,
): Promise<WaitlistEntry[]> {
  const { data, error } = await client
    .from('waitlist_entries')
    .select(
      `id, client_id, status, day, window_start, window_end, items, services_label, source, notes,
       appointment_id, created_at,
       client:clients!waitlist_entries_client_id_fkey ( name, phone, email ),
       offers:waitlist_offers ( id, opening_id, status, starts_at, ends_at, price_cents, sent_via,
                                sent_at, expires_at )`,
    )
    .eq('salon_id', salonId)
    .gte('day', fromDay)
    .in('status', [...LIVE_ENTRY])
    .order('day')
    .order('created_at');
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    clientId: row.client_id,
    clientName: row.client?.name ?? 'Client',
    clientPhone: row.client?.phone ?? null,
    clientEmail: row.client?.email ?? null,
    status: row.status,
    day: row.day,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    items: row.items as unknown as WaitlistItem[],
    servicesLabel: row.services_label,
    source: row.source as 'owner' | 'public',
    notes: row.notes,
    appointmentId: row.appointment_id,
    createdAt: row.created_at,
    offers: (row.offers ?? [])
      .filter((o) => o.status === 'draft' || o.status === 'sent')
      .map((o) => ({
        id: o.id,
        openingId: o.opening_id,
        status: o.status,
        startsAt: o.starts_at,
        endsAt: o.ends_at,
        priceCents: o.price_cents,
        sentVia: o.sent_via as 'email' | 'text' | null,
        sentAt: o.sent_at,
        expiresAt: o.expires_at,
      }))
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)),
  }));
}

export interface AddWaitlistEntryInput {
  clientId: string;
  items: WaitlistItem[];
  servicesLabel: string;
  /** Local `YYYY-MM-DD`. */
  day: string;
  /** Local `HH:MM`; both or neither. */
  windowStart?: string | null;
  windowEnd?: string | null;
  notes?: string | null;
}

/** Adds the client for that day, or updates their entry if they're already waiting for it. */
export async function addWaitlistEntry(
  client: ChairsideClient,
  salonId: string,
  input: AddWaitlistEntryInput,
): Promise<WaitlistEntryRow> {
  const { data, error } = await client.rpc('add_waitlist_entry', {
    p_salon_id: salonId,
    p_client_id: input.clientId,
    p_items: input.items as unknown as Json,
    p_services_label: input.servicesLabel,
    p_day: input.day,
    ...(input.windowStart ? { p_window_start: input.windowStart } : {}),
    ...(input.windowEnd ? { p_window_end: input.windowEnd } : {}),
    ...(input.notes ? { p_notes: input.notes } : {}),
  });
  if (error) throw error;
  return data as unknown as WaitlistEntryRow;
}

export async function removeWaitlistEntry(client: ChairsideClient, entryId: string) {
  const { error } = await client.rpc('remove_waitlist_entry', { p_entry_id: entryId });
  if (error) throw error;
}

/** What sending an offer returns: everything a text or an email needs. */
export type SentWaitlistOffer = {
  ok: true;
  offerId: string;
  token: string;
  clientName: string;
  email: string | null;
  phone: string | null;
  salonName: string;
  timezone: string;
  startsAt: string;
  endsAt: string;
  servicesLabel: string;
  expiresAt: string;
};

export type SendWaitlistOfferResult =
  | SentWaitlistOffer
  | { ok: false; reason: 'not_found' | 'unavailable' | 'no_email'; message?: string };

/**
 * Marks a drafted offer sent and starts its expiry. Via 'text' the stylist texts the returned
 * link himself; email offers go through the `waitlist` function (`send_offer`), which calls this
 * and emails the client.
 */
export async function sendWaitlistOffer(
  client: ChairsideClient,
  offerId: string,
  via: 'text' | 'email',
): Promise<SendWaitlistOfferResult> {
  const { data, error } = await client.rpc('send_waitlist_offer', {
    p_offer_id: offerId,
    p_via: via,
  });
  if (error) throw error;
  return data as unknown as SendWaitlistOfferResult;
}

export async function dismissWaitlistOffer(client: ChairsideClient, offerId: string) {
  const { error } = await client.rpc('dismiss_waitlist_offer', { p_offer_id: offerId });
  if (error) throw error;
}

/** The client's waitlist link on the web app. */
export function waitlistPath(token: string): string {
  return `/w/${encodeURIComponent(token)}`;
}

// --- The waitlist function (service role) ----------------------------------------------------

/** One pending opening and the clients waiting for its day, from `claim_waitlist_openings`. */
export interface ClaimedOpening {
  openingId: string;
  salonId: string;
  stylistId: string | null;
  startsAt: string;
  endsAt: string;
  day: string;
  timezone: string;
  enabled: boolean;
  entries: {
    entryId: string;
    clientId: string;
    items: WaitlistItem[];
    /** Local `HH:MM`. */
    windowStart: string | null;
    windowEnd: string | null;
    createdAt: string;
  }[];
}

/** An engine fit for one waiting client, for `save_waitlist_offers`. */
export interface WaitlistOfferDraft {
  entryId: string;
  startsAt: string;
  endsAt: string;
  segments: WaitlistSegment[];
  services: unknown[];
  priceCents: number | null;
}

export type SaveWaitlistOffersResult =
  { ok: true; saved: number; sent: SentWaitlistOffer[] } | { ok: false; reason: 'not_found' };

/** The entry behind a /w/{token} link, from `waitlist_by_token`. */
export interface WaitlistLinkRow {
  salonId: string;
  entry: {
    status: WaitlistEntryStatus;
    day: string;
    windowStart: string | null;
    windowEnd: string | null;
    servicesLabel: string;
    clientFirstName: string | null;
  };
  offer: {
    offerId: string;
    startsAt: string;
    endsAt: string;
    expiresAt: string;
    items: WaitlistItem[];
    segments: WaitlistSegment[];
    services: unknown[];
    priceCents: number | null;
  } | null;
  booking: {
    startsAt: string;
    endsAt: string;
    status: Enums<'appointment_status'>;
    manageToken: string;
  } | null;
  salon: { name: string; slug: string; timezone: string };
}

export type AcceptWaitlistOfferResult =
  | { ok: true; appointmentId: string; startsAt: string; endsAt: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'taken' | 'conflict' };

export interface JoinWaitlistInput {
  name: string | null;
  phone: string | null;
  /** Local `YYYY-MM-DD`. */
  day: string;
  windowStart: string | null;
  windowEnd: string | null;
  items: WaitlistItem[];
  servicesLabel: string;
  notes: string | null;
}

export type JoinWaitlistResult =
  { ok: true; token: string; day: string } | { ok: false; reason: 'disabled' | 'limit' };

/** `client` must be a service-role client for every function below. */
export async function claimWaitlistOpenings(
  client: ChairsideClient,
  salonId?: string,
): Promise<ClaimedOpening[]> {
  const { data, error } = await client.rpc('claim_waitlist_openings', {
    ...(salonId ? { p_salon_id: salonId } : {}),
  });
  if (error) throw error;
  return (data as unknown as ClaimedOpening[] | null) ?? [];
}

export async function saveWaitlistOffers(
  client: ChairsideClient,
  openingId: string,
  offers: WaitlistOfferDraft[],
): Promise<SaveWaitlistOffersResult> {
  const { data, error } = await client.rpc('save_waitlist_offers', {
    p_opening_id: openingId,
    p_offers: offers as unknown as Json,
  });
  if (error) throw error;
  return data as unknown as SaveWaitlistOffersResult;
}

export async function getWaitlistLink(
  client: ChairsideClient,
  token: string,
): Promise<WaitlistLinkRow | null> {
  const { data, error } = await client.rpc('waitlist_by_token', { p_token: token });
  if (error) throw error;
  return (data as unknown as WaitlistLinkRow | null) ?? null;
}

export async function leaveWaitlistByToken(
  client: ChairsideClient,
  token: string,
): Promise<{ ok: boolean }> {
  const { data, error } = await client.rpc('leave_waitlist_by_token', { p_token: token });
  if (error) throw error;
  return data as unknown as { ok: boolean };
}

export async function acceptWaitlistOffer(
  client: ChairsideClient,
  token: string,
  offerId: string,
  segments: WaitlistSegment[],
): Promise<AcceptWaitlistOfferResult> {
  const { data, error } = await client.rpc('accept_waitlist_offer', {
    p_token: token,
    p_offer_id: offerId,
    p_segments: segments as unknown as Json,
  });
  if (error) throw error;
  return data as unknown as AcceptWaitlistOfferResult;
}

export async function joinWaitlist(
  client: ChairsideClient,
  salonId: string,
  userId: string,
  input: JoinWaitlistInput,
  maxActive?: number,
): Promise<JoinWaitlistResult> {
  const { data, error } = await client.rpc('join_waitlist', {
    p_salon_id: salonId,
    p_user_id: userId,
    p_entry: input as unknown as Json,
    ...(maxActive ? { p_max_active: maxActive } : {}),
  });
  if (error) throw error;
  return data as unknown as JoinWaitlistResult;
}

// --- The waitlist Edge Function's API ---------------------------------------------------------

/** What the client sees on /w/{token}: no ids beyond the offer's, no other clients. */
export interface WaitlistLinkView {
  entry: WaitlistLinkRow['entry'];
  offer: {
    offerId: string;
    startsAt: string;
    endsAt: string;
    expiresAt: string;
    priceCents: number | null;
  } | null;
  booking: { startsAt: string; endsAt: string; status: string; manageToken: string } | null;
  salon: WaitlistLinkRow['salon'];
}

export type WaitlistRequest =
  | { action: 'process'; salonId?: string }
  | {
      action: 'join';
      slug: string;
      date: string;
      windowStart?: string | null;
      windowEnd?: string | null;
      items: WaitlistItem[];
      name?: string;
      phone?: string;
      notes?: string;
    }
  | { action: 'view'; token: string }
  | { action: 'accept'; token: string; offerId: string }
  | { action: 'leave'; token: string }
  | { action: 'send_offer'; offerId: string };

export type WaitlistProcessResponse = { openings: number; offers: number; sent: number };
export type WaitlistJoinResponse = { token: string; day: string };
export type WaitlistViewResponse = { link: WaitlistLinkView };
export type WaitlistAcceptResponse = { link: WaitlistLinkView };
export type WaitlistSendOfferResponse = { sent: true; email: string };

export interface WaitlistErrorBody {
  error: { code: string; message: string };
}
