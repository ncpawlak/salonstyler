import { describe, expect, it } from 'vitest';

import { firstName, manageBookingUrl, reminderText } from './reminder-text';

const TOKEN = 'f'.repeat(64);

describe('reminder text', () => {
  it('builds the manage link without a doubled slash', () => {
    expect(manageBookingUrl(TOKEN, 'https://app.example.com/')).toBe(
      `https://app.example.com/m/${TOKEN}`,
    );
  });

  it('greets by first name, in the salon time zone, with the link', () => {
    const text = reminderText(
      {
        clientName: '  Karina  Lopez ',
        startsAt: '2026-12-18T16:00:00Z',
        services: 'All-over Color',
        manageToken: TOKEN,
      },
      'Studio K',
      'America/Chicago',
      'https://app.example.com',
    );
    expect(text).toBe(
      'Hi Karina! Reminder: you’re booked at Studio K for All-over Color on Fri, Dec 18 at ' +
        `10:00 AM. Need to change it? https://app.example.com/m/${TOKEN}`,
    );
  });

  it('handles walk-ins and missing services', () => {
    expect(firstName(null)).toBeNull();
    expect(firstName('   ')).toBeNull();
    const text = reminderText(
      { clientName: null, startsAt: '2026-12-18T16:00:00Z', services: null, manageToken: TOKEN },
      'Studio K',
      'America/Chicago',
      'https://x.test',
    );
    expect(text.startsWith('Hi! Reminder: you’re booked at Studio K on Fri')).toBe(true);
  });
});
