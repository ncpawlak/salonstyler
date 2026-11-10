import { describe, expect, it } from 'vitest';

import { offerText, waitlistUrl, windowLabel } from './offer-text';

const TOKEN = 'e'.repeat(64);

describe('waitlist offer text', () => {
  it('builds the link without a doubled slash', () => {
    expect(waitlistUrl(TOKEN, 'https://app.example.com/')).toBe(
      `https://app.example.com/w/${TOKEN}`,
    );
  });

  it('greets by first name with the time in the salon time zone and the link', () => {
    const text = offerText(
      {
        clientName: 'Karina Lopez',
        salonName: 'Studio K',
        timezone: 'America/Chicago',
        startsAt: '2026-12-18T20:30:00Z',
        token: TOKEN,
      },
      'https://app.example.com',
    );
    expect(text.startsWith('Hi Karina! A spot opened up at Studio K on ')).toBe(true);
    expect(text).toContain('2:30 PM');
    expect(text.endsWith(`https://app.example.com/w/${TOKEN}`)).toBe(true);
  });

  it('labels windows in 12-hour time', () => {
    expect(windowLabel('09:00:00', '12:30:00')).toBe('9:00 AM–12:30 PM');
    expect(windowLabel('13:00', '17:00')).toBe('1:00 PM–5:00 PM');
    expect(windowLabel(null, null)).toBeNull();
  });
});
