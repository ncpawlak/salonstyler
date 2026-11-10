import type { ChairsideClient, Enums, Json, SalonSettings, Tables } from './index.ts';

/**
 * Marketing (#27): "Time for a touch-up?" rebook nudges, campaigns to opted-in clients and
 * post-visit review requests. Everything is drafted for the stylist to approve (or auto-sent when
 * the owner turns that on), then delivered by the `marketing` Edge Function. Only clients with
 * `marketing_opt_in` get anything, and every message carries a one-click unsubscribe link
 * (/u/{token}). Members read the tables; every change goes through an RPC.
 */

export type MarketingMessageRow = Tables<'marketing_messages'>;
export type MarketingCampaignRow = Tables<'marketing_campaigns'>;
export type MarketingMessageKind = Enums<'marketing_message_kind'>;
export type MarketingChannel = Enums<'marketing_channel'>;
export type MarketingMessageStatus = Enums<'marketing_message_status'>;
export type MarketingCampaignStatus = Enums<'marketing_campaign_status'>;

/** Who a campaign goes to, on top of "opted in with an email". Empty = everyone opted in. */
export interface MarketingAudience {
  /** Any of these client tags (case-insensitive). */
  tags?: string[];
  /** Came in within this many days. */
  lastVisitWithinDays?: number;
  /** Hasn't been in for at least this many days. */
  noVisitForDays?: number;
}

/** Filled in per client when the message is sent. */
export const MARKETING_PLACEHOLDERS = [
  '{firstName}',
  '{salonName}',
  '{bookingLink}',
  '{reviewLink}',
] as const;

// --- Settings --------------------------------------------------------------------------------

/** Settings → Marketing. */
export type MarketingSettings = Pick<
  SalonSettings,
  | 'marketing_nudges_enabled'
  | 'marketing_nudges_auto_send'
  | 'marketing_nudge_lead_days'
  | 'marketing_reviews_enabled'
  | 'marketing_reviews_auto_send'
  | 'marketing_review_url'
  | 'marketing_review_delay_hours'
>;

const SETTINGS_COLUMNS =
  'marketing_nudges_enabled, marketing_nudges_auto_send, marketing_nudge_lead_days, marketing_reviews_enabled, marketing_reviews_auto_send, marketing_review_url, marketing_review_delay_hours';

/** Days before the client is due that the nudge goes out (the database allows 0-21). */
export const NUDGE_LEAD_DAY_OPTIONS = [0, 3, 7, 14] as const;
/** Hours after checkout that a review request goes out (the database allows 0-72). */
export const REVIEW_DELAY_HOUR_OPTIONS = [0, 2, 24, 48] as const;

export async function getMarketingSettings(
  client: ChairsideClient,
  salonId: string,
): Promise<MarketingSettings> {
  const { data, error } = await client
    .from('settings')
    .select(SETTINGS_COLUMNS)
    .eq('salon_id', salonId)
    .single();
  if (error) throw error;
  return data;
}

