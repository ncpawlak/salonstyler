import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { COLOR, CUT, KARINA, NOW, TZ } from '../assistant/fake-salon.ts';
import { FAKE_KEYS, FIXTURE_MODELS, TINY_PNG_BASE64 } from '../contract/scenarios.ts';
import { AiProviderError } from '../http.ts';
import { AI_PROVIDERS, type AiProvider } from '../providers.ts';
import { createProvider } from '../registry.ts';
import type { StoredAiConfig, UsageEntry } from '../server/handler.ts';
import type { ChatMessage, ChatResult, FetchLike, LLMProvider } from '../types.ts';
import { fakeInboxPort } from './fake-inbox.ts';
import { handleInboxRequest, type InboxServiceDeps } from './handler.ts';
import { handleManualCapture, isManualCapture, type ManualCaptureDeps } from './manual.ts';
import { normalizeConversation, READ_CONVERSATION_TOOL } from './screenshot.ts';

const SALON = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const KEY = 'sk-saved-key-0123456789abcdef';
const DM = 'Hey! can I get color + trim fri afternoon?';
const IMAGE = { mimeType: 'image/png', data: TINY_PNG_BASE64 } as const;

const READ = {
  isConversation: true,
  platform: 'instagram',
  sender: 'Karina Lopez',
  senderPhone: null,
  text: DM,
  sentOn: '2026-12-01',
  sentTime: '09:03',
};
const PARSE = {
  intent: 'booking',
  clientName: null,
  services: [{ serviceId: COLOR }, { serviceId: CUT }],
  date: '2026-12-04',
  timeOfDay: 'afternoon',
  notes: null,
};

/** A model stand-in that answers each forced tool from a script and records what it was sent. */
function scriptedLlm(answers: Record<string, unknown>) {
  const calls: { tool: string; messages: ChatMessage[] }[] = [];
  const llm: LLMProvider = {
    id: 'anthropic',
    model: 'claude-haiku-4-5',
    async chat(messages, tools): Promise<ChatResult> {
      const tool = tools?.[0]?.name ?? '';
      calls.push({ tool, messages });
      return {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        usage: { inputTokens: 900, outputTokens: 60, totalTokens: 960 },
        finishReason: 'tool_calls',
        type: 'tool_calls',
        text: null,
        toolCalls: [{ id: `c${calls.length}`, name: tool, arguments: answers[tool] as never }],
      };
    },
  };
  return { llm, calls };
}

function setup(
  options: {
    llm?: LLMProvider;
    demo?: boolean;
    config?: StoredAiConfig | null;
    role?: 'owner' | 'stylist' | null;
    createProvider?: ManualCaptureDeps['createProvider'];
  } = {},
) {
  const port = fakeInboxPort();
  const usage: UsageEntry[] = [];
  const config =
    options.config === undefined
      ? {
          provider: 'anthropic' as const,
          model: 'claude-haiku-4-5',
          apiKey: KEY,
          monthlyTokenBudget: 10_000,
        }
      : options.config;
  const deps: ManualCaptureDeps = {
    getMemberRole: async () => (options.role === undefined ? 'stylist' : options.role),
    markTested: async () => {
      throw new Error('a manual capture is never a bridge test');
    },
    createPort: () => port,
    loadConfig: async () => config,
    tokensUsedThisMonth: async () => 0,
    recordUsage: async (e) => void usage.push(e),
    createProvider: options.createProvider ?? (() => options.llm ?? scriptedLlm({}).llm),
    demo: options.demo,
    now: () => NOW,
  };
  return { deps, port, usage };
}

const capture = (extra: Record<string, unknown>) => ({
  action: 'capture',
  salonId: SALON,
  ...extra,
});

/** The parts of a captured request the approval card shows. */
const card = (req: ReturnType<typeof fakeInboxPort>['captured'][number]) => ({
  clientId: req.clientId,
  intent: req.intent,
  message: req.message,
  parsed: req.parsed,
  services: req.services,
  segments: req.segments,
  priceCents: req.priceCents,
  newClient: req.newClient,
});

