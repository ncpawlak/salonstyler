import { describe, expect, it } from 'vitest';

import type { ServiceMenu } from '@chairside/db/services';

import { COLOR, CUT, MENU, NOW, TZ, createFakePort } from '../assistant/fake-salon.ts';
import type { ChatMessage, ChatResult, LLMProvider } from '../types.ts';
import { planPublicBooking, publicMenu, publicSlots } from './booking.ts';
import { DemoConciergeProvider, demoMatchService } from './demo-provider.ts';
import {
  handlePublicBookingRequest,
  trimVisibleHistory,
  type PublicBookingDeps,
  type PublicChatResponse,
  type PublicPageResponse,
  type PublicSlotsResponse,
} from './handler.ts';
import type {
  PublicBookResult,
  PublicBookingInput,
  PublicBookingPort,
  PublicClientBooking,
  PublicSalonPage,
} from './types.ts';

const SALON = '00000000-0000-4000-8000-000000000001';
const HIDDEN = '00000000-0000-4000-8000-0000000000c3';
const USER = '00000000-0000-4000-8000-0000000000e1';

const menu: ServiceMenu = {
  ...MENU,
  services: [
    ...MENU.services,
    {
      ...MENU.services[0]!,
      id: HIDDEN,
      position: 2,
      name: 'Secret Treatment',
      bookableOnline: false,
    },
  ],
};

const PAGE: PublicSalonPage = {
  salonId: SALON,
  name: 'Studio K',
  slug: 'studio-k',
  timezone: TZ,
  currency: 'USD',
  enabled: true,
  intro: 'Welcome!',
  faq: 'Park in the back lot.',
  autoConfirm: true,
};

interface TestPort extends PublicBookingPort {
  page: PublicSalonPage;
  booked: PublicBookingInput[];
  hits: Map<string, number>;
  limitOverride: Map<string, number>;
  codes: string[];
  bookReply: PublicBookResult | null;
}

function createTestPort(): TestPort {
  const salon = createFakePort();
  const port: TestPort = {
    page: { ...PAGE },
    booked: [],
    hits: new Map(),
    limitOverride: new Map(),
    codes: [],
    bookReply: null,
    getPage: async (slug) => (slug === port.page.slug ? port.page : null),
    getSchedule: (_salonId, range) => salon.getSchedule(range),
    getMenu: async () => menu,
    async listBusy(_salonId, range) {
      return (await salon.listAppointments(range)).map((a) => ({ id: a.id, segments: a.segments }));
    },
    async hitRateLimit(key, limit) {
      const count = (port.hits.get(key) ?? 0) + 1;
      port.hits.set(key, count);
      return count <= (port.limitOverride.get(key.split(':').slice(0, 2).join(':')) ?? limit);
    },
    async sendCode(email) {
      port.codes.push(email);
    },
    getVerifiedUser: async (token) =>
      token === 'verified' ? { id: USER, email: 'jo@example.com' } : null,
    async book(_salonId, _userId, booking) {
      port.booked.push(booking);
      return (
        port.bookReply ?? {
          ok: true,
          appointmentId: 'appt-1',
          status: booking.requiresApproval ? 'requested' : 'confirmed',
          startsAt: booking.segments[0]!.start,
          endsAt: booking.segments.at(-1)!.end,
          clientId: 'client-1',
          clientCreated: true,
          clientLinked: true,
        }
      );
    },
    myBookings: async (): Promise<PublicClientBooking[]> => [
      {
        id: 'appt-1',
        status: 'confirmed',
        startsAt: '2026-12-04T16:00:00Z',
        endsAt: '2026-12-04T17:00:00Z',
        services: "Women's Haircut",
      },
    ],
  };
  return port;
}

const depsFor = (port: PublicBookingPort, extra: Partial<PublicBookingDeps> = {}) =>
  ({
    port,
    loadConfig: async () => null,
    tokensUsedThisMonth: async () => 0,
    recordUsage: async () => {},
    now: () => NOW,
    ...extra,
  }) satisfies PublicBookingDeps;

