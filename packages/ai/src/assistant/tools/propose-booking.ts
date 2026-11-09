import { bookingErrorMessage, planBooking, toSalonDate } from '@chairside/core';
import { z } from 'zod';

import {
  DAY,
  defineTool,
  DRAFT_NOTE,
  formatDayLabel,
  formatTime,
  itemsFor,
  itemsSchema,
  requireClient,
  toExisting,
  ToolError,
  type ToolContext,
  type ToolOutput,
} from '../tool-kit.ts';
import type { BookingItem, DraftCard } from '../types.ts';

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

export default defineTool({
  name: 'propose_booking',
  order: 50,
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
  schema: z.object({
    clientId: z.string().min(1),
    start: z.iso.datetime({ offset: true }),
    services: itemsSchema.nullish(),
  }),
  handler: (ctx, args) => proposeBooking(ctx, args),
});
