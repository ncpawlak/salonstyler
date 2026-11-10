import { describe, expect, it, vi } from 'vitest';

import {
  type ClientEmailRow,
  emailConfigFromEnv,
  formatWhen,
  renderClientEmail,
  resendTransport,
  runEmailer,
  toEmailMessage,
} from './client-email.ts';
import { buildIcs, foldLine, icsText } from './ics.ts';
import {
  buildMime,
  EmailSendError,
  encodeHeader,
  sendSmtp,
  type SmtpConn,
  type SmtpConnector,
} from './smtp.ts';

const row = (over: Partial<ClientEmailRow> = {}): ClientEmailRow => ({
  id: 'e1',
  kind: 'confirmation',
  to: 'karina@example.com',
  reminderHours: null,
  appointmentId: 'a1',
  salon: { name: 'Studio <B>', slug: 'studio-b', timezone: 'America/Chicago' },
  clientName: 'Karina Lopez',
  startsAt: '2026-11-13T20:00:00.000Z',
  endsAt: '2026-11-13T21:00:00.000Z',
  services: 'Haircut, Gloss',
  manageToken: 'ab'.repeat(32),
  sequence: 0,
  ...over,
});

const opts = { appUrl: 'https://app.example/', fromAddress: 'hello@studio.example' };

const decodeMimeParts = (mime: string) =>
  [
    ...mime.matchAll(
      /Content-Transfer-Encoding: base64\r\n(?:[^\r\n]+\r\n)*\r\n([A-Za-z0-9+/=\r\n]+)/g,
    ),
  ].map((m) => Buffer.from((m[1] ?? '').replace(/\r\n/g, ''), 'base64').toString('utf8'));

describe('ics', () => {
  it('builds a stable, updatable event', () => {
    const ics = buildIcs({
      uid: 'a1@chairside',
      sequence: 2,
      method: 'REQUEST',
      start: new Date('2026-11-13T20:00:00Z'),
      end: new Date('2026-11-13T21:00:00Z'),
      summary: 'Cut, color; and more',
      organizer: { name: 'Studio "B"', email: 'hello@studio.example' },
      attendee: { email: 'k@example.com' },
      now: new Date('2026-11-01T00:00:00Z'),
    });
    expect(ics).toContain('METHOD:REQUEST\r\n');
    expect(ics).toContain('UID:a1@chairside\r\n');
    expect(ics).toContain('SEQUENCE:2\r\n');
    expect(ics).toContain('DTSTART:20261113T200000Z\r\n');
    expect(ics).toContain('DTEND:20261113T210000Z\r\n');
    expect(ics).toContain('SUMMARY:Cut\\, color\\; and more\r\n');
    expect(ics).toContain('ORGANIZER;CN="Studio  B":mailto:hello@studio.example');
    expect(ics).toContain('STATUS:CONFIRMED');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('cancels with the same UID', () => {
    const ics = buildIcs({
      uid: 'a1@chairside',
      sequence: 3,
      method: 'CANCEL',
      start: new Date('2026-11-13T20:00:00Z'),
      end: new Date('2026-11-13T21:00:00Z'),
      summary: 'Cut',
    });
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).not.toContain('VALARM');
  });

  it('escapes text and folds long lines on character boundaries', () => {
    expect(icsText('a\\b\nc')).toBe('a\\\\b\\nc');
    const folded = foldLine(`SUMMARY:${'é'.repeat(80)}`);
    for (const line of folded.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, '')).toBe(`SUMMARY:${'é'.repeat(80)}`);
  });
});

