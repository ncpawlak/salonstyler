import { z } from 'zod';

import { CONFIDENT_MATCH, rankByName } from '../fuzzy.ts';
import { resolveItems, usualItems } from '../menu.ts';
import { defineTool } from '../tool-kit.ts';

export default defineTool({
  name: 'find_client',
  order: 10,
  description:
    'Fuzzy-search the salon’s clients by name (typos OK). Returns matches with their usual services. Always call this before booking for a named person.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Name as the user said it' } },
    required: ['query'],
  },
  schema: z.object({ query: z.string().trim().min(1).max(100) }),
  async handler(ctx, args) {
    const { port } = ctx;
    const ranked = rankByName(args.query, await port.listClients());
    if (ranked.length === 0 || ranked[0]!.score < CONFIDENT_MATCH) {
      return {
        result: {
          matches: ranked.map((m) => ({ id: m.item.id, name: m.item.name, confidence: m.score })),
          note:
            ranked.length === 0
              ? `No client named "${args.query}". The app is offering the owner a button to add them; ask if they want to.`
              : 'No confident match. Ask the owner which client they meant, or offer to add a new one.',
        },
        card: {
          type: 'client_not_found' as const,
          query: args.query,
          suggestions: ranked.map((m) => ({ id: m.item.id, name: m.item.name })),
        },
      };
    }
    const menu = await port.getMenu();
    const confident = ranked.filter((m) => m.score >= CONFIDENT_MATCH);
    const matches = await Promise.all(
      confident.slice(0, 3).map(async ({ item, score }) => {
        const [visits, overrides] = await Promise.all([
          port.clientVisits(item.id, 10),
          port.clientOverrides(item.id),
        ]);
        const usual = usualItems(menu, visits);
        let usualSummary: string | null = null;
        if (usual) {
          try {
            usualSummary = resolveItems(menu, usual, overrides).summary;
          } catch {
            usualSummary = null;
          }
        }
        return {
          id: item.id,
          name: item.name,
          confidence: score,
          lastVisit: visits[0]?.startsAt ?? null,
          usualServices: usual,
          usualSummary,
        };
      }),
    );
    return {
      result: {
        matches,
        note:
          matches.length > 1 ? 'Several clients match; ask which one before booking.' : undefined,
      },
    };
  },
});
