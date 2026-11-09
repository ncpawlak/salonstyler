import { formatDay, formatTime } from '../appointments/format';

/** Text the client gets about their next visit (sent from the stylist's own phone or mail). */
export function rebookConfirmationMessage(input: {
  clientName?: string | null;
  salonName: string;
  startsAt: string;
  timeZone: string;
  held: boolean;
}): string {
  const first = input.clientName?.trim().split(/\s+/)[0];
  const when = `${formatDay(Date.parse(input.startsAt), input.timeZone)} at ${formatTime(
    Date.parse(input.startsAt),
    input.timeZone,
  )}`;
  const hi = first ? `Hi ${first}! ` : 'Hi! ';
  return input.held
    ? `${hi}I'm holding ${when} for your next visit at ${input.salonName}. Reply YES to confirm.`
    : `${hi}You're booked for your next visit at ${input.salonName}: ${when}. See you then!`;
}

/**
 * "sms:" / "mailto:" links prefilled with the confirmation. iOS expects `&body=` after the
 * recipient; Android and web use `?body=`.
 */
export function rebookConfirmationLinks(input: {
  message: string;
  salonName: string;
  phone?: string | null;
  email?: string | null;
  platform: string;
}) {
  const sep = input.platform === 'ios' ? '&' : '?';
  const body = encodeURIComponent(input.message);
  return {
    sms: `sms:${input.phone ?? ''}${sep}body=${body}`,
    email: `mailto:${input.email ?? ''}?subject=${encodeURIComponent(
      `Your next visit at ${input.salonName}`,
    )}&body=${body}`,
  };
}
