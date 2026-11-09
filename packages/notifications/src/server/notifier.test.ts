import { describe, expect, it, vi } from 'vitest';

import { EXPO_PUSH_URL, type FetchLike, sendExpoPush } from './expo.ts';
import {
  type NotificationResult,
  type NotifierDeps,
  type OutboxRow,
  type PushTokenRow,
  runNotifier,
} from './notifier.ts';

const row = (id: string, overrides: Partial<OutboxRow> = {}): OutboxRow => ({
  id,
  salon_id: 's1',
  user_id: 'u1',
  kind: 'request',
  title: 'New request from Karina',
  body: 'Fri, Nov 13 at 2:00 PM · Balayage',
  category: 'appointmentRequest',
  data: { type: 'request', salonId: 's1', appointmentId: `appt-${id}` },
  ...overrides,
});

/** A mocked Expo Push API: answers each message via `ticketFor`, records every request. */
function mockExpo(
  ticketFor: (message: { to: string }) => unknown = () => ({ status: 'ok', id: 'ticket' }),
  response?: () => Response,
) {
  const requests: {
    url: string;
    init: RequestInit;
    messages: { to: string; categoryId?: string }[];
  }[] = [];
  const fetch: FetchLike = vi.fn(async (url: string, init: RequestInit) => {
    const messages = JSON.parse(String(init.body)) as { to: string }[];
    requests.push({ url, init, messages });
    if (response) return response();
    return new Response(JSON.stringify({ data: messages.map(ticketFor) }), { status: 200 });
  });
  return { fetch, requests };
}

function deps(
  queue: OutboxRow[][],
  tokens: PushTokenRow[],
  fetch: FetchLike,
): NotifierDeps & { finished: NotificationResult[]; deleted: string[] } {
  const finished: NotificationResult[] = [];
  const deleted: string[] = [];
  return {
    finished,
    deleted,
    fetch,
    expoAccessToken: 'expo-access',
    claim: vi.fn(async () => queue.shift() ?? []),
    tokensFor: vi.fn(async (recipients: { salonId: string; userId: string }[]) =>
      tokens.filter((t) =>
        recipients.some((r) => r.salonId === t.salon_id && r.userId === t.user_id),
      ),
    ),
    deleteTokens: vi.fn(async (t: string[]) => void deleted.push(...t)),
    finish: vi.fn(async (r: NotificationResult[]) => void finished.push(...r)),
  };
}

const token = (t: string, user = 'u1', salon = 's1'): PushTokenRow => ({
  salon_id: salon,
  user_id: user,
  token: t,
});