describe('manual capture', () => {
  it('tells a manual capture apart from a forwarded text', () => {
    expect(isManualCapture(capture({ source: 'paste', text: 'hi' }))).toBe(true);
    expect(isManualCapture({ sender: 'Karina', text: 'hi' })).toBe(false);
    expect(isManualCapture(null)).toBe(false);
  });

  it('validates the body', async () => {
    const { deps } = setup();
    expect((await handleManualCapture(capture({ source: 'paste' }), deps)).status).toBe(400);
    expect(
      (await handleManualCapture(capture({ source: 'fax', text: 'cut fri' }), deps)).status,
    ).toBe(400);
    expect(
      (
        await handleManualCapture(
          capture({ source: 'screenshot', image: { mimeType: 'image/heic', data: 'x' } }),
          deps,
        )
      ).status,
    ).toBe(400);
  });

  it('only salon members can capture', async () => {
    const { deps, port } = setup({ role: null, demo: true });
    const res = await handleManualCapture(capture({ source: 'paste', text: DM }), deps);
    expect(res).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
    expect(port.captured).toEqual([]);
  });

  it('a pasted message becomes a request for approval, never a reply', async () => {
    const { deps, port } = setup({ demo: true });
    const res = await handleManualCapture(
      capture({ source: 'paste', text: DM, sender: 'Karina', senderPhone: '555-0101' }),
      deps,
    );
    expect(res).toMatchObject({
      status: 200,
      body: { ok: true, status: 'captured', intent: 'booking', source: 'paste' },
    });
    expect(res.body).not.toHaveProperty('reply');
    expect(res.body).not.toHaveProperty('read');
    const [req] = port.captured;
    expect(req).toMatchObject({ channel: 'paste', clientId: KARINA, message: DM });
    expect(req!.services!.map((s) => s.serviceId)).toEqual([COLOR, CUT]);
    expect(req!.appointmentId).toBeTruthy();
    expect(port.replies).toEqual([]);
  });

  it('a bare "test" or "Chairside" paste is still captured, not treated as a bridge test', async () => {
    const { deps, port } = setup({ demo: true });
    const res = await handleManualCapture(capture({ source: 'share', text: 'test' }), deps);
    expect(res.status).toBe(200);
    expect(res.body).not.toMatchObject({ status: 'test' });
    expect(port.replies).toEqual([]);
  });

  it('demo mode reads a fixed Instagram DM without an AI key', async () => {
    const { deps, port, usage } = setup({ demo: true, config: null });
    const res = await handleManualCapture(capture({ source: 'screenshot', image: IMAGE }), deps);
    expect(res).toMatchObject({
      status: 200,
      body: {
        status: 'captured',
        source: 'screenshot',
        read: { platform: 'instagram', sender: 'Karina Lopez', parser: 'demo' },
      },
    });
    expect(port.captured[0]).toMatchObject({ channel: 'instagram', clientId: KARINA });
    expect(usage).toEqual([]);
  });

  it('reading a screenshot needs AI and budget outside demo mode', async () => {
    const noKey = setup({ config: null });
    expect(
      await handleManualCapture(capture({ source: 'screenshot', image: IMAGE }), noKey.deps),
    ).toMatchObject({ status: 409, body: { error: { code: 'not_configured' } } });

    const broke = setup({
      config: { provider: 'openai', model: 'gpt-4.1-mini', apiKey: KEY, monthlyTokenBudget: 0 },
    });
    expect(
      await handleManualCapture(capture({ source: 'screenshot', image: IMAGE }), broke.deps),
    ).toMatchObject({ status: 429, body: { error: { code: 'budget_exceeded' } } });
  });

  it('an image that is not a conversation is rejected after metering the read', async () => {
    const { llm } = scriptedLlm({
      read_conversation: { isConversation: false, platform: 'other', text: '' },
    });
    const { deps, port, usage } = setup({ llm });
    const res = await handleManualCapture(capture({ source: 'screenshot', image: IMAGE }), deps);
    expect(res).toMatchObject({ status: 422, body: { error: { code: 'no_message_found' } } });
    expect(port.captured).toEqual([]);
    expect(usage).toEqual([expect.objectContaining({ purpose: 'inbox_screenshot' })]);
  });

  it('reports provider failures without leaking the key', async () => {
    const llm: LLMProvider = {
      id: 'anthropic',
      model: 'claude-haiku-4-5',
      chat: async () => {
        throw new AiProviderError('anthropic', 'auth', `bad key ${KEY}`, 401);
      },
    };
    const { deps } = setup({ llm });
    const res = await handleManualCapture(capture({ source: 'screenshot', image: IMAGE }), deps);
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });

  it('sends the image to the model, and resolves "tomorrow" from the day the client wrote', async () => {
    const { llm, calls } = scriptedLlm({
      read_conversation: {
        ...READ,
        platform: 'whatsapp',
        text: 'can I come in tomorrow for a cut',
        sentOn: '2026-11-27',
        sentTime: '18:45',
      },
      submit_request: { intent: 'booking', services: [{ serviceId: CUT }], date: '2026-11-28' },
    });
    const { deps, port, usage } = setup({ llm });
    const res = await handleManualCapture(
      capture({ source: 'screenshot', image: IMAGE, text: 'she prefers mornings' }),
      deps,
    );
    expect(res.status).toBe(200);

    expect(calls.map((c) => c.tool)).toEqual(['read_conversation', 'submit_request']);
    expect(calls[0]!.messages[1]!.content).toContainEqual({ type: 'image', ...IMAGE });
    const parseSystem = String(calls[1]!.messages[0]!.content);
    expect(parseSystem).toContain('The message was sent on 2026-11-27');

    const [req] = port.captured;
    expect(req).toMatchObject({
      channel: 'whatsapp',
      clientId: KARINA,
      message: 'can I come in tomorrow for a cut\nshe prefers mornings',
      // 6:45 PM in Chicago on Fri Nov 27.
      receivedAt: '2026-11-28T00:45:00.000Z',
    });
    expect(usage.map((u) => u.purpose)).toEqual(['inbox_screenshot', 'inbox']);
  });

  it('a phone typed by the stylist beats a name on the screenshot', async () => {
    const { llm } = scriptedLlm({
      read_conversation: { ...READ, sender: 'K' },
      submit_request: PARSE,
    });
    const { deps, port } = setup({ llm });
    await handleManualCapture(
      capture({ source: 'screenshot', image: IMAGE, senderPhone: '(555) 0101' }),
      deps,
    );
    expect(port.captured[0]).toMatchObject({ clientId: KARINA, senderPhone: '5550101' });
  });
});

