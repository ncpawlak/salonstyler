import { findSlots, planBooking, toSalonDate, type SlotCandidate } from '@chairside/core';
import type { AppointmentServiceSnapshot, AppointmentWithDetails } from '@chairside/db';
import { z } from 'zod';

import { AiProviderError } from '../http.ts';
import { createProvider as defaultCreateProvider } from '../registry.ts';
import type { LLMProvider } from '../types.ts';
import { CONFIDENT_MATCH, rankByName } from '../assistant/fuzzy.ts';
import { resolveItems, usualItems } from '../assistant/menu.ts';
import { formatDayLabel, formatTime } from '../assistant/tools.ts';
import type { AssistantClient, AssistantPort, BookingItem } from '../assistant/types.ts';
import { type AiErrorBody, type AiServiceDeps, providerFailure } from '../server/handler.ts';
import {
  demoParse,
  parseWithLlm,
  type InboxParseContext,
  type ParsedInboxRequest,
} from './parse.ts';
import {
  formatPhone,
  inboxDedupeKey,
  isPhoneLike,
  normalizePhone,
  phonesMatch,
  stripKeyword,
} from './text.ts';

const DAY = 86_400_000;
/** Forwarded requests per bridge token per hour. */
export const INBOX_HOURLY_LIMIT = 60;
export const INBOX_NOTE = 'Requested by text';

/** Body the iOS Shortcut posts (see docs/spikes/ios-shortcut-keyword-bridge.md). */
export const inboxRequestSchema = z.object({
  sender: z.string().trim().max(200).default(''),
  senderPhone: z.string().trim().max(60).nullish(),
  text: z.string().trim().min(1).max(4000),
  receivedAt: z.string().trim().max(60).nullish(),
  bridgeVersion: z.union([z.string().max(20), z.number()]).nullish(),
  channel: z
    .string()
    .regex(/^[a-z_]{1,20}$/)
    .nullish(),
});
export type InboxRequest = z.infer<typeof inboxRequestSchema>;

export interface InboxBridge {
  salonId: string;
  keyword: string;
  rateLimited: boolean;
}

/** Args for the `capture_inbox_request` RPC (camelCase JSON). */
export interface CaptureInput {
  dedupeKey: string;
  channel: string;
  sender: string | null;
  senderPhone: string | null;
  message: string;
  parsed: Record<string, unknown>;
  intent: Exclude<ParsedInboxRequest['intent'], 'ignore'>;
  receivedAt: string | null;
  note: string | null;
  clientId?: string;
  newClient?: { name: string; phone: string | null };
  segments?: { kind: string; start: string; end: string }[];
  services?: AppointmentServiceSnapshot[];
  priceCents?: number | null;
  notes?: string;
  targetAppointmentId?: string;
}

export interface CaptureResult {
  id: string;
  duplicate: boolean;
  clientId?: string | null;
  clientCreated?: boolean;
  appointmentId?: string | null;
  note?: string | null;
}

/** The agent's data access for one salon (service role; every query is filtered by salon). */
export interface InboxPort extends Pick<
  AssistantPort,
  'getSchedule' | 'getMenu' | 'listClients' | 'clientVisits' | 'listAppointments'
> {
  /** Id of an already captured request with this key, if any. */
  findCaptured(dedupeKey: string): Promise<string | null>;
  capture(input: CaptureInput): Promise<CaptureResult>;
}

export interface InboxServiceDeps extends Omit<AiServiceDeps, 'createProvider' | 'getMemberRole'> {
  /** Resolves (and rate-counts) a bridge token. Null when the token is unknown. */
  authenticate(token: string): Promise<InboxBridge | null>;
  createPort(salonId: string): InboxPort;
  createProvider?: typeof defaultCreateProvider;
  /** Local development only: parse with rules instead of the salon's model. Never in production. */
  demo?: boolean;
}

export type InboxResponse =
  | { ok: true; status: 'ignored'; reason: 'empty' | 'not_a_request' }
  | { ok: true; status: 'duplicate'; requestId: string }
  | {
      ok: true;
      status: 'captured';
      requestId: string;
      intent: CaptureInput['intent'];
      appointmentId: string | null;
      clientCreated: boolean;
    };

export type InboxServiceResult =
  | { status: 200; body: InboxResponse }
  | { status: 400 | 401 | 409 | 429 | 500 | 502; body: AiErrorBody };

