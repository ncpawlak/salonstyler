import type { ReminderQueueItem } from '@chairside/db/client-self-service';

import { formatDay, formatTime } from '../appointments/format';

/** The client's manage link: works on the web build without signing in. */
export function manageBookingUrl(token: string, origin: string): string {
  return `${origin.replace(/\/+$/, '')}/m/${token}`;
}

/** First name for a friendly text ("Hi Karina"), or nothing for walk-ins. */
export function firstName(name: string | null): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
}

/** The reminder the stylist texts from his own phone (tap → Messages, prefilled). */
export function reminderText(
  item: Pick<ReminderQueueItem, 'clientName' | 'startsAt' | 'services' | 'manageToken'>,
  salonName: string,
  timeZone: string,
  origin: string,
): string {
  const at = Date.parse(item.startsAt);
  const hi = firstName(item.clientName);
  const what = item.services ? ` for ${item.services}` : '';
  return (
    `${hi ? `Hi ${hi}! ` : 'Hi! '}Reminder: you’re booked at ${salonName}${what} on ` +
    `${formatDay(at, timeZone)} at ${formatTime(at, timeZone)}. ` +
    `Need to change it? ${manageBookingUrl(item.manageToken, origin)}`
  );
}
