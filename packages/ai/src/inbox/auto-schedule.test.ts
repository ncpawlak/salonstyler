import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { appointment, COLOR, CUT, KARINA, NOW, TZ } from '../assistant/fake-salon.ts';
import { FAKE_KEYS, FIXTURE_MODELS } from '../contract/scenarios.ts';
import { AiProviderError } from '../http.ts';
import { AI_PROVIDERS, type AiProvider } from '../providers.ts';
import { createProvider } from '../registry.ts';
import type { StoredAiConfig, UsageEntry } from '../server/handler.ts';
import type { ChatMessage, ChatResult, FetchLike, LLMProvider } from '../types.ts';
import {
  type AutoScheduleDeps,
  type AutoScheduleResponse,
  describeWindow,
  fallbackWindow,
  handleAutoSchedule,
  isAutoSchedule,
  normalizeWindow,
  SUBMIT_WINDOW_TOOL,
  type StoredCapturedRequest,
} from './auto-schedule.ts';
import { fakeInboxPort } from './fake-inbox.ts';

const SALON = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const REQUEST = '7a1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e01';
const RACHEL_TEXT = 'any chance we can move my appointment to next week? Mornings are best';
const TODAY = { today: '2026-12-01', sentOn: '2026-12-01' };

function scriptedLlm(answer: unknown) {
  const calls: ChatMessage[][] = [];
  const llm: LLMProvider = {
    id: 'anthropic',
    model: 'claude-haiku-4-5',
    async chat(messages): Promise<ChatResult> {
      calls.push(messages);
      return {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        usage: { inputTokens: 400, outputTokens: 40, totalTokens: 440 },
        finishReason: 'tool_calls',
        type: 'tool_calls',
        text: null,
        toolCalls: [{ id: 'c1', name: SUBMIT_WINDOW_TOOL.name, arguments: answer as never }],
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
    createProvider?: AutoScheduleDeps['createProvider'];
  } = {},
) {
  const port = fakeInboxPort();
  const usage: UsageEntry[] = [];
  const config =
    options.config === undefined
      ? {
          provider: 'anthropic' as const,
          model: 'claude-haiku-4-5',
          apiKey: 'sk-saved-key-0123456789abcdef',
          monthlyTokenBudget: 10_000,
        }
      : options.config;
  const deps: AutoScheduleDeps = {
    getMemberRole: async () => (options.role === undefined ? 'stylist' : options.role),
    createPort: () => port,
    loadConfig: async () => config,
    tokensUsedThisMonth: async () => 0,
    recordUsage: async (e) => void usage.push(e),
    createProvider:
      options.createProvider ??
      (() =>
        options.llm ??
        (() => {
          throw new Error('no model in this test');
        })()),
    demo: options.demo,
    now: () => NOW,
  };
  return { deps, port, usage };
}

/** Karina's color on Thu Dec 3, 11:00 AM (CST), which she asks to move. */
function addTarget(port: ReturnType<typeof fakeInboxPort>) {
  const target = appointment(
    KARINA,
    [
      { kind: 'busy', start: '2026-12-03T17:00:00Z', end: '2026-12-03T17:45:00Z' },
      { kind: 'processing', start: '2026-12-03T17:45:00Z', end: '2026-12-03T18:30:00Z' },
      { kind: 'style', start: '2026-12-03T18:30:00Z', end: '2026-12-03T19:00:00Z' },
    ],
    {
      services: [
        {
          serviceId: COLOR,
          name: 'All-over Color',
          variantId: null,
          variantName: null,
          colorTag: 'purple',
        },
      ],
    },
  );
  port.base.appointments.push(target);
  return target;
}

function addRequest(
  port: ReturnType<typeof fakeInboxPort>,
  overrides: Partial<StoredCapturedRequest> = {},
): StoredCapturedRequest {
  const request: StoredCapturedRequest = {
    id: REQUEST,
    status: 'pending',
    intent: 'booking',
    message: 'can I get a haircut?',
    parsed: { intent: 'booking', services: [{ serviceId: CUT }] },
    clientId: KARINA,
    appointmentId: null,
    targetAppointmentId: null,
    receivedAt: '2026-12-01T14:30:00Z',
    ...overrides,
  };
  port.stored.push(request);
  return request;
}

function rachel(port: ReturnType<typeof fakeInboxPort>) {
  const target = addTarget(port);
  addRequest(port, {
    intent: 'reschedule',
    message: RACHEL_TEXT,
    parsed: { intent: 'reschedule', timeOfDay: 'morning', services: [] },
    targetAppointmentId: target.id,
  });
  return target;
}

const body = { action: 'auto_schedule', salonId: SALON, requestId: REQUEST };

async function ok(deps: AutoScheduleDeps): Promise<AutoScheduleResponse> {
  const res = await handleAutoSchedule(body, deps);
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return res.body;
}

const localHour = (iso: string) =>
  Number(new Date(iso).toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }));

