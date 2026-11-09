/**
 * In-memory salon for the assistant's unit tests (not exported from the package).
 * Studio K, America/Chicago, open Tue–Sat 9:00–5:00 with a 12:00–12:30 break.
 */
import { buildWorkHours, type BookingSegment, type ClientServiceOverride } from '@chairside/core';
import type {
  AppointmentServiceSnapshot,
  AppointmentWithDetails,
} from '@chairside/db/appointments';
import type { ServiceMenu } from '@chairside/db/services';

import type {
  AssistantClient,
  AssistantPort,
  ClientVisit,
  ReplyContext,
  ReplyRequestInfo,
} from './types.ts';

export const TZ = 'America/Chicago';
/** Tue Dec 1 2026, 9:00 AM in Chicago. */
export const NOW = Date.parse('2026-12-01T15:00:00Z');

export const CUT = '00000000-0000-4000-8000-0000000000c1';
export const COLOR = '00000000-0000-4000-8000-0000000000c2';
export const KARINA = '00000000-0000-4000-8000-00000000000a';
export const KAREN = '00000000-0000-4000-8000-00000000000b';
export const MARIA = '00000000-0000-4000-8000-00000000000c';
const SALON = '00000000-0000-4000-8000-000000000001';

export const MENU: ServiceMenu = {
  services: [
    {
      id: CUT,
      isCombo: false,
      position: 0,
      archivedAt: null,
      name: "Women's Haircut",
      category: 'Cuts',
      priceCents: 6500,
      colorTag: 'pink',
      segments: [{ kind: 'busy', minutes: 60 }],
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      consultationRequired: false,
      bookableOnline: true,
      newClientsOnly: false,
      variants: [],
    },
    {
      id: COLOR,
      isCombo: false,
      position: 1,
      archivedAt: null,
      name: 'All-over Color',
      category: 'Color',
      priceCents: 12000,
      colorTag: 'purple',
      segments: [
        { kind: 'busy', minutes: 45, label: 'Apply' },
        { kind: 'processing', minutes: 45, label: 'Process' },
        { kind: 'style', minutes: 30, label: 'Blow-dry' },
      ],
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      consultationRequired: false,
      bookableOnline: true,
      newClientsOnly: false,
      variants: [{ id: 'v-long', name: 'Long hair', deltaMinutes: 30 }],
    },
  ],
  combos: [],
  addons: [],
};

const blocks = [{ start: '09:00', end: '17:00', type: 'open' }];
const breaks = [{ start: '12:00', end: '12:30' }];

export type FakeAppointment = AppointmentWithDetails;

const snap = (id: string): AppointmentServiceSnapshot => {
  const s = MENU.services.find((x) => x.id === id)!;
  return {
    serviceId: s.id,
    name: s.name,
    variantId: null,
    variantName: null,
    colorTag: s.colorTag,
  };
};

let seq = 0;
export function appointment(
  clientId: string | null,
  segments: BookingSegment[],
  overrides: Partial<AppointmentWithDetails> = {},
): FakeAppointment {
  const client = CLIENTS.find((c) => c.id === clientId) ?? null;
  return {
    id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    salon_id: SALON,
    stylist_id: 'stylist',
    client_id: clientId,
    client: client ? { id: client.id, name: client.name, phone: client.phone, notes: null } : null,
    starts_at: segments[0]!.start,
    ends_at: segments.at(-1)!.end,
    status: 'confirmed',
    source: 'owner',
    services: [snap(CUT)],
    segments: segments.map((s) => ({ ...s, label: null })),
    hold_expires_at: null,
    notes: null,
    price_cents: null,
    cancel_reason: null,
    cancelled_at: null,
    requested_at: null,
    created_at: '2026-11-01T00:00:00Z',
    created_by: null,
    updated_at: '2026-11-01T00:00:00Z',
    import_key: null,
    manage_token: '0'.repeat(64),
    text_reminder_sent_at: null,
    ...overrides,
  };
}

const busy = (start: string, end: string): BookingSegment => ({ kind: 'busy', start, end });

export const CLIENTS: AssistantClient[] = [
  { id: KARINA, name: 'Karina Lopez', phone: '555-0101', email: null },
  { id: KAREN, name: 'Karen Smith', phone: null, email: null },
  { id: MARIA, name: 'Maria Garcia', phone: null, email: null },
];

export interface FakePort extends AssistantPort {
  appointments: FakeAppointment[];
  clients: AssistantClient[];
  audits: { action: string; details: Record<string, unknown> }[];
  visits: Map<string, ClientVisit[]>;
  overrides: Map<string, ClientServiceOverride[]>;
  notes: { clientId: string; kind: 'note' | 'formula'; text: string }[];
  replySettings: Omit<ReplyContext, 'request'>;
  requests: ReplyRequestInfo[];
}

