import { describe, expect, it } from 'vitest';

import type {
  ManageBookingRow,
  ManageSegment,
  ManageSlotsResponse,
  ManageViewResponse,
} from '@chairside/db/client-self-service';

import { NOW, TZ, createFakePort } from '../assistant/fake-salon.ts';
import { handleManageBookingRequest, MANAGE_LIMITS } from './handler.ts';
import type { ManageBookingPort } from './types.ts';

const TOKEN = 'a'.repeat(64);
const APPT = '00000000-0000-4000-8000-0000000000aa';

/** Thu Dec 17 2026, 10:00 AM Chicago: color with apply / process / blow-dry. */
const SEGMENTS: ManageSegment[] = [
  { kind: 'busy', label: 'Apply', start: '2026-12-17T16:00:00Z', end: '2026-12-17T16:45:00Z' },
  {
    kind: 'processing',
    label: 'Process',
    start: '2026-12-17T16:45:00Z',
    end: '2026-12-17T17:30:00Z',
  },
  { kind: 'style', label: 'Blow-dry', start: '2026-12-17T17:30:00Z', end: '2026-12-17T18:00:00Z' },
];

const ROW: ManageBookingRow = {
  appointmentId: APPT,
  salonId: '00000000-0000-4000-8000-000000000001',
  stylistId: '00000000-0000-4000-8000-0000000000f1',
  status: 'confirmed',
  startsAt: '2026-12-17T16:00:00Z',
  endsAt: '2026-12-17T18:00:00Z',
  services: 'All-over Color',
  clientFirstName: 'Jo',
  salon: { name: 'Studio K', slug: 'studio-k', timezone: TZ },
  canCancel: true,
  canReschedule: true,
  policyMessage: null,
  feeCents: 0,
  segments: SEGMENTS,
};

interface TestPort extends ManageBookingPort {
  row: ManageBookingRow;
  hits: Map<string, number>;
  rescheduled: ManageSegment[][];
  cancelled: number;
  rescheduleReply: { ok: false; reason: string; message?: string } | null;
}

function createTestPort(): TestPort {
  const salon = createFakePort();
  const port: TestPort = {
    row: structuredClone(ROW),
    hits: new Map(),
    rescheduled: [],
    cancelled: 0,
    rescheduleReply: null,
    getBooking: async (token) => (token === TOKEN ? structuredClone(port.row) : null),
    getSchedule: (_salonId, range) => salon.getSchedule(range),
    async listBusy(_salonId, range) {
      const others = (await salon.listAppointments(range)).map((a) => ({
        id: a.id,
        segments: a.segments,
      }));
      return [...others, { id: APPT, segments: port.row.segments }];
    },
    async hitRateLimit(key, limit) {
      const count = (port.hits.get(key) ?? 0) + 1;
      port.hits.set(key, count);
      return count <= limit;
    },
    async cancel() {
      port.cancelled++;
      port.row = { ...port.row, status: 'cancelled', canCancel: false, canReschedule: false };
      return { ok: true, status: 'cancelled', feeCents: 0 };
    },
    async reschedule(_token, segments) {
      if (port.rescheduleReply) return port.rescheduleReply;
      port.rescheduled.push(segments);
      port.row = {
        ...port.row,
        segments,
        startsAt: segments[0]!.start,
        endsAt: segments.at(-1)!.end,
      };
      return { ok: true, startsAt: segments[0]!.start, endsAt: segments.at(-1)!.end };
    },
  };
  return port;
}

const call = (port: TestPort, body: Record<string, unknown>, ip = '203.0.113.7') =>
  handleManageBookingRequest(body, { ip }, { port, now: () => NOW });

