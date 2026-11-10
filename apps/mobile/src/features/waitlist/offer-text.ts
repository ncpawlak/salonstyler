import type { SentWaitlistOffer } from '@chairside/db/waitlist';

import { formatDay, formatTime } from '../appointments/format';
import { firstName } from '../client-self-service/reminder-text';

/** The client's waitlist link: works on the web build without signing in. */
export function waitlistUrl(token: string, origin: string): string {
  return `${origin.replace(/\/+$/, '')}/w/${token}`;
}

/** "9:00 AM–12:00 PM" from local `HH:MM[:SS]` times, or null for "any time". */
export function windowLabel(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  const fmt = (t: string) => {
    const [h = 0, m = 0] = t.split(':').map(Number);
    const hour = h % 12 || 12;
    return `${hour}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  };
  return `${fmt(start)}–${fmt(end)}`;
}

/** The offer the stylist texts from his own phone (tap → Messages, prefilled). */
export function offerText(
  offer: Pick<SentWaitlistOffer, 'clientName' | 'salonName' | 'timezone' | 'startsAt' | 'token'>,
  origin: string,
): string {
  const at = Date.parse(offer.startsAt);
  const hi = firstName(offer.clientName);
  return (
    `${hi ? `Hi ${hi}! ` : 'Hi! '}A spot opened up at ${offer.salonName} on ` +
    `${formatDay(at, offer.timezone)} at ${formatTime(at, offer.timezone)}. ` +
    `First to claim it gets it: ${waitlistUrl(offer.token, origin)}`
  );
}