const fail = (
  status: Exclude<InboxServiceResult['status'], 200>,
  code: string,
  message: string,
): InboxServiceResult => ({ status, body: { error: { code, message } } });

const isUnexpired = (a: AppointmentWithDetails) =>
  ['held', 'requested', 'confirmed'].includes(a.status);

/** Handles one forwarded text: authenticate, parse, match the client, hold a slot, capture. */
export async function handleInboxRequest(
  token: string | null | undefined,
  rawBody: unknown,
  deps: InboxServiceDeps,
): Promise<InboxServiceResult> {
  if (!token?.trim()) return fail(401, 'unauthorized', 'Missing X-Bridge-Token');
  const bridge = await deps.authenticate(token.trim());
  if (!bridge) return fail(401, 'unauthorized', 'Unknown bridge token');
  if (bridge.rateLimited) return fail(429, 'rate_limited', 'Too many messages; try again later');

  const body = inboxRequestSchema.safeParse(rawBody);
  if (!body.success) return fail(400, 'invalid_request', z.prettifyError(body.error));
  const request = body.data;
  const now = deps.now ?? (() => Date.now());

  const message = stripKeyword(request.text, bridge.keyword).slice(0, 2000);
  if (!message) return { status: 200, body: { ok: true, status: 'ignored', reason: 'empty' } };

  const port = deps.createPort(bridge.salonId);
  try {
    const receivedMs = request.receivedAt ? Date.parse(request.receivedAt) : NaN;
    const receivedAt = Number.isNaN(receivedMs) ? null : new Date(receivedMs).toISOString();
    const dedupeKey = await inboxDedupeKey({
      sender: request.sender,
      senderPhone: request.senderPhone,
      text: request.text,
      // Without a receive time, the same text within a minute counts as a retry.
      receivedAt: request.receivedAt ?? String(Math.floor(now() / 60_000)),
    });
    const existing = await port.findCaptured(dedupeKey);
    if (existing) {
      return { status: 200, body: { ok: true, status: 'duplicate', requestId: existing } };
    }

    const today = toSalonDate(now(), 'UTC');
    const [schedule, menu] = await Promise.all([
      port.getSchedule({ from: today, to: today }),
      port.getMenu(),
    ]);
    const timeZone = schedule.hours.timeZone;
    const localToday = toSalonDate(now(), timeZone);
    const ctx: InboxParseContext = {
      menu,
      today: localToday,
      todayLabel: formatDayLabel(localToday),
      timeZone,
      salonName: schedule.salonName,
    };

    const outcome = await parse(message, ctx, bridge.salonId, deps);
    if ('status' in outcome) return outcome;
    const { parsed, parser } = outcome;
    if (parsed.intent === 'ignore') {
      return { status: 200, body: { ok: true, status: 'ignored', reason: 'not_a_request' } };
    }

    const capture = await draft({
      port,
      parsed,
      parser,
      request,
      message,
      dedupeKey,
      receivedAt,
      ctx,
      now: now(),
    });
    const result = await port.capture(capture);
    if (result.duplicate) {
      return { status: 200, body: { ok: true, status: 'duplicate', requestId: result.id } };
    }
    return {
      status: 200,
      body: {
        ok: true,
        status: 'captured',
        requestId: result.id,
        intent: capture.intent,
        appointmentId: result.appointmentId ?? null,
        clientCreated: Boolean(result.clientCreated),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(500, 'inbox_error', message);
  }
}

async function parse(
  message: string,
  ctx: InboxParseContext,
  salonId: string,
  deps: InboxServiceDeps,
): Promise<{ parsed: ParsedInboxRequest; parser: 'llm' | 'demo' | 'none' } | InboxServiceResult> {
  if (deps.demo) return { parsed: demoParse(message, ctx), parser: 'demo' };

  const config = await deps.loadConfig(salonId);
  if (!config) {
    return fail(
      409,
      'not_configured',
      'The inbox needs an AI provider. Add a key in Settings → AI.',
    );
  }
  const used = await deps.tokensUsedThisMonth(salonId);
  if (used >= config.monthlyTokenBudget) {
    return fail(429, 'budget_exceeded', 'This salon has used its monthly AI token budget');
  }
  let llm: LLMProvider;
  try {
    llm = (deps.createProvider ?? defaultCreateProvider)(config.provider, {
      apiKey: config.apiKey,
      model: config.model,
    });
    const out = await parseWithLlm(llm, message, ctx);
    await deps.recordUsage({
      salonId,
      provider: config.provider,
      model: out.model,
      purpose: 'inbox',
      inputTokens: out.usage.inputTokens,
      outputTokens: out.usage.outputTokens,
    });
    // An unreadable answer still reaches the stylist: the keyword says the client meant it.
    return out.parsed
      ? { parsed: out.parsed, parser: 'llm' }
      : {
          parsed: {
            intent: 'booking',
            clientName: null,
            services: [],
            date: null,
            time: null,
            timeOfDay: null,
            notes: null,
          },
          parser: 'none',
        };
  } catch (error) {
    if (error instanceof AiProviderError) {
      return { status: 502, body: providerFailure(error, config.apiKey).body as AiErrorBody };
    }
    throw error;
  }
}

interface DraftInput {
  port: InboxPort;
  parsed: ParsedInboxRequest;
  parser: 'llm' | 'demo' | 'none';
  request: InboxRequest;
  message: string;
  dedupeKey: string;
  receivedAt: string | null;
  ctx: InboxParseContext;
  now: number;
}

/** Matches by phone first, then by a single confident name match. */
export function matchClient(
  clients: readonly AssistantClient[],
  phone: string | null,
  names: (string | null | undefined)[],
): AssistantClient | null {
  if (phone) {
    const byPhone = clients.filter((c) => phonesMatch(c.phone, phone));
    if (byPhone.length === 1) return byPhone[0]!;
  }
  for (const name of names) {
    if (!name?.trim() || isPhoneLike(name)) continue;
    const confident = rankByName(name, clients).filter((m) => m.score >= CONFIDENT_MATCH);
    if (confident.length === 1) return confident[0]!.item;
  }
  return null;
}

async function draft(input: DraftInput): Promise<CaptureInput> {
  const { port, parsed, request, ctx } = input;
  const intent = parsed.intent as CaptureInput['intent'];
  const senderPhone =
    normalizePhone(request.senderPhone) ??
    (isPhoneLike(request.sender) ? normalizePhone(request.sender) : null);
  const senderName = request.sender && !isPhoneLike(request.sender) ? request.sender : null;

  const clients = await port.listClients();
  const client = matchClient(clients, senderPhone, [parsed.clientName, senderName]);

  const capture: CaptureInput = {
    dedupeKey: input.dedupeKey,
    channel: request.channel ?? 'sms',
    sender: request.sender || null,
    senderPhone,
    message: input.message,
    parsed: {},
    intent,
    receivedAt: input.receivedAt,
    note: null,
  };
  if (client) {
    capture.clientId = client.id;
  } else {
    const fallback = senderPhone ?? request.senderPhone ?? request.sender;
    capture.newClient = {
      name: (
        parsed.clientName ??
        senderName ??
        (fallback ? `Text from ${formatPhone(fallback)}` : 'New client')
      ).slice(0, 80),
      phone: senderPhone,
    };
  }

  // Reschedule and cancel act on the client's next appointment.
  let target: AppointmentWithDetails | null = null;
  if (client && intent !== 'booking') {
    const upcoming = await port.listAppointments({
      from: new Date(input.now).toISOString(),
      to: new Date(input.now + 180 * DAY).toISOString(),
    });
    target =
      upcoming
        .filter((a) => a.client_id === client.id && isUnexpired(a))
        .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))[0] ?? null;
    if (target) capture.targetAppointmentId = target.id;
  }

  let items: BookingItem[] | null = parsed.services.length ? parsed.services : null;
  if (!items && target?.services.length) {
    items = target.services.map((s) => ({
      serviceId: s.serviceId,
      variantId: s.variantId ?? null,
    }));
  }
  if (!items && client) items = usualItems(ctx.menu, await port.clientVisits(client.id, 10));

  const summary: Record<string, unknown> = {
    clientName: parsed.clientName,
    services: [] as unknown[],
    date: parsed.date,
    time: parsed.time,
    timeOfDay: parsed.timeOfDay,
    notes: parsed.notes,
    parser: input.parser,
  };
  capture.parsed = summary;

  if (intent === 'cancel') {
    if (!target) capture.note = 'No upcoming appointment found for this client.';
    return capture;
  }
  if (intent === 'reschedule' && !target) {
    capture.note = 'No upcoming appointment found to move; treating it as a new request.';
  }

  let resolved: ReturnType<typeof resolveItems> | null = null;
  if (items) {
    try {
      resolved = resolveItems(ctx.menu, items);
      summary.services = resolved.snapshots.map((s) => ({
        serviceId: s.serviceId,
        variantId: s.variantId ?? null,
        name: s.variantName ? `${s.name} (${s.variantName})` : s.name,
      }));
    } catch {
      resolved = null;
    }
  }
  if (!resolved) {
    capture.note = 'Couldn’t tell which service. Pick one when you reply.';
    return capture;
  }

  const slot = await pickSlot(port, resolved.service, parsed, ctx, input.now, target?.id);
  if (!slot.ok) {
    capture.note = slot.note;
    return capture;
  }
  capture.segments = slot.segments;
  capture.services = resolved.snapshots;
  capture.priceCents = resolved.service.priceCents ?? null;
  capture.notes = parsed.notes ? `${INBOX_NOTE}: ${parsed.notes}` : INBOX_NOTE;
  return capture;
}