type Meta = { ip: string; accessToken: string | null };
const anon: Meta = { ip: '203.0.113.9', accessToken: null };
const verified: Meta = { ip: '203.0.113.9', accessToken: 'verified' };

/** Fri Dec 4 2026, 10:00 AM in Chicago. */
const FRI_10AM = '2026-12-04T16:00:00.000Z';

describe('publicMenu', () => {
  it('lists only services bookable online', () => {
    const names = publicMenu(menu).map((s) => s.name);
    expect(names).toEqual(["Women's Haircut", 'All-over Color']);
    const color = publicMenu(menu).find((s) => s.id === COLOR)!;
    expect(color.minutes).toBe(120);
    expect(color.variants).toEqual([{ id: 'v-long', name: 'Long hair', minutes: 150 }]);
  });

  it('hides archived services', () => {
    const archived = {
      ...menu,
      services: menu.services.map((s) =>
        s.id === CUT ? { ...s, archivedAt: '2026-01-01T00:00:00Z' } : s,
      ),
    };
    expect(publicMenu(archived).map((s) => s.id)).toEqual([COLOR]);
  });
});

describe('publicSlots', () => {
  it('returns engine slots without any appointment details', async () => {
    const port = createTestPort();
    const card = await publicSlots(
      port,
      SALON,
      { items: [{ serviceId: CUT }], date: '2026-12-18' },
      NOW,
    );
    const fri = card.days.find((d) => d.date === '2026-12-18')!;
    // Booked 9:00–11:30 and 2:30–4:00, break 12:00–12:30.
    expect(fri.slots.map((s) => s.time)).not.toContain('9:00 AM');
    expect(fri.slots.length).toBeGreaterThan(0);
    expect(JSON.stringify(card)).not.toMatch(/Maria|Karen|client/i);
  });

  it('refuses services that are not bookable online', async () => {
    await expect(
      publicSlots(
        createTestPort(),
        SALON,
        { items: [{ serviceId: HIDDEN }], date: '2026-12-18' },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'unknown_service' });
  });

  it('explains a closed day', async () => {
    const card = await publicSlots(
      createTestPort(),
      SALON,
      { items: [{ serviceId: CUT }], date: '2026-12-06' },
      NOW,
    );
    expect(card.requestedNote).toMatch(/Closed/);
  });
});

describe('planPublicBooking', () => {
  it('re-plans the slot with the engine', async () => {
    const plan = await planPublicBooking(
      createTestPort(),
      SALON,
      { items: [{ serviceId: CUT }], start: FRI_10AM },
      NOW,
    );
    expect(plan.start).toBe(FRI_10AM);
    expect(plan.end).toBe('2026-12-04T17:00:00.000Z');
    expect(plan.priceCents).toBe(6500);
    expect(plan.requiresApproval).toBe(false);
  });

  it('rejects a taken slot', async () => {
    await expect(
      planPublicBooking(
        createTestPort(),
        SALON,
        { items: [{ serviceId: CUT }], start: '2026-12-18T15:00:00Z' },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'slot_unavailable' });
  });

  it('rejects a slot outside open hours', async () => {
    await expect(
      planPublicBooking(
        createTestPort(),
        SALON,
        // Sunday.
        { items: [{ serviceId: CUT }], start: '2026-12-06T16:00:00Z' },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'slot_unavailable' });
  });

  it('turns consultation services into requests', async () => {
    const port = createTestPort();
    port.getMenu = async () => ({
      ...menu,
      services: menu.services.map((s) => (s.id === CUT ? { ...s, consultationRequired: true } : s)),
    });
    const plan = await planPublicBooking(
      port,
      SALON,
      { items: [{ serviceId: CUT }], start: FRI_10AM },
      NOW,
    );
    expect(plan.requiresApproval).toBe(true);
  });
});

