import { describe, expect, it } from 'vitest';

import { AiProviderError } from '../http.ts';
import {
  appointment,
  COLOR,
  createFakePort,
  CUT,
  KARINA,
  MENU,
  NOW,
  TZ,
} from '../assistant/fake-salon.ts';
import type { StoredAiConfig, UsageEntry } from '../server/handler.ts';
import type { ChatResult, LLMProvider } from '../types.ts';
import {
  type InboxServiceDeps,
  handleInboxRequest,
  isAffirmative,
  matchClient,
} from './handler.ts';
import { fakeInboxPort } from './fake-inbox.ts';
import { demoParse, normalizeParsed, type InboxParseContext } from './parse.ts';
import {
  formatPhone,
  inboxDedupeKey,
  isPhoneLike,
  normalizePhone,
  phonesMatch,
  stripKeyword,
} from './text.ts';

const SALON = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const TOKEN = 'csb_test-token';
const KEY = 'sk-saved-key-0123456789abcdef';

/** A model stand-in that answers with one `submit_request` call (or plain text). */
function fakeLlm(answer: Record<string, unknown> | string): LLMProvider {
  return {
    id: 'anthropic',
    model: 'claude-haiku-4-5',
    async chat(): Promise<ChatResult> {
      const base = {
        provider: 'anthropic' as const,
        model: 'claude-haiku-4-5',
        usage: { inputTokens: 300, outputTokens: 40, totalTokens: 340 },
      };
      return typeof answer === 'string'
        ? { ...base, finishReason: 'stop', type: 'text', text: answer, toolCalls: [] }
        : {
            ...base,
            finishReason: 'tool_calls',
            type: 'tool_calls',
            text: null,
            toolCalls: [{ id: 'c1', name: 'submit_request', arguments: answer }],
          };
    },
  };
}

function setup(
  options: {
    llm?: LLMProvider;
    demo?: boolean;
    config?: StoredAiConfig | null;
    used?: number;
    rateLimited?: boolean;
    autoReply?: boolean;
  } = {},
) {
  const port = fakeInboxPort();
  const usage: UsageEntry[] = [];
  const versions: (string | null)[] = [];
  const tested: string[] = [];
  const config =
    options.config === undefined
      ? {
          provider: 'anthropic' as const,
          model: 'claude-haiku-4-5',
          apiKey: KEY,
          monthlyTokenBudget: 10_000,
        }
      : options.config;
  const deps: InboxServiceDeps = {
    authenticate: async (token, meta) => {
      if (token !== TOKEN) return null;
      versions.push(meta.bridgeVersion);
      return {
        salonId: SALON,
        keyword: 'Chairside',
        rateLimited: options.rateLimited ?? false,
        autoReply: options.autoReply ?? false,
        salonName: 'Studio K',
      };
    },
    markTested: async (salonId) => void tested.push(salonId),
    createPort: () => port,
    loadConfig: async () => config,
    tokensUsedThisMonth: async () => options.used ?? 0,
    recordUsage: async (e) => void usage.push(e),
    createProvider: () => options.llm ?? fakeLlm({ intent: 'ignore' }),
    demo: options.demo,
    now: () => NOW,
  };
  return { deps, port, usage, versions, tested };
}

const body = (text: string, extra: Record<string, unknown> = {}) => ({
  sender: 'Karina',
  senderPhone: '555-0101',
  text,
  receivedAt: '2026-12-01T09:03:22-06:00',
  bridgeVersion: '1',
  ...extra,
});

const local = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    timeZone: TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

