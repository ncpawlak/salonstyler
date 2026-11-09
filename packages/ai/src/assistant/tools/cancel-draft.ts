import { toSalonDate } from '@chairside/core';
import { z } from 'zod';

import {
  defineTool,
  draftCard,
  DRAFT_NOTE,
  ToolError,
  type ToolContext,
  type ToolOutput,
} from '../tool-kit.ts';
import type { DraftCard } from '../types.ts';

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

export default defineTool({
  name: 'cancel_draft',
  order: 60,
  description: 'Releases a draft (held) booking created by propose_booking.',
  parameters: {
    type: 'object',
    properties: { appointmentId: { type: 'string' } },
    required: ['appointmentId'],
  },
  schema: z.object({ appointmentId: z.string().min(1) }),
  handler: (ctx, args) => cancelDraft(ctx, args.appointmentId),
});
