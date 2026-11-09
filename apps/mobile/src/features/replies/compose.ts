import type { ClientReply, ClientReplySource } from '@chairside/db';

/**
 * An `sms:` URL that opens Messages with the body filled in (used when the in-app composer isn't
 * available). iOS separates the body with `&`, Android with `?`.
 */
export function smsUrl(to: string | null, body: string, os: string): string {
  const recipient = to ? to.replace(/[^\d+]/g, '') : '';
  return `sms:${recipient}${os === 'ios' ? '&' : '?'}body=${encodeURIComponent(body)}`;
}

/** `edited` once the stylist changed the draft; otherwise where the draft came from. */
export function replySource(
  draft: { text: string; source: ClientReplySource } | null,
  sent: string,
): ClientReplySource {
  if (!draft) return 'edited';
  return sent.trim() === draft.text.trim() ? draft.source : 'edited';
}

const SENT_LABEL: Record<string, string> = {
  confirm: 'Confirmation sent',
  offer: 'Offer sent · waiting for a yes',
  decline: 'Reply sent',
  cancelled: 'Cancellation sent',
  running_late: 'Running-late text sent',
  other: 'Reply sent',
};

/** The line an Inbox card shows about the latest reply to that request. */
export function replyStatusLabel(reply: Pick<ClientReply, 'kind' | 'status' | 'channel'>): string {
  if (reply.status === 'queued' || reply.status === 'sending') return 'Auto-send queued';
  const label = SENT_LABEL[reply.kind] ?? 'Reply sent';
  if (reply.channel === 'bridge') return `${label} automatically`;
  return reply.channel === 'copy' ? label.replace(' sent', ' copied') : label;
}

/** Latest reply per request (the list comes newest first). */
export function latestReplyByRequest<T extends Pick<ClientReply, 'captured_request_id'>>(
  replies: readonly T[],
): Map<string, T> {
  const map = new Map<string, T>();
  for (const r of replies) {
    if (r.captured_request_id && !map.has(r.captured_request_id)) {
      map.set(r.captured_request_id, r);
    }
  }
  return map;
}