describe('Auto-Schedule (#84)', () => {
  it('recognizes its action', () => {
    expect(isAutoSchedule(body)).toBe(true);
    expect(isAutoSchedule({ action: 'capture' })).toBe(false);
    expect(isAutoSchedule(null)).toBe(false);
  });

  it("moves Rachel's appointment to next-week mornings (no model: the stored parse)", async () => {
    const { deps, port } = setup({ config: null });
    const target = rachel(port);
    const res = await ok(deps);

    expect(res).toMatchObject({
      intent: 'reschedule',
      interpreter: 'parsed',
      fits: true,
      window: { dateFrom: '2026-12-07', dateTo: '2026-12-13', timeOfDay: 'morning' },
      moving: { appointmentId: target.id, label: 'Thu, Dec 3 · 11:00 AM' },
      serviceSummary: 'All-over Color · 2h00',
    });
    expect(res.window!.label).toBe('Next week · mornings');
    expect(res.suggestions.length).toBeGreaterThanOrEqual(3);
    const inWindow = res.suggestions.filter((s) => s.reasons.some((r) => r.kind === 'requested'));
    expect(inWindow.length).toBeGreaterThanOrEqual(3);
    for (const s of inWindow) {
      expect(s.localDate >= '2026-12-07' && s.localDate <= '2026-12-13').toBe(true);
      expect(localHour(s.start)).toBeLessThan(12);
      expect(s.reasons[0]).toEqual({ kind: 'requested', label: 'Next week · mornings' });
    }
    // Her usual: Tuesdays at 10 (two of her last three visits).
    expect(res.suggestions[0]).toMatchObject({ localDate: '2026-12-08', localTime: '10:00' });
    expect(res.suggestions[0]!.reasons.map((r) => r.kind)).toContain('usual');
    // Ready to book: color with its processing gap.
    expect(res.suggestions[0]!.segments.map((s) => s.kind)).toEqual([
      'busy',
      'processing',
      'style',
    ]);
  });

  it('ignores the appointment being moved and the request’s own hold', async () => {
    const { deps, port } = setup({ config: null });
    rachel(port);
    // A hold on Tue Dec 8 at 10 made by the pipeline for this very request.
    const hold = appointment(KARINA, [
      { kind: 'busy', start: '2026-12-08T16:00:00Z', end: '2026-12-08T18:00:00Z' },
    ]);
    hold.status = 'requested';
    port.base.appointments.push(hold);
    port.stored[0]!.appointmentId = hold.id;
    const res = await ok(deps);
    expect(res.suggestions[0]).toMatchObject({ localDate: '2026-12-08', localTime: '10:00' });
  });

  it('uses the salon’s model to read the window and meters it', async () => {
    const { llm, calls } = scriptedLlm({
      dateFrom: '2026-12-08',
      dateTo: '2026-12-08',
      weekdays: [],
      timeOfDay: null,
      time: '14:00',
    });
    const { deps, port, usage } = setup({ llm });
    rachel(port);
    const res = await ok(deps);
    expect(res.interpreter).toBe('llm');
    expect(res.window!.label).toBe('Tue, Dec 8 · around 2 PM');
    expect(res.suggestions[0]!.localDate).toBe('2026-12-08');
    expect(Math.abs(localHour(res.suggestions[0]!.start) - 14)).toBeLessThanOrEqual(1);
    expect(usage.map((u) => u.purpose)).toEqual(['inbox_auto_schedule']);
    const system = calls[0]![0]!.content as string;
    expect(system).toContain('Thu, Dec 3 · 11:00 AM');
    expect(system).toContain('Never suggest or choose a time');
  });

  it('falls back to the stored parse when the provider fails', async () => {
    const { deps, port, usage } = setup({
      createProvider: () => ({
        id: 'anthropic',
        model: 'x',
        chat: async () => {
          throw new AiProviderError('anthropic', 'rate_limit', 'slow down', 429);
        },
      }),
    });
    rachel(port);
    const res = await ok(deps);
    expect(res.interpreter).toBe('parsed');
    expect(res.window!.label).toBe('Next week · mornings');
    expect(usage).toEqual([]);
  });

  it('demo mode reads the window with rules', async () => {
    const { deps, port } = setup({ demo: true });
    rachel(port);
    expect((await ok(deps)).interpreter).toBe('demo');
  });

  it('says when nothing fits and offers the nearest openings', async () => {
    const { deps, port } = setup({ config: null });
    // Sunday: the salon is closed.
    addRequest(port, {
      message: 'can I get a haircut sunday morning?',
      parsed: {
        intent: 'booking',
        services: [{ serviceId: CUT }],
        date: '2026-12-06',
        timeOfDay: 'morning',
      },
    });
    const res = await ok(deps);
    expect(res.fits).toBe(false);
    expect(res.intent).toBe('booking');
    expect(res.suggestions.length).toBeGreaterThan(0);
    expect(res.suggestions[0]!.reasons[0]!.kind).toBe('nearest');
    expect(['2026-12-05', '2026-12-08']).toContain(res.suggestions[0]!.localDate);
  });

  it('a new client without a window gets the soonest openings', async () => {
    const { deps, port } = setup({ config: null });
    addRequest(port, { clientId: null, message: 'hi can i get a haircut' });
    const res = await ok(deps);
    expect(res.window).toBeNull();
    expect(res.fits).toBeNull();
    expect(res.suggestions[0]!.reasons.map((r) => r.kind)).toContain('soonest');
    // 9:00 AM today is inside the hour of minimum notice.
    expect(res.suggestions[0]!.start >= '2026-12-01T16:00:00.000Z').toBe(true);
  });

  it('falls back to the client’s usual services and refuses without any', async () => {
    const usual = setup({ config: null });
    addRequest(usual.port, { parsed: { intent: 'booking', services: [] } });
    expect((await ok(usual.deps)).serviceSummary).toBe('All-over Color · 2h00');

    const none = setup({ config: null });
    addRequest(none.port, { clientId: null, parsed: { intent: 'booking' } });
    expect(await handleAutoSchedule(body, none.deps)).toMatchObject({
      status: 422,
      body: { error: { code: 'no_service' } },
    });
  });

  it('rejects cancellations, handled or unknown requests, and non-members', async () => {
    const cancel = setup({ config: null });
    addRequest(cancel.port, { intent: 'cancel' });
    expect((await handleAutoSchedule(body, cancel.deps)).status).toBe(422);

    const handled = setup({ config: null });
    addRequest(handled.port, { status: 'approved' });
    expect((await handleAutoSchedule(body, handled.deps)).status).toBe(409);

    const gone = setup({ config: null });
    expect((await handleAutoSchedule(body, gone.deps)).status).toBe(404);

    const outsider = setup({ config: null, role: null });
    addRequest(outsider.port);
    expect((await handleAutoSchedule(body, outsider.deps)).status).toBe(403);

    expect((await handleAutoSchedule({ ...body, requestId: 'nope' }, gone.deps)).status).toBe(400);
  });
});