export function createFakePort(): FakePort {
  seq = 0;
  const clients = CLIENTS.map((c) => ({ ...c }));
  const visits = new Map<string, ClientVisit[]>([
    [
      KARINA,
      [
        { startsAt: '2026-10-20T15:00:00Z', status: 'completed', services: [snap(COLOR)] },
        { startsAt: '2026-09-01T15:00:00Z', status: 'completed', services: [snap(CUT)] },
        { startsAt: '2026-08-01T15:00:00Z', status: 'completed', services: [snap(COLOR)] },
      ],
    ],
  ]);
  // Fri Dec 18 (CST = UTC-6): booked 9:00–11:30 and 2:30–4:00, so color only fits around midday.
  const appointments: FakeAppointment[] = [
    appointment(MARIA, [busy('2026-12-18T15:00:00Z', '2026-12-18T17:30:00Z')]),
    appointment(KAREN, [busy('2026-12-18T20:30:00Z', '2026-12-18T22:00:00Z')]),
  ];
  // Tests opt in, e.g. `port.overrides.set(KARINA, [{ serviceId: COLOR, deltaMinutes: 20 }])`.
  const overrides = new Map<string, ClientServiceOverride[]>();
  const port: FakePort = {
    appointments,
    clients,
    visits,
    overrides,
    notes: [],
    audits: [],
    replySettings: {
      autoSendReplies: false,
      toneExamples: null,
      bookingLink: null,
      includeBookingLink: false,
      bridgeKeyword: null,
    },
    requests: [],
    async getSchedule() {
      return {
        salonName: 'Studio K',
        hours: buildWorkHours({
          timeZone: TZ,
          template: [2, 3, 4, 5, 6].map((weekday) => ({ weekday, blocks, breaks })),
        }),
        rules: { leadTimeMinutes: 60, bookingWindowDays: 120, slotGridMinutes: 15 },
        holdExpiryHours: 24,
      };
    },
    getMenu: async () => MENU,
    listClients: async () => clients,
    getClient: async (id) => clients.find((c) => c.id === id) ?? null,
    clientVisits: async (id, limit) => (visits.get(id) ?? []).slice(0, limit),
    clientOverrides: async (id) => overrides.get(id) ?? [],
    async addClientNote(input) {
      port.notes.push(input);
      return { id: `note-${port.notes.length}` };
    },
    async listAppointments({ from, to }) {
      return appointments.filter(
        (a) =>
          ['held', 'requested', 'confirmed', 'completed'].includes(a.status) &&
          Date.parse(a.starts_at) < Date.parse(to) &&
          Date.parse(a.ends_at) > Date.parse(from),
      );
    },
    getAppointment: async (id) => appointments.find((a) => a.id === id) ?? null,
    async bookHeld(input) {
      const blocking = (s: BookingSegment) => s.kind !== 'processing';
      for (const a of await port.listAppointments({
        from: input.segments[0]!.start,
        to: input.segments.at(-1)!.end,
      })) {
        for (const s of a.segments.filter(blocking)) {
          for (const n of input.segments.filter(blocking)) {
            if (
              Date.parse(s.start) < Date.parse(n.end) &&
              Date.parse(n.start) < Date.parse(s.end)
            ) {
              throw Object.assign(new Error('conflict'), { code: '23P01' });
            }
          }
        }
      }
      const row = appointment(input.clientId, input.segments, {
        status: 'held',
        services: input.services,
        notes: input.notes,
        price_cents: input.priceCents,
        hold_expires_at: new Date(NOW + 24 * 3_600_000).toISOString(),
      });
      // Client span excludes buffers.
      const real = input.segments.filter((s) => s.kind !== 'buffer');
      row.starts_at = real[0]!.start;
      row.ends_at = real.at(-1)!.end;
      appointments.push(row);
      return { id: row.id, holdExpiresAt: row.hold_expires_at };
    },
    async setStatus(id, status) {
      const a = appointments.find((x) => x.id === id);
      if (!a) throw new Error('not found');
      a.status = status;
      a.hold_expires_at = null;
    },
    async createClient(input) {
      const client: AssistantClient = {
        id: `00000000-0000-4000-8000-1${String(clients.length).padStart(11, '0')}`,
        name: input.name,
        phone: input.phone ?? null,
        email: null,
      };
      clients.push(client);
      return client;
    },
    getReplyContext: async (requestId) => ({
      ...port.replySettings,
      request: port.requests.find((r) => r.id === requestId) ?? null,
    }),
    async audit(action, details) {
      port.audits.push({ action, details });
    },
  };
  return port;
}
