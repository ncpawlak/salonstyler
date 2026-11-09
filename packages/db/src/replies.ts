import type { ChairsideClient, Tables } from './index.ts';

export type ClientReply = Tables<'client_replies'>;
export type ClientReplyKind =
  'confirm' | 'offer' | 'decline' | 'cancelled' | 'running_late' | 'other';
/** `messages`: the Messages composer · `copy`: clipboard (web) · `bridge`: the iOS Shortcut. */
export type ClientReplyChannel = 'messages' | 'copy' | 'bridge';
export type ClientReplySource = 'ai' | 'template' | 'edited';

/** Reply preferences stored on `settings`. */
export interface ReplySettings {
  /** Opt-in: approved requests are texted back automatically through the bridge. */
  autoSendReplies: boolean;
  toneExamples: string | null;
  bookingLink: string | null;
  includeBookingLink: boolean;
}

export const MAX_REPLY_TONE_EXAMPLES = 1500;
export const MAX_REPLY_LENGTH = 1000;

/** Mirrors the `settings.booking_link` check. */
export function isValidBookingLink(link: string): boolean {
  return /^https:\/\/\S+$/i.test(link) && link.length <= 300;
}

export async function getReplySettings(
  client: ChairsideClient,
  salonId: string,
): Promise<ReplySettings> {
  const { data, error } = await client
    .from('settings')
    .select('auto_send_replies, reply_tone_examples, booking_link, reply_include_booking_link')
    .eq('salon_id', salonId)
    .single();
  if (error) throw error;
  return {
    autoSendReplies: data.auto_send_replies,
    toneExamples: data.reply_tone_examples,
    bookingLink: data.booking_link,
    includeBookingLink: data.reply_include_booking_link,
  };
}

/** Owner-only (RLS). Empty strings clear the tone examples / booking link. */
export async function updateReplySettings(
  client: ChairsideClient,
  salonId: string,
  patch: Partial<ReplySettings>,
): Promise<void> {
  const update: {
    auto_send_replies?: boolean;
    reply_tone_examples?: string | null;
    booking_link?: string | null;
    reply_include_booking_link?: boolean;
  } = {};
  if (patch.autoSendReplies !== undefined) update.auto_send_replies = patch.autoSendReplies;
  if (patch.toneExamples !== undefined) {
    update.reply_tone_examples = patch.toneExamples?.trim() || null;
  }
  if (patch.bookingLink !== undefined) update.booking_link = patch.bookingLink?.trim() || null;
  if (patch.includeBookingLink !== undefined) {
    update.reply_include_booking_link = patch.includeBookingLink;
  }
  const { data, error } = await client
    .from('settings')
    .update(update)
    .eq('salon_id', salonId)
    .select('salon_id');
  if (error) throw error;
  if (data.length === 0) throw new Error('Only the salon owner can change reply settings');
}

export interface RecordClientReplyInput {
  kind: ClientReplyKind;
  body: string;
  channel: Exclude<ClientReplyChannel, 'bridge'>;
  source?: ClientReplySource | null;
  toPhone?: string | null;
  capturedRequestId?: string | null;
  appointmentId?: string | null;
  clientId?: string | null;
}

/**
 * Records a reply the stylist sent from the editor (or copied on web). Any reply still queued for
 * the same request is cancelled so the bridge doesn't text the client twice.
 */
export async function recordClientReply(
  client: ChairsideClient,
  salonId: string,
  input: RecordClientReplyInput,
): Promise<ClientReply> {
  const { data, error } = await client.rpc('record_client_reply', {
    p_salon_id: salonId,
    p_reply: { ...input },
  });
  if (error) throw error;
  return data;
}

/** Replies for the given requests, newest first (for "Offer sent" / "Reply sent" badges). */
export async function listRequestReplies(
  client: ChairsideClient,
  salonId: string,
  requestIds: readonly string[],
): Promise<ClientReply[]> {
  if (requestIds.length === 0) return [];
  const { data, error } = await client
    .from('client_replies')
    .select('*')
    .eq('salon_id', salonId)
    .in('captured_request_id', requestIds)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}