describe('renderClientEmail', () => {
  it('formats the time in the salon timezone', () => {
    expect(formatWhen('2026-11-13T20:00:00.000Z', 'America/Chicago')).toBe(
      'Fri, Nov 13 at 2:00 PM',
    );
  });

  it('confirms with the manage link and an invite', () => {
    const r = renderClientEmail(row(), opts);
    expect(r.subject).toBe("You're booked at Studio <B>: Fri, Nov 13 at 2:00 PM");
    const link = `https://app.example/m/${'ab'.repeat(32)}`;
    expect(r.text).toContain(link);
    expect(r.html).toContain(`href="${link}"`);
    expect(r.html).toContain('Studio &lt;B&gt;');
    expect(r.html).not.toContain('<B>');
    expect(r.ics?.method).toBe('REQUEST');
    expect(r.ics?.content).toContain('UID:a1@chairside');
  });

  it('words reminders by lead time and skips the invite', () => {
    expect(renderClientEmail(row({ kind: 'reminder', reminderHours: 48 }), opts).subject).toBe(
      'Reminder: Studio <B> in 2 days, Fri, Nov 13 at 2:00 PM',
    );
    const r = renderClientEmail(row({ kind: 'reminder', reminderHours: 2 }), opts);
    expect(r.subject).toContain('in 2 hours');
    expect(r.ics).toBeUndefined();
    expect(renderClientEmail(row({ kind: 'reminder', reminderHours: 24 }), opts).subject).toContain(
      'tomorrow',
    );
  });

  it('sends updated invites for moves and cancellations', () => {
    const moved = renderClientEmail(row({ kind: 'rescheduled', sequence: 1 }), opts);
    expect(moved.subject).toBe('Your Studio <B> appointment moved to Fri, Nov 13 at 2:00 PM');
    expect(moved.ics?.content).toContain('SEQUENCE:1');
    const cancelled = renderClientEmail(row({ kind: 'cancellation', sequence: 2 }), opts);
    expect(cancelled.ics?.method).toBe('CANCEL');
    expect(cancelled.text).toContain('https://app.example/b/studio-b');
    expect(cancelled.text).not.toContain('/m/');
  });

  it('links the forms page without an invite', () => {
    const r = renderClientEmail(row({ kind: 'forms_request' }), opts);
    expect(r.subject).toBe('Before your visit: a quick form from Studio <B>');
    expect(r.text).toContain('Fill out your forms: https://app.example/f/');
    expect(r.text).not.toContain('/m/');
    expect(r.html).toContain('Studio &lt;B&gt;');
    expect(r.ics).toBeUndefined();
  });
});

describe('mime', () => {
  it('builds text, html and the invite attachment', () => {
    const r = renderClientEmail(row(), opts);
    const mime = buildMime(
      toEmailMessage({ ...row(), to: 'karina@example.com' }, r, 'Studio B <hello@studio.example>'),
    );
    expect(mime).toContain('From: Studio B <hello@studio.example>');
    expect(mime).toContain('To: Karina Lopez <karina@example.com>');
    expect(mime).toContain(
      'Content-Type: text/calendar; method=REQUEST; charset=utf-8; name="invite.ics"',
    );
    const parts = decodeMimeParts(mime);
    expect(parts[0]).toContain('Fri, Nov 13 at 2:00 PM');
    expect(parts[1]).toContain('<!doctype html>');
    expect(parts[2]).toContain('BEGIN:VCALENDAR');
  });

  it('encodes non-ASCII headers', () => {
    expect(encodeHeader('Hello')).toBe('Hello');
    expect(encodeHeader('Café')).toBe('=?UTF-8?B?Q2Fmw6k=?=');
  });
});

/** A scripted SMTP server: replies to each command in order and records what it received. */
function fakeSmtp(script: Record<string, string>) {
  const received: string[] = [];
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let pending: string[] = ['220 mail.test ESMTP\r\n'];
  let inData = false;
  let dataBuf = '';
  let closed = false;
  const respond = (line: string) => {
    const verb = line.split(/[ :]/)[0]!.toUpperCase();
    pending.push(script[verb] ?? '250 OK\r\n');
  };
  const conn: SmtpConn = {
    async read(p) {
      if (pending.length === 0) return closed ? null : 0;
      const bytes = enc.encode(pending.shift()!);
      p.set(bytes);
      return bytes.length;
    },
    async write(p) {
      let text = dec.decode(p);
      if (inData) {
        dataBuf += text;
        const end = dataBuf.indexOf('\r\n.\r\n');
        if (end === -1) return p.length;
        received.push(`DATA:${dataBuf.slice(0, end)}`);
        inData = false;
        text = dataBuf.slice(end + 5);
        dataBuf = '';
        pending.push(script['.'] ?? '250 2.0.0 Ok: queued as ABC123\r\n');
      }
      for (const line of text.split('\r\n').filter(Boolean)) {
        received.push(line);
        respond(line);
        if (line === 'DATA' && (script.DATA ?? '354').startsWith('354')) inData = true;
      }
      return p.length;
    },
    close() {
      closed = true;
      pending = [];
    },
  };
  const connector: SmtpConnector = {
    connect: vi.fn(async () => conn),
    startTls: vi.fn(async (c: SmtpConn) => c),
  };
  return { connector, received };
}

const message = {
  from: 'Studio <hello@studio.example>',
  to: 'Karina <karina@example.com>',
  subject: 'Hi',
  text: 'line one\n.starts with a dot',
  html: '<p>hi</p>',
};

