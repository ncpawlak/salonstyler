// Client emails: confirmation (with a calendar invite), reminders, "moved" and "cancelled".
// Drains public.client_email_outbox through Resend or SMTP. Pure logic with injected dependencies;
// supabase/functions/notifier wires it up next to the push notifier. See
// supabase/docs/client-self-service.md for setup.
import { buildIcs } from './ics.ts';
import {
  addressOf,
  base64,
  type EmailMessage,
  EmailSendError,
  sendSmtp,
  type SmtpConfig,
  type SmtpConnector,
} from './smtp.ts';
import type { FetchLike } from './expo.ts';

export { buildIcs } from './ics.ts';
export { buildMime, EmailSendError, sendSmtp } from './smtp.ts';
export type { EmailMessage, SmtpConfig, SmtpConn, SmtpConnector } from './smtp.ts';

export type ClientEmailKind =
  'confirmation' | 'reminder' | 'rescheduled' | 'cancellation' | 'forms_request';

/** One row of public.claim_client_emails(). */
export interface ClientEmailRow {
  id: string;
  kind: ClientEmailKind;
  to: string | null;
  reminderHours: number | null;
  appointmentId: string;
  salon: { name: string; slug: string; timezone: string };
  clientName: string | null;
  startsAt: string;
  endsAt: string;
  services: string | null;
  manageToken: string;
  sequence: number;
}

export interface ClientEmailResult {
  id: string;
  outcome: 'sent' | 'skipped' | 'retry';
  error?: string;
  providerId?: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
  ics?: { method: 'REQUEST' | 'CANCEL'; content: string };
}

export interface RenderOptions {
  /** Public web app origin, e.g. https://app.chairside.example (no trailing slash needed). */
  appUrl: string;
  /** Sender address, used as the invite's organizer. */
  fromAddress: string;
  now?: Date;
}

export function manageUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, '')}/m/${encodeURIComponent(token)}`;
}

/** The client's intake & consent forms for this appointment (#45). */
export function formsUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, '')}/f/${encodeURIComponent(token)}`;
}

export function bookingUrl(appUrl: string, slug: string): string {
  return `${appUrl.replace(/\/+$/, '')}/b/${encodeURIComponent(slug)}`;
}

/** "Fri, Nov 13 at 2:00 PM" in the salon's timezone. */
export function formatWhen(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(d);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
  return `${day} at ${time}`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function firstName(name: string | null): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
}

function reminderLead(hours: number | null): string {
  if (!hours) return 'soon';
  if (hours % 24 === 0) return hours === 24 ? 'tomorrow' : `in ${hours / 24} days`;
  return hours === 1 ? 'in 1 hour' : `in ${hours} hours`;
}

