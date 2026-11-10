import type {
  ClaimedMarketingMessage,
  MarketingSendOutcome,
  NudgeCandidate,
  RebookNudgeDraft,
} from '@chairside/db/marketing';
import { describe, expect, it, vi } from 'vitest';

import type { UsageEntry } from '../server/handler.ts';
import type { ChatResult, LLMProvider } from '../types.ts';
import { parseMarketingCopy, templateMarketingCopy } from './copy.ts';
import { handleMarketingRequest, type MarketingDeps } from './handler.ts';
import { draftRebookNudges, isNudgeDue, planRebookNudge } from './nudges.ts';
import type { MarketingChannelSender, MarketingPort } from './types.ts';

const SALON = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const TOKEN = 'b'.repeat(64);
const DAY = 86_400_000;
const NOW = Date.parse('2026-12-01T17:00:00Z');

const candidate = (over: Partial<NudgeCandidate> = {}): NudgeCandidate => ({
  salonId: SALON,
  timeZone: 'America/Chicago',
  leadDays: 3,
  clientId: 'client-1',
  clientName: 'Karina Lopez',
  visit: {
    appointmentId: 'appt-1',
    // A Tuesday, 4 weeks minus 2 days before NOW.
    startsAt: '2026-11-03T16:00:00Z',
    serviceIds: ['root'],
  },
  history: [],
  services: [{ id: 'root', name: 'Root touch-up', category: 'color', rebookIntervalDays: null }],
  ...over,
});

describe('rebook nudges', () => {
  it('uses the rebook engine: a root touch-up is due back in 4 weeks', () => {
    const plan = planRebookNudge(candidate())!;
    expect(plan.interval).toMatchObject({ days: 28, source: 'typical' });
    expect(plan.targetDate).toBe('2026-12-01');
    expect(plan.sendFrom).toBe('2026-11-28');
  });

  it('prefers the client’s own rhythm and the owner’s setting', () => {
    const own = planRebookNudge(
      candidate({
        history: [
          { startsAt: '2026-08-11T16:00:00Z', serviceIds: ['root'] },
          { startsAt: '2026-09-22T16:00:00Z', serviceIds: ['root'] },
          { startsAt: '2026-11-03T16:00:00Z', serviceIds: ['root'] },
        ],
      }),
    )!;
    expect(own.interval).toMatchObject({ days: 42, source: 'client' });
    const owner = planRebookNudge(
      candidate({
        services: [{ id: 'root', name: 'Root touch-up', category: null, rebookIntervalDays: 35 }],
      }),
    )!;
    expect(owner.interval).toMatchObject({ days: 35, source: 'service' });
  });

  it('is due from lead days before the date until a month after', () => {
    const plan = planRebookNudge(candidate())!;
    expect(isNudgeDue(plan, '2026-11-27')).toBe(false);
    expect(isNudgeDue(plan, '2026-11-28')).toBe(true);
    expect(isNudgeDue(plan, '2026-12-31')).toBe(true);
    expect(isNudgeDue(plan, '2027-01-01')).toBe(false);
  });

  it('drafts copy only for clients due today', () => {
    const notYet = candidate({
      clientId: 'client-2',
      visit: { appointmentId: 'appt-2', startsAt: '2026-11-24T16:00:00Z', serviceIds: ['root'] },
    });
    const drafts = draftRebookNudges([candidate(), notYet], NOW - 2 * DAY);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      clientId: 'client-1',
      appointmentId: 'appt-1',
      subject: 'Time for a touch-up?',
      meta: { serviceName: 'Root touch-up', intervalDays: 28, dueOn: '2026-12-01' },
    });
    expect(drafts[0]!.body).toContain('Hi {firstName},');
    expect(drafts[0]!.body).toContain(
      "Your Root touch-up usually lasts about 4 weeks, so you're due for the next one around Tuesday, December 1.",
    );
    expect(drafts[0]!.body).toContain('{bookingLink}');
  });

  it('skips visits with no services', () => {
    expect(
      draftRebookNudges(
        [candidate({ visit: { appointmentId: 'a', startsAt: '2026-09-01', serviceIds: [] } })],
        NOW,
      ),
    ).toEqual([]);
  });
});

describe('copy', () => {
  it('parses the model’s JSON and rejects junk', () => {
    expect(parseMarketingCopy('```json\n{"subject":"Hi","body":"Body"}\n```')).toEqual({
      subject: 'Hi',
      body: 'Body',
    });
    expect(parseMarketingCopy('no json')).toBeNull();
    expect(parseMarketingCopy('{"subject":""}')).toBeNull();
  });

  it('templates use the brief and the placeholders', () => {
    const copy = templateMarketingCopy({
      kind: 'campaign',
      salonName: 'Studio B',
      brief: 'Open late on Dec 23!',
    });
    expect(copy.body).toContain('Open late on Dec 23!');
    expect(copy.body).toContain('{bookingLink}');
    expect(templateMarketingCopy({ kind: 'review_request', salonName: 'S' }).body).toContain(
      '{reviewLink}',
    );
  });
});

