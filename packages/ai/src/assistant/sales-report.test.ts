import { beforeEach, describe, expect, it } from 'vitest';

import { DemoAssistantProvider } from './demo-provider.ts';
import { createFakePort, type FakePort, NOW } from './fake-salon.ts';
import { runAssistantTurn } from './loop.ts';
import { runTool, type ToolContext } from './tools.ts';

let port: FakePort;
let ctx: ToolContext;

beforeEach(() => {
  port = createFakePort();
  ctx = { port, now: () => NOW };
});

describe('get_sales_report', () => {
  it('answers "how did I do last month?" with the previous salon-local month', async () => {
    const out = await runTool(ctx, 'get_sales_report', { period: 'last_month' });
    expect(out.ok).toBe(true);
    expect(port.reportRanges).toEqual([{ from: '2026-11-01', to: '2026-11-30' }]);
    expect(out.result).toMatchObject({
      from: '2026-11-01',
      to: '2026-11-30',
      checkouts: 4,
      sales: '$455.00',
      services: '$390.00',
      retail: '$60.00',
      tips: '$45.00',
      averageTicket: '$113.75',
      collected: { card: '$380.00', cash: '$100.00', other: '$0.00' },
      keptDeposits: '1 ($25.00)',
      topServices: [{ name: 'All-over Color', count: 2, revenue: '$300.00' }, expect.anything()],
      bestDay: { date: '2026-11-30', sales: '$255.00' },
      clients: { served: 3, new: 2, returning: 1 },
      appointments: { booked: 5, completed: 3, noShows: 1, cancelled: 1 },
      rebookRate: '25%',
    });
  });

  it('uses the salon time zone for "today"', async () => {
    // 03:00 UTC on Dec 1 is still Nov 30 in Chicago, so "last month" is October.
    ctx.now = () => Date.parse('2026-12-01T03:00:00Z');
    await runTool(ctx, 'get_sales_report', { period: 'last_month' });
    expect(port.reportRanges).toEqual([{ from: '2026-10-01', to: '2026-10-31' }]);
  });

  it('takes an explicit range', async () => {
    const out = await runTool(ctx, 'get_sales_report', { from: '2026-07-01', to: '2026-09-30' });
    expect(out.ok).toBe(true);
    expect(port.reportRanges).toEqual([{ from: '2026-07-01', to: '2026-09-30' }]);
  });

  it('rejects reversed or over-long ranges and missing arguments', async () => {
    for (const args of [
      { from: '2026-09-30', to: '2026-07-01' },
      { from: '2025-01-01', to: '2026-06-30' },
      {},
    ]) {
      const out = await runTool(ctx, 'get_sales_report', args);
      expect(out.ok).toBe(false);
    }
    expect(port.reportRanges).toEqual([]);
  });
});

describe('Ask Chairside (demo provider)', () => {
  it('"How did I do last month?" → a sales report summary', async () => {
    const turn = await runAssistantTurn({
      llm: new DemoAssistantProvider(),
      tools: ctx,
      prompt: { salonName: 'Studio K', timeZone: 'America/Chicago' },
      history: [],
      text: 'How did I do last month?',
    });
    expect(turn.toolCalls).toEqual([{ name: 'get_sales_report', ok: true }]);
    expect(port.reportRanges).toEqual([{ from: '2026-11-01', to: '2026-11-30' }]);
    expect(turn.reply).toMatch(
      /\$455\.00 in sales.*\$45\.00 in tips.*All-over Color.*25% rebooked/,
    );
  });
});
