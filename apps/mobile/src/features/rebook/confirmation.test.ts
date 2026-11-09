import { describe, expect, it } from 'vitest';

import { rebookConfirmationLinks, rebookConfirmationMessage } from './confirmation';

const base = {
  clientName: 'Karina Lopez',
  salonName: 'Glow Studio',
  startsAt: '2026-04-17T14:00:00Z',
  timeZone: 'America/New_York',
};

describe('rebookConfirmationMessage', () => {
  it('confirms a booked visit in the salon time zone', () => {
    expect(rebookConfirmationMessage({ ...base, held: false })).toBe(
      "Hi Karina! You're booked for your next visit at Glow Studio: Fri, Apr 17 at 10:00 AM. See you then!",
    );
  });

  it('asks the client to confirm a hold', () => {
    expect(rebookConfirmationMessage({ ...base, clientName: null, held: true })).toBe(
      "Hi! I'm holding Fri, Apr 17 at 10:00 AM for your next visit at Glow Studio. Reply YES to confirm.",
    );
  });
});

describe('rebookConfirmationLinks', () => {
  const message = 'See you Fri & soon?';

  it('prefills sms and email', () => {
    const links = rebookConfirmationLinks({
      message,
      salonName: 'Glow Studio',
      phone: '+15551234567',
      email: 'k@example.com',
      platform: 'android',
    });
    expect(links.sms).toBe(`sms:+15551234567?body=${encodeURIComponent(message)}`);
    expect(links.email).toBe(
      `mailto:k@example.com?subject=Your%20next%20visit%20at%20Glow%20Studio&body=${encodeURIComponent(message)}`,
    );
  });

  it('uses &body on iOS', () => {
    const links = rebookConfirmationLinks({ message, salonName: 'S', platform: 'ios' });
    expect(links.sms.startsWith('sms:&body=')).toBe(true);
  });
});
