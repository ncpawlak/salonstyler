import type { ManualCaptureRequest, ManualCaptureResponse } from '@chairside/ai/inbox';

/** What the inbox function takes; base64 images over this are rejected (matches the server). */
export const MAX_CAPTURE_IMAGE_CHARS = 8 * 1024 * 1024;
export const CAPTURE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type CaptureImage = NonNullable<ManualCaptureRequest['image']>;

const CHANNELS: Record<string, string> = {
  instagram: 'Instagram DM',
  whatsapp: 'WhatsApp',
  imessage: 'iMessage',
  messenger: 'Messenger',
  screenshot: 'Screenshot',
  paste: 'Pasted',
  share: 'Shared',
};

/** The card's "where it came from" line: texts keep the number; captured messages name the app. */
export function channelLabel(channel: string | null | undefined, phone: string | null) {
  const label = channel ? CHANNELS[channel] : undefined;
  if (label) return phone ? `${label} · ${phone}` : label;
  return phone ? `Text from ${phone}` : 'Text';
}

/** `data:image/png;base64,…` → an upload, or null if it isn't a supported image. */
export function dataUriToImage(uri: string): CaptureImage | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(uri);
  if (!match) return null;
  return toCaptureImage(match[1]!, match[2]!);
}

/** Validates an image before upload; throws a message the stylist can act on. */
export function toCaptureImage(mimeType: string, data: string): CaptureImage {
  const type = mimeType.toLowerCase();
  if (!(CAPTURE_IMAGE_TYPES as readonly string[]).includes(type)) {
    throw new Error('Choose a PNG, JPEG or WebP screenshot.');
  }
  if (!data) throw new Error('Couldn’t read that image. Try another screenshot.');
  if (data.length > MAX_CAPTURE_IMAGE_CHARS) {
    throw new Error('That image is too large. Crop the screenshot to just the conversation.');
  }
  return { mimeType: type as CaptureImage['mimeType'], data };
}

/** "Who sent it" box → a phone (if it looks like one) or a name; empty means let the AI decide. */
export function senderFields(from: string): { sender?: string; senderPhone?: string } {
  const value = from.trim();
  if (!value) return {};
  const digits = value.replace(/\D/g, '');
  if (/^[+\d\s().-]+$/.test(value) && digits.length >= 7) return { senderPhone: value };
  return { sender: value };
}

/** Shared text often comes as "message\nhttps://…" from some apps; keep it, but trim it. */
export function sharedText(text: string | null | undefined, webUrl?: string | null) {
  const parts = [text?.trim(), webUrl && !text?.includes(webUrl) ? webUrl : null].filter(Boolean);
  return parts.join('\n').slice(0, 4000);
}

/** One-line result for the capture screen. */
export function captureSummary(outcome: ManualCaptureResponse): {
  title: string;
  detail: string;
  toInbox: boolean;
} {
  switch (outcome.status) {
    case 'captured':
      return {
        title: 'Added to your Inbox',
        detail: outcome.appointmentId
          ? 'A slot is on hold. Approve or change it from the Inbox.'
          : 'Review it in the Inbox to pick a time.',
        toInbox: true,
      };
    case 'confirmed':
      return {
        title: 'Booked',
        detail: 'They said yes to the time you offered, so it’s on the calendar.',
        toInbox: true,
      };
    case 'duplicate':
      return {
        title: 'Already in your Inbox',
        detail: 'This message was captured before.',
        toInbox: true,
      };
    case 'ignored':
      return {
        title: 'No booking request found',
        detail:
          outcome.reason === 'empty'
            ? 'There was nothing to read.'
            : 'This doesn’t look like a booking, change or cancellation. Nothing was added.',
        toInbox: false,
      };
    default:
      return { title: 'Done', detail: '', toInbox: true };
  }
}