describe('fallbackWindow', () => {
  it('reads next week, this week, weekends and weekday plurals', () => {
    expect(fallbackWindow('next week works', {}, TODAY)).toMatchObject({
      dateFrom: '2026-12-07',
      dateTo: '2026-12-13',
    });
    expect(fallbackWindow('anytime this week', {}, TODAY)).toMatchObject({
      dateFrom: '2026-12-01',
      dateTo: '2026-12-06',
    });
    expect(fallbackWindow('I can only do weekends', {}, TODAY).weekdays).toEqual([0, 6]);
    expect(
      fallbackWindow('mondays or fridays in the afternoon', { date: '2026-12-07' }, TODAY),
    ).toMatchObject({ dateFrom: null, dateTo: null, weekdays: [1, 5], timeOfDay: 'afternoon' });
    expect(fallbackWindow('fri at 2?', { date: '2026-12-04', time: '14:00' }, TODAY)).toMatchObject(
      { dateFrom: '2026-12-04', dateTo: '2026-12-04', time: '14:00' },
    );
  });

  it('resolves relative days from the day the message was sent', () => {
    // Sent last Thursday: "next week" was this week.
    expect(
      fallbackWindow('next week?', {}, { today: '2026-12-01', sentOn: '2026-11-26' }),
    ).toMatchObject({ dateFrom: '2026-12-01', dateTo: '2026-12-06' });
  });
});