/** Owners only (RLS). The review link must be https. */
export async function updateMarketingSettings(
  client: ChairsideClient,
  salonId: string,
  changes: Partial<MarketingSettings>,
): Promise<MarketingSettings> {
  const { data, error } = await client
    .from('settings')
    .update(changes)
    .eq('salon_id', salonId)
    .select(SETTINGS_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

// --- Messages (drafts to approve, history) ---------------------------------------------------

export interface MarketingMessage {
  id: string;
  kind: MarketingMessageKind;
  channel: MarketingChannel;
  status: MarketingMessageStatus;
  clientId: string;
  clientName: string;
  clientEmail: string | null;
  campaignId: string | null;
  appointmentId: string | null;
  subject: string;
  body: string;
  dueAt: string;
  sentAt: string | null;
  lastError: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

type MessageSelect = MarketingMessageRow & {
  client: { name: string; email: string | null } | null;
};

function toMessage(row: MessageSelect): MarketingMessage {
  return {
    id: row.id,
    kind: row.kind,
    channel: row.channel,
    status: row.status,
    clientId: row.client_id,
    clientName: row.client?.name ?? 'Client',
    clientEmail: row.client?.email ?? null,
    campaignId: row.campaign_id,
    appointmentId: row.appointment_id,
    subject: row.subject,
    body: row.body,
    dueAt: row.due_at,
    sentAt: row.sent_at,
    lastError: row.last_error,
    meta:
      row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta)
        ? (row.meta as Record<string, unknown>)
        : {},
    createdAt: row.created_at,
  };
}

/**
 * Drafts waiting on the stylist (oldest first) or recent history (newest first). Campaign
 * fan-out rows are left out of drafts: a campaign is approved as a whole.
 */
export async function listMarketingMessages(
  client: ChairsideClient,
  salonId: string,
  options: { statuses: MarketingMessageStatus[]; limit?: number; kinds?: MarketingMessageKind[] },
): Promise<MarketingMessage[]> {
  let query = client
    .from('marketing_messages')
    .select('*, client:clients!marketing_messages_client_id_fkey(name, email)')
    .eq('salon_id', salonId)
    .in('status', options.statuses);
  if (options.kinds) query = query.in('kind', options.kinds);
  const drafts = options.statuses.length === 1 && options.statuses[0] === 'draft';
  const { data, error } = await query
    .order(drafts ? 'created_at' : 'updated_at', { ascending: drafts })
    .limit(options.limit ?? 100);
  if (error) throw error;
  return (data as unknown as MessageSelect[]).map(toMessage);
}

/** Members. Queues a draft (optionally edited); it goes out within a minute. */
export async function approveMarketingMessage(
  client: ChairsideClient,
  messageId: string,
  edits: { subject?: string; body?: string } = {},
): Promise<MarketingMessageRow> {
  const { data, error } = await client.rpc('approve_marketing_message', {
    p_message_id: messageId,
    ...(edits.subject !== undefined ? { p_subject: edits.subject } : {}),
    ...(edits.body !== undefined ? { p_body: edits.body } : {}),
  });
  if (error) throw error;
  return data;
}

export async function dismissMarketingMessage(
  client: ChairsideClient,
  messageId: string,
): Promise<MarketingMessageRow> {
  const { data, error } = await client.rpc('dismiss_marketing_message', {
    p_message_id: messageId,
  });
  if (error) throw error;
  return data;
}

// --- Campaigns -------------------------------------------------------------------------------

export interface MarketingCampaign {
  id: string;
  name: string;
  subject: string;
  body: string;
  channel: MarketingChannel;
  audience: MarketingAudience;
  status: MarketingCampaignStatus;
  sendAt: string | null;
  sentAt: string | null;
  recipientCount: number;
  createdAt: string;
  updatedAt: string;
}

export function toCampaign(row: MarketingCampaignRow): MarketingCampaign {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    body: row.body,
    channel: row.channel,
    audience: (row.audience ?? {}) as MarketingAudience,
    status: row.status,
    sendAt: row.send_at,
    sentAt: row.sent_at,
    recipientCount: row.recipient_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Newest first. Members only. */
export async function listMarketingCampaigns(
  client: ChairsideClient,
  salonId: string,
): Promise<MarketingCampaign[]> {
  const { data, error } = await client
    .from('marketing_campaigns')
    .select('*')
    .eq('salon_id', salonId)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return data.map(toCampaign);
}

export interface SaveMarketingCampaignInput {
  /** Omit to create; only drafts can be edited. */
  id?: string | null;
  name: string;
  subject: string;
  body: string;
  audience: MarketingAudience;
}

export async function saveMarketingCampaign(
  client: ChairsideClient,
  salonId: string,
  input: SaveMarketingCampaignInput,
): Promise<MarketingCampaign> {
  const { data, error } = await client.rpc('save_marketing_campaign', {
    p_salon_id: salonId,
    // The RPC takes null to create.
    p_campaign_id: (input.id ?? null) as string,
    p_name: input.name,
    p_subject: input.subject,
    p_body: input.body,
    p_audience: input.audience as Json,
  });
  if (error) throw error;
  return toCampaign(data);
}

/** Sends now, or at `sendAt` (up to 90 days ahead). Messages go to the audience at that moment. */
export async function sendMarketingCampaign(
  client: ChairsideClient,
  campaignId: string,
  sendAt?: string | null,
): Promise<MarketingCampaign> {
  const { data, error } = await client.rpc('send_marketing_campaign', {
    p_campaign_id: campaignId,
    ...(sendAt ? { p_send_at: sendAt } : {}),
  });
  if (error) throw error;
  return toCampaign(data);
}

/** Deletes a draft, or cancels a scheduled campaign before it goes out. */
export async function cancelMarketingCampaign(
  client: ChairsideClient,
  campaignId: string,
): Promise<void> {
  const { error } = await client.rpc('cancel_marketing_campaign', { p_campaign_id: campaignId });
  if (error) throw error;
}

/** Opted-in clients with an email who match the audience right now. */
export async function countMarketingAudience(
  client: ChairsideClient,
  salonId: string,
  audience: MarketingAudience,
): Promise<number> {
  const { data, error } = await client.rpc('marketing_audience_count', {
    p_salon_id: salonId,
    p_audience: audience as Json,
  });
  if (error) throw error;
  return data;
}

// --- Unsubscribe link ------------------------------------------------------------------------

export function unsubscribePath(token: string): string {
  return `/u/${encodeURIComponent(token)}`;
}

/** What /u/{token} shows. */
export interface MarketingSubscriptionView {
  salonName: string;
  clientFirstName: string | null;
  subscribed: boolean;
}

// --- Service role (the marketing Edge Function) ----------------------------------------------

export interface NudgeCandidate {
  salonId: string;
  timeZone: string;
  leadDays: number;
  clientId: string;
  clientName: string;
  /** The client's last completed visit. */
  visit: { appointmentId: string; startsAt: string; serviceIds: string[] };
  /** Recent completed visits (for the client's own rhythm). */
  history: { startsAt: string; serviceIds: string[] }[];
  services: {
    id: string;
    name: string;
    category: string | null;
    rebookIntervalDays: number | null;
  }[];
}

export interface RebookNudgeDraft {
  clientId: string;
  appointmentId: string;
  subject: string;
  body: string;
  meta?: Record<string, unknown>;
}

export interface ClaimedMarketingMessage {
  id: string;
  kind: MarketingMessageKind;
  channel: MarketingChannel;
  /** Email address or phone number, by channel. */
  to: string;
  subject: string;
  body: string;
  clientName: string | null;
  unsubscribeToken: string;
  reviewUrl: string | null;
  salon: { name: string; slug: string; timezone: string };
}

export interface MarketingSendOutcome {
  id: string;
  outcome: 'sent' | 'skipped' | 'retry';
  error?: string;
  providerId?: string;
}

/**
 * Clients with nothing booked whose last visit was a while ago (not nudged recently), most
 * recent visit first. Pass the last row of a page as `before` for the next one.
 */
export async function marketingNudgeCandidates(
  service: ChairsideClient,
  options: { limit?: number; before?: { startsAt: string; clientId: string } | null } = {},
): Promise<NudgeCandidate[]> {
  const { data, error } = await service.rpc('marketing_nudge_candidates', {
    p_limit: options.limit ?? 200,
    ...(options.before
      ? { p_before_at: options.before.startsAt, p_before_client: options.before.clientId }
      : {}),
  });
  if (error) throw error;
  return (data ?? []) as unknown as NudgeCandidate[];
}

export async function saveRebookNudges(
  service: ChairsideClient,
  nudges: RebookNudgeDraft[],
): Promise<{ saved: number; queued: number }> {
  if (nudges.length === 0) return { saved: 0, queued: 0 };
  const { data, error } = await service.rpc('save_rebook_nudges', {
    p_nudges: nudges as unknown as Json,
  });
  if (error) throw error;
  return data as unknown as { saved: number; queued: number };
}

export async function claimMarketingMessages(
  service: ChairsideClient,
  channels: MarketingChannel[],
  limit = 50,
): Promise<ClaimedMarketingMessage[]> {
  const { data, error } = await service.rpc('claim_marketing_messages', {
    p_channels: channels,
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as unknown as ClaimedMarketingMessage[];
}

export async function finishMarketingMessages(
  service: ChairsideClient,
  results: MarketingSendOutcome[],
): Promise<number> {
  if (results.length === 0) return 0;
  const { data, error } = await service.rpc('finish_marketing_messages', {
    p_results: results as unknown as Json,
  });
  if (error) throw error;
  return data;
}

export async function getMarketingSubscription(
  service: ChairsideClient,
  token: string,
): Promise<MarketingSubscriptionView | null> {
  const { data, error } = await service.rpc('marketing_subscription_by_token', {
    p_token: token,
  });
  if (error) throw error;
  return (data as unknown as MarketingSubscriptionView | null) ?? null;
}

export async function setMarketingSubscription(
  service: ChairsideClient,
  token: string,
  subscribed: boolean,
): Promise<MarketingSubscriptionView | null> {
  const { data, error } = await service.rpc('set_marketing_subscription_by_token', {
    p_token: token,
    p_subscribed: subscribed,
  });
  if (error) throw error;
  return (data as unknown as MarketingSubscriptionView | null) ?? null;
}

// --- Edge Function API -----------------------------------------------------------------------

/** Body of POST /functions/v1/marketing. */
export type MarketingRequest =
  /** The database (shared secret): find clients due a nudge and draft them. */
  | { action: 'scan' }
  /** The database (shared secret): deliver what's queued. */
  | { action: 'send' }
  /** A member: suggest copy for a campaign (AI when set up, else a template). */
  | {
      action: 'draft_copy';
      salonId: string;
      kind: 'campaign' | 'rebook_nudge' | 'review_request';
      brief?: string;
    }
  | { action: 'view' | 'unsubscribe' | 'resubscribe'; token: string };

export type MarketingScanResponse = { candidates: number; saved: number; queued: number };
export type MarketingSendResponse = {
  claimed: number;
  sent: number;
  skipped: number;
  retried: number;
};
export type MarketingDraftCopyResponse = {
  subject: string;
  body: string;
  source: 'ai' | 'template';
};
export type MarketingSubscriptionResponse = { subscription: MarketingSubscriptionView };

export interface MarketingErrorBody {
  error: { code: string; message: string };
}
