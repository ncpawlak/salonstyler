/** Test double for the inbox port: an in-memory salon plus captured requests, offers and replies. */
import { createFakePort } from '../assistant/fake-salon.ts';
import type { AutoSchedulePort, StoredCapturedRequest } from './auto-schedule.ts';
import type { CaptureInput, QueuedReply } from './handler.ts';
import { phonesMatch } from './text.ts';

export function fakeInboxPort() {
  const port = createFakePort();
  const captured: (CaptureInput & { id: string; appointmentId: string | null })[] = [];
  const offers: { phone: string; requestId: string; appointmentId: string; sentAt: string }[] = [];
  const replies: (QueuedReply & { status: string; body?: string; source?: string })[] = [];
  // Requests as stored, for Auto-Schedule tests.
  const stored: StoredCapturedRequest[] = [];
  const rebookIntervals = new Map<string, number | null>();
  const inbox: AutoSchedulePort & {
    captured: typeof captured;
    stored: typeof stored;
    rebookIntervals: typeof rebookIntervals;
    base: typeof port;
    offers: typeof offers;
    replies: typeof replies;
  } = {
    base: port,
    captured,
    stored,
    rebookIntervals,
    clientOverrides: port.clientOverrides,
    serviceRebookIntervals: async () => rebookIntervals,
    getCapturedRequest: async (id) => stored.find((r) => r.id === id) ?? null,
    offers,
    replies,
    getSchedule: port.getSchedule,
    getMenu: port.getMenu,
    listClients: port.listClients,
    clientVisits: port.clientVisits,
    listAppointments: port.listAppointments,
    getAppointment: port.getAppointment,
    getClient: port.getClient,
    getReplyContext: port.getReplyContext,
    async findOpenOffer(phone, sinceIso) {
      const offer = offers.find(
        (o) =>
          phonesMatch(o.phone, phone) &&
          o.sentAt >= sinceIso &&
          ['held', 'requested'].includes(
            port.appointments.find((a) => a.id === o.appointmentId)?.status ?? '',
          ),
      );
      return offer ? { requestId: offer.requestId, appointmentId: offer.appointmentId } : null;
    },
    async confirmAppointment(id) {
      await port.setStatus(id, 'confirmed');
      // What the auto-send trigger does when the request is approved.
      const offer = offers.find((o) => o.appointmentId === id);
      if (offer && port.replySettings.autoSendReplies && port.replySettings.bridgeKeyword) {
        replies.push({
          id: `reply-${replies.length + 1}`,
          kind: 'confirm',
          toPhone: offer.phone,
          capturedRequestId: offer.requestId,
          appointmentId: id,
          clientId: null,
          status: 'queued',
        });
      }
    },
    async claimQueuedReplies(limit) {
      if (!port.replySettings.autoSendReplies) return [];
      const due = replies.filter((r) => r.status === 'queued').slice(0, limit);
      for (const r of due) r.status = 'sending';
      return due.map(({ status: _s, body: _b, source: _src, ...r }) => r);
    },
    async completeReply(id, body, source) {
      Object.assign(
        replies.find((r) => r.id === id)!,
        { status: 'sent', body, source },
      );
    },
    findCaptured: async (key) => captured.find((c) => c.dedupeKey === key)?.id ?? null,
    async capture(input) {
      const dup = captured.find((c) => c.dedupeKey === input.dedupeKey);
      if (dup) return { id: dup.id, duplicate: true };
      let clientId = input.clientId ?? null;
      let clientCreated = false;
      if (!clientId && input.newClient) {
        clientId = (await port.createClient(input.newClient)).id;
        clientCreated = true;
      }
      let appointmentId: string | null = null;
      if (input.segments) {
        const booked = await port.bookHeld({
          clientId: clientId!,
          segments: input.segments as never,
          services: input.services ?? [],
          priceCents: input.priceCents ?? null,
          notes: input.notes ?? '',
        });
        port.appointments.find((a) => a.id === booked.id)!.status = 'requested';
        appointmentId = booked.id;
      }
      const id = `req-${captured.length + 1}`;
      captured.push({ ...input, id, appointmentId, clientId: clientId ?? undefined });
      return { id, duplicate: false, clientId, clientCreated, appointmentId, note: input.note };
    },
  };
  return inbox;
}
