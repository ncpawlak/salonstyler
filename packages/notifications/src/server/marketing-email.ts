// Marketing email (#27): rebook nudges, campaigns and review requests. The stylist's copy is
// plain text with {placeholders}; this fills them per client, turns links into links, and adds
// the one-click unsubscribe footer and List-Unsubscribe headers (RFC 2369 / RFC 8058) every
// marketing email must carry. Transactional emails (client-email.ts) never go through here.
// See supabase/docs/marketing.md.
import { bookingUrl, escapeHtml } from './client-email.ts';

export type MarketingEmailKind = 'rebook_nudge' | 'review_request' | 'campaign';

export interface MarketingEmailInput {
  kind: MarketingEmailKind;
  subject: string;
  body: string;
  clientName: string | null;
  unsubscribeToken: string;
  reviewUrl: string | null;
  salon: { name: string; slug: string };
}

export interface MarketingEmailOptions {
  /** Public web app origin (for /u/{token} and the booking page). */
  appUrl: string;
  /**
   * The marketing Edge Function URL. When set, mail apps get an RFC 8058 one-click POST target
   * (`?token=…`); without it the header points at the /u/{token} page only.
   */
  functionsUrl?: string | null;
}

export interface RenderedMarketingEmail {
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

export function unsubscribeUrl(appUrl: string, token: string): string {
  return `${trimSlash(appUrl)}/u/${encodeURIComponent(token)}`;
}

export function oneClickUnsubscribeUrl(functionsUrl: string, token: string): string {
  const url = trimSlash(functionsUrl);
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/** First word of the client's name. */
function firstNameOf(name: string | null): string | null {
  return name?.trim().split(/\s+/)[0] || null;
}

/**
 * Replaces {firstName}, {salonName}, {bookingLink} and {reviewLink}. Unknown placeholders are
 * left alone so a typo is visible in the preview rather than silently dropped.
 */
export function fillMarketingPlaceholders(
  template: string,
  values: { firstName: string | null; salonName: string; bookingLink: string; reviewLink: string },
): string {
  return template.replace(/\{(firstName|salonName|bookingLink|reviewLink)\}/g, (_, key: string) => {
    switch (key) {
      case 'firstName':
        return values.firstName ?? 'there';
      case 'salonName':
        return values.salonName;
      case 'bookingLink':
        return values.bookingLink;
      default:
        return values.reviewLink;
    }
  });
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g;

/** Escaped HTML paragraphs with bare URLs turned into links. */
function bodyHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => {
      let html = '';
      let last = 0;
      for (const match of paragraph.matchAll(URL_PATTERN)) {
        const url = match[0];
        html += escapeHtml(paragraph.slice(last, match.index));
        html += `<a href="${escapeHtml(url)}" style="color:#1c1917">${escapeHtml(url)}</a>`;
        last = (match.index ?? 0) + url.length;
      }
      html += escapeHtml(paragraph.slice(last));
      return `<p style="margin:0 0 16px;font-size:16px;line-height:1.5">${html.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
}

export function renderMarketingEmail(
  message: MarketingEmailInput,
  options: MarketingEmailOptions,
): RenderedMarketingEmail {
  const salon = message.salon.name;
  const booking = bookingUrl(options.appUrl, message.salon.slug);
  const review = message.reviewUrl?.trim() || booking;
  const values = {
    firstName: firstNameOf(message.clientName),
    salonName: salon,
    bookingLink: booking,
    reviewLink: review,
  };
  const subject = fillMarketingPlaceholders(message.subject, values).replace(/[\r\n]+/g, ' ');
  const body = fillMarketingPlaceholders(message.body, values).trim();
  const unsubscribe = unsubscribeUrl(options.appUrl, message.unsubscribeToken);

  const cta =
    message.kind === 'review_request'
      ? message.reviewUrl && !body.includes(message.reviewUrl)
        ? { label: 'Leave a review', url: review }
        : null
      : body.includes(booking)
        ? null
        : { label: 'Book your next visit', url: booking };

  const footer = `You're getting this because you said yes to news from ${salon}.`;
  const text = [
    body,
    ...(cta ? ['', `${cta.label}: ${cta.url}`] : []),
    '',
    '--',
    footer,
    `Unsubscribe: ${unsubscribe}`,
  ].join('\n');

  const e = escapeHtml;
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f5f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1917">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;padding:24px">
<tr><td>
${bodyHtml(body)}
${cta ? `<p style="margin:8px 0 24px"><a href="${e(cta.url)}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:999px;font-size:15px;font-weight:600">${e(cta.label)}</a></p>\n` : ''}<p style="margin:0;font-size:14px;color:#57534e">${e(salon)}</p>
</td></tr></table>
<p style="max-width:480px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#78716c">${e(footer)} <a href="${e(unsubscribe)}" style="color:#78716c">Unsubscribe</a></p>
</td></tr></table>
</body></html>`;

  const headers: Record<string, string> = options.functionsUrl
    ? {
        'List-Unsubscribe': `<${oneClickUnsubscribeUrl(options.functionsUrl, message.unsubscribeToken)}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      }
    : { 'List-Unsubscribe': `<${unsubscribe}>` };

  return { subject, text, html, headers };
}