type PickedSlot =
  | { ok: true; candidate: SlotCandidate; segments: { kind: string; start: string; end: string }[] }
  | { ok: false; note: string };

function clockMinutes(hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * The engine picks the slot: closest to the requested day, preferring the asked time of day, or
 * the engine candidate nearest an exact clock time the client named.
 */
async function pickSlot(
  port: InboxPort,
  service: ReturnType<typeof resolveItems>['service'],
  parsed: ParsedInboxRequest,
  ctx: InboxParseContext,
  now: number,
  movingId: string | undefined,
): Promise<PickedSlot> {
  const requested = parsed.date && parsed.date >= ctx.today ? parsed.date : ctx.today;
  const radius = parsed.date ? 3 : 7;
  const base = Date.parse(`${requested}T12:00:00Z`);
  const schedule = await port.getSchedule({
    from: toSalonDate(base - (radius + 1) * DAY, 'UTC'),
    to: toSalonDate(base + (radius + 1) * DAY, 'UTC'),
  });
  const appointments = (
    await port.listAppointments({
      from: new Date(base - (radius + 2) * DAY).toISOString(),
      to: new Date(base + (radius + 2) * DAY).toISOString(),
    })
  ).filter((a) => a.id !== movingId);
  const existing = appointments.map((a) => ({ id: a.id, segments: a.segments }));

  const candidates = findSlots({
    service,
    hours: schedule.hours,
    requestedDate: requested,
    searchRadiusDays: radius,
    ...(parsed.timeOfDay ? { preference: parsed.timeOfDay } : {}),
    existing,
    rules: schedule.rules,
    now,
  });
  const asked = parsed.time ? clockMinutes(parsed.time) : null;
  const candidate =
    asked === null
      ? (candidates.find((c) => c.matchesPreference) ?? candidates[0])
      : candidates.reduce<SlotCandidate | undefined>((best, c) => {
          if (!best) return c;
          const day = Math.abs(c.dayOffset) - Math.abs(best.dayOffset);
          if (day !== 0) return day < 0 ? c : best;
          const gap = (x: SlotCandidate) => Math.abs(clockMinutes(x.localTime) - asked);
          return gap(c) < gap(best) ? c : best;
        }, undefined);
  const label = formatDayLabel(requested);
  if (!candidate) return { ok: false, note: `No opening near ${label}. Pick a time to offer.` };

  const plan = planBooking({
    service,
    start: candidate.start,
    hours: schedule.hours,
    existing,
    rules: schedule.rules,
    now,
  });
  if (!plan.ok) return { ok: false, note: plan.message };
  return {
    ok: true,
    candidate,
    segments: plan.segments.map((s) => ({ kind: s.kind, start: s.start, end: s.end })),
  };
}

/** "Fri, Dec 4 · 1:00 PM" for an ISO start in the salon's time zone. */
export function formatSlotLabel(startIso: string, timeZone: string): string {
  return `${formatDayLabel(toSalonDate(startIso, timeZone))} · ${formatTime(startIso, timeZone)}`;
}
