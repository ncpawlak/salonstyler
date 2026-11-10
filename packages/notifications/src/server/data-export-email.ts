// Data export email: "your Chairside export is ready". Sent by supabase/functions/data-export
// through the same transport as the client emails. See supabase/docs/data-export.md.
import { escapeHtml, type RenderedEmail } from './client-email.ts';

export interface DataExportEmailInput {
  salonName: string;
  url: string;
  expiresAt: string;
  fileName: string;
  counts: Record<string, number>;
}

const HIGHLIGHTS: [table: string, label: string][] = [
  ['clients', 'clients'],
  ['appointments', 'appointments'],
  ['payments', 'payments'],
  ['client_formulas', 'formulas'],
  ['client_photos', 'photos'],
];

export function renderDataExportEmail(input: DataExportEmailInput): Omit<RenderedEmail, 'ics'> {
  const salon = input.salonName;
  const hours = Math.max(1, Math.round((Date.parse(input.expiresAt) - Date.now()) / 3_600_000));
  const summary = HIGHLIGHTS.filter(([t]) => input.counts[t] !== undefined)
    .map(([t, label]) => `${input.counts[t]} ${label}`)
    .join(', ');
  const lead = `Your export of ${salon} is ready: everything in Chairside, as spreadsheets (CSV), one data.json file and your client photos.`;
  const note = `The link works for ${hours} hours and only for this file. Anyone with the link can download it, so don't forward this email. You can make a new export any time in Settings.`;
  const label = 'Download export';

  const subject = `Your ${salon} data export is ready`;
  const text = [
    'Hi,',
    '',
    lead,
    ...(summary ? ['', `Includes ${summary}.`] : []),
    '',
    `${label} (${input.fileName}): ${input.url}`,
    '',
    note,
    '',
    '- Chairside',
  ].join('\n');

  const e = escapeHtml;
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f5f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1917">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;padding:24px">
<tr><td>
<p style="margin:0 0 16px;font-size:16px">Hi,</p>
<p style="margin:0 0 16px;font-size:16px">${e(lead)}</p>
${summary ? `<p style="margin:0 0 24px;font-size:16px;color:#57534e">Includes ${e(summary)}.</p>` : ''}
<p style="margin:0 0 8px"><a href="${e(input.url)}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:999px;font-size:15px;font-weight:600">${e(label)}</a></p>
<p style="margin:0 0 24px;font-size:13px;color:#78716c">${e(input.fileName)}</p>
<p style="margin:0 0 16px;font-size:14px;color:#57534e">${e(note)}</p>
<p style="margin:0;font-size:14px;color:#57534e">Chairside</p>
</td></tr></table>
</td></tr></table>
</body></html>`;

  return { subject, text, html };
}