describe('manage-booking handler', () => {
  it('rejects malformed tokens and unknown links', async () => {
    const port = createTestPort();
    expect((await call(port, { action: 'view', token: 'nope' })).status).toBe(400);
    expect((await call(port, { action: 'view', token: TOKEN.toUpperCase() })).status).toBe(400);
    const missing = await call(port, { action: 'view', token: 'b'.repeat(64) });
    expect(missing.status).toBe(404);
  });

  it('shows the appointment without internal ids or the segment layout', async () => {
    const port = createTestPort();
    const result = await call(port, { action: 'view', token: TOKEN });
    expect(result.status).toBe(200);
    const { booking } = result.body as ManageViewResponse;
    expect(booking).toMatchObject({ status: 'confirmed', services: 'All-over Color' });
    expect(Object.keys(booking)).not.toEqual(
      expect.arrayContaining(['appointmentId', 'salonId', 'stylistId', 'segments']),
    );
    expect(JSON.stringify(result.body)).not.toContain(ROW.salonId);
    expect(JSON.stringify(result.body)).not.toContain(ROW.stylistId);
  });

  it('offers open slots for the same service, ignoring its own current time', async () => {
    const port = createTestPort();
    const result = await call(port, { action: 'slots', token: TOKEN, date: '2026-12-17' });
    expect(result.status).toBe(200);
    const { days } = result.body as ManageSlotsResponse;
    const thursday = days.find((d) => d.date === '2026-12-17')!;
    expect(thursday.slots.length).toBeGreaterThan(0);
    // Its own 10:00 isn't offered back, but times that overlap its current spot are.
    expect(thursday.slots.map((s) => s.start)).not.toContain('2026-12-17T16:00:00.000Z');
    // No names or ids of other appointments leak.
    expect(JSON.stringify(result.body)).not.toMatch(/Maria|Karen|0000-4000/);
    // Friday is booked 9:00–11:30 and 2:30–4:00: nothing starts inside those.
    const friday = days.find((d) => d.date === '2026-12-18');
    for (const slot of friday?.slots ?? []) {
      const start = Date.parse(slot.start);
      expect(
        start >= Date.parse('2026-12-18T15:00:00Z') && start < Date.parse('2026-12-18T17:30:00Z'),
      ).toBe(false);
    }
  });

  it('moves it to an open slot, keeping the same shape and labels', async () => {
    const port = createTestPort();
    const result = await call(port, {
      action: 'reschedule',
      token: TOKEN,
      start: '2026-12-22T15:00:00Z',
    });
    expect(result.status).toBe(200);
    expect(port.rescheduled).toHaveLength(1);
    const moved = port.rescheduled[0]!;
    expect(moved.map((s) => [s.kind, s.label])).toEqual(SEGMENTS.map((s) => [s.kind, s.label]));
    expect(moved.map((s) => Date.parse(s.end) - Date.parse(s.start))).toEqual(
      SEGMENTS.map((s) => Date.parse(s.end) - Date.parse(s.start)),
    );
    expect(moved[0]!.start).toBe('2026-12-22T15:00:00.000Z');
    expect((result.body as ManageViewResponse).booking.startsAt).toBe('2026-12-22T15:00:00.000Z');
  });

  it('refuses overlaps, closed days and the past without calling the database', async () => {
    const port = createTestPort();
    for (const start of [
      '2026-12-18T15:30:00Z', // over Maria's appointment
      '2026-12-20T16:00:00Z', // Sunday: closed
      '2026-12-01T12:00:00Z', // before now
    ]) {
      const result = await call(port, { action: 'reschedule', token: TOKEN, start });
      expect(result.status, start).toBe(409);
    }
    expect(port.rescheduled).toHaveLength(0);
  });

  it('maps a lost race in the database to 409', async () => {
    const port = createTestPort();
    port.rescheduleReply = { ok: false, reason: 'conflict', message: 'That time was just taken.' };
    const result = await call(port, {
      action: 'reschedule',
      token: TOKEN,
      start: '2026-12-22T15:00:00Z',
    });
    expect(result).toEqual({
      status: 409,
      body: { error: { code: 'slot_unavailable', message: 'That time was just taken.' } },
    });
  });

  it('cancels once, then reports it cancelled', async () => {
    const port = createTestPort();
    const first = await call(port, { action: 'cancel', token: TOKEN });
    expect(first.status).toBe(200);
    expect((first.body as ManageViewResponse).booking.status).toBe('cancelled');
    const again = await call(port, { action: 'cancel', token: TOKEN });
    expect(again.status).toBe(200);
    expect(port.cancelled).toBe(1);
    expect((await call(port, { action: 'slots', token: TOKEN, date: '2026-12-17' })).status).toBe(
      403,
    );
  });

  it('honours the policy hook: no change, with the policy message', async () => {
    const port = createTestPort();
    port.row = {
      ...port.row,
      canCancel: false,
      canReschedule: false,
      policyMessage: 'Changes within 24 hours need a call.',
    };
    const result = await call(port, { action: 'cancel', token: TOKEN });
    expect(result).toEqual({
      status: 403,
      body: { error: { code: 'not_allowed', message: 'Changes within 24 hours need a call.' } },
    });
    const move = await call(port, {
      action: 'reschedule',
      token: TOKEN,
      start: '2026-12-22T15:00:00Z',
    });
    expect(move.status).toBe(403);
    expect(port.cancelled).toBe(0);
    expect(port.rescheduled).toHaveLength(0);
  });

  it('rate limits changes per link and lookups per IP', async () => {
    const port = createTestPort();
    for (let i = 0; i < MANAGE_LIMITS.changeToken.limit; i++) {
      await call(
        port,
        { action: 'reschedule', token: TOKEN, start: '2026-12-01T12:00:00Z' },
        `ip${i}`,
      );
    }
    const limited = await call(port, { action: 'cancel', token: TOKEN }, 'fresh-ip');
    expect(limited.status).toBe(429);
    expect(port.cancelled).toBe(0);

    for (let i = 0; i < MANAGE_LIMITS.view.limit; i++) {
      await call(port, { action: 'view', token: TOKEN }, 'scraper');
    }
    expect((await call(port, { action: 'view', token: TOKEN }, 'scraper')).status).toBe(429);
  });
});
