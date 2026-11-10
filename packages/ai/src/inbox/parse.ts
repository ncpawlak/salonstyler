import type { TimeOfDay } from '@chairside/core';
import type { ServiceMenu } from '@chairside/db/services';
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
  /** Salon-local `HH:MM` when the client names a clock time ("2pm"), else null. */
  time: string | null;
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
  /**
   * Salon-local `YYYY-MM-DD` the message was sent, when that was before today (a screenshot of an
   * older thread). Relative days ("tomorrow") are resolved from it.
   */
  sentOn?: string | null;
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
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullish()
    .catch(null),
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
      time: {
        type: ['string', 'null'],
        description: 'A clock time they name, as 24-hour HH:MM ("2pm" is "14:00"), or null.',
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
    ...(ctx.sentOn && ctx.sentOn < ctx.today
      ? [
          `The message was sent on ${ctx.sentOn}. Resolve relative days ("tomorrow", "fri") from that date, not from today.`,
        ]
      : []),
    'You only interpret the message. Never suggest or choose a time; the scheduling engine does that. Record a clock time only if they name one.',
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
    time: parsed.data.time ?? null,
    timeOfDay: parsed.data.timeOfDay ?? timeOfDayAt(parsed.data.time ?? null),
    notes: parsed.data.notes || null,
  };
}

export function extractJson(text: string | null): unknown {
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

/** Same windows as the engine's time-of-day preference. */
export function timeOfDayAt(time: string | null): TimeOfDay | null {
  if (!time) return null;
  const hour = Number(time.slice(0, 2));
  return hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
}

/** "2pm", "2:30 pm", "at 10" (assumed 9am-8pm) as `HH:MM`, or null. */
function demoClockTime(t: string): string | null {
  const m =
    /\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?m\.?\b/.exec(t) ??
    /\bat\s+(\d{1,2})(?::([0-5]\d))?\b(?!\s*(?:day|week|month|min|hour))/.exec(t);
  if (!m) return null;
  let hour = Number(m[1]);
  if (hour < 1 || hour > 12) return null;
  const meridiem = m[3];
  if (meridiem === 'p' && hour < 12) hour += 12;
  else if (meridiem === 'a' && hour === 12) hour = 0;
  else if (!meridiem && hour < 9) hour += 12;
  return `${String(hour).padStart(2, '0')}:${m[2] ?? '00'}`;
}

/**
 * One menu item per word the client used: prefer items whose every name word was mentioned,
 * then items covering more of the message, then a literal match over a synonym, then shorter
 * names. "haircut" picks "Haircut", not every item with "cut" in it.
 */
function demoServices(text: string, ctx: InboxParseContext): BookingItem[] {
  const said = normalizeName(text).split(' ').filter(Boolean);
  const words = new Set(said);
  for (const w of said) for (const s of SYNONYMS[w] ?? []) words.add(s);
  const live = [...ctx.menu.services, ...ctx.menu.combos]
    .filter((s) => !s.archivedAt)
    .map((s) => ({
      id: s.id,
      tokens: normalizeName(s.name)
        .split(' ')
        .filter((x) => x && !STOP_WORDS.has(x)),
    }))
    .filter((s) => s.tokens.length > 0);

  const picked: typeof live = [];
  for (const w of said) {
    if (picked.some((p) => p.tokens.includes(w))) continue;
    const forms = [w, ...(SYNONYMS[w] ?? [])];
    const rank = (s: (typeof live)[number]) => [
      s.tokens.every((x) => words.has(x)) ? 0 : 1,
      -s.tokens.filter((x) => words.has(x)).length,
      s.tokens.includes(w) ? 0 : 1,
      s.tokens.length,
    ];
    const best = live
      .filter((s) => forms.some((f) => s.tokens.includes(f)))
      .sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
        return 0;
      })[0];
    if (best && !picked.includes(best)) picked.push(best);
  }
  return picked.slice(0, 5).map((s) => ({ serviceId: s.id, variantId: null }));
}

/**
 * Rule-based stand-in for the model, enabled with `CHAIRSIDE_AI_DEMO=1` against a local stack. It
 * recognises a few phrasings ("can I get color + trim fri afternoon?", "need to cancel tomorrow").
 */
export function demoParse(text: string, ctx: InboxParseContext): ParsedInboxRequest {
  const t = text.toLowerCase();
  const services = demoServices(text, ctx);

  const date = parseDemoDate(text, ctx.sentOn && ctx.sentOn < ctx.today ? ctx.sentOn : ctx.today);
  const time = demoClockTime(t);
  const timeOfDay: TimeOfDay | null = /\bmorning\b/.test(t)
    ? 'morning'
    : /\bafternoon\b/.test(t)
      ? 'afternoon'
      : /\b(evening|tonight|after work)\b/.test(t)
        ? 'evening'
        : timeOfDayAt(time);
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

  return { intent, clientName: name, services, date, time, timeOfDay, notes: null };
}
