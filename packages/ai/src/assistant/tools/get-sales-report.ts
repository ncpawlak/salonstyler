import { NAMED_RANGES, namedRange, rangeDays, type DateRange } from '@chairside/core/reports';
import { toSalonDate } from '@chairside/core';
import { z } from 'zod';

import { defineTool, localDate, ToolError } from '../tool-kit.ts';

const money = (cents: number, currency: string) => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
};

const pct = (n: number | null) => (n == null ? null : `${Math.round(n * 100)}%`);

export default defineTool({
  name: 'get_sales_report',
  order: 45,
  description:
    'Business report: revenue (services vs retail), tips, average ticket, top services, new vs ' +
    'returning clients, no-shows/cancellations and rebook rate. Use for "how did I do last ' +
    'month?". Pass `period` (e.g. last_month) or a local `from`/`to` (YYYY-MM-DD, ≤ 1 year).',
  parameters: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: [...NAMED_RANGES] },
      from: { type: 'string' },
      to: { type: 'string' },
    },
  },
  schema: z
    .object({
      period: z.enum(NAMED_RANGES).optional(),
      from: localDate.optional(),
      to: localDate.optional(),
    })
    .refine((a) => a.period || (a.from && a.to), 'Pass a period, or both from and to.'),
  async handler(ctx, args) {
    const { port } = ctx;
    let range: DateRange;
    if (args.from && args.to) {
      range = { from: args.from, to: args.to };
    } else {
      const nowIso = new Date(ctx.now()).toISOString();
      const utcDay = nowIso.slice(0, 10);
      const { hours } = await port.getSchedule({ from: utcDay, to: utcDay });
      const today = toSalonDate(nowIso, hours.timeZone);
      const named = namedRange(args.period ?? 'last_month', today);
      range = { from: named.from, to: named.to };
    }
    if (range.from > range.to) throw new ToolError('bad_range', '`from` must not be after `to`.');
    if (rangeDays(range) > 367) throw new ToolError('bad_range', 'Reports cover at most a year.');

    const r = await port.salesReport(range);
    const $ = (cents: number) => money(cents, r.currency);
    const best = r.daily.reduce<(typeof r.daily)[number] | null>(
      (top, d) => (d.salesCents > (top?.salesCents ?? 0) ? d : top),
      null,
    );
    return {
      result: {
        from: r.from,
        to: r.to,
        checkouts: r.checkouts,
        sales: $(r.salesCents),
        services: $(r.servicesCents),
        retail: $(r.retailCents),
        retailItems: r.retailItems,
        other: r.otherSalesCents ? $(r.otherSalesCents) : undefined,
        tips: $(r.tipsCents),
        averageTicket: r.avgTicketCents == null ? null : $(r.avgTicketCents),
        collected: { card: $(r.cardCents), cash: $(r.cashCents), other: $(r.otherCents) },
        refunded: r.refundedCents ? $(r.refundedCents) : undefined,
        keptDeposits: r.keptDeposits ? `${r.keptDeposits} (${$(r.keptDepositsCents)})` : undefined,
        topServices: r.topServices.map((s) => ({
          name: s.name,
          count: s.count,
          revenue: $(s.cents),
        })),
        bestDay: best ? { date: best.date, sales: $(best.salesCents) } : null,
        clients: r.clients,
        appointments: r.appointments,
        rebookRate: pct(r.rebook.rate),
      },
    };
  },
});
