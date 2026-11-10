import { describe, expect, it, vi } from 'vitest';

import { resendTransport } from './client-email.ts';
import {
  fillMarketingPlaceholders,
  type MarketingEmailInput,
  renderMarketingEmail,
} from './marketing-email.ts';
import { buildMime } from './smtp.ts';

const TOKEN = 'a'.repeat(64);

const nudge = (over: Partial<MarketingEmailInput> = {}): MarketingEmailInput => ({
  kind: 'rebook_nudge',
  subject: 'Time for a touch-up, {firstName}?',
  body: 'Hi {firstName}, it has been about 6 weeks.\n\nGrab a time: {bookingLink}',
  clientName: 'Karina Lopez',
  unsubscribeToken: TOKEN,
  reviewUrl: null,
  salon: { name: 'Studio <B>', slug: 'studio-b' },
  ...over,
});

const opts = { appUrl: 'https://app.example/' };

describe('fillMarketingPlaceholders', () => {
  it('fills known placeholders and leaves typos visible', () => {
    expect(
      fillMarketingPlaceholders('Hi {firstName} from {salonName} {reviewLink} {oops}', {
        firstName: null,
        salonName: 'Studio B',
        bookingLink: 'b',
        reviewLink: 'https://g.page/r/x',
      }),
    ).toBe('Hi there from Studio B https://g.page/r/x {oops}');
  });
});

describe('renderMarketingEmail', () => {
  it('fills the copy, links the booking page and adds the unsubscribe footer', () => {
    const r = renderMarketingEmail(nudge(), opts);
    expect(r.subject).toBe('Time for a touch-up, Karina?');
    expect(r.text).toContain('Hi Karina, it has been about 6 weeks.');
    expect(r.text).toContain('Grab a time: https://app.example/b/studio-b');
    // The body already has the booking link, so no extra button.
    expect(r.text).not.toContain('Book your next visit');
    expect(r.text).toContain(`Unsubscribe: https://app.example/u/${TOKEN}`);
    expect(r.html).toContain('<a href="https://app.example/b/studio-b"');
    expect(r.html).toContain(`href="https://app.example/u/${TOKEN}"`);
    expect(r.html).toContain('Studio &lt;B&gt;');
    expect(r.headers).toEqual({ 'List-Unsubscribe': `<https://app.example/u/${TOKEN}>` });
  });

  it('offers RFC 8058 one-click unsubscribe when the function URL is known', () => {
    const r = renderMarketingEmail(nudge(), {
      ...opts,
      functionsUrl: 'https://x.supabase.co/functions/v1/marketing',
    });
    expect(r.headers).toEqual({
      'List-Unsubscribe': `<https://x.supabase.co/functions/v1/marketing?token=${TOKEN}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('adds a review button for review requests', () => {
    const r = renderMarketingEmail(
      nudge({
        kind: 'review_request',
        subject: 'Thanks for coming in!',
        body: 'Would you leave {salonName} a quick review?',
        reviewUrl: 'https://g.page/r/abc/review',
      }),
      opts,
    );
    expect(r.text).toContain('Leave a review: https://g.page/r/abc/review');
    expect(r.html).toContain('href="https://g.page/r/abc/review"');
  });

  it('adds a booking button to campaigns without a link and escapes the copy', () => {
    const r = renderMarketingEmail(
      nudge({ kind: 'campaign', subject: 'Holiday hours', body: 'Open Dec 24 <9-2>!' }),
      opts,
    );
    expect(r.text).toContain('Book your next visit: https://app.example/b/studio-b');
    expect(r.html).toContain('Open Dec 24 &lt;9-2&gt;!');
  });
});

describe('custom headers', () => {
  const message = {
    from: 'Studio <hello@studio.example>',
    to: 'karina@example.com',
    subject: 'Hi',
    text: 't',
    html: '<p>h</p>',
    headers: {
      'List-Unsubscribe': '<https://app.example/u/x>',
      'Bad Header': 'dropped',
      'X-Injected': 'a\r\nBcc: evil@example.com',
    },
  };

  it('are written to the MIME message, one line each', () => {
    const mime = buildMime(message);
    expect(mime).toContain('List-Unsubscribe: <https://app.example/u/x>\r\n');
    expect(mime).not.toContain('Bad Header');
    expect(mime).toContain('X-Injected: a Bcc: evil@example.com\r\n');
  });

  it('are passed to Resend', async () => {
    const fetch = vi.fn(async () => new Response('{"id":"re_1"}', { status: 200 }));
    await resendTransport('key', fetch)(message);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).headers).toEqual(message.headers);
  });
});