describe('normalizeWindow / describeWindow', () => {
  it('cleans one-sided, reversed and past ranges', () => {
    const today = '2026-12-01';
    expect(normalizeWindow({ dateFrom: '2026-12-09', dateTo: '2026-12-08' }, today)).toMatchObject({
      dateFrom: '2026-12-08',
      dateTo: '2026-12-09',
    });
    expect(normalizeWindow({ dateTo: '2026-12-09' }, today)).toMatchObject({
      dateFrom: '2026-12-09',
      dateTo: '2026-12-09',
    });
    expect(normalizeWindow({ dateFrom: '2026-11-20', dateTo: '2026-11-21' }, today)).toMatchObject({
      dateFrom: null,
      dateTo: null,
    });
    expect(normalizeWindow({ dateFrom: 'soon', time: '9am', weekdays: [9] }, today)).toEqual({
      dateFrom: null,
      dateTo: null,
      weekdays: [],
      timeOfDay: null,
      time: null,
    });
  });

  it('labels windows', () => {
    const w = { dateFrom: null, dateTo: null, weekdays: [], timeOfDay: null, time: null };
    expect(describeWindow({ ...w, weekdays: [0, 6] }, '2026-12-01')).toBe('Weekends');
    expect(describeWindow({ ...w, weekdays: [1] }, '2026-12-01')).toBe('Mondays');
    expect(
      describeWindow({ ...w, dateFrom: '2026-12-04', dateTo: '2026-12-05' }, '2026-12-01'),
    ).toBe('Fri, Dec 4 – Sat, Dec 5');
  });
});

// Recorded-format responses (packages/ai/fixtures/<provider>/inbox_auto_schedule.json), replayed
// through the real adapters.
const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'fixtures');
interface InboxFixture {
  request: { method: string; url: string; body: unknown };
  response: { status: number; body: unknown };
}
const loadFixture = (provider: AiProvider): InboxFixture =>
  JSON.parse(readFileSync(join(fixturesDir, provider, 'inbox_auto_schedule.json'), 'utf8'));

describe('acceptance: every provider reads "next week, mornings" the same way', () => {
  for (const provider of AI_PROVIDERS) {
    it(provider, async () => {
      const fixture = loadFixture(provider);
      const bodies: unknown[] = [];
      const fetch: FetchLike = async (url, init) => {
        bodies.push(JSON.parse(String(init.body)));
        expect(url).toBe(fixture.request.url);
        return new Response(JSON.stringify(fixture.response.body), {
          status: fixture.response.status,
        });
      };
      const { deps, port, usage } = setup({
        config: {
          provider,
          model: FIXTURE_MODELS[provider],
          apiKey: FAKE_KEYS[provider],
          monthlyTokenBudget: 100_000,
        },
        createProvider: (id, options) => createProvider(id, { ...options, fetch }),
      });
      rachel(port);
      const res = await ok(deps);
      expect(bodies).toEqual([fixture.request.body]);
      expect(res).toMatchObject({
        interpreter: 'llm',
        fits: true,
        window: { label: 'Next week · mornings' },
      });
      expect(res.suggestions[0]).toMatchObject({ localDate: '2026-12-08', localTime: '10:00' });
      expect(usage).toHaveLength(1);
    });
  }
});
