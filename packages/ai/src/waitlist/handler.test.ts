import { describe, expect, it } from 'vitest';

import type {
  ClaimedOpening,
  SentWaitlistOffer,
  WaitlistLinkRow,
  WaitlistOfferDraft,
  WaitlistProcessResponse,
  WaitlistSegment,
  WaitlistViewResponse,
} from '@chairside/db/waitlist';

import {
  COLOR,
  CUT,
  KAREN,
  KARINA,
  MARIA,
  NOW,
  TZ,
  createFakePort,
} from '../assistant/fake-salon.ts';
import { handleWaitlistRequest, WAITLIST_LIMITS } from './handler.ts';
import { matchOpening, MAX_OFFERS_PER_OPENING } from './match.ts';
import type { WaitlistPort } from './types.ts';

const SALON = '00000000-0000-4000-8000-000000000001';
const OPENING = '00000000-0000-4000-8000-0000000000e1';
const OFFER = '00000000-0000-4000-8000-0000000000f1';
const TOKEN = 'a'.repeat(64);
const MEMBER_TOKEN = 'member.jwt';
const CLIENT_TOKEN = 'client.jwt';
const entry = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;

/** Fri Dec 18 2026 (CST): Karen's 2:30-4:00 PM is cancelled; Maria still has 9:00-11:30. */
const OPENING_ROW: ClaimedOpening = {
  openingId: OPENING,
  salonId: SALON,
  stylistId: 'stylist',
  startsAt: '2026-12-18T20:30:00Z',
  endsAt: '2026-12-18T22:00:00Z',
  day: '2026-12-18',
  timezone: TZ,
  enabled: true,
  entries: [],
};

const OFFER_SEGMENTS: WaitlistSegment[] = [
  { kind: 'busy', label: null, start: '2026-12-18T20:30:00Z', end: '2026-12-18T21:30:00Z' },
];

const LINK: WaitlistLinkRow = {
  salonId: SALON,
  entry: {
    status: 'offered',
    day: '2026-12-18',
    windowStart: null,
    windowEnd: null,
    servicesLabel: "Women's Haircut",
    clientFirstName: 'Karina',
  },
  offer: {
    offerId: OFFER,
    startsAt: '2026-12-18T20:30:00Z',
    endsAt: '2026-12-18T21:30:00Z',
    expiresAt: '2026-12-01T17:00:00Z',
    items: [{ serviceId: CUT }],
    segments: OFFER_SEGMENTS,
    services: [],
    priceCents: 6500,
  },
  booking: null,
  salon: { name: 'Studio K', slug: 'studio-k', timezone: TZ },
};

const SENT: SentWaitlistOffer = {
  ok: true,
  offerId: OFFER,
  token: TOKEN,
  clientName: 'Karina Lopez',
  email: 'karina@example.com',
  phone: '+15550100101',
  salonName: 'Studio K',
  timezone: TZ,
  startsAt: '2026-12-18T20:30:00Z',
  endsAt: '2026-12-18T21:30:00Z',
  servicesLabel: "Women's Haircut",
  expiresAt: '2026-12-01T17:00:00Z',
};

interface TestPort extends WaitlistPort {
  salon: ReturnType<typeof createFakePort>;
  openings: ClaimedOpening[];
  saved: { openingId: string; offers: WaitlistOfferDraft[] }[];
  autoSent: SentWaitlistOffer[];
  emailed: SentWaitlistOffer[];
  accepted: WaitlistSegment[][];
  joined: unknown[];
  link: WaitlistLinkRow | null;
  hits: Map<string, number>;
}

