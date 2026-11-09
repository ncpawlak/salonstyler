import { z } from 'zod';

import { defineTool, requireClient } from '../tool-kit.ts';

export default defineTool({
  name: 'add_client_note',
  order: 80,
  description:
    'Saves text the owner pasted or dictated to a client’s profile: a color formula (kind "formula", e.g. "7N + 7G 1:1, 20 vol, 35 min") or a general note. Only call when the owner asks to save it.',
  parameters: {
    type: 'object',
    properties: {
      clientId: { type: 'string', description: 'From find_client' },
      kind: { type: 'string', enum: ['note', 'formula'], description: 'Default "note"' },
      text: { type: 'string', description: 'The note or formula, as given (max 2000 chars)' },
    },
    required: ['clientId', 'text'],
  },
  schema: z.object({
    clientId: z.string().min(1),
    kind: z.enum(['note', 'formula']).nullish(),
    text: z.string().trim().min(1).max(2000),
  }),
  async handler(ctx, args) {
    const client = await requireClient(ctx.port, args.clientId);
    const kind = args.kind ?? 'note';
    const saved = await ctx.port.addClientNote({ clientId: client.id, kind, text: args.text });
    await ctx.port.audit('assistant.client_note_added', {
      clientId: client.id,
      kind,
      id: saved.id,
    });
    return {
      result: {
        saved: true,
        kind,
        client: { id: client.id, name: client.name },
        note: `Saved to ${client.name}'s profile.`,
      },
    };
  },
});
