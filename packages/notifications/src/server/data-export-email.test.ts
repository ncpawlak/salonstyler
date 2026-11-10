import { describe, expect, it } from 'vitest';

import { renderDataExportEmail } from './data-export-email.ts';

describe('renderDataExportEmail', () => {
  it('links the export, says how long it lasts and escapes the salon name', () => {
    const email = renderDataExportEmail({
      salonName: 'Ana <b>&</b> Co',
      url: 'https://x.test/storage/v1/object/sign/data-exports/a.zip?token=t&download=a.zip',
      expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      fileName: 'chairside-export-ana-2026-11-09.zip',
      counts: { clients: 12, appointments: 40, payments: 3, client_formulas: 5, services: 9 },
    });
    expect(email.subject).toBe('Your Ana <b>&</b> Co data export is ready');
    expect(email.text).toContain('Includes 12 clients, 40 appointments, 3 payments, 5 formulas.');
    expect(email.text).toContain('works for 24 hours');
    expect(email.text).toContain('token=t&download=a.zip');
    expect(email.html).toContain('Ana &lt;b&gt;&amp;&lt;/b&gt; Co');
    expect(email.html).toContain(
      'href="https://x.test/storage/v1/object/sign/data-exports/a.zip?token=t&amp;download=a.zip"',
    );
    expect(email.html).not.toContain('<b>&</b>');
  });
});
