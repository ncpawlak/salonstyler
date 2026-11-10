import { z } from 'zod';

import { formatStock, productLabel, resolveProduct } from '../inventory.ts';
import { defineTool, ToolError } from '../tool-kit.ts';
import type { StockAdjustmentCard } from '../types.ts';

const ACTIONS = ['use', 'receive', 'remove'] as const;

export default defineTool({
  name: 'adjust_stock',
  order: 88,
  description:
    'Drafts a stock change for the owner to approve: "used 2 tubes of 6N" (action "use"), "got 6 shampoo in" ("receive"), "threw out a broken bottle" ("remove"). Pass the product as said (or an id from inventory_lookup) and a positive quantity in the product’s unit. Nothing changes until the owner taps Apply on the card; never say stock was updated. Service recipes already deduct product when an appointment is completed, so only use this for extra or one-off usage.',
  parameters: {
    type: 'object',
    properties: {
      product: { type: 'string', description: 'Product name, SKU or id, as given' },
      quantity: { type: 'number', description: 'Positive, up to 2 decimals' },
      action: { type: 'string', enum: [...ACTIONS] },
      note: { type: 'string', description: 'Optional, e.g. "Karina’s root touch-up"' },
    },
    required: ['product', 'quantity', 'action'],
  },
  schema: z.object({
    product: z.string().trim().min(1).max(100),
    quantity: z
      .number()
      .positive()
      .max(9999)
      .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, 'At most 2 decimals'),
    action: z.enum(ACTIONS),
    note: z.string().trim().max(200).nullish(),
  }),
  async handler(ctx, args) {
    const products = await ctx.port.listProducts();
    const byId = products.find((p) => p.id === args.product);
    const resolved = byId ? { product: byId } : resolveProduct(args.product, products);
    if (!('product' in resolved)) {
      const names = resolved.candidates.map(productLabel);
      throw new ToolError(
        names.length ? 'ambiguous_product' : 'unknown_product',
        names.length
          ? `Which product: ${names.join(', ')}? Ask the owner, then retry with its id from inventory_lookup.`
          : `No product matches "${args.product}". Products are added in Inventory.`,
      );
    }
    const p = resolved.product;
    const delta = args.action === 'receive' ? args.quantity : -args.quantity;
    const after = Math.round((p.onHand + delta) * 100) / 100;
    if (after < 0) {
      throw new ToolError(
        'not_enough_stock',
        `Only ${formatStock(p.onHand, p.unit)} of ${productLabel(p)} on hand. Ask the owner to recount it in Inventory if that's wrong.`,
      );
    }
    const card: StockAdjustmentCard = {
      type: 'stock_adjustment',
      productId: p.id,
      productName: productLabel(p),
      unit: p.unit,
      reason: args.action === 'remove' ? 'adjust' : args.action,
      delta,
      onHandBefore: p.onHand,
      onHandAfter: after,
      note: args.note || null,
    };
    await ctx.port.audit('assistant.stock_adjustment_drafted', {
      productId: p.id,
      delta,
      reason: card.reason,
    });
    return {
      result: {
        drafted: true,
        product: productLabel(p),
        change: `${delta > 0 ? '+' : '−'}${formatStock(Math.abs(delta), p.unit)}`,
        onHand: formatStock(p.onHand, p.unit),
        afterApply: formatStock(after, p.unit),
        note: 'Drafted. The owner must tap Apply on the card; stock has not changed yet.',
      },
      card,
    };
  },
});