describe('text helpers', () => {
  it('strips the keyword and its autocorrect variants, never requiring it', () => {
    expect(stripKeyword('Chairside can I get a cut')).toBe('can I get a cut');
    expect(stripKeyword('chair side: color fri?')).toBe('color fri?');
    expect(stripKeyword('CHAIR-SIDE hi')).toBe('hi');
    expect(stripKeyword('Hey chairsides, trim sat')).toBe('Hey trim sat');
    expect(stripKeyword('can I get a cut friday')).toBe('can I get a cut friday');
    expect(stripKeyword('Chairside')).toBe('');
    expect(stripKeyword('Book me, StudioK!', 'StudioK')).toBe('Book me, !');
    // Only whole words: "armchairsidetable" is not the keyword.
    expect(stripKeyword('armchairsidetable')).toBe('armchairsidetable');
  });

  it('normalizes and matches phone numbers', () => {
    expect(normalizePhone('+1 (555) 010-0199')).toBe('+15550100199');
    expect(normalizePhone('555.010.0199')).toBe('+15550100199');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('Karina M.')).toBeNull();
    expect(phonesMatch('+1 (555) 010-0199', '5550100199')).toBe(true);
    expect(phonesMatch('555-0101', '+1 312 555 0101')).toBe(true);
    expect(phonesMatch('555-0101', '555-0102')).toBe(false);
    expect(phonesMatch('12345', '12345')).toBe(false);
    expect(isPhoneLike('karina@example.com')).toBe(false);
    expect(formatPhone('+13125550199')).toBe('(312) 555-0199');
  });

  it('derives a stable dedupe key from sender, text and receive time', async () => {
    const a = await inboxDedupeKey({
      sender: 'K',
      senderPhone: '+1 555 010 0199',
      text: 'hi',
      receivedAt: 'x',
    });
    const b = await inboxDedupeKey({
      sender: 'k',
      senderPhone: '15550100199',
      text: ' hi ',
      receivedAt: 'x',
    });
    const c = await inboxDedupeKey({
      sender: 'K',
      senderPhone: '15550100199',
      text: 'hi',
      receivedAt: 'y',
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('parsing', () => {
  const ctx: InboxParseContext = {
    menu: MENU,
    today: '2026-12-01',
    todayLabel: 'Tue, Dec 1',
    timeZone: TZ,
    salonName: 'Studio K',
  };

  it('keeps only menu items the salon actually has', () => {
    const parsed = normalizeParsed(
      {
        intent: 'booking',
        services: [
          { serviceId: COLOR, variantId: 'v-long' },
          { serviceId: 'made-up' },
          { serviceId: CUT, variantId: 'nope' },
        ],
        date: 'friday',
        timeOfDay: 'afternoon',
      },
      MENU,
    );
    expect(parsed).toMatchObject({
      intent: 'booking',
      services: [
        { serviceId: COLOR, variantId: 'v-long' },
        { serviceId: CUT, variantId: null },
      ],
      date: null,
      timeOfDay: 'afternoon',
    });
    expect(normalizeParsed({ intent: 'book it' }, MENU)).toBeNull();
  });

  it('demo parser understands the common phrasings', () => {
    expect(demoParse('hey can I get color + trim fri afternoon?', ctx)).toMatchObject({
      intent: 'booking',
      services: [{ serviceId: COLOR }, { serviceId: CUT }],
      date: '2026-12-04',
      time: null,
      timeOfDay: 'afternoon',
    });
    expect(demoParse("it's Dana, can I book a cut tomorrow morning", ctx)).toMatchObject({
      intent: 'booking',
      clientName: 'Dana',
      date: '2026-12-02',
      timeOfDay: 'morning',
    });
    expect(demoParse('need to cancel my appt', ctx).intent).toBe('cancel');
    expect(demoParse('can I move my appointment to sat', ctx).intent).toBe('reschedule');
    expect(demoParse('thank you so much!!', ctx).intent).toBe('ignore');
  });

  it('demo parser picks one menu item per mention and reads clock times', () => {
    const item = (id: string, name: string) => ({ ...MENU.services[0]!, id, name });
    const menu = {
      ...MENU,
      services: [
        item('womens', "Women's cut & style"),
        item('mens', "Men's cut"),
        item('kids', "Kids' cut (≤12)"),
        item('haircut', 'Haircut'),
        item('balayage', 'Balayage'),
      ],
      combos: [{ ...item('combo', "Balayage + Women's cut"), isCombo: true }],
    } as unknown as typeof MENU;
    const big = { ...ctx, menu };
    expect(demoParse('Can I get a haircut tomorrow at 2pm?', big)).toMatchObject({
      services: [{ serviceId: 'haircut' }],
      date: '2026-12-02',
      time: '14:00',
      timeOfDay: 'afternoon',
    });
    expect(demoParse("balayage + women's cut sat at 10:30", big)).toMatchObject({
      services: [{ serviceId: 'combo' }],
      time: '10:30',
      timeOfDay: 'morning',
    });
    expect(demoParse('kids cut at 4', big)).toMatchObject({
      services: [{ serviceId: 'kids' }],
      time: '16:00',
    });
  });

  it('accepts a clock time from the model and derives the time of day', () => {
    expect(normalizeParsed({ intent: 'booking', time: '09:15' }, MENU)).toMatchObject({
      time: '09:15',
      timeOfDay: 'morning',
    });
    expect(normalizeParsed({ intent: 'booking', time: '2pm' }, MENU)).toMatchObject({
      time: null,
      timeOfDay: null,
    });
  });
});

describe('client matching', () => {
  const clients = createFakePort().clients;
  it('prefers the phone number, then one confident name', () => {
    expect(matchClient(clients, '+1 312 555 0101', ['Someone Else'])?.id).toBe(KARINA);
    expect(matchClient(clients, null, ['karina'])?.id).toBe(KARINA);
    // "Kar" is ambiguous (Karina, Karen): don't guess.
    expect(matchClient(clients, null, ['Kar'])).toBeNull();
    expect(matchClient(clients, null, ['+1 312 555 0199'])).toBeNull();
  });
});

describe('handleInboxRequest', () => {
  it('rejects missing or unknown tokens and rate-limited bridges', async () => {
    const { deps } = setup();
    expect((await handleInboxRequest(null, body('hi'), deps)).status).toBe(401);
    expect((await handleInboxRequest('csb_wrong', body('hi'), deps)).status).toBe(401);
    const limited = setup({ rateLimited: true });
    const res = await handleInboxRequest(TOKEN, body('hi'), limited.deps);
    expect(res).toMatchObject({ status: 429, body: { error: { code: 'rate_limited' } } });
  });

  it('validates the body', async () => {
    const { deps } = setup();
    expect((await handleInboxRequest(TOKEN, { sender: 'x' }, deps)).status).toBe(400);
    expect((await handleInboxRequest(TOKEN, 'nope', deps)).status).toBe(400);
  });

  it('acceptance: "color + trim fri afternoon" from a known number holds Friday afternoon', async () => {
    const llm = fakeLlm({
      intent: 'booking',
      clientName: null,
      services: [{ serviceId: COLOR }, { serviceId: CUT }],
      date: '2026-12-04',
      timeOfDay: 'afternoon',
      notes: null,
    });
    const { deps, port, usage } = setup({ llm });
    const res = await handleInboxRequest(
      TOKEN,
      body('Chairside hey can I get color + trim fri afternoon?'),
      deps,
    );
    expect(res).toMatchObject({
      status: 200,
      body: { ok: true, status: 'captured', intent: 'booking', clientCreated: false },
    });

    const [req] = port.captured;
    expect(req).toMatchObject({
      clientId: KARINA,
      intent: 'booking',
      message: 'hey can I get color + trim fri afternoon?',
      senderPhone: '5550101',
      receivedAt: '2026-12-01T15:03:22.000Z',
      note: null,
      parsed: { date: '2026-12-04', timeOfDay: 'afternoon', parser: 'llm' },
    });
    expect(req!.newClient).toBeUndefined();
    expect(req!.services!.map((s) => s.serviceId)).toEqual([COLOR, CUT]);

    const appt = port.base.appointments.find((a) => a.id === req!.appointmentId)!;
    expect(appt.status).toBe('requested');
    expect(local(appt.starts_at)).toMatch(/^Fri, Dec 4, (12|[1-4]):\d\d PM$/);
    expect(usage).toEqual([
      expect.objectContaining({
        salonId: SALON,
        purpose: 'inbox',
        inputTokens: 300,
        outputTokens: 40,
      }),
    ]);
  });

  it('holds the engine slot nearest a clock time the client named', async () => {
    const llm = fakeLlm({
      intent: 'booking',
      services: [{ serviceId: CUT }],
      date: '2026-12-04',
      time: '14:00',
    });
    const { deps, port } = setup({ llm });
    await handleInboxRequest(TOKEN, body('Chairside cut fri at 2pm?'), deps);
    const [req] = port.captured;
    expect(req!.parsed).toMatchObject({ time: '14:00', timeOfDay: 'afternoon' });
    const appt = port.base.appointments.find((a) => a.id === req!.appointmentId)!;
    expect(local(appt.starts_at)).toBe('Fri, Dec 4, 2:00 PM');
  });

  it('acceptance: a non-booking message stores nothing', async () => {
    const { deps, port, usage } = setup({ llm: fakeLlm({ intent: 'ignore' }) });
    const res = await handleInboxRequest(TOKEN, body('Chairside thank you so much!'), deps);
    expect(res).toEqual({
      status: 200,
      body: { ok: true, status: 'ignored', reason: 'not_a_request', replies: [] },
    });
    expect(port.captured).toHaveLength(0);
    expect(port.base.appointments).toHaveLength(2);
    expect(usage).toHaveLength(1);
  });

  it('ignores a bare keyword without calling the model', async () => {
    const { deps, usage } = setup();
    const res = await handleInboxRequest(TOKEN, body('  Chairside!  '), deps);
    expect(res.body).toMatchObject({ status: 'ignored', reason: 'empty' });
    expect(res.body).not.toHaveProperty('reply');
    expect(usage).toHaveLength(0);
  });

  it('records the Shortcut version the bridge reported', async () => {
    const { deps, versions } = setup();
    await handleInboxRequest(TOKEN, body('Chairside!', { bridgeVersion: 2 }), deps);
    await handleInboxRequest(TOKEN, 'not json', deps);
    expect(versions).toEqual(['2', null]);
  });

  it('treats a hand run and "<keyword> test" as a bridge test, capturing nothing', async () => {
    const { deps, port, usage, tested } = setup({ autoReply: true });
    const handRun = await handleInboxRequest(TOKEN, body(''), deps);
    expect(handRun).toEqual({ status: 200, body: { ok: true, status: 'test', replies: [] } });
    const texted = await handleInboxRequest(TOKEN, body('Chair side TEST!'), deps);
    expect(texted.body).toMatchObject({ status: 'test', reply: expect.stringContaining('✅') });
    expect(tested).toEqual([SALON, SALON]);
    expect(port.captured).toHaveLength(0);
    expect(usage).toHaveLength(0);
  });

  it('auto-reply mode: help for a bare keyword, a teaching "got it" for a request', async () => {
    const llm = fakeLlm({ intent: 'booking', services: [{ serviceId: CUT }], date: '2026-12-04' });
    const { deps } = setup({ llm, autoReply: true });
    const help = await handleInboxRequest(TOKEN, body('chairside'), deps);
    expect(help.body).toMatchObject({ status: 'ignored', reason: 'empty' });
    expect((help.body as { reply: string }).reply).toMatch(
      /Studio K.*“Chairside” \+ what you need/,
    );

    const res = await handleInboxRequest(TOKEN, body('Chairside cut fri'), deps);
    expect(res.body).toMatchObject({ status: 'captured' });
    expect((res.body as { reply: string }).reply).toBe(
      'Got it! Studio K will confirm your time shortly. Next time just text “Chairside” + what you need ✂️',
    );
    // A retry never texts the client twice.
    const again = await handleInboxRequest(TOKEN, body('Chairside cut fri'), deps);
    expect(again.body).toMatchObject({ status: 'duplicate' });
    expect(again.body).not.toHaveProperty('reply');
  });

  it('draft mode never replies', async () => {
    const llm = fakeLlm({ intent: 'booking', services: [{ serviceId: CUT }], date: '2026-12-04' });
    const { deps } = setup({ llm });
    const res = await handleInboxRequest(TOKEN, body('Chairside cut fri'), deps);
    expect(res.body).toMatchObject({ status: 'captured' });
    expect(res.body).not.toHaveProperty('reply');
  });

  it('auto-creates a pending client for an unknown sender', async () => {
    const { deps, port } = setup({ demo: true });
    const res = await handleInboxRequest(
      TOKEN,
      body("Chairside it's Dana, can I book a cut tomorrow morning", {
        sender: '+1 (312) 555-0199',
        senderPhone: '',
      }),
      deps,
    );
    expect(res.body).toMatchObject({ status: 'captured', clientCreated: true });
    const [req] = port.captured;
    expect(req!.newClient).toEqual({ name: 'Dana', phone: '+13125550199' });
    const appt = port.base.appointments.find((a) => a.id === req!.appointmentId)!;
    expect(local(appt.starts_at)).toMatch(/^Wed, Dec 2, (9|10|11):\d\d AM$/);
  });

  it('names an unknown, nameless sender after their number', async () => {
    const { deps, port } = setup({ demo: true });
    await handleInboxRequest(
      TOKEN,
      body('Chairside cut sat?', { sender: '3125550199', senderPhone: null }),
      deps,
    );
    expect(port.captured[0]!.newClient).toEqual({
      name: 'Text from (312) 555-0199',
      phone: '+13125550199',
    });
  });

  it('is idempotent on sender + text + receivedAt', async () => {
    const { deps, port } = setup({ demo: true });
    const first = await handleInboxRequest(TOKEN, body('Chairside cut sat?'), deps);
    const again = await handleInboxRequest(TOKEN, body('Chairside cut sat?'), deps);
    expect(first.body).toMatchObject({ status: 'captured' });
    expect(again.body).toMatchObject({
      status: 'duplicate',
      requestId: (first.body as { requestId: string }).requestId,
    });
    expect(port.captured).toHaveLength(1);
  });

  it('uses the usual service when none is named', async () => {
    const { deps, port } = setup({ demo: true });
    await handleInboxRequest(TOKEN, body('Chairside can I come in thursday?'), deps);
    // Karina's most frequent visit is color.
    expect(port.captured[0]!.services!.map((s) => s.serviceId)).toEqual([COLOR]);
  });

  it('captures without a hold when the service is unclear', async () => {
    const { deps, port } = setup({ demo: true });
    await handleInboxRequest(
      TOKEN,
      body('Chairside any openings next week?', {
        sender: 'New Person',
        senderPhone: '+13125550100',
      }),
      deps,
    );
    expect(port.captured[0]).toMatchObject({
      intent: 'booking',
      note: 'Couldn’t tell which service. Pick one when you reply.',
      newClient: { name: 'New Person', phone: '+13125550100' },
    });
    expect(port.captured[0]!.segments).toBeUndefined();
  });

  it('targets the next appointment for cancel and reschedule requests', async () => {
    const { deps, port } = setup({ demo: true });
    const upcoming = appointment(KARINA, [
      { kind: 'busy', start: '2026-12-10T16:00:00Z', end: '2026-12-10T17:00:00Z' },
    ]);
    port.base.appointments.push(upcoming);

    await handleInboxRequest(TOKEN, body('Chairside need to cancel my appt'), deps);
    expect(port.captured[0]).toMatchObject({ intent: 'cancel', targetAppointmentId: upcoming.id });
    expect(port.captured[0]!.segments).toBeUndefined();

    await handleInboxRequest(
      TOKEN,
      body('Chairside can I move my appointment to friday morning', { receivedAt: 'later' }),
      deps,
    );
    const moved = port.captured[1]!;
    expect(moved).toMatchObject({ intent: 'reschedule', targetAppointmentId: upcoming.id });
    expect(moved.services!.map((s) => s.serviceId)).toEqual([CUT]);
    const held = port.base.appointments.find((a) => a.id === moved.appointmentId)!;
    expect(local(held.starts_at)).toMatch(/^Fri, Dec 4, (9|10|11):\d\d AM$/);
  });

  it('notes when there is nothing to cancel', async () => {
    const { deps, port } = setup({ demo: true });
    await handleInboxRequest(TOKEN, body('Chairside cancel please'), deps);
    expect(port.captured[0]).toMatchObject({
      intent: 'cancel',
      note: 'No upcoming appointment found for this client.',
    });
  });

  it('still captures when the model answer is unreadable', async () => {
    const { deps, port } = setup({ llm: fakeLlm('Sure! I think they want a haircut.') });
    const res = await handleInboxRequest(TOKEN, body('Chairside ???'), deps);
    expect(res.body).toMatchObject({ status: 'captured' });
    expect(port.captured[0]).toMatchObject({ intent: 'booking', parsed: { parser: 'none' } });
  });

  it('needs an AI provider and budget outside demo mode', async () => {
    const none = setup({ config: null });
    expect(await handleInboxRequest(TOKEN, body('Chairside cut sat'), none.deps)).toMatchObject({
      status: 409,
      body: { error: { code: 'not_configured' } },
    });
    const broke = setup({ used: 10_000 });
    expect(await handleInboxRequest(TOKEN, body('Chairside cut sat'), broke.deps)).toMatchObject({
      status: 429,
      body: { error: { code: 'budget_exceeded' } },
    });
  });

  it('reports provider failures without leaking the key', async () => {
    const llm: LLMProvider = {
      id: 'anthropic',
      model: 'm',
      chat: async () => {
        throw new AiProviderError('anthropic', 'auth', `bad key ${KEY}`, 401);
      },
    };
    const { deps, port } = setup({ llm });
    const res = await handleInboxRequest(TOKEN, body('Chairside cut sat'), deps);
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(port.captured).toHaveLength(0);
  });

  describe('replies (#7)', () => {
    async function offered(deps: InboxServiceDeps, port: ReturnType<typeof fakeInboxPort>) {
      const res = await handleInboxRequest(TOKEN, body('Chairside cut sat?'), deps);
      const { requestId, appointmentId } = res.body as { requestId: string; appointmentId: string };
      port.offers.push({
        phone: '+15550101',
        requestId,
        appointmentId,
        sentAt: new Date(NOW - 3_600_000).toISOString(),
      });
      return { requestId, appointmentId };
    }

    it('a "yes" to an offer books the held slot', async () => {
      const { deps, port } = setup({ demo: true });
      const { requestId, appointmentId } = await offered(deps, port);
      const res = await handleInboxRequest(
        TOKEN,
        body('Chairside yes please!', { receivedAt: '2026-12-01T10:00:00-06:00' }),
        deps,
      );
      expect(res.body).toEqual({
        ok: true,
        status: 'confirmed',
        requestId,
        appointmentId,
        replies: [],
      });
      expect(port.base.appointments.find((a) => a.id === appointmentId)!.status).toBe('confirmed');
      expect(port.captured).toHaveLength(1);
    });

    it('does not confirm for another number or an offer that is too old', async () => {
      const { deps, port } = setup({ demo: true });
      const { appointmentId } = await offered(deps, port);
      const other = await handleInboxRequest(
        TOKEN,
        body('Chairside yes', { sender: 'Dana', senderPhone: '312-555-0199', receivedAt: 'x1' }),
        deps,
      );
      expect(other.body).not.toMatchObject({ status: 'confirmed' });
      port.offers[0]!.sentAt = new Date(NOW - 8 * 86_400_000).toISOString();
      const stale = await handleInboxRequest(
        TOKEN,
        body('Chairside yes', { receivedAt: 'x2' }),
        deps,
      );
      expect(stale.body).not.toMatchObject({ status: 'confirmed' });
      expect(port.base.appointments.find((a) => a.id === appointmentId)!.status).toBe('requested');
    });

    it('auto-send: hands queued replies to the Shortcut and marks them sent', async () => {
      const { deps, port } = setup({ demo: true });
      Object.assign(port.base.replySettings, { autoSendReplies: true, bridgeKeyword: 'Chairside' });
      await offered(deps, port);
      const res = await handleInboxRequest(
        TOKEN,
        body('Chairside yep', { receivedAt: 'y', bridgeVersion: '3' }),
        deps,
      );
      const { replies } = res.body as { replies: { id: string; to: string; text: string }[] };
      expect(replies).toHaveLength(1);
      expect(replies[0]!.to).toBe('+15550101');
      expect(replies[0]!.text).toMatch(/booked/i);
      expect(port.replies[0]).toMatchObject({ status: 'sent', source: 'ai' });

      const again = await handleInboxRequest(TOKEN, { action: 'outbox' }, deps);
      expect(again.body).toEqual({ ok: true, status: 'outbox', replies: [] });
    });

    it('outbox: drafts from the template without an AI provider, adding the booking link', async () => {
      const { deps, port } = setup({ config: null });
      Object.assign(port.base.replySettings, {
        autoSendReplies: true,
        bridgeKeyword: 'Chairside',
        bookingLink: 'https://book.example.com/k',
        includeBookingLink: true,
      });
      port.replies.push({
        id: 'r1',
        kind: 'confirm',
        toPhone: '+15550101',
        capturedRequestId: null,
        appointmentId: port.base.appointments[0]!.id,
        clientId: null,
        status: 'queued',
      });
      const res = await handleInboxRequest(TOKEN, { action: 'outbox' }, deps);
      expect(res.status).toBe(200);
      const [reply] = (res.body as { replies: { text: string }[] }).replies;
      expect(reply!.text).toMatch(/^Hi Maria! You're booked/);
      expect(reply!.text).toContain('https://book.example.com/k');
      expect(port.replies[0]).toMatchObject({ status: 'sent', source: 'template' });
    });

    it('a pre-v3 Shortcut is not handed queued replies (it has no step to send them)', async () => {
      const { deps, port } = setup({ demo: true });
      Object.assign(port.base.replySettings, { autoSendReplies: true, bridgeKeyword: 'Chairside' });
      await offered(deps, port);
      const res = await handleInboxRequest(
        TOKEN,
        body('Chairside yep', { receivedAt: 'y', bridgeVersion: '2' }),
        deps,
      );
      expect(res.body).toMatchObject({ status: 'confirmed', replies: [] });
      expect(port.replies[0]!.status).toBe('queued');

      const v3 = await handleInboxRequest(
        TOKEN,
        body('Chairside hi', { receivedAt: 'z', bridgeVersion: '3' }),
        deps,
      );
      expect((v3.body as { replies: unknown[] }).replies).toHaveLength(1);
      expect(port.replies[0]!.status).toBe('sent');
    });

    it('auto-send off: queued replies stay unsent', async () => {
      const { deps, port } = setup({ demo: true });
      port.replies.push({
        id: 'r1',
        kind: 'confirm',
        toPhone: '+15550101',
        capturedRequestId: null,
        appointmentId: null,
        clientId: null,
        status: 'queued',
      });
      const res = await handleInboxRequest(TOKEN, { action: 'outbox' }, deps);
      expect(res.body).toMatchObject({ replies: [] });
      expect(port.replies[0]!.status).toBe('queued');
    });

    it('outbox calls still need a valid token', async () => {
      const { deps } = setup({ demo: true });
      const res = await handleInboxRequest('csb_wrong', { action: 'outbox' }, deps);
      expect(res.status).toBe(401);
    });
  });
});

describe('isAffirmative', () => {
  it.each([
    'yes',
    'Yes!',
    'yes please',
    'Yep, sounds good',
    'ok thanks',
    'perfect',
    '👍',
    'Sounds great!',
  ])('accepts %j', (text) => expect(isAffirmative(text)).toBe(true));
  it.each(['no', 'yes but can we do 3 instead?', 'not yet', 'yes for my sister on monday', ''])(
    'rejects %j',
    (text) => expect(isAffirmative(text)).toBe(false),
  );
});