describe('sendSmtp', () => {
  it('speaks SMTP with STARTTLS and AUTH', async () => {
    const { connector, received } = fakeSmtp({
      EHLO: '250-mail.test\r\n250 STARTTLS\r\n',
      STARTTLS: '220 Ready\r\n',
      AUTH: '235 OK\r\n',
      DATA: '354 Go\r\n',
    });
    const result = await sendSmtp(
      { host: 'mail.test', port: 587, security: 'starttls', user: 'u', pass: 'p' },
      connector,
      message,
    );
    expect(result.id).toBe('ABC123');
    expect(connector.startTls).toHaveBeenCalled();
    const commands = received.filter((r) => !r.startsWith('DATA:'));
    expect(commands).toEqual([
      'EHLO chairside',
      'STARTTLS',
      'EHLO chairside',
      `AUTH PLAIN ${Buffer.from('\0u\0p').toString('base64')}`,
      'MAIL FROM:<hello@studio.example>',
      'RCPT TO:<karina@example.com>',
      'DATA',
      'QUIT',
    ]);
    expect(received.find((r) => r.startsWith('DATA:'))).toContain('Subject: Hi');
  });

  it('treats 5xx as permanent and 4xx as retryable', async () => {
    const bad = fakeSmtp({ RCPT: '550 No such user\r\n' });
    await expect(
      sendSmtp({ host: 'h', port: 1025, security: 'none' }, bad.connector, message),
    ).rejects.toMatchObject({ permanent: true });
    const busy = fakeSmtp({ MAIL: '451 Try later\r\n' });
    await expect(
      sendSmtp({ host: 'h', port: 1025, security: 'none' }, busy.connector, message),
    ).rejects.toMatchObject({ permanent: false });
  });
});

describe('resendTransport', () => {
  it('posts the message with the invite attached', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 're_1' }), { status: 200 }));
    const send = resendTransport('key', fetch);
    const res = await send({
      ...message,
      attachments: [{ filename: 'invite.ics', contentType: 'text/calendar', content: 'X' }],
    });
    expect(res.id).toBe('re_1');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer key' });
    const body = JSON.parse(String(init.body));
    expect(body.to).toEqual(['Karina <karina@example.com>']);
    expect(body.attachments).toEqual([
      { filename: 'invite.ics', content: 'WA==', content_type: 'text/calendar' },
    ]);
  });

  it('classifies failures', async () => {
    const reject = resendTransport(
      'k',
      async () => new Response('{"message":"bad"}', { status: 422 }),
    );
    await expect(reject(message)).rejects.toMatchObject({ permanent: true });
    const limited = resendTransport('k', async () => new Response('{}', { status: 429 }));
    await expect(limited(message)).rejects.toMatchObject({ permanent: false });
  });
});

describe('emailConfigFromEnv', () => {
  const connector = fakeSmtp({}).connector;
  it('needs a sender and the app URL', () => {
    expect(emailConfigFromEnv({ RESEND_API_KEY: 'k' })).toBeNull();
    expect(emailConfigFromEnv({ EMAIL_FROM: 'a@b.c', PUBLIC_APP_URL: 'https://x' })).toBeNull();
  });
  it('prefers Resend, else SMTP', () => {
    const base = { EMAIL_FROM: 'a@b.c', PUBLIC_APP_URL: 'https://x' };
    expect(
      emailConfigFromEnv({ ...base, RESEND_API_KEY: 'k', SMTP_HOST: 'h' }, { connector })?.provider,
    ).toBe('resend');
    expect(emailConfigFromEnv({ ...base, SMTP_HOST: 'h' }, { connector })?.provider).toBe('smtp');
  });
});

describe('runEmailer', () => {
  it('sends, skips rows without an address and retries failures', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({ id: 'p1' })
      .mockRejectedValueOnce(new EmailSendError('down'))
      .mockRejectedValueOnce(new EmailSendError('bad address', true));
    const finish = vi.fn(async () => {});
    const claim = vi
      .fn()
      .mockResolvedValueOnce([
        row({ id: '1' }),
        row({ id: '2', to: null }),
        row({ id: '3' }),
        row({ id: '4' }),
      ])
      .mockResolvedValue([]);
    const summary = await runEmailer({
      claim,
      finish,
      config: {
        from: 'Studio <hello@studio.example>',
        appUrl: 'https://x',
        transport,
        provider: 'smtp',
      },
      batchSize: 4,
    });
    expect(summary).toEqual({ claimed: 4, sent: 1, skipped: 2, retried: 1 });
    expect(finish).toHaveBeenCalledWith([
      { id: '1', outcome: 'sent', providerId: 'p1' },
      { id: '2', outcome: 'skipped', error: 'no_email' },
      { id: '3', outcome: 'retry', error: 'down' },
      { id: '4', outcome: 'skipped', error: 'bad address' },
    ]);
    expect(claim).toHaveBeenCalledTimes(2);
  });
});