describe('screenshot transcripts', () => {
  it('drops dates in the future and needs client text', () => {
    expect(normalizeConversation({ ...READ, sentOn: '2026-12-09' }, '2026-12-01')).toMatchObject({
      sentOn: null,
      sentTime: null,
    });
    expect(normalizeConversation({ ...READ, text: '  ' }, '2026-12-01')).toBeNull();
    expect(normalizeConversation({ ...READ, platform: 'tiktok' }, '2026-12-01')).toMatchObject({
      platform: 'other',
    });
    expect(normalizeConversation('nonsense', '2026-12-01')).toBeNull();
  });
});

// Recorded-format provider responses (packages/ai/fixtures/<provider>/inbox_screenshot_*.json), replayed
// through the real adapters so the vision request and the tool parsing are exercised end to end.
const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'fixtures');
interface InboxFixture {
  request: { method: string; url: string; body: unknown };
  response: { status: number; body: unknown };
}
const loadFixture = (provider: AiProvider, name: string): InboxFixture =>
  JSON.parse(readFileSync(join(fixturesDir, provider, `${name}.json`), 'utf8'));

function replay(provider: AiProvider): { fetch: FetchLike; bodies: string[] } {
  const bodies: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = String(init.body);
    bodies.push(body);
    const name = body.includes(READ_CONVERSATION_TOOL.name)
      ? 'inbox_screenshot_read'
      : 'inbox_screenshot_parse';
    const fixture = loadFixture(provider, name);
    expect(url).toBe(fixture.request.url);
    return new Response(JSON.stringify(fixture.response.body), {
      status: fixture.response.status,
    });
  };
  return { fetch, bodies };
}

describe('acceptance: a screenshot of an IG DM makes the same request card as a forwarded text', () => {
  for (const provider of AI_PROVIDERS) {
    it(provider, async () => {
      // The forwarded text, through the Shortcut bridge.
      const { llm: textLlm } = scriptedLlm({ submit_request: PARSE });
      const shortcut = setup({ llm: textLlm });
      const bridgeDeps: InboxServiceDeps = {
        ...shortcut.deps,
        authenticate: async () => ({
          salonId: SALON,
          keyword: 'Chairside',
          rateLimited: false,
          autoReply: false,
          salonName: 'Studio K',
        }),
        markTested: async () => {},
      };
      const forwarded = await handleInboxRequest(
        'csb_test-token',
        {
          sender: 'Karina',
          senderPhone: '555-0101',
          text: `Chairside ${DM}`,
          receivedAt: '2026-12-01T09:03:22-06:00',
          bridgeVersion: '3',
        },
        bridgeDeps,
      );
      expect(forwarded.status).toBe(200);

      // The screenshot of the same DM, read by the provider's vision model (replayed).
      const { fetch, bodies } = replay(provider);
      const shot = setup({
        config: {
          provider,
          model: FIXTURE_MODELS[provider],
          apiKey: FAKE_KEYS[provider],
          monthlyTokenBudget: 100_000,
        },
        createProvider: (id, options) => createProvider(id, { ...options, fetch }),
      });
      const res = await handleManualCapture(
        capture({ source: 'screenshot', image: IMAGE }),
        shot.deps,
      );
      expect(res).toMatchObject({
        status: 200,
        body: { status: 'captured', read: { platform: 'instagram', parser: 'llm' } },
      });
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toContain(TINY_PNG_BASE64);

      const fromText = shortcut.port.captured[0]!;
      const fromShot = shot.port.captured[0]!;
      expect(card(fromShot)).toEqual(card(fromText));
      expect(fromShot.clientId).toBe(KARINA);
      expect(fromShot.channel).toBe('instagram');
      expect(fromShot.receivedAt).toBe('2026-12-01T15:03:00.000Z');
      const held = shot.port.base.appointments.find((a) => a.id === fromShot.appointmentId)!;
      expect(
        new Date(held.starts_at).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' }),
      ).toBe('Fri');
      expect(shot.usage.map((u) => u.purpose)).toEqual(['inbox_screenshot', 'inbox']);
    });
  }
});
