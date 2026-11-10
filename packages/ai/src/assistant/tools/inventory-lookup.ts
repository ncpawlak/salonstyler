import { z } from 'zod';

import { formatStock, matchProducts, productSummary } from '../inventory.ts';
import { defineTool } from '../tool-kit.ts';

export default defineTool({
  name: 'inventory_lookup',
  order: 87,
  description:
    'Looks up back-bar and retail stock. Pass `query` (product name, brand, SKU or barcode; typos OK) for "how much 6N do I have?", or `lowStockOnly: true` for "what do I need to reorder?" (everything at or below its reorder point, with a suggested order quantity).',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Product as the owner said it' },
      lowStockOnly: { type: 'boolean', description: 'Only products that need reordering' },
    },
  },
  schema: z
    .object({
      query: z.string().trim().min(1).max(100).nullish(),
      lowStockOnly: z.boolean().nullish(),
    })
    .refine((a) => a.query || a.lowStockOnly, 'Pass a query, or lowStockOnly: true.'),
  async handler(ctx, args) {
    const products = await ctx.port.listProducts();
    if (args.lowStockOnly) {
      const low = products
        .filter((p) => p.suggestedQuantity !== null)
        .filter((p) => !args.query || matchProducts(args.query, [p]).length > 0);
      return {
        result: {
          reorder: low.map((p) => ({
            ...productSummary(p),
            order: formatStock(p.suggestedQuantity!, p.unit),
            supplier: p.supplier,
          })),
          note: low.length
            ? 'Quantities come from the reorder list; repeat them as given. The full list (and CSV export) is in Inventory → Reorder list.'
            : 'Nothing is at or below its reorder point.',
        },
      };
    }
    const matches = matchProducts(args.query!, products);
    return {
      result: {
        matches: matches.map((m) => ({ ...productSummary(m.product), confidence: m.score })),
        note: matches.length
          ? undefined
          : `No product matches "${args.query}". Products are added in Inventory.`,
      },
    };
  },
});
