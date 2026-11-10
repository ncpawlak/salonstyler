/**
 * Screenshot reading for manual capture (Bridge E, #2). A vision model transcribes a screenshot of
 * a conversation (iMessage, Instagram, WhatsApp, ...) into the same `{ sender, text }` a forwarded
 * text carries. The transcript then goes through the normal inbox parse, so a screenshot and a
 * forwarded text of the same message produce the same request. The model only reads; it never
 * interprets the request or picks a time.
 */
import { z } from 'zod';

import { extractJson } from './parse.ts';
import type { ChatMessage, ImagePart, LLMProvider, TokenUsage, ToolDefinition } from '../types.ts';

export const SCREENSHOT_PLATFORMS = [
  'imessage',
  'sms',
  'instagram',
  'whatsapp',
  'messenger',
  'other',
] as const;
export type ScreenshotPlatform = (typeof SCREENSHOT_PLATFORMS)[number];

/** What a screenshot says: who wrote, what they wrote, and when. */
export interface ScreenshotConversation {
  platform: ScreenshotPlatform;
  /** The client's display name (or @handle) from the thread header. Null if not shown. */
  sender: string | null;
  /** Only when the screenshot shows a phone number. */
  senderPhone: string | null;
  /** The client's latest messages, verbatim, oldest first, one per line. */
  text: string;
  /** Salon-local `YYYY-MM-DD` of the latest client message, if the screenshot shows it. */
  sentOn: string | null;
  /** Salon-local `HH:MM` of the latest client message, if shown. */
  sentTime: string | null;
}

export interface ScreenshotReadContext {
  /** Salon-local `YYYY-MM-DD`. */
  today: string;
  /** e.g. "Tue, Dec 1". */
  todayLabel: string;
  timeZone: string;
  salonName: string;
}

export const READ_CONVERSATION_TOOL: ToolDefinition = {
  name: 'read_conversation',
  description: 'Record what the screenshot shows. Call exactly once.',
  parameters: {
    type: 'object',
    properties: {
      isConversation: {
        type: 'boolean',
        description: 'False if the image is not a message thread (a photo, a menu, a web page).',
      },
      platform: {
        type: 'string',
        enum: [...SCREENSHOT_PLATFORMS],
        description:
          'imessage: blue/grey bubbles. sms: green bubbles. instagram: Instagram DM. whatsapp. messenger: Facebook Messenger. other.',
      },
      sender: {
        type: ['string', 'null'],
        description:
          'The other person in the thread (the client): their display name from the header, or the @handle when no name is shown. Null if neither is shown.',
      },
      senderPhone: {
        type: ['string', 'null'],
        description: 'A phone number shown for the client, as written. Null if none is shown.',
      },
      text: {
        type: 'string',
        description:
          "The client's most recent messages, word for word, oldest first, one per line. Only the client's (incoming, left-side) bubbles, never the salon's own (outgoing, right-side) ones. Empty if the client wrote nothing.",
      },
      sentOn: {
        type: ['string', 'null'],
        description:
          'The day of the client\'s latest message as YYYY-MM-DD, resolving labels like "Yesterday" or "Tue" from today. Null if not shown.',
      },
      sentTime: {
        type: ['string', 'null'],
        description: "The time of the client's latest message as 24-hour HH:MM. Null if not shown.",
      },
    },
    required: ['isConversation', 'platform', 'text'],
  },
};

export function screenshotReadPrompt(ctx: ScreenshotReadContext): string {
  return [
    `You read screenshots of message threads between ${ctx.salonName}, a hair salon, and one of its clients, and transcribe them by calling read_conversation.`,
    `Today is ${ctx.todayLabel} (${ctx.today}), time zone ${ctx.timeZone}.`,
    'Copy the words exactly. Do not summarize, translate, or interpret what the client wants, and never suggest a time.',
    'The salon is the phone owner: its messages are the outgoing (right-side, colored) bubbles. Transcribe only the client.',
  ].join('\n');
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullish()
  .catch(null);

const conversationSchema = z.object({
  isConversation: z.boolean().catch(true),
  platform: z.enum(SCREENSHOT_PLATFORMS).catch('other'),
  sender: z.string().trim().max(200).nullish().catch(null),
  senderPhone: z.string().trim().max(60).nullish().catch(null),
  text: z.string().trim().max(4000),
  sentOn: isoDate,
  sentTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullish()
    .catch(null),
});

/** Null when the answer is unusable or the image isn't a conversation with client text. */
export function normalizeConversation(raw: unknown, today: string): ScreenshotConversation | null {
  const parsed = conversationSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.isConversation || !parsed.data.text) return null;
  const d = parsed.data;
  return {
    platform: d.platform,
    sender: d.sender || null,
    senderPhone: d.senderPhone || null,
    text: d.text,
    // A date in the future is a misread (e.g. a month/day swap); drop it.
    sentOn: d.sentOn && d.sentOn <= today ? d.sentOn : null,
    sentTime: d.sentOn && d.sentOn <= today ? (d.sentTime ?? null) : null,
  };
}

export interface ScreenshotReadResult {
  conversation: ScreenshotConversation | null;
  usage: TokenUsage;
  model: string;
}

/** One vision call with a single forced tool. */
export async function readScreenshot(
  llm: LLMProvider,
  image: ImagePart,
  ctx: ScreenshotReadContext,
): Promise<ScreenshotReadResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: screenshotReadPrompt(ctx) },
    {
      role: 'user',
      content: [{ type: 'text', text: 'Transcribe this screenshot.' }, image],
    },
  ];
  const result = await llm.chat(messages, [READ_CONVERSATION_TOOL], {
    maxOutputTokens: 800,
    temperature: 0,
  });
  const call = result.toolCalls.find((c) => c.name === READ_CONVERSATION_TOOL.name);
  return {
    conversation: normalizeConversation(
      call ? call.arguments : extractJson(result.text),
      ctx.today,
    ),
    usage: result.usage,
    model: result.model,
  };
}

/** `captured_requests.channel` for a screenshot from this app. */
export function screenshotChannel(platform: ScreenshotPlatform): string {
  return platform === 'other' ? 'screenshot' : platform;
}

/**
 * Local development only (CHAIRSIDE_AI_DEMO): a fixed Instagram DM instead of reading the image,
 * so the screenshot flow can be clicked through without an AI key.
 */
export const DEMO_SCREENSHOT_CONVERSATION: ScreenshotConversation = {
  platform: 'instagram',
  sender: 'Karina Lopez',
  senderPhone: null,
  text: 'Hey! can I get color + trim fri afternoon?',
  sentOn: null,
  sentTime: null,
};