export function renderClientEmail(row: ClientEmailRow, options: RenderOptions): RenderedEmail {
  const salon = row.salon.name;
  const when = formatWhen(row.startsAt, row.salon.timezone);
  const what = row.services?.trim() || 'Appointment';
  const link = manageUrl(options.appUrl, row.manageToken);
  const hi = firstName(row.clientName);
  const greeting = hi ? `Hi ${hi},` : 'Hi,';

  let subject: string;
  let lead: string;
  let action: { label: string; url: string };
  let ics: RenderedEmail['ics'];
  const footer = 'Need to change it? Use the link above to reschedule or cancel.';
  let note: string | null = footer;

  switch (row.kind) {
    case 'confirmation':
      subject = `You're booked at ${salon}: ${when}`;
      lead = `You're booked at ${salon}.`;
      action = { label: 'View or change your appointment', url: link };
      break;
    case 'reminder':
      subject = `Reminder: ${salon} ${reminderLead(row.reminderHours)}, ${when}`;
      lead = `This is a reminder of your appointment at ${salon} ${reminderLead(row.reminderHours)}.`;
      action = { label: 'View or change your appointment', url: link };
      break;
    case 'rescheduled':
      subject = `Your ${salon} appointment moved to ${when}`;
      lead = `Your appointment at ${salon} has moved.`;
      action = { label: 'View or change your appointment', url: link };
      break;
    case 'cancellation':
      subject = `Cancelled: ${salon}, ${when}`;
      lead = `Your appointment at ${salon} is cancelled.`;
      action = { label: 'Book another time', url: bookingUrl(options.appUrl, row.salon.slug) };
      note = null;
      break;
    case 'forms_request':
      subject = `Before your visit: a quick form from ${salon}`;
      lead = `Please fill out and sign ${salon}'s form before your appointment. It takes a couple of minutes on your phone.`;
      action = { label: 'Fill out your forms', url: formsUrl(options.appUrl, row.manageToken) };
      note = null;
      break;
  }

  if (row.kind !== 'reminder' && row.kind !== 'forms_request') {
    const method = row.kind === 'cancellation' ? 'CANCEL' : 'REQUEST';
    ics = {
      method,
      content: buildIcs({
        uid: `${row.appointmentId}@chairside`,
        sequence: row.sequence,
        method,
        start: new Date(row.startsAt),
        end: new Date(row.endsAt),
        summary: `${what} at ${salon}`,
        description: row.kind === 'cancellation' ? undefined : `Change or cancel: ${link}`,
        location: salon,
        url: row.kind === 'cancellation' ? undefined : link,
        organizer: { name: salon, email: options.fromAddress },
        attendee: row.to ? { name: row.clientName ?? undefined, email: row.to } : undefined,
        now: options.now,
      }),
    };
  }

  const text = [
    greeting,
    '',
    lead,
    '',
    `${what}`,
    `${when}`,
    '',
    `${action.label}: ${action.url}`,
    ...(note ? ['', note] : []),
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
<p style="margin:0 0 24px"><a href="${e(action.url)}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:999px;font-size:15px;font-weight:600">${e(action.label)}</a></p>
${note ? `<p style="margin:0 0 16px;font-size:14px;color:#57534e">${e(note)}</p>` : ''}
<p style="margin:0;font-size:14px;color:#57534e">${e(salon)}</p>
</td></tr></table>
</td></tr></table>
</body></html>`;

  return { subject, text, html, ics };
}

export function toEmailMessage(
  row: ClientEmailRow & { to: string },
  rendered: RenderedEmail,
  from: string,
): EmailMessage {
  return {
    from,
    to: row.clientName ? `${row.clientName.replace(/[<>"\r\n]/g, '')} <${row.to}>` : row.to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    attachments: rendered.ics
      ? [
          {
            filename: rendered.ics.method === 'CANCEL' ? 'cancel.ics' : 'invite.ics',
            contentType: `text/calendar; method=${rendered.ics.method}`,
            content: rendered.ics.content,
          },
        ]
      : undefined,
  };
}

// --- Transports ---------------------------------------------------------------------------

export type EmailTransport = (message: EmailMessage) => Promise<{ id?: string }>;

export const RESEND_URL = 'https://api.resend.com/emails';

export function resendTransport(apiKey: string, fetchImpl?: FetchLike): EmailTransport {
  const doFetch = fetchImpl ?? (globalThis.fetch as FetchLike);
  return async (message) => {
    let res: Response;
    try {
      res = await doFetch(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          ...(message.attachments
            ? {
                attachments: message.attachments.map((a) => ({
                  filename: a.filename,
                  content: base64(a.content),
                  content_type: a.contentType,
                })),
              }
            : {}),
        }),
      });
    } catch (err) {
      throw new EmailSendError(`Resend request failed: ${String(err)}`);
    }
    let payload: { id?: string; message?: string } | undefined;
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      payload = undefined;
    }
    if (!res.ok) {
      // 4xx (bad address, unverified domain) won't fix itself; 429 and 5xx are worth a retry.
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
      throw new EmailSendError(
        `Resend failed: ${payload?.message ?? `HTTP ${res.status}`}`,
        permanent,
      );
    }
    return { id: payload?.id };
  };
}

export function smtpTransport(config: SmtpConfig, connector: SmtpConnector): EmailTransport {
  return (message) => sendSmtp(config, connector, message);
}