describe('handlePublicBookingRequest', () => {
  it('serves the page without the salon id', async () => {
    const port = createTestPort();
    const res = await handlePublicBookingRequest(
      { action: 'page', slug: 'Studio-K' },
      anon,
      depsFor(port),
    );
    expect(res.status).toBe(200);
    const body = res.body as PublicPageResponse;
    expect(body.page).not.toHaveProperty('salonId');
    expect(body.page.concierge).toBe(false);
    expect(body.services.map((s) => s.id)).toEqual([CUT, COLOR]);
  });

  it('404s unknown slugs and hides the menu of a disabled page', async () => {
    const port = createTestPort();
    expect(
      (await handlePublicBookingRequest({ action: 'page', slug: 'nope' }, anon, depsFor(port)))
        .status,
    ).toBe(404);
    port.page.enabled = false;
    const page = await handlePublicBookingRequest(
      { action: 'page', slug: 'studio-k' },
      anon,
      depsFor(port),
    );
    expect((page.body as PublicPageResponse).services).toEqual([]);
    const slots = await handlePublicBookingRequest(
      { action: 'slots', slug: 'studio-k', services: [{ serviceId: CUT }], date: '2026-12-18' },
      anon,
      depsFor(port),
    );
    expect(slots.status).toBe(403);
  });

  it('rate limits by IP', async () => {
    const port = createTestPort();
    port.limitOverride.set('ip:page', 2);
    const call = () =>
      handlePublicBookingRequest({ action: 'page', slug: 'studio-k' }, anon, depsFor(port));
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
  });

  it('sends codes with per-email and per-phone limits', async () => {
    const port = createTestPort();
    port.limitOverride.set('phone:send_code', 1);
    const send = (email: string) =>
      handlePublicBookingRequest(
        { action: 'send_code', slug: 'studio-k', email, phone: '(555) 010-1234' },
        anon,
        depsFor(port),
      );
    expect((await send('Jo@Example.com')).status).toBe(200);
    expect(port.codes).toEqual(['jo@example.com']);
    expect((await send('other@example.com')).status).toBe(429);
    expect(port.codes).toHaveLength(1);
  });

  it('rejects invalid phone numbers', async () => {
    const res = await handlePublicBookingRequest(
      { action: 'send_code', slug: 'studio-k', email: 'jo@example.com', phone: 'call me' },
      anon,
      depsFor(createTestPort()),
    );
    expect(res.status).toBe(400);
  });

  const bookBody = {
    action: 'book',
    slug: 'studio-k',
    services: [{ serviceId: CUT }],
    start: FRI_10AM,
    name: 'Jo',
    phone: '555-010-1234',
    notes: 'First visit',
  };

  it('requires a verified email to book', async () => {
    const port = createTestPort();
    const res = await handlePublicBookingRequest(bookBody, anon, depsFor(port));
    expect(res.status).toBe(401);
    expect(port.booked).toHaveLength(0);
    const bad = await handlePublicBookingRequest(
      bookBody,
      { ip: '1.1.1.1', accessToken: 'forged' },
      depsFor(port),
    );
    expect(bad.status).toBe(401);
  });

  it('books an engine-planned slot', async () => {
    const port = createTestPort();
    const res = await handlePublicBookingRequest(bookBody, verified, depsFor(port));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      booking: { status: 'confirmed', start: FRI_10AM, serviceSummary: "Women's Haircut · 1h00" },
    });
    expect(port.booked[0]).toMatchObject({
      name: 'Jo',
      phone: '+15550101234',
      priceCents: 6500,
      requiresApproval: false,
      notes: 'Online booking: First visit',
    });
    expect(port.booked[0]!.segments[0]).toMatchObject({ start: FRI_10AM });
  });

  it('never trusts a client-picked time the engine rejects', async () => {
    const port = createTestPort();
    const res = await handlePublicBookingRequest(
      { ...bookBody, start: '2026-12-18T15:00:00Z' },
      verified,
      depsFor(port),
    );
    expect(res.status).toBe(409);
    expect(port.booked).toHaveLength(0);
  });

  it('refuses hidden services', async () => {
    const res = await handlePublicBookingRequest(
      { ...bookBody, services: [{ serviceId: HIDDEN }] },
      verified,
      depsFor(createTestPort()),
    );
    expect(res).toMatchObject({ status: 400, body: { error: { code: 'unknown_service' } } });
  });

  it('maps database refusals', async () => {
    const port = createTestPort();
    port.bookReply = { ok: false, reason: 'conflict' };
    expect(await handlePublicBookingRequest(bookBody, verified, depsFor(port))).toMatchObject({
      status: 409,
      body: { error: { code: 'slot_unavailable' } },
    });
    port.bookReply = { ok: false, reason: 'limit' };
    expect(await handlePublicBookingRequest(bookBody, verified, depsFor(port))).toMatchObject({
      status: 409,
      body: { error: { code: 'limit' } },
    });
  });

  it('limits bookings per verified user', async () => {
    const port = createTestPort();
    port.limitOverride.set('user:book', 1);
    expect((await handlePublicBookingRequest(bookBody, verified, depsFor(port))).status).toBe(200);
    expect((await handlePublicBookingRequest(bookBody, verified, depsFor(port))).status).toBe(429);
  });

  it('shows my bookings only when verified', async () => {
    const port = createTestPort();
    const body = { action: 'my_bookings', slug: 'studio-k' };
    expect((await handlePublicBookingRequest(body, anon, depsFor(port))).status).toBe(401);
    const res = await handlePublicBookingRequest(body, verified, depsFor(port));
    expect(res).toMatchObject({ status: 200, body: { bookings: [{ id: 'appt-1' }] } });
  });

  it('is unavailable without an AI key', async () => {
    const res = await handlePublicBookingRequest(
      { action: 'chat', slug: 'studio-k', text: 'haircut friday' },
      anon,
      depsFor(createTestPort()),
    );
    expect(res.status).toBe(503);
  });

  it('chats with the demo concierge and returns slot cards', async () => {
    const port = createTestPort();
    const res = await handlePublicBookingRequest(
      { action: 'chat', slug: 'studio-k', text: 'Can I get a haircut on Dec 18?' },
      anon,
      depsFor(port, { demoProvider: () => new DemoConciergeProvider() }),
    );
    expect(res.status).toBe(200);
    const body = res.body as PublicChatResponse;
    expect(body.cards).toHaveLength(1);
    expect(body.cards[0]!.requestedDate).toBe('2026-12-18');
    expect(body.cards[0]!.days[0]!.date).toBe('2026-12-18');
    expect(body.reply).toMatch(/Fri, Dec 18/);
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('meters a real provider and hides its errors', async () => {
    const usage: string[] = [];
    const failing: LLMProvider = {
      id: 'openai',
      model: 'gpt-test',
      async chat() {
        const { AiProviderError } = await import('../http.ts');
        throw new AiProviderError('openai', 'auth', 'bad key sk-secret', 401);
      },
    };
    const res = await handlePublicBookingRequest(
      { action: 'chat', slug: 'studio-k', text: 'hi' },
      anon,
      depsFor(createTestPort(), {
        loadConfig: async () => ({
          provider: 'openai',
          model: 'gpt-test',
          apiKey: 'sk-secret',
          monthlyTokenBudget: 1000,
        }),
        recordUsage: async (e) => void usage.push(e.purpose),
        createProvider: () => failing,
      }),
    );
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('sk-secret');
  });

  it('records concierge usage against the salon budget', async () => {
    const usage: string[] = [];
    const scripted: LLMProvider = {
      id: 'openai',
      model: 'gpt-test',
      async chat(): Promise<ChatResult> {
        return {
          type: 'text',
          text: 'Hello!',
          toolCalls: [],
          provider: 'openai',
          model: 'gpt-test',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        };
      },
    };
    const res = await handlePublicBookingRequest(
      { action: 'chat', slug: 'studio-k', text: 'hi' },
      anon,
      depsFor(createTestPort(), {
        loadConfig: async () => ({
          provider: 'openai',
          model: 'gpt-test',
          apiKey: 'sk-secret',
          monthlyTokenBudget: 1000,
        }),
        recordUsage: async (e) => void usage.push(e.purpose),
        createProvider: () => scripted,
      }),
    );
    expect(res.status).toBe(200);
    expect(usage).toEqual(['concierge']);
  });
});

