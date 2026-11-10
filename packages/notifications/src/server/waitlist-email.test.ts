import { describe, expect, it } from 'vitest';

import { renderWaitlistOfferEmail, waitlistUrl } from './waitlist-email.ts';

const OFFER = {
  token: 'a'.repeat(64),
  clientName: 'Karina <Lopez>',
  salonName: 'Studio K',
  timezone: 'America/Chicago',
  startsAt: '2026-12-18T20:30:00Z',
  servicesLabel: "Women's Haircut",
  expiresAt: '2026-12-18T17:00:00Z',
};

describe('waitlist offer email', () => {
  it('links to the claim page with the time in the salon timezone', () => {
    const email = renderWaitlistOfferEmail(OFFER, { appUrl: 'https://app.example/' });
    expect(email.subject).toBe('A spot opened up at Studio K: Fri, Dec 18 at 2:30 PM');
    expect(email.text).toContain(`Claim this time: https://app.example/w/${OFFER.token}`);
    expect(email.text).toContain('Hi Karina,');
    expect(email.text).toContain('The offer ends at 11:00 AM.');
    expect(email.html).toContain(`href="${waitlistUrl('https://app.example', OFFER.token)}"`);
  });

  it('escapes names in the html and falls back without a name or services', () => {
    const named = renderWaitlistOfferEmail(
      { ...OFFER, clientName: '<b>Jo</b> Smith' },
      { appUrl: 'https://app.example' },
    );
    expect(named.html).toContain('Hi &lt;b&gt;Jo&lt;/b&gt;,');
    const bare = renderWaitlistOfferEmail(
      { ...OFFER, clientName: null, servicesLabel: null },
      { appUrl: 'https://app.example' },
    );
    expect(bare.text.startsWith('Hi,\n')).toBe(true);
    expect(bare.text).toContain('\nAppointment\n');
  });
});