function fakePort(over: Partial<MarketingPort> = {}) {
  const saved: RebookNudgeDraft[][] = [];
  const finished: MarketingSendOutcome[][] = [];
  const port: MarketingPort = {
    nudgeCandidates: vi.fn(async () => []),
    saveNudges: vi.fn(async (nudges) => {
      saved.push(nudges);
      return { saved: nudges.length, queued: 0 };
    }),
    claim: vi.fn(async () => []),
    finish: vi.fn(async (results) => {
      finished.push(results);
      return results.length;
    }),
    getSubscription: vi.fn(async (t) =>
      t === TOKEN ? { salonName: 'Studio B', clientFirstName: 'Karina', subscribed: true } : null,
    ),
    setSubscription: vi.fn(async (t, subscribed) =>
      t === TOKEN ? { salonName: 'Studio B', clientFirstName: 'Karina', subscribed } : null,
    ),
    hitRateLimit: vi.fn(async () => true),
    salonName: vi.fn(async () => 'Studio B'),
    ...over,
  };
  return { port, saved, finished };
}

const claimed = (id: string, over: Partial<ClaimedMarketingMessage> = {}) =>
  ({
    id,
    kind: 'rebook_nudge',
    channel: 'email',
    to: 'karina@example.com',
    subject: 'Time for a touch-up?',
    body: 'Hi {firstName}',
    clientName: 'Karina',
    unsubscribeToken: TOKEN,
    reviewUrl: null,
    salon: { name: 'Studio B', slug: 'studio-b', timezone: 'America/Chicago' },
    ...over,
  }) satisfies ClaimedMarketingMessage;

const trusted = { ip: '1.2.3.4', trusted: true };
const anon = { ip: '1.2.3.4', trusted: false };

