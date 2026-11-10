import { beforeEach, describe, expect, it } from 'vitest';

import { createFakePort, DEVELOPER, type FakePort, NOW, TUBE_6N, TUBE_6NB } from './fake-salon.ts';
import { matchProducts, resolveProduct } from './inventory.ts';
import { runTool, type ToolContext } from './tools.ts';

let port: FakePort;
let ctx: ToolContext;

beforeEach(() => {
  port = createFakePort();
  ctx = { port, now: () => NOW };
});

describe('product matching', () => {
  it('prefers the exact name over a prefix ("6N" vs "6NB")', () => {
    const r = resolveProduct('6N', port.products);
    expect('product' in r && r.product.id).toBe(TUBE_6N);
  });

  it('matches brand + name, typos and SKUs', () => {
    expect(matchProducts('shades eq 6nb', port.products)[0]!.product.id).toBe(TUBE_6NB);
    expect(matchProducts('procesing solution', port.products)[0]!.product.id).toBe(DEVELOPER);
    expect(matchProducts('rk-ces-300', port.products)[0]!.score).toBe(1);
  });

  it('asks when nothing is clearly meant', () => {
    expect(resolveProduct('purple shampoo', port.products)).toEqual({ candidates: [] });
  });
});

describe('inventory_lookup', () => {
  it('answers "what do I need to reorder?" from the reorder list', async () => {
    const out = await runTool(ctx, 'inventory_lookup', { lowStockOnly: true });
    expect(out.ok).toBe(true);
    expect(out.result).toMatchObject({
      reorder: [
        { name: 'Shades EQ 6NB', onHand: '1 tube', order: '3 tube', supplier: 'SalonCentric' },
        { name: 'Redken Color Extend Shampoo', onHand: '2', order: '6', low: true },
      ],
    });
  });

  it('looks a product up by name', async () => {
    const out = await runTool(ctx, 'inventory_lookup', { query: 'processing solution' });
    expect(out.result).toMatchObject({
      matches: [{ id: DEVELOPER, onHand: '940 ml', low: false, confidence: 1 }],
    });
  });

  it('needs a query or lowStockOnly', async () => {
    const out = await runTool(ctx, 'inventory_lookup', {});
    expect(out).toMatchObject({ ok: false, result: { error: { code: 'invalid_arguments' } } });
  });
});

describe('adjust_stock', () => {
  it('drafts "used 2 tubes of 6N" without writing anything', async () => {
    const before = JSON.stringify(port.products);
    const out = await runTool(ctx, 'adjust_stock', { product: '6N', quantity: 2, action: 'use' });
    expect(out.ok).toBe(true);
    expect(out.card).toEqual({
      type: 'stock_adjustment',
      productId: TUBE_6N,
      productName: 'Shades EQ 6N',
      unit: 'tube',
      reason: 'use',
      delta: -2,
      onHandBefore: 5,
      onHandAfter: 3,
      note: null,
    });
    expect(out.result).toMatchObject({ drafted: true, change: '−2 tube', afterApply: '3 tube' });
    expect(JSON.stringify(port.products)).toBe(before);
    expect(port.audits.at(-1)?.action).toBe('assistant.stock_adjustment_drafted');
  });

  it('drafts deliveries and removals', async () => {
    const got = await runTool(ctx, 'adjust_stock', {
      product: TUBE_6NB,
      quantity: 6,
      action: 'receive',
      note: 'Delivery',
    });
    expect(got.card).toMatchObject({
      reason: 'receive',
      delta: 6,
      onHandAfter: 7,
      note: 'Delivery',
    });
    const out = await runTool(ctx, 'adjust_stock', {
      product: 'processing solution',
      quantity: 12.5,
      action: 'remove',
    });
    expect(out.card).toMatchObject({ reason: 'adjust', delta: -12.5, onHandAfter: 927.5 });
  });

  it('refuses to draft more than is on hand', async () => {
    const out = await runTool(ctx, 'adjust_stock', { product: '6NB', quantity: 2, action: 'use' });
    expect(out).toMatchObject({ ok: false, result: { error: { code: 'not_enough_stock' } } });
  });

  it('asks about unknown products and rejects bad quantities', async () => {
    const unknown = await runTool(ctx, 'adjust_stock', {
      product: 'purple shampoo',
      quantity: 1,
      action: 'use',
    });
    expect(unknown).toMatchObject({ ok: false, result: { error: { code: 'unknown_product' } } });
    for (const quantity of [0, -1, 1.005]) {
      const bad = await runTool(ctx, 'adjust_stock', { product: '6N', quantity, action: 'use' });
      expect(bad).toMatchObject({ ok: false, result: { error: { code: 'invalid_arguments' } } });
    }
    const fine = await runTool(ctx, 'adjust_stock', {
      product: '6N',
      quantity: 1.1,
      action: 'use',
    });
    expect(fine.ok).toBe(true);
  });
});
