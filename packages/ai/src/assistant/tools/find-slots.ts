import {
  findSlots,
  getWorkingBlocks,
  toSalonDate,
  type SlotCandidate,
  type TimeOfDay,
} from '@chairside/core';
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

/** Below this many shown openings, search forward past the radius for more days. */
const MIN_OPENINGS = 3;
/** How far past the requested date the forward search may go. */
const WIDEN_MAX_DAYS = 21;

export default defineTool({
  name: 'find_slots',
  order: 30,
  description:
    'Open time slots from the scheduling engine for a service on a date and the surrounding days (and the next days with openings, up to 3 weeks out, when few are free nearby). The ONLY source of availability: never suggest a time that this tool did not return. If services is omitted the client’s usual service is used.',
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

    const common = {
      service: resolved.service,
      ...(args.timeOfDay ? { preference: args.timeOfDay as TimeOfDay } : {}),
      rules: schedule.rules,
      now: ctx.now(),
    };
    const candidates = findSlots({
      ...common,
      hours: schedule.hours,
      requestedDate: args.date,
      searchRadiusDays: radius,
      existing: toExisting(appointments),
    });

    const perDay = args.perDay ?? 3;
    const byDate = new Map<string, SlotCandidate[]>();
    const collect = (list: SlotCandidate[]) => {
      for (const c of list) {
        if (args.timeOfDay && !c.matchesPreference) continue;
        byDate.set(c.localDate, [...(byDate.get(c.localDate) ?? []), c]);
      }
    };
    collect(candidates);
    const toDay = (date: string, offset: number): SlotDay => ({
      date,
      label: formatDayLabel(date),
      dayOffset: offset,
      slots: pickSpread(byDate.get(date) ?? [], perDay).map((c) => ({
        start: c.start,
        end: c.end,
        time: formatTime(c.start, timeZone),
        requiresApproval: c.requiresApproval,
      })),
    });
    const days: SlotDay[] = [];
    for (let offset = 0 - radius; offset <= radius; offset++) {
      const date = shiftDate(args.date, offset);
      // Always show the requested day, even when it's full or closed.
      if (!byDate.has(date) && offset !== 0) continue;
      days.push(toDay(date, offset));
    }

    // Too few openings around the requested day: keep looking forward (bounded) so the owner
    // still gets real alternatives instead of a lone slot or an empty card.
    const total = () => days.reduce((n, d) => n + d.slots.length, 0);
    let widened = false;
    if (total() < MIN_OPENINGS && radius < WIDEN_MAX_DAYS) {
      const first = radius + 1;
      const half = Math.ceil((WIDEN_MAX_DAYS - first) / 2);
      const center = shiftDate(args.date, first + half);
      const later = await port.getSchedule({
        from: shiftDate(args.date, first),
        to: shiftDate(args.date, WIDEN_MAX_DAYS),
      });
      const centerMs = Date.parse(`${center}T12:00:00Z`);
      const laterAppointments = await port.listAppointments({
        from: new Date(centerMs - (half + 2) * DAY).toISOString(),
        to: new Date(centerMs + (half + 2) * DAY).toISOString(),
      });
      collect(
        findSlots({
          ...common,
          hours: later.hours,
          requestedDate: center,
          searchRadiusDays: half,
          existing: toExisting(laterAppointments),
        }),
      );
      for (let offset = first; offset <= WIDEN_MAX_DAYS && total() < MIN_OPENINGS; offset++) {
        const date = shiftDate(args.date, offset);
        if (!byDate.has(date)) continue;
        days.push(toDay(date, offset));
        widened = true;
      }
    }
    const requested = days.find((d) => d.dayOffset === 0)!;
    let requestedNote: string | undefined;
    if (requested.slots.length === 0) {
      const blocks = getWorkingBlocks(schedule.hours, args.date);
      const today = toSalonDate(ctx.now(), timeZone);
      requestedNote =
        args.date < today
          ? `${requested.label} has already passed.`
          : blocks.status === 'closed'
            ? `Closed on ${requested.label}.`
            : args.date === today
              ? `No openings left today for this service.`
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
        ...(widened ? { widened: true } : {}),
        note: widened
          ? 'Few openings near the requested day, so the next days with openings are included. The app shows these as tappable cards. Mention a few; only these slots exist.'
          : 'The app shows these as tappable cards. Mention a few; only these slots exist.',
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