describe('handleMarketingRequest', () => {
  it('scan and send need the shared secret', async () => {
    const { port } = fakePort();
    for (const action of ['scan', 'send']) {
      const r = await handleMarketingRequest({ action }, anon, { port, channels: [] });
      expect(r.status).toBe(401);
    }
  });

  it('scan pages through candidates and saves the due nudges', async () => {
    const page = Array.from({ length: 200 }, (_, i) =>
      candidate({ clientId: `c${i}`, visit: { ...candidate().visit, appointmentId: `a${i}` } }),
    );
    const nudgeCandidates = vi
      .fn<MarketingPort['nudgeCandidates']>()
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([candidate({ clientId: 'last' })]);
    const { port, saved } = fakePort({ nudgeCandidates });
    const r = await handleMarketingRequest({ action: 'scan' }, trusted, {
      port,
      channels: [],
      now: () => NOW,
    });
    expect(r).toEqual({ status: 200, body: { candidates: 201, saved: 201, queued: 0 } });
    expect(nudgeCandidates).toHaveBeenCalledTimes(2);
    expect(nudgeCandidates.mock.calls[1]).toEqual([
      200,
      { startsAt: '2026-11-03T16:00:00Z', clientId: 'c199' },
    ]);
    expect(saved[0]).toHaveLength(200);
  });

  it('send delivers through the channel and reports outcomes', async () => {
    const claim = vi
      .fn<MarketingPort['claim']>()
      .mockResolvedValueOnce([claimed('m1'), claimed('m2'), claimed('m3')]);
    const { port, finished } = fakePort({ claim });
    const send = vi.fn<MarketingChannelSender['send']>(async (m) => {
      if (m.id === 'm2') throw Object.assign(new Error('bad address'), { permanent: true });
      if (m.id === 'm3') throw new Error('timeout');
      return { providerId: 're_1' };
    });
    const r = await handleMarketingRequest({ action: 'send' }, trusted, {
      port,
      channels: [{ channel: 'email', send }],
    });
    expect(r).toEqual({ status: 200, body: { claimed: 3, sent: 1, skipped: 1, retried: 1 } });
    expect(claim).toHaveBeenCalledWith(['email'], 50);
    expect(finished[0]).toEqual([
      { id: 'm1', outcome: 'sent', providerId: 're_1' },
      { id: 'm2', outcome: 'skipped', error: 'bad address' },
      { id: 'm3', outcome: 'retry', error: 'timeout' },
    ]);
  });

  it('send claims nothing without a channel (SMS waits for #22)', async () => {
    const { port } = fakePort();
    const r = await handleMarketingRequest({ action: 'send' }, trusted, { port, channels: [] });
    expect(r).toEqual({ status: 200, body: { claimed: 0, sent: 0, skipped: 0, retried: 0 } });
    expect(port.claim).not.toHaveBeenCalled();
  });

  it('the unsubscribe link only needs the token', async () => {
    const { port } = fakePort();
    const deps = { port, channels: [] };
    expect(await handleMarketingRequest({ action: 'view', token: TOKEN }, anon, deps)).toEqual({
      status: 200,
      body: {
        subscription: { salonName: 'Studio B', clientFirstName: 'Karina', subscribed: true },
      },
    });
    const off = await handleMarketingRequest({ action: 'unsubscribe', token: TOKEN }, anon, deps);
    expect(off).toMatchObject({ status: 200, body: { subscription: { subscribed: false } } });
    expect(port.setSubscription).toHaveBeenCalledWith(TOKEN, false);
    const on = await handleMarketingRequest({ action: 'resubscribe', token: TOKEN }, anon, deps);
    expect(on).toMatchObject({ status: 200, body: { subscription: { subscribed: true } } });
    const missing = await handleMarketingRequest(
      { action: 'unsubscribe', token: 'c'.repeat(64) },
      anon,
      deps,
    );
    expect(missing.status).toBe(404);
    const bad = await handleMarketingRequest({ action: 'view', token: 'x' }, anon, deps);
    expect(bad.status).toBe(400);
  });

  it('rate limits the link', async () => {
    const { port } = fakePort({ hitRateLimit: vi.fn(async () => false) });
    const r = await handleMarketingRequest({ action: 'unsubscribe', token: TOKEN }, anon, {
      port,
      channels: [],
    });
    expect(r.status).toBe(429);
    expect(port.setSubscription).not.toHaveBeenCalled();
  });

  describe('draft_copy', () => {
    function ai(reply: ChatResult | Error | null, over: Partial<MarketingDeps['ai']> = {}) {
      const usage: UsageEntry[] = [];
      const chat = vi.fn<LLMProvider['chat']>(async () => {
        if (reply instanceof Error) throw reply;
        return reply!;
      });
      const deps: NonNullable<MarketingDeps['ai']> = {
        getMemberRole: async () => 'stylist',
        loadConfig: async () => ({
          provider: 'openai',
          model: 'gpt-test',
          apiKey: 'sk-test-0123456789abcdefghij',
          monthlyTokenBudget: 100_000,
        }),
        tokensUsedThisMonth: async () => 0,
        recordUsage: async (e) => {
          usage.push(e);
        },
        createProvider: (id, o) => ({ id, model: o.model, chat }),
        ...over,
      };
      return { deps, usage, chat };
    }
    const text = (t: string): ChatResult => ({
      type: 'text',
      text: t,
      toolCalls: [],
      provider: 'openai',
      model: 'gpt-test',
      finishReason: 'stop',
      usage: { inputTokens: 300, outputTokens: 80, totalTokens: 380 },
    });
    const body = { action: 'draft_copy', salonId: SALON, kind: 'campaign', brief: 'Open Dec 26' };

    it('words the brief with AI and meters it', async () => {
      const { port } = fakePort();
      const { deps, usage, chat } = ai(
        text('{"subject":"Holiday hours","body":"Hi {firstName}, we are open Dec 26."}'),
      );
      const r = await handleMarketingRequest(body, anon, { port, channels: [], ai: deps });
      expect(r).toEqual({
        status: 200,
        body: {
          subject: 'Holiday hours',
          body: 'Hi {firstName}, we are open Dec 26.',
          source: 'ai',
        },
      });
      const [messages] = chat.mock.calls[0]!;
      expect(messages[0]!.content).toContain('[marketing-copy]');
      expect(messages[0]!.content).toContain('Studio B');
      expect(messages[1]!.content).toContain('Open Dec 26');
      expect(usage).toEqual([
        expect.objectContaining({ purpose: 'marketing_copy', inputTokens: 300 }),
      ]);
    });

    it('falls back to the template without AI, on errors or junk', async () => {
      const { port } = fakePort();
      for (const deps of [
        ai(null, { loadConfig: async () => null }).deps,
        ai(new Error('boom')).deps,
        ai(text('sorry')).deps,
        ai(null, { tokensUsedThisMonth: async () => 1e9 }).deps,
      ]) {
        const r = await handleMarketingRequest(body, anon, { port, channels: [], ai: deps });
        expect(r).toMatchObject({ status: 200, body: { source: 'template' } });
        expect((r.body as { body: string }).body).toContain('Open Dec 26');
      }
    });

    it('needs a member', async () => {
      const { port } = fakePort();
      expect((await handleMarketingRequest(body, anon, { port, channels: [] })).status).toBe(401);
      const { deps } = ai(null, { getMemberRole: async () => null });
      const r = await handleMarketingRequest(body, anon, { port, channels: [], ai: deps });
      expect(r.status).toBe(403);
    });
  });
});
