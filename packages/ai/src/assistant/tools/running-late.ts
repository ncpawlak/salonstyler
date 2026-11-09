import { MAX_RUNNING_LATE_MINUTES, planRunningLate, toSalonDate } from '@chairside/core';
import { z } from 'zod';

import { DAY, defineTool, formatTime, type ToolContext, type ToolOutput } from '../tool-kit.ts';
import type { RunningLateCard } from '../types.ts';

const RUNNING_LATE_MOVABLE: readonly string[] = ['held', 'requested', 'confirmed'];

/** Previews today's cascade for a delay. The owner applies it from the Running late sheet. */
async function runningLate(
  ctx: ToolContext,
  args: { minutes: number },
): Promise<ToolOutput & { card: RunningLateCard }> {
  const now = ctx.now();
  const utcToday = toSalonDate(now, 'UTC');
  const probe = await ctx.port.getSchedule({ from: utcToday, to: utcToday });
  const timeZone = probe.hours.timeZone;
  const today = toSalonDate(now, timeZone);
  const schedule =
    today === utcToday ? probe : await ctx.port.getSchedule({ from: today, to: today });
  const day = (
    await ctx.port.listAppointments({
      from: new Date(now - DAY).toISOString(),
      to: new Date(now + DAY).toISOString(),
    })
  ).filter((a) => toSalonDate(a.starts_at, timeZone) === today);
  // Same defaults as the Running late sheet: only live bookings move, starting with the next
  // client who hasn't started (or the earliest one still in the chair).
  const movable = day
    .filter((a) => RUNNING_LATE_MOVABLE.includes(a.status) && Date.parse(a.ends_at) > now)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  const first = movable.find((a) => Date.parse(a.starts_at) > now) ?? movable[0];
  const plan = first
    ? planRunningLate({
        appointments: day.map((a) => ({ id: a.id, segments: a.segments })),
        delayMinutes: args.minutes,
        firstId: first.id,
        fixedIds: day.filter((a) => !RUNNING_LATE_MOVABLE.includes(a.status)).map((a) => a.id),
        hours: schedule.hours,
        now,
      })
    : { moves: [], unchanged: [], overtimeMinutes: 0 };
  const name = (id: string) => day.find((a) => a.id === id)?.client?.name ?? 'Walk-in';
  const card: RunningLateCard = {
    type: 'running_late',
    delayMinutes: args.minutes,
    moves: plan.moves.map((m) => ({
      appointmentId: m.id,
      clientName: name(m.id),
      from: m.from.start,
      to: m.to.start,
      label: `${formatTime(m.from.start, timeZone)} → ${formatTime(m.to.start, timeZone)}`,
    })),
    unchangedCount: plan.unchanged.length,
    overtimeMinutes: plan.overtimeMinutes,
  };
  return {
    result: {
      moves: card.moves.map((m) => ({ client: m.clientName, change: m.label })),
      unaffectedLaterClients: card.unchangedCount,
      overtimeMinutes: card.overtimeMinutes,
      note: card.moves.length
        ? 'Card shown with a Review button: the owner checks the new times and the drafted texts, then updates the calendar. Nothing has moved yet.'
        : 'Nobody left today needs to move.',
    },
    card,
  };
}

export default defineTool({
  name: 'running_late',
  order: 70,
  description:
    'The owner is running late today ("I’m 15 behind"). Works out which of today’s clients have to move and shows a card to review the new times and drafted texts. Moves nothing by itself.',
  parameters: {
    type: 'object',
    properties: { minutes: { type: 'integer', description: 'How many minutes late (1–240)' } },
    required: ['minutes'],
  },
  schema: z.object({ minutes: z.int().min(1).max(MAX_RUNNING_LATE_MINUTES) }),
  handler: runningLate,
});
