// Waitlist offer email: "a spot opened up, tap to take it". Sent by supabase/functions/waitlist
// through the same transport as the client emails. See supabase/docs/waitlist.md.
import { escapeHtml, formatWhen, type RenderedEmail } from './client-email.ts';

export interface WaitlistOfferEmail {
  token: string;
  clientName: string | null;
  salonName: string;
  timezone: string;
  startsAt: string;
  servicesLabel: string | null;
  expiresAt: string;
}

export function waitlistUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, '')}/w/${encodeURIComponent(token)}`;
}

/** "2:00 PM" (same day) or "Fri, Nov 13 at 2:00 PM" for when the offer lapses. */
function formatDeadline(iso: string, startsAt: string, timeZone: string): string {
  const day = (v: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(new Date(v));
  const now = new Date().toISOString();
  if (day(iso) === day(now) || day(iso) === day(startsAt)) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  }
  return formatWhen(iso, timeZone);
}

export function renderWaitlistOfferEmail(
  offer: WaitlistOfferEmail,
  options: { appUrl: string },
): Omit<RenderedEmail, 'ics'> {
  const salon = offer.salonName;
  const when = formatWhen(offer.startsAt, offer.timezone);
  const what = offer.servicesLabel?.trim() || 'Appointment';
  const link = waitlistUrl(options.appUrl, offer.token);
  const first = offer.clientName?.trim().split(/\s+/)[0];
  const greeting = first ? `Hi ${first},` : 'Hi,';
  const lead = `A spot opened up at ${salon} and you're on the waitlist.`;
  const deadline = formatDeadline(offer.expiresAt, offer.startsAt, offer.timezone);
  const note = `It goes to whoever claims it first. The offer ends at ${deadline}.`;
  const label = 'Claim this time';

  const subject = `A spot opened up at ${salon}: ${when}`;
  const text = [
    greeting,
    '',
    lead,
    '',
    what,
    when,
    '',
    `${label}: ${link}`,
    '',
    note,
    '',
    `- ${salon}`,
  ].join('\n');

  const e = escapeHtml;
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f5f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1917">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;padding:24px">
<tr><td>
<p style="margin:0 0 16px;font-size:16px">${e(greeting)}</p>
<p style="margin:0 0 16px;font-size:16px">${e(lead)}</p>
<p style="margin:0 0 4px;font-size:18px;font-weight:600">${e(what)}</p>
<p style="margin:0 0 24px;font-size:16px;color:#57534e">${e(when)}</p>
<p style="margin:0 0 24px"><a href="${e(link)}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:999px;font-size:15px;font-weight:600">${e(label)}</a></p>
<p style="margin:0 0 16px;font-size:14px;color:#57534e">${e(note)}</p>
<p style="margin:0;font-size:14px;color:#57534e">${e(salon)}</p>
</td></tr></table>
</td></tr></table>
</body></html>`;

  return { subject, text, html };
}