function createTestPort(options: { email?: boolean } = {}): TestPort {
  const salon = createFakePort();
  // Karen's appointment was cancelled; the calendar no longer has it.
  salon.appointments.splice(
    salon.appointments.findIndex((a) => a.client_id === KAREN),
    1,
  );
  const port: TestPort = {
    salon,
    openings: [],
    saved: [],
    autoSent: [],
    emailed: [],
    accepted: [],
    joined: [],
    link: structuredClone(LINK),
    hits: new Map(),
    claimOpenings: async () => port.openings.splice(0),
    async saveOffers(openingId, offers) {
      port.saved.push({ openingId, offers });
      return { ok: true, saved: offers.length, sent: port.autoSent };
    },
    getSchedule: (_salonId, range) => salon.getSchedule(range),
    getMenu: () => salon.getMenu(),
    clientOverrides: (_salonId, clientId) => salon.clientOverrides(clientId),
    async listBusy(_salonId, range) {
      return (await salon.listAppointments(range)).map((a) => ({ id: a.id, segments: a.segments }));
    },
    async hitRateLimit(key, limit) {
      const count = (port.hits.get(key) ?? 0) + 1;
      port.hits.set(key, count);
      return count <= limit;
    },
    getPage: async (slug) =>
      slug === 'studio-k'
        ? {
            salonId: SALON,
            name: 'Studio K',
            slug,
            timezone: TZ,
            currency: 'usd',
            enabled: true,
            intro: null,
            faq: null,
            autoConfirm: true,
          }
        : null,
    getVerifiedUser: async (accessToken) =>
      accessToken === CLIENT_TOKEN ? { id: 'client-user', email: 'nina@example.com' } : null,
    async join(_salonId, _userId, input) {
      port.joined.push(input);
      return { ok: true, token: TOKEN, day: input.day };
    },
    getLink: async (token) => (token === TOKEN ? structuredClone(port.link) : null),
    async leave() {
      port.link = port.link && {
        ...port.link,
        entry: { ...port.link.entry, status: 'cancelled' },
        offer: null,
      };
      return { ok: true };
    },
    async accept(_token, _offerId, segments) {
      port.accepted.push(segments);
      port.link = port.link && {
        ...port.link,
        entry: { ...port.link.entry, status: 'booked' },
        offer: null,
        booking: {
          startsAt: segments[0]!.start,
          endsAt: segments.at(-1)!.end,
          status: 'confirmed',
          manageToken: 'b'.repeat(64),
        },
      };
      return {
        ok: true,
        appointmentId: 'appt',
        startsAt: segments[0]!.start,
        endsAt: segments.at(-1)!.end,
      };
    },
    memberUserId: async (accessToken, salonId) =>
      accessToken === MEMBER_TOKEN && salonId === SALON ? 'owner' : null,
    offerSalonId: async (offerId) => (offerId === OFFER ? SALON : null),
    sendOffer: async () => SENT,
    sendOfferEmail:
      options.email === false
        ? null
        : async (offer) => {
            port.emailed.push(offer);
          },
  };
  return port;
}

const call = (
  port: TestPort,
  body: Record<string, unknown>,
  meta: { accessToken?: string | null; trusted?: boolean; ip?: string } = {},
) =>
  handleWaitlistRequest(
    body,
    {
      ip: meta.ip ?? '203.0.113.7',
      accessToken: meta.accessToken ?? null,
      trusted: !!meta.trusted,
    },
    { port, now: () => NOW },
  );

describe('waitlist matching', () => {
  it('offers each waiting client the open start closest to the freed time', async () => {
    const port = createTestPort();
    const drafts = await matchOpening(
      port,
      {
        ...OPENING_ROW,
        entries: [
          {
            entryId: entry(1),
            clientId: KARINA,
            items: [{ serviceId: CUT }],
            windowStart: null,
            windowEnd: null,
            createdAt: '',
          },
          {
            entryId: entry(2),
            clientId: MARIA,
            items: [{ serviceId: COLOR }],
            windowStart: null,
            windowEnd: null,
            createdAt: '',
          },
        ],
      },
      NOW,
    );
    expect(drafts.map((d) => [d.entryId, d.startsAt, d.endsAt])).toEqual([
      [entry(1), '2026-12-18T20:30:00.000Z', '2026-12-18T21:30:00.000Z'],
      [entry(2), '2026-12-18T20:30:00.000Z', '2026-12-18T22:30:00.000Z'],
    ]);
    expect(drafts[0]!.priceCents).toBe(6500);
    expect(drafts[0]!.services).toEqual([expect.objectContaining({ serviceId: CUT })]);
    expect(drafts[1]!.segments.map((s) => s.kind)).toEqual(['busy', 'processing', 'style']);
  });

  it('respects the client window, their duration overrides and services that still exist', async () => {
    const port = createTestPort();
    port.salon.overrides.set(KARINA, [{ serviceId: CUT, deltaMinutes: 20 }]);
    const drafts = await matchOpening(
      port,
      {
        ...OPENING_ROW,
        entries: [
          // Only mornings: the freed afternoon slot doesn't suit her.
          {
            entryId: entry(1),
            clientId: MARIA,
            items: [{ serviceId: CUT }],
            windowStart: '09:00',
            windowEnd: '12:00',
            createdAt: '',
          },
          {
            entryId: entry(2),
            clientId: KAREN,
            items: [{ serviceId: '00000000-0000-4000-8000-0000000000ff' }],
            windowStart: null,
            windowEnd: null,
            createdAt: '',
          },
          {
            entryId: entry(3),
            clientId: KARINA,
            items: [{ serviceId: CUT }],
            windowStart: '14:00',
            windowEnd: '17:00',
            createdAt: '',
          },
        ],
      },
      NOW,
    );
    expect(drafts.map((d) => [d.entryId, d.endsAt])).toEqual([
      [entry(3), '2026-12-18T21:50:00.000Z'],
    ]);
  });

  it('never offers time outside the freed slot or more than a handful of clients', async () => {
    const port = createTestPort();
    const entries = Array.from({ length: 8 }, (_, i) => ({
      entryId: entry(i + 1),
      clientId: KARINA,
      items: [{ serviceId: CUT }],
      windowStart: null,
      windowEnd: null,
      createdAt: '',
    }));
    const drafts = await matchOpening(port, { ...OPENING_ROW, entries }, NOW);
    expect(drafts).toHaveLength(MAX_OFFERS_PER_OPENING);

    // The day is otherwise free in the morning, but only the freed afternoon is offered.
    const tooLong = await matchOpening(
      port,
      {
        ...OPENING_ROW,
        startsAt: '2026-12-18T22:30:00Z',
        endsAt: '2026-12-18T23:00:00Z',
        entries: [{ ...entries[0]!, items: [{ serviceId: COLOR }] }],
      },
      NOW,
    );
    expect(tooLong).toEqual([]);
  });
});

