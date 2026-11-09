import {
  addDays,
  bookingErrorMessage,
  findSlots,
  formatDuration,
  formatLocalDate,
  getWorkingBlocks,
  parseLocalDate,
  planBooking,
  toSalonDate,
  type SlotCandidate,
  type TimeOfDay,
} from '@chairside/core';
import type { AppointmentWithDetails } from '@chairside/db';
import { z } from 'zod';

import type { ToolDefinition } from '../types.ts';
import { CONFIDENT_MATCH, rankByName } from './fuzzy.ts';
import { menuSummary, resolveItems, usualItems } from './menu.ts';
import type {
  AssistantCard,
  AssistantClient,
  AssistantPort,
  BookingItem,
  DraftCard,
  SlotDay,
} from './types.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DRAFT_NOTE = 'Drafted by Ask Chairside';

export interface ToolContext {
  port: AssistantPort;
  now: () => number;
}

export interface ToolOutput {
  /** Sent back to the model as the tool message (JSON). */
  result: unknown;
  card?: AssistantCard;
}

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

// ---------------------------------------------------------------------------------------------
// Formatting (salon time zone)
// ---------------------------------------------------------------------------------------------

export const formatTime = (iso: string | number, timeZone: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });

/** "Fri, Dec 18" for a local `YYYY-MM-DD`. */
export function formatDayLabel(date: string): string {
  const d = parseLocalDate(date);
  return new Date(Date.UTC(d.year, d.month - 1, d.day, 12)).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

const shiftDate = (date: string, days: number) =>
  formatLocalDate(addDays(parseLocalDate(date), days));

// ---------------------------------------------------------------------------------------------
// Argument schemas
// ---------------------------------------------------------------------------------------------

const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((s) => {
    try {
      parseLocalDate(s);
      return true;
    } catch {
      return false;
    }
  }, 'Not a real date');
const itemSchema = z.object({
  serviceId: z.string().min(1),
  variantId: z.string().min(1).nullish(),
});
const itemsSchema = z.array(itemSchema).min(1).max(5);

const schemas = {
  find_client: z.object({ query: z.string().trim().min(1).max(100) }),
  list_services: z.object({}),
  find_slots: z.object({
    clientId: z.string().min(1).nullish(),
    services: itemsSchema.nullish(),
    date: localDate,
    radiusDays: z.int().min(0).max(7).nullish(),
    timeOfDay: z.enum(['morning', 'afternoon', 'evening']).nullish(),
    perDay: z.int().min(1).max(8).nullish(),
  }),
  get_day_summary: z.object({ date: localDate }),
  propose_booking: z.object({
    clientId: z.string().min(1),
    start: z.iso.datetime({ offset: true }),
    services: itemsSchema.nullish(),
  }),
  cancel_draft: z.object({ appointmentId: z.string().min(1) }),
} as const;

export type AssistantToolName = keyof typeof schemas;

/** JSON Schemas the model sees. Kept by hand so descriptions read well for every provider. */
export const ASSISTANT_TOOLS: ToolDefinition[] = [
  {
    name: 'find_client',
    description:
      'Fuzzy-search the salon’s clients by name (typos OK). Returns matches with their usual services. Always call this before booking for a named person.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Name as the user said it' } },
      required: ['query'],
    },
  },
  {
    name: 'list_services',
    description: 'The salon’s service menu: ids, names, durations and length variants.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'find_slots',
    description:
      'Open time slots from the scheduling engine for a service on a date and the surrounding days. The ONLY source of availability: never suggest a time that this tool did not return. If services is omitted the client’s usual service is used.',
    parameters: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'From find_client' },
        services: {
          type: 'array',
          description: 'Menu items from list_services (omit to use the client’s usual)',
          items: {
            type: 'object',
            properties: { serviceId: { type: 'string' }, variantId: { type: 'string' } },
            required: ['serviceId'],
          },
        },
        date: { type: 'string', description: 'Requested local date, YYYY-MM-DD' },
        radiusDays: {
          type: 'integer',
          description: 'Also search this many days before/after (default 3, max 7)',
        },
        timeOfDay: { type: 'string', enum: ['morning', 'afternoon', 'evening'] },
        perDay: { type: 'integer', description: 'Max suggestions per day (default 3)' },
      },
      required: ['date'],
    },
  },
  {
    name: 'get_day_summary',
    description: 'Work hours and appointments for one local date (YYYY-MM-DD).',
    parameters: {
      type: 'object',
      properties: { date: { type: 'string' } },
      required: ['date'],
    },
  },
  {
    name: 'propose_booking',
    description:
      'Places a temporary hold on a slot returned by find_slots and shows the owner a draft to confirm. Nothing is booked until the owner taps Confirm.',
    parameters: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
        start: { type: 'string', description: 'A slot `start` exactly as find_slots returned it' },
        services: {
          type: 'array',
          items: {
            type: 'object',
            properties: { serviceId: { type: 'string' }, variantId: { type: 'string' } },
            required: ['serviceId'],
          },
        },
      },
      required: ['clientId', 'start'],
    },
  },
  {
    name: 'cancel_draft',
    description: 'Releases a draft (held) booking created by propose_booking.',
    parameters: {
      type: 'object',
      properties: { appointmentId: { type: 'string' } },
      required: ['appointmentId'],
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

async function requireClient(port: AssistantPort, id: string): Promise<AssistantClient> {
  const client = await port.getClient(id);
  if (!client) throw new ToolError('unknown_client', 'No client with that id. Call find_client.');
  return client;
}

async function itemsFor(
  port: AssistantPort,
  clientId: string | null | undefined,
  given: BookingItem[] | null | undefined,
) {
  const menu = await port.getMenu();
  let items = given ?? null;
  if (!items && clientId) items = usualItems(menu, await port.clientVisits(clientId, 10));
  if (!items) {
    throw new ToolError(
      'service_required',
      'No service given and the client has no booking history. Ask which service (see list_services).',
    );
  }
  try {
    return { items, resolved: resolveItems(menu, items) };
  } catch (e) {
    throw new ToolError('unknown_service', (e as Error).message);
  }
}

const toExisting = (appointments: AppointmentWithDetails[]) =>
  appointments.map((a) => ({ id: a.id, segments: a.segments }));

/** Picks up to `n` well-spread, high-scoring slots for one day, returned in time order. */
function pickSpread(candidates: SlotCandidate[], n: number): SlotCandidate[] {
  const byScore = [...candidates].sort(
    (a, b) => b.score - a.score || Date.parse(a.start) - Date.parse(b.start),
  );
  const picked: SlotCandidate[] = [];
  for (const minGap of [90, 45, 0]) {
    for (const c of byScore) {
      if (picked.length >= n) break;
      if (picked.includes(c)) continue;
      const t = Date.parse(c.start);
      if (picked.every((p) => Math.abs(Date.parse(p.start) - t) >= minGap * 60_000)) picked.push(c);
    }
  }
  return picked.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

function draftCard(
  appointment: AppointmentWithDetails,
  timeZone: string,
  client: { id: string; name: string },
): DraftCard {
  const date = toSalonDate(appointment.starts_at, timeZone);
  const minutes = Math.round(
    (Date.parse(appointment.ends_at) - Date.parse(appointment.starts_at)) / 60_000,
  );
  const names = appointment.services.map((s) =>
    s.variantName ? `${s.name} (${s.variantName})` : s.name,
  );
  return {
    type: 'draft',
    appointmentId: appointment.id,
    client,
    items: appointment.services.map((s) => ({
      serviceId: s.serviceId,
      variantId: s.variantId ?? null,
    })),
    start: new Date(appointment.starts_at).toISOString(),
    end: new Date(appointment.ends_at).toISOString(),
    label: `${formatDayLabel(date)} · ${formatTime(appointment.starts_at, timeZone)}`,
    serviceSummary: `${names.join(' + ')} · ${formatDuration(minutes)}`,
    status:
      appointment.status === 'held'
        ? 'held'
        : appointment.status === 'cancelled'
          ? 'cancelled'
          : 'confirmed',
    holdExpiresAt: appointment.hold_expires_at,
    requiresApproval: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

async function findClient(ctx: ToolContext, args: z.infer<typeof schemas.find_client>) {
  const { port } = ctx;
  const ranked = rankByName(args.query, await port.listClients());
  if (ranked.length === 0 || ranked[0]!.score < CONFIDENT_MATCH) {
    return {
      result: {
        matches: ranked.map((m) => ({ id: m.item.id, name: m.item.name, confidence: m.score })),
        note:
          ranked.length === 0
            ? `No client named "${args.query}". The app is offering the owner a button to add them; ask if they want to.`
            : 'No confident match. Ask the owner which client they meant, or offer to add a new one.',
      },
      card: {
        type: 'client_not_found' as const,
        query: args.query,
        suggestions: ranked.map((m) => ({ id: m.item.id, name: m.item.name })),
      },
    };
  }
  const menu = await port.getMenu();
  const confident = ranked.filter((m) => m.score >= CONFIDENT_MATCH);
  const matches = await Promise.all(
    confident.slice(0, 3).map(async ({ item, score }) => {
      const visits = await port.clientVisits(item.id, 10);
      const usual = usualItems(menu, visits);
      let usualSummary: string | null = null;
      if (usual) {
        try {
          usualSummary = resolveItems(menu, usual).summary;
        } catch {
          usualSummary = null;
        }
      }
      return {
        id: item.id,
        name: item.name,
        confidence: score,
        lastVisit: visits[0]?.startsAt ?? null,
        usualServices: usual,
        usualSummary,
      };
    }),
  );
  return {
    result: {
      matches,
      note: matches.length > 1 ? 'Several clients match; ask which one before booking.' : undefined,
    },
  };
}

async function findSlotsTool(ctx: ToolContext, args: z.infer<typeof schemas.find_slots>) {
  const { port } = ctx;
  const client = args.clientId ? await requireClient(port, args.clientId) : null;
  const { items, resolved } = await itemsFor(port, client?.id, args.services);
  const radius = args.radiusDays ?? 3;
  const from = shiftDate(args.date, -radius);
  const to = shiftDate(args.date, radius);
  const schedule = await port.getSchedule({ from, to });
  const { timeZone } = schedule.hours;
  const base = Date.parse(`${args.date}T12:00:00Z`);
  const appointments = await port.listAppointments({
    from: new Date(base - (radius + 2) * DAY).toISOString(),
    to: new Date(base + (radius + 2) * DAY).toISOString(),
  });

  const candidates = findSlots({
    service: resolved.service,
    hours: schedule.hours,
    requestedDate: args.date,
    searchRadiusDays: radius,
    ...(args.timeOfDay ? { preference: args.timeOfDay as TimeOfDay } : {}),
    existing: toExisting(appointments),
    rules: schedule.rules,
    now: ctx.now(),
  });

  const perDay = args.perDay ?? 3;
  const byDate = new Map<string, SlotCandidate[]>();
  for (const c of candidates) {
    if (args.timeOfDay && !c.matchesPreference) continue;
    byDate.set(c.localDate, [...(byDate.get(c.localDate) ?? []), c]);
  }
  const days: SlotDay[] = [];
  for (let offset = -radius; offset <= radius; offset++) {
    const date = shiftDate(args.date, offset);
    const found = byDate.get(date);
    // Always show the requested day, even when it's full or closed.
    if (!found && offset !== 0) continue;
    days.push({
      date,
      label: formatDayLabel(date),
      dayOffset: offset,
      slots: pickSpread(found ?? [], perDay).map((c) => ({
        start: c.start,
        end: c.end,
        time: formatTime(c.start, timeZone),
        requiresApproval: c.requiresApproval,
      })),
    });
  }
  const requested = days.find((d) => d.dayOffset === 0)!;
  let requestedNote: string | undefined;
  if (requested.slots.length === 0) {
    const blocks = getWorkingBlocks(schedule.hours, args.date);
    requestedNote =
      blocks.status === 'closed'
        ? `Closed on ${requested.label}.`
        : `${requested.label} is fully booked for this service.`;
  }

  return {
    result: {
      client: client ? { id: client.id, name: client.name } : null,
      services: items,
      serviceSummary: resolved.summary,
      requestedDate: args.date,
      requestedNote,
      days: days.map((d) => ({
        date: d.date,
        label: d.label,
        slots: d.slots.map((s) => ({
          start: s.start,
          time: s.time,
          ...(s.requiresApproval ? { tentative: true } : {}),
        })),
      })),
      note: 'The app shows these as tappable cards. Mention a few; only these slots exist.',
    },
    card: {
      type: 'slots' as const,
      client: client ? { id: client.id, name: client.name } : null,
      items,
      serviceSummary: resolved.summary,
      requestedDate: args.date,
      days,
    },
  };
}

async function daySummary(ctx: ToolContext, args: z.infer<typeof schemas.get_day_summary>) {
  const { port } = ctx;
  const schedule = await port.getSchedule({ from: args.date, to: args.date });
  const { timeZone } = schedule.hours;
  const blocks = getWorkingBlocks(schedule.hours, args.date);
  const base = Date.parse(`${args.date}T12:00:00Z`);
  const appointments = (
    await port.listAppointments({
      from: new Date(base - 2 * DAY).toISOString(),
      to: new Date(base + 2 * DAY).toISOString(),
    })
  ).filter((a) => toSalonDate(a.starts_at, timeZone) === args.date);
  const bookedMinutes = appointments.reduce(
    (n, a) => n + (Date.parse(a.ends_at) - Date.parse(a.starts_at)) / 60_000,
    0,
  );
  return {
    result: {
      date: args.date,
      label: formatDayLabel(args.date),
      status: blocks.status,
      hours: blocks.blocks,
      openMinutes: blocks.openMinutes + blocks.tentativeMinutes,
      bookedMinutes,
      appointments: appointments.map((a) => ({
        id: a.id,
        time: `${formatTime(a.starts_at, timeZone)}–${formatTime(a.ends_at, timeZone)}`,
        client: a.client?.name ?? null,
        services: a.services.map((s) => s.name),
        status: a.status,
      })),
    },
  };
}

/** Holds a slot after re-checking it with the engine. Shared by the model and the app's tap. */
export async function proposeBooking(
  ctx: ToolContext,
  args: { clientId: string; start: string; services?: BookingItem[] | null },
): Promise<ToolOutput & { card: DraftCard }> {
  const { port } = ctx;
  const client = await requireClient(port, args.clientId);
  const { resolved } = await itemsFor(port, client.id, args.services);
  const start = Date.parse(args.start);
  if (Number.isNaN(start)) throw new ToolError('invalid_arguments', 'start must be an ISO time');
  const schedule = await port.getSchedule({
    from: toSalonDate(start - 2 * DAY, 'UTC'),
    to: toSalonDate(start + 2 * DAY, 'UTC'),
  });
  const appointments = await port.listAppointments({
    from: new Date(start - DAY).toISOString(),
    to: new Date(start + DAY).toISOString(),
  });
  const plan = planBooking({
    service: resolved.service,
    start,
    hours: schedule.hours,
    existing: toExisting(appointments),
    rules: schedule.rules,
    now: ctx.now(),
  });
  if (!plan.ok) throw new ToolError('slot_unavailable', plan.message);
  // The owner can book anything by hand; the assistant only drafts engine-approved slots.
  if (plan.warning) {
    throw new ToolError(
      'slot_unavailable',
      `That time isn't an open slot (${plan.warning}). Call find_slots and pick one of its results.`,
    );
  }
  let booked: { id: string; holdExpiresAt: string | null };
  try {
    booked = await port.bookHeld({
      clientId: client.id,
      segments: plan.segments,
      services: resolved.snapshots,
      priceCents: resolved.service.priceCents,
      notes: DRAFT_NOTE,
    });
  } catch (e) {
    throw new ToolError(
      'slot_unavailable',
      bookingErrorMessage(e as { code?: string; message?: string }),
    );
  }
  const { timeZone } = schedule.hours;
  const date = toSalonDate(plan.start, timeZone);
  const card: DraftCard = {
    type: 'draft',
    appointmentId: booked.id,
    client: { id: client.id, name: client.name },
    items: resolved.snapshots.map((s) => ({
      serviceId: s.serviceId,
      variantId: s.variantId ?? null,
    })),
    start: plan.start,
    end: plan.end,
    label: `${formatDayLabel(date)} · ${formatTime(plan.start, timeZone)}`,
    serviceSummary: resolved.summary,
    status: 'held',
    holdExpiresAt: booked.holdExpiresAt,
    requiresApproval: plan.requiresApproval,
  };
  return {
    result: {
      appointmentId: booked.id,
      status: 'held',
      label: card.label,
      serviceSummary: card.serviceSummary,
      note: 'Draft shown to the owner with Confirm / Change buttons. Not booked until they confirm.',
    },
    card,
  };
}

async function loadDraft(ctx: ToolContext, appointmentId: string) {
  const appointment = await ctx.port.getAppointment(appointmentId);
  if (!appointment) throw new ToolError('not_found', 'No such appointment');
  if (appointment.status !== 'held') {
    throw new ToolError('not_a_draft', `This booking is ${appointment.status}, not a draft.`);
  }
  if (appointment.notes !== DRAFT_NOTE) {
    throw new ToolError('not_a_draft', 'Only holds drafted by Ask Chairside can be changed here.');
  }
  return appointment;
}

async function finishDraft(
  ctx: ToolContext,
  appointmentId: string,
  status: 'confirmed' | 'cancelled',
): Promise<ToolOutput & { card: DraftCard }> {
  const appointment = await loadDraft(ctx, appointmentId);
  await ctx.port.setStatus(
    appointment.id,
    status,
    status === 'cancelled' ? 'assistant_draft_discarded' : undefined,
  );
  const date = toSalonDate(appointment.starts_at, 'UTC');
  const schedule = await ctx.port.getSchedule({ from: date, to: date });
  const card = draftCard({ ...appointment, status }, schedule.hours.timeZone, {
    id: appointment.client?.id ?? appointment.client_id ?? '',
    name: appointment.client?.name ?? 'Client',
  });
  return { result: { appointmentId: appointment.id, status }, card };
}

/** Owner tapped Confirm on a draft. Never exposed to the model: booking needs a human tap. */
export const confirmDraft = (ctx: ToolContext, appointmentId: string) =>
  finishDraft(ctx, appointmentId, 'confirmed');

export const cancelDraft = (ctx: ToolContext, appointmentId: string) =>
  finishDraft(ctx, appointmentId, 'cancelled');

const HANDLERS: {
  [K in AssistantToolName]: (
    ctx: ToolContext,
    args: z.infer<(typeof schemas)[K]>,
  ) => Promise<ToolOutput>;
} = {
  find_client: findClient,
  list_services: async (ctx) => ({ result: { services: menuSummary(await ctx.port.getMenu()) } }),
  find_slots: findSlotsTool,
  get_day_summary: daySummary,
  propose_booking: (ctx, args) => proposeBooking(ctx, args),
  cancel_draft: (ctx, args) => cancelDraft(ctx, args.appointmentId),
};

/**
 * Validates and runs one model tool call. Failures come back as `{ error }` results so the model
 * can recover (e.g. ask for the service) instead of the whole turn failing.
 */
export async function runTool(
  ctx: ToolContext,
  name: string,
  rawArgs: Record<string, unknown>,
): Promise<ToolOutput & { ok: boolean }> {
  if (!(name in schemas)) {
    return { ok: false, result: { error: { code: 'unknown_tool', message: `No tool ${name}` } } };
  }
  const tool = name as AssistantToolName;
  const parsed = schemas[tool].safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      result: { error: { code: 'invalid_arguments', message: z.prettifyError(parsed.error) } },
    };
  }
  try {
    const handler = HANDLERS[tool] as (ctx: ToolContext, args: unknown) => Promise<ToolOutput>;
    return { ok: true, ...(await handler(ctx, parsed.data)) };
  } catch (e) {
    if (e instanceof ToolError) {
      return { ok: false, result: { error: { code: e.code, message: e.message } } };
    }
    throw e;
  }
}