describe('sendExpoPush', () => {
  it('posts to the Expo push API with the access token', async () => {
    const expo = mockExpo();
    const tickets = await sendExpoPush([{ to: 'ExponentPushToken[a]', title: 't', body: 'b' }], {
      fetch: expo.fetch,
      accessToken: 'secret',
    });
    expect(tickets).toEqual([{ status: 'ok', id: 'ticket' }]);
    expect(expo.requests[0]?.url).toBe(EXPO_PUSH_URL);
    expect(expo.requests[0]?.init.method).toBe('POST');
    expect((expo.requests[0]?.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer secret',
    );
  });

  it('throws when Expo rejects the request', async () => {
    const expo = mockExpo(undefined, () =>
      Response.json(
        { errors: [{ code: 'TOO_MANY_REQUESTS', message: 'Slow down' }] },
        { status: 429 },
      ),
    );
    await expect(
      sendExpoPush([{ to: 'x', title: 't', body: 'b' }], { fetch: expo.fetch }),
    ).rejects.toThrow('Expo push failed: Slow down');
  });
});

describe('runNotifier', () => {
  it('sends each claimed notification to every device of its recipient with its category', async () => {
    const expo = mockExpo();
    const d = deps(
      [[row('n1')]],
      [token('ExponentPushToken[phone]'), token('ExponentPushToken[ipad]')],
      expo.fetch,
    );

    const summary = await runNotifier(d);

    expect(summary).toMatchObject({ claimed: 1, sent: 1, skipped: 0, retried: 0 });
    expect(expo.requests).toHaveLength(1);
    expect(expo.requests[0]?.messages).toEqual([
      expect.objectContaining({
        to: 'ExponentPushToken[phone]',
        title: 'New request from Karina',
        categoryId: 'appointmentRequest',
        data: { type: 'request', salonId: 's1', appointmentId: 'appt-n1', notificationId: 'n1' },
      }),
      expect.objectContaining({ to: 'ExponentPushToken[ipad]' }),
    ]);
    expect(d.finished).toEqual([
      { id: 'n1', outcome: 'sent', tickets: [expect.any(Object), expect.any(Object)] },
    ]);
  });

  it('only sends to the recipient’s own devices', async () => {
    const expo = mockExpo();
    const d = deps(
      [[row('n1'), row('n2', { user_id: 'u2' })]],
      [
        token('ExponentPushToken[u1]'),
        token('ExponentPushToken[u2]', 'u2'),
        token('ExponentPushToken[other]', 'u1', 's2'),
      ],
      expo.fetch,
    );
    await runNotifier(d);
    expect(
      expo.requests[0]?.messages.map((m) => [
        m.to,
        (m as { data?: { notificationId?: string } }).data?.notificationId,
      ]),
    ).toEqual([
      ['ExponentPushToken[u1]', 'n1'],
      ['ExponentPushToken[u2]', 'n2'],
    ]);
  });

  it('skips notifications for recipients without a push token', async () => {
    const expo = mockExpo();
    const d = deps([[row('n1')]], [], expo.fetch);
    const summary = await runNotifier(d);
    expect(expo.requests).toHaveLength(0);
    expect(summary.skipped).toBe(1);
    expect(d.finished).toEqual([{ id: 'n1', outcome: 'skipped', error: 'no_push_tokens' }]);
  });

  it('removes tokens Expo reports as DeviceNotRegistered', async () => {
    const expo = mockExpo((m) =>
      m.to.startsWith('ExponentPushToken[old')
        ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } }
        : { status: 'ok', id: 'ok' },
    );
    const d = deps(
      [[row('n1'), row('n2', { user_id: 'u2' })]],
      [
        token('ExponentPushToken[old]'),
        token('ExponentPushToken[new]'),
        token('ExponentPushToken[old2]', 'u2'),
      ],
      expo.fetch,
    );

    const summary = await runNotifier(d);

    expect(d.deleted.sort()).toEqual(['ExponentPushToken[old2]', 'ExponentPushToken[old]']);
    expect(summary).toMatchObject({ sent: 1, skipped: 1, removedTokens: 2 });
    expect(d.finished.find((r) => r.id === 'n2')).toMatchObject({
      outcome: 'skipped',
      error: 'device_not_registered',
    });
  });

  it('retries the batch when Expo is unavailable', async () => {
    const expo = mockExpo(undefined, () => new Response('upstream down', { status: 503 }));
    const d = deps([[row('n1')]], [token('ExponentPushToken[a]')], expo.fetch);
    const summary = await runNotifier(d);
    expect(summary.retried).toBe(1);
    expect(d.finished).toEqual([
      { id: 'n1', outcome: 'retry', error: 'Expo push failed: HTTP 503' },
    ]);
  });

  it('retries on a transient per-message error', async () => {
    const expo = mockExpo(() => ({
      status: 'error',
      message: 'Rate exceeded',
      details: { error: 'MessageRateExceeded' },
    }));
    const d = deps([[row('n1')]], [token('ExponentPushToken[a]')], expo.fetch);
    await runNotifier(d);
    expect(d.finished[0]).toMatchObject({ id: 'n1', outcome: 'retry', error: 'Rate exceeded' });
  });

  it('sends at most 100 messages per Expo request', async () => {
    const expo = mockExpo();
    const many = Array.from({ length: 150 }, (_, i) => token(`ExponentPushToken[${i}]`));
    const d = deps([[row('n1')]], many, expo.fetch);
    await runNotifier(d);
    expect(expo.requests.map((r) => r.messages.length)).toEqual([100, 50]);
    expect(d.finished).toHaveLength(1);
  });

  it('keeps claiming full batches until the outbox is drained', async () => {
    const expo = mockExpo();
    const d = deps([[row('a'), row('b')], [row('c')]], [token('ExponentPushToken[a]')], expo.fetch);
    d.batchSize = 2;
    const summary = await runNotifier(d);
    expect(summary).toMatchObject({ claimed: 3, sent: 3 });
    expect(d.claim).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the outbox is empty', async () => {
    const expo = mockExpo();
    const d = deps([], [], expo.fetch);
    expect(await runNotifier(d)).toEqual({
      claimed: 0,
      sent: 0,
      skipped: 0,
      retried: 0,
      removedTokens: 0,
    });
    expect(d.finish).not.toHaveBeenCalled();
  });
});
