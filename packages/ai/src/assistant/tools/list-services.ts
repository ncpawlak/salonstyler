import { z } from 'zod';

import { menuSummary } from '../menu.ts';
import { defineTool } from '../tool-kit.ts';

export default defineTool({
  name: 'list_services',
  order: 20,
  description: 'The salon’s service menu: ids, names, durations and length variants.',
  parameters: { type: 'object', properties: {} },
  schema: z.object({}),
  handler: async (ctx) => ({ result: { services: menuSummary(await ctx.port.getMenu()) } }),
});
