import { findSlots, getWorkingBlocks, type SlotCandidate, type TimeOfDay } from '@chairside/core';
import { z } from 'zod';

import {
  DAY,
  defineTool,
  formatDayLabel,
  formatTime,
  itemsFor,
  itemsSchema,
  localDate,
  pickSpread,
  requireClient,
  shiftDate,
  toExisting,
} from '../tool-kit.ts';
import type { SlotDay } from '../types.ts';

export default defineTool({
  name: 'find_slots',
  order: 30,
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
  schema: z.object({
    clientId: z.string().min(1).nullish(),
    services: itemsSchema.nullish(),
    date: localDate,
    radiusDays: z.int().min(0).max(7).nullish(),
    timeOfDay: z.enum(['morning', 'afternoon', 'evening']).nullish(),
    perDay: z.int().min(1).max(8).nullish(),
  }),
  async handler(ctx, args) {
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
  },
});