describe('waitlist handler', () => {
  it('only matches for the database or a salon member', async () => {
    const port = createTestPort();
    expect((await call(port, { action: 'process' })).status).toBe(401);
    expect(
      (await call(port, { action: 'process', salonId: SALON }, { accessToken: CLIENT_TOKEN }))
        .status,
    ).toBe(403);
    expect(
      (await call(port, { action: 'process', salonId: SALON }, { accessToken: MEMBER_TOKEN }))
        .status,
    ).toBe(200);
  });

  it('saves the fits and emails offers that went out automatically', async () => {
    const port = createTestPort();
    port.openings.push({
      ...OPENING_ROW,
      entries: [
        {
          entryId: entry(1),
          clientId: KARINA,
          items: [{ serviceId: CUT }],
          windowStart: null,
          windowEnd: null,
          createdAt: '',
        },
      ],
    });
    port.autoSent.push(SENT);
    const result = await call(port, { action: 'process' }, { trusted: true });
    expect(result).toEqual({
      status: 200,
      body: { openings: 1, offers: 1, sent: 1 } satisfies WaitlistProcessResponse,
    });
    expect(port.saved[0]!.openingId).toBe(OPENING);
    expect(port.emailed).toEqual([SENT]);
  });

  it('closes openings for salons that turned the waitlist off', async () => {
    const port = createTestPort();
    port.openings.push({
      ...OPENING_ROW,
      enabled: false,
      entries: [
        {
          entryId: entry(1),
          clientId: KARINA,
          items: [{ serviceId: CUT }],
          windowStart: null,
          windowEnd: null,
          createdAt: '',
        },
      ],
    });
    await call(port, { action: 'process' }, { trusted: true });
    expect(port.saved).toEqual([{ openingId: OPENING, offers: [] }]);
  });

  it('joins a verified client for a day and window from the booking page', async () => {
    const port = createTestPort();
    const body = {
      action: 'join',
      slug: 'studio-k',
      date: '2026-12-18',
      windowStart: '13:00',
      windowEnd: '17:00',
      items: [{ serviceId: CUT }],
      name: 'Nina',
      phone: '(555) 010-0505',
    };
    expect((await call(port, body)).status).toBe(401);
    const result = await call(port, body, { accessToken: CLIENT_TOKEN });
    expect(result).toEqual({ status: 200, body: { token: TOKEN, day: '2026-12-18' } });
    expect(port.joined).toEqual([
      expect.objectContaining({
        day: '2026-12-18',
        windowStart: '13:00',
        windowEnd: '17:00',
        servicesLabel: "Women's Haircut · 1h00",
        phone: '+15550100505',
      }),
    ]);
  });

  it('rejects bad days, windows and services', async () => {
    const port = createTestPort();
    const base = {
      action: 'join',
      slug: 'studio-k',
      date: '2026-12-18',
      items: [{ serviceId: CUT }],
    };
    const meta = { accessToken: CLIENT_TOKEN };
    expect((await call(port, { ...base, date: '2026-11-30' }, meta)).status).toBe(400);
    expect((await call(port, { ...base, date: '2027-06-01' }, meta)).status).toBe(400);
    expect(
      (await call(port, { ...base, windowStart: '15:00', windowEnd: '13:00' }, meta)).status,
    ).toBe(400);
    expect((await call(port, { ...base, windowStart: '15:00' }, meta)).status).toBe(400);
    port.salon.getMenu = async () => ({ services: [], combos: [], addons: [] });
    expect((await call(port, base, meta)).body).toMatchObject({
      error: { code: 'unknown_service' },
    });
    expect(port.joined).toEqual([]);
  });

  it('shows the link without internal ids or the segment layout', async () => {
    const port = createTestPort();
    expect((await call(port, { action: 'view', token: 'b'.repeat(64) })).status).toBe(404);
    const result = await call(port, { action: 'view', token: TOKEN });
    expect(result.status).toBe(200);
    const { link } = result.body as WaitlistViewResponse;
    expect(link.offer).toEqual({
      offerId: OFFER,
      startsAt: LINK.offer!.startsAt,
      endsAt: LINK.offer!.endsAt,
      expiresAt: LINK.offer!.expiresAt,
      priceCents: 6500,
    });
    expect(JSON.stringify(link)).not.toContain(SALON);
  });

  it('re-checks the slot with the engine before booking it', async () => {
    const port = createTestPort();
    const result = await call(port, { action: 'accept', token: TOKEN, offerId: OFFER });
    expect(result.status).toBe(200);
    expect(port.accepted).toEqual([
      [
        {
          kind: 'busy',
          label: null,
          start: '2026-12-18T20:30:00.000Z',
          end: '2026-12-18T21:30:00.000Z',
        },
      ],
    ]);
    expect((result.body as WaitlistViewResponse).link.booking?.manageToken).toBe('b'.repeat(64));
  });

  it('turns down a slot that was booked in the meantime or a stale offer', async () => {
    const port = createTestPort();
    expect((await call(port, { action: 'accept', token: TOKEN, offerId: entry(9) })).status).toBe(
      409,
    );
    port.salon.appointments.push({
      ...port.salon.appointments[0]!,
      id: 'other',
      segments: [
        { kind: 'busy', label: null, start: '2026-12-18T21:00:00Z', end: '2026-12-18T21:45:00Z' },
      ],
      starts_at: '2026-12-18T21:00:00Z',
      ends_at: '2026-12-18T21:45:00Z',
    });
    const result = await call(port, { action: 'accept', token: TOKEN, offerId: OFFER });
    expect(result).toMatchObject({ status: 409, body: { error: { code: 'taken' } } });
    expect(port.accepted).toEqual([]);
  });

  it('lets the client leave', async () => {
    const port = createTestPort();
    const result = await call(port, { action: 'leave', token: TOKEN });
    expect((result.body as WaitlistViewResponse).link.entry.status).toBe('cancelled');
  });

  it('rate limits changes per token', async () => {
    const port = createTestPort();
    for (let i = 0; i < WAITLIST_LIMITS.changeToken.limit; i++) {
      await call(port, { action: 'leave', token: TOKEN }, { ip: `198.51.100.${i}` });
    }
    expect(
      (await call(port, { action: 'leave', token: TOKEN }, { ip: '198.51.100.99' })).status,
    ).toBe(429);
  });

  it('emails a drafted offer for a member when email is set up', async () => {
    expect((await call(createTestPort(), { action: 'send_offer', offerId: OFFER })).status).toBe(
      401,
    );
    expect(
      (
        await call(
          createTestPort(),
          { action: 'send_offer', offerId: OFFER },
          { accessToken: CLIENT_TOKEN },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          createTestPort({ email: false }),
          { action: 'send_offer', offerId: OFFER },
          { accessToken: MEMBER_TOKEN },
        )
      ).status,
    ).toBe(503);
    const port = createTestPort();
    const result = await call(
      port,
      { action: 'send_offer', offerId: OFFER },
      { accessToken: MEMBER_TOKEN },
    );
    expect(result).toEqual({ status: 200, body: { sent: true, email: 'karina@example.com' } });
    expect(port.emailed).toEqual([SENT]);
  });
});
