import { getWorkingBlocks, toSalonDate } from '@chairside/core';
import { z } from 'zod';

import { DAY, defineTool, formatDayLabel, formatTime, localDate } from '../tool-kit.ts';

export default defineTool({
  name: 'get_day_summary',
  order: 40,
  description: 'Work hours and appointments for one local date (YYYY-MM-DD).',
  parameters: {
    type: 'object',
    properties: { date: { type: 'string' } },
    required: ['date'],
  },
  schema: z.object({ date: localDate }),
  async handler(ctx, args) {
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
  },
});
