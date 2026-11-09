import type { TimeOfDay } from '@chairside/core';
import type { ServiceMenu } from '@chairside/db';
import { z } from 'zod';

import { parseDemoDate } from '../assistant/demo-provider.ts';
import { normalizeName } from '../assistant/fuzzy.ts';
import { menuSummary } from '../assistant/menu.ts';
import type { BookingItem } from '../assistant/types.ts';
import type { ChatMessage, LLMProvider, TokenUsage, ToolDefinition } from '../types.ts';

export type InboxIntent = 'booking' | 'reschedule' | 'cancel' | 'ignore';

/** What a client's text asks for. The model only interprets; it never picks a time. */
export interface ParsedInboxRequest {
  intent: InboxIntent;
  /** Name the client gave for themselves ("it's Karina"), if any. */
  clientName: string | null;
  /** Menu ids. Empty when no service was mentioned. */
  services: BookingItem[];
  /** Local `YYYY-MM-DD` the client asked for, if any. */
  date: string | null;
  timeOfDay: TimeOfDay | null;
  /** Anything else worth showing the stylist ("bringing my daughter"). */
  notes: string | null;
}

export interface InboxParseContext {
  menu: ServiceMenu;
  /** Salon-local `YYYY-MM-DD`. */
  today: string;
  /** e.g. "Tue, Dec 1". */
  todayLabel: string;
  timeZone: string;
  salonName: string;
}

const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullish()
  .catch(null);

export const parsedRequestSchema = z.object({
  intent: z.enum(['booking', 'reschedule', 'cancel', 'ignore']),
  clientName: z.string().trim().max(80).nullish().catch(null),
  services: z
    .array(z.object({ serviceId: z.string().min(1), variantId: z.string().min(1).nullish() }))
    .max(5)
    .nullish()
    .catch(null),
  date: localDate,
  timeOfDay: z.enum(['morning', 'afternoon', 'evening']).nullish().catch(null),
  notes: z.string().trim().max(300).nullish().catch(null),
});

export const SUBMIT_REQUEST_TOOL: ToolDefinition = {
  name: 'submit_request',
  description: 'Record what the client is asking for. Call exactly once.',
  parameters: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        enum: ['booking', 'reschedule', 'cancel', 'ignore'],
        description:
          'booking: wants a new appointment. reschedule: wants to move an existing one. cancel: wants to cancel one. ignore: anything else (thanks, running late, questions, chit-chat).',
      },
      clientName: {
        type: ['string', 'null'],
        description: 'The name the client gives for themselves, if they do. Never guess.',
      },
      services: {
        type: 'array',
        description: 'Menu items they ask for, by id. Empty if they don’t say.',
        items: {
          type: 'object',
          properties: {
            serviceId: { type: 'string' },
            variantId: { type: ['string', 'null'] },
          },
          required: ['serviceId'],
        },
      },
      date: {
        type: ['string', 'null'],
        description: 'The day they ask for as YYYY-MM-DD (the next such day), or null.',
      },
      timeOfDay: {
        type: ['string', 'null'],
        enum: ['morning', 'afternoon', 'evening', null],
      },
      notes: {
        type: ['string', 'null'],
        description: 'Other details the stylist should see, briefly. Null if none.',
      },
    },
    required: ['intent'],
  },
};

export function inboxParsePrompt(ctx: InboxParseContext): string {
  return [
    `You read text messages that clients send to ${ctx.salonName}, a hair salon, and record what they want by calling submit_request.`,
    `Today is ${ctx.todayLabel} (${ctx.today}), time zone ${ctx.timeZone}. Resolve days like "fri" or "next week" to dates.`,
    'You only interpret the message. Never suggest or choose a time; the scheduling engine does that.',
    'Map services to the menu below by id; leave services empty if none is mentioned. Treat "trim" as a haircut.',
    `Menu: ${JSON.stringify(menuSummary(ctx.menu))}`,
  ].join('\n');
}