export interface EmailEnv {
  EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  /** 'tls' | 'starttls' | 'none'; defaults from the port (465 tls, 587 starttls, else none). */
  SMTP_SECURITY?: string;
  PUBLIC_APP_URL?: string;
}

export interface EmailConfig {
  from: string;
  appUrl: string;
  transport: EmailTransport;
  provider: 'resend' | 'smtp';
}

/** Email settings from Edge Function secrets, or null (client emails stay queued) if unset. */
export function emailConfigFromEnv(
  env: EmailEnv,
  options: { connector?: SmtpConnector; fetch?: FetchLike } = {},
): EmailConfig | null {
  const from = env.EMAIL_FROM?.trim();
  const appUrl = env.PUBLIC_APP_URL?.trim();
  if (!from || !appUrl) return null;
  if (env.RESEND_API_KEY?.trim()) {
    return {
      from,
      appUrl,
      provider: 'resend',
      transport: resendTransport(env.RESEND_API_KEY.trim(), options.fetch),
    };
  }
  if (env.SMTP_HOST?.trim() && options.connector) {
    const port = Number.parseInt(env.SMTP_PORT ?? '', 10) || 587;
    const security =
      env.SMTP_SECURITY === 'tls' ||
      env.SMTP_SECURITY === 'starttls' ||
      env.SMTP_SECURITY === 'none'
        ? env.SMTP_SECURITY
        : port === 465
          ? 'tls'
          : port === 587
            ? 'starttls'
            : 'none';
    return {
      from,
      appUrl,
      provider: 'smtp',
      transport: smtpTransport(
        {
          host: env.SMTP_HOST.trim(),
          port,
          security,
          user: env.SMTP_USER?.trim() || undefined,
          pass: env.SMTP_PASS,
        },
        options.connector,
      ),
    };
  }
  return null;
}

// --- The emailer ----------------------------------------------------------------------------

export interface EmailerDeps {
  /** public.claim_client_emails(limit) */
  claim(limit: number): Promise<ClientEmailRow[]>;
  /** public.finish_client_emails(results) */
  finish(results: ClientEmailResult[]): Promise<void>;
  config: EmailConfig;
  batchSize?: number;
  maxBatches?: number;
  now?: () => Date;
}

export interface EmailerSummary {
  claimed: number;
  sent: number;
  skipped: number;
  retried: number;
}

export async function deliverEmail(
  row: ClientEmailRow,
  deps: Pick<EmailerDeps, 'config' | 'now'>,
): Promise<ClientEmailResult> {
  if (!row.to) return { id: row.id, outcome: 'skipped', error: 'no_email' };
  try {
    const rendered = renderClientEmail(row, {
      appUrl: deps.config.appUrl,
      fromAddress: addressOf(deps.config.from),
      now: deps.now?.(),
    });
    const { id } = await deps.config.transport(
      toEmailMessage({ ...row, to: row.to }, rendered, deps.config.from),
    );
    return { id: row.id, outcome: 'sent', ...(id ? { providerId: id } : {}) };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    const permanent = err instanceof EmailSendError && err.permanent;
    return { id: row.id, outcome: permanent ? 'skipped' : 'retry', error: message };
  }
}

/** Claims and sends client emails until nothing is due (bounded by maxBatches). */
export async function runEmailer(deps: EmailerDeps): Promise<EmailerSummary> {
  const batchSize = deps.batchSize ?? 25;
  const maxBatches = deps.maxBatches ?? 4;
  const summary: EmailerSummary = { claimed: 0, sent: 0, skipped: 0, retried: 0 };

  for (let i = 0; i < maxBatches; i++) {
    const rows = await deps.claim(batchSize);
    if (rows.length === 0) break;
    summary.claimed += rows.length;

    const results: ClientEmailResult[] = [];
    for (const row of rows) results.push(await deliverEmail(row, deps));
    await deps.finish(results);
    for (const r of results) {
      if (r.outcome === 'sent') summary.sent++;
      else if (r.outcome === 'skipped') summary.skipped++;
      else summary.retried++;
    }
    if (rows.length < batchSize) break;
  }
  return summary;
}
