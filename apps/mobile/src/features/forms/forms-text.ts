import { formsUrl } from '@chairside/db/forms';

import { formatDay, formatTime } from '../appointments/format';

/** The text a stylist sends with a client's forms link. */
export function formsText(
  a: { clientName: string | null; startsAt: string; manageToken: string; missing: string[] },
  salonName: string,
  timeZone: string,
  origin: string,
): string {
  const first = a.clientName?.trim().split(/\s+/)[0];
  const at = Date.parse(a.startsAt);
  const what = a.missing.length === 1 ? `the ${a.missing[0]} form` : 'a couple of quick forms';
  return [
    `${first ? `Hi ${first}! ` : ''}Before your ${salonName} appointment on ${formatDay(at, timeZone)} at ${formatTime(at, timeZone)}, please fill out and sign ${what}:`,
    formsUrl(origin, a.manageToken),
  ].join(' ');
}