describe('concierge', () => {
  it('answers my-bookings questions only after verification', async () => {
    const port = createTestPort();
    const ask = (meta: Meta) =>
      handlePublicBookingRequest(
        { action: 'chat', slug: 'studio-k', text: 'What are my bookings?' },
        meta,
        depsFor(port, { demoProvider: () => new DemoConciergeProvider() }),
      );
    expect(((await ask(anon)).body as PublicChatResponse).reply).toMatch(/Verify your email/);
    expect(((await ask(verified)).body as PublicChatResponse).reply).toMatch(/Fri, Dec 4/);
  });

  it('answers salon questions from the FAQ', async () => {
    const res = await handlePublicBookingRequest(
      { action: 'chat', slug: 'studio-k', text: 'Where do I park?' },
      anon,
      depsFor(createTestPort(), { demoProvider: () => new DemoConciergeProvider() }),
    );
    expect((res.body as PublicChatResponse).reply).toContain('back lot');
  });

  it('cannot reach hidden services through the model', async () => {
    const port = createTestPort();
    const sneaky: LLMProvider = {
      id: 'openai',
      model: 'x',
      async chat(messages: ChatMessage[]): Promise<ChatResult> {
        const base = {
          provider: 'openai' as const,
          model: 'x',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        };
        const tool = [...messages].reverse().find((m) => m.role === 'tool');
        if (tool) {
          return {
            ...base,
            type: 'text',
            text: tool.content as string,
            toolCalls: [],
            finishReason: 'stop',
          };
        }
        return {
          ...base,
          type: 'tool_calls',
          text: null,
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: '1',
              name: 'find_slots',
              arguments: { services: [{ serviceId: HIDDEN }], date: '2026-12-18' },
            },
          ],
        };
      },
    };
    const res = await handlePublicBookingRequest(
      { action: 'chat', slug: 'studio-k', text: 'secret please' },
      anon,
      depsFor(port, { demoProvider: () => sneaky }),
    );
    const body = res.body as PublicChatResponse;
    expect(body.cards).toEqual([]);
    expect(body.reply).toContain('unknown_service');
  });

  it('keeps only recent visible history starting with the client', () => {
    const history = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: String(i),
    }));
    const kept = trimVisibleHistory(history);
    expect(kept[0]!.role).toBe('user');
    expect(kept.length).toBeLessThanOrEqual(20);
  });

  it('matches services by words', () => {
    expect(demoMatchService('can I get color', publicMenu(menu))?.id).toBe(COLOR);
    expect(demoMatchService('a haircut please', publicMenu(menu))?.id).toBe(CUT);
    expect(demoMatchService('pedicure', publicMenu(menu))).toBeNull();
  });
});

describe('slots action', () => {
  it('returns a card for public services', async () => {
    const res = await handlePublicBookingRequest(
      {
        action: 'slots',
        slug: 'studio-k',
        services: [{ serviceId: COLOR, variantId: null }],
        date: '2026-12-18',
        timeOfDay: 'afternoon',
      },
      anon,
      depsFor(createTestPort()),
    );
    expect(res.status).toBe(200);
    const card = (res.body as PublicSlotsResponse).card;
    expect(card.serviceSummary).toContain('All-over Color');
  });
});