export function normalizeParsed(raw: unknown, menu: ServiceMenu): ParsedInboxRequest | null {
  const parsed = parsedRequestSchema.safeParse(raw);
  if (!parsed.success) return null;
  const live = [...menu.services, ...menu.combos].filter((s) => !s.archivedAt);
  const services: BookingItem[] = [];
  for (const item of parsed.data.services ?? []) {
    const service = live.find((s) => s.id === item.serviceId);
    if (!service || services.some((s) => s.serviceId === item.serviceId)) continue;
    const variants = 'variants' in service ? service.variants : [];
    const variantId = variants.some((v) => v.id === item.variantId) ? item.variantId! : null;
    services.push({ serviceId: service.id, variantId });
  }
  return {
    intent: parsed.data.intent,
    clientName: parsed.data.clientName || null,
    services,
    date: parsed.data.date ?? null,
    timeOfDay: parsed.data.timeOfDay ?? null,
    notes: parsed.data.notes || null,
  };
}

function extractJson(text: string | null): unknown {
  const match = text ? /\{[\s\S]*\}/.exec(text) : null;
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

export interface LlmParseResult {
  parsed: ParsedInboxRequest | null;
  usage: TokenUsage;
  model: string;
}

/** One model call with a single forced tool. Null `parsed` means the model's answer was unusable. */
export async function parseWithLlm(
  llm: LLMProvider,
  text: string,
  ctx: InboxParseContext,
): Promise<LlmParseResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: inboxParsePrompt(ctx) },
    { role: 'user', content: text },
  ];
  const result = await llm.chat(messages, [SUBMIT_REQUEST_TOOL], {
    maxOutputTokens: 400,
    temperature: 0,
  });
  const call = result.toolCalls.find((c) => c.name === SUBMIT_REQUEST_TOOL.name);
  const raw = call ? call.arguments : extractJson(result.text);
  return { parsed: normalizeParsed(raw, ctx.menu), usage: result.usage, model: result.model };
}

// ---------------------------------------------------------------------------------------------
// Demo parser (local development only; no model call)
// ---------------------------------------------------------------------------------------------

const SYNONYMS: Record<string, string[]> = {
  trim: ['cut', 'haircut'],
  cut: ['haircut'],
  haircut: ['cut'],
  colour: ['color'],
  dye: ['color'],
  highlight: ['highlights'],
  blowout: ['blow', 'dry'],
};
const STOP_WORDS = new Set([
  'hair',
  'women',
  'womens',
  'men',
  'mens',
  's',
  'the',
  'and',
  'all',
  'over',
  'with',
  'a',
]);

/**
 * Rule-based stand-in for the model, enabled with `CHAIRSIDE_AI_DEMO=1` against a local stack. It
 * recognises a few phrasings ("can I get color + trim fri afternoon?", "need to cancel tomorrow").
 */
export function demoParse(text: string, ctx: InboxParseContext): ParsedInboxRequest {
  const t = text.toLowerCase();
  const words = new Set(normalizeName(text).split(' '));
  for (const w of [...words]) for (const s of SYNONYMS[w] ?? []) words.add(s);

  const services: BookingItem[] = [];
  for (const s of [...ctx.menu.services, ...ctx.menu.combos]) {
    if (s.archivedAt) continue;
    const tokens = normalizeName(s.name)
      .split(' ')
      .filter((x) => !STOP_WORDS.has(x));
    if (tokens.some((x) => words.has(x))) services.push({ serviceId: s.id, variantId: null });
  }

  const date = parseDemoDate(text, ctx.today);
  const timeOfDay: TimeOfDay | null = /\bmorning\b/.test(t)
    ? 'morning'
    : /\bafternoon\b/.test(t)
      ? 'afternoon'
      : /\b(evening|tonight|after work)\b/.test(t)
        ? 'evening'
        : null;
  const name =
    /\b(?:this is|it'?s|i'?m)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/.exec(text)?.[1] ?? null;

  let intent: InboxIntent = 'ignore';
  if (/\b(cancel|can'?t make it|cant make it|won'?t make it)\b/.test(t)) intent = 'cancel';
  else if (/\b(reschedule|move my|push my|change my)\b/.test(t)) intent = 'reschedule';
  else if (
    services.length > 0 ||
    /\b(book|appointment|appt|schedule|come in|get in|available|availability|opening|openings)\b/.test(
      t,
    )
  ) {
    intent = 'booking';
  }

  return { intent, clientName: name, services, date, timeOfDay, notes: null };
}
