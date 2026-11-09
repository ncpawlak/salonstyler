import { toSalonDate } from '@chairside/core';
import { z } from 'zod';

import type { ChatMessage, LLMProvider, TokenUsage } from '../types.ts';
import { teachingLine } from '../inbox/shortcut.ts';
import { formatDayLabel, formatTime } from './tools.ts';

/**
 * Replies to clients (issue #7). The model only words the text; when, what and to whom come from
 * the database. Links and the "reply yes" instruction are appended in code so the model can't
 * garble them, and anything unusable falls back to a template, so a draft always exists.
 */

/** Marks the drafting system prompt (the demo provider keys off it). */
export const REPLY_PROMPT_TAG = '[client-reply]';

/** What the reply says. `running_late` texts are drafted by running-late.ts. */
export type ReplyKind = 'confirm' | 'offer' | 'decline' | 'cancelled' | 'other';

export const MAX_REPLY_TEXT = 480;

export interface ReplyDraftInput {
  kind: ReplyKind;
  salonName: string;
  timeZone: string;
  clientName: string | null;
  /** ISO start of the appointment the reply is about, if any. */
  start: string | null;
  services: readonly string[];
  /** What the client wrote, for context only. */
  clientMessage?: string | null;
  /** Sample texts in the stylist's voice (settings.reply_tone_examples). */
  toneExamples?: string | null;
  /** Appended when set (the caller checks settings.reply_include_booking_link). */
  bookingLink?: string | null;
  /**
   * Offers only: the bridge keyword. The Shortcut only forwards texts containing it, so the
   * client is asked to reply "<keyword> yes".
   */
  confirmKeyword?: string | null;
  /**
   * Confirmations to a texted request: the bridge keyword, so the text ends with the line that
   * teaches it (`teachingLine`, #6).
   */
  teachKeyword?: string | null;
}

export interface ReplyDraft {
  text: string;
  source: 'ai' | 'template';
}

const firstName = (name: string | null) => {
  const first = name?.trim().split(/\s+/)[0];
  // Placeholder names for unknown senders ("Text from (555) …") aren't names.
  return first && !/^text$/i.test(first) && /\p{L}/u.test(first) ? first : null;
};

/** "Fri, Dec 18 at 1:30 PM" in the salon's time zone. */
export function formatReplyWhen(startIso: string, timeZone: string): string {
  return `${formatDayLabel(toSalonDate(startIso, timeZone))} at ${formatTime(startIso, timeZone)}`;
}

const listServices = (services: readonly string[]) => {
  const names = services.filter(Boolean);
  if (names.length <= 1) return names[0] ?? null;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};

/** The deterministic text, before the link / "reply yes" footer. */
function templateBody(input: ReplyDraftInput): string {
  const name = firstName(input.clientName);
  const hi = name ? `Hi ${name}!` : 'Hi!';
  const when = input.start ? formatReplyWhen(input.start, input.timeZone) : null;
  const what = listServices(input.services);
  switch (input.kind) {
    case 'confirm':
      return when
        ? `${hi} You're booked${what ? ` for ${what}` : ''} on ${when}. See you then!`
        : `${hi} You're all set. See you soon!`;
    case 'offer':
      return when
        ? `${hi} I have ${when} open${what ? ` for ${what}` : ''}. Does that work for you?`
        : `${hi} Let me know what day works best for you.`;
    case 'decline':
      return `${hi} So sorry, I can't fit you in at that time.`;
    case 'cancelled':
      return when
        ? `${hi} No problem, your ${when} appointment is cancelled.`
        : `${hi} No problem, your appointment is cancelled.`;
    case 'other':
      return `${hi} `;
  }
}

/**
 * Adds what must always be there: the "reply <keyword> yes" instruction for offers, the keyword
 * teaching line for texted confirmations, and the booking link, each only if the text doesn't
 * already contain it.
 */
export function finishReply(text: string, input: ReplyDraftInput): string {
  let out = text.trim();
  const keyword = input.confirmKeyword?.trim();
  if (input.kind === 'offer' && input.start && keyword) {
    const yes = `${keyword} yes`;
    if (!out.toLowerCase().includes(yes.toLowerCase())) out += ` Reply "${yes}" to confirm.`;
  }
  const teach = input.teachKeyword?.trim();
  if (input.kind === 'confirm' && teach && !out.toLowerCase().includes(teach.toLowerCase())) {
    out += ` ${teachingLine(teach)}`;
  }
  const link = input.bookingLink?.trim();
  if (link && !out.includes(link)) {
    const lead =
      input.kind === 'decline' || input.kind === 'cancelled'
        ? 'Book another time here:'
        : 'Book anytime:';
    out += `\n${lead} ${link}`;
  }
  return out.slice(0, 1000);
}

export function templateReply(input: ReplyDraftInput): ReplyDraft {
  const body = templateBody(input);
  return { text: input.kind === 'other' ? body : finishReply(body, input), source: 'template' };
}

const KIND_BRIEF: Record<ReplyKind, string> = {
  confirm: 'Confirm the booking: the appointment below is booked.',
  offer:
    'Offer the time below and ask if it works. It is not booked until they say yes, so do not say it is booked.',
  decline: 'Politely say you cannot fit them in at the time they asked. Do not offer other times.',
  cancelled: 'Confirm that the appointment below is cancelled, kindly.',
  other: 'Reply to their message briefly and kindly.',
};

export function replyMessages(input: ReplyDraftInput): ChatMessage[] {
  const system = [
    REPLY_PROMPT_TAG,
    `You write a short text message from a hairstylist at ${input.salonName} to a client.`,
    KIND_BRIEF[input.kind],
    'Warm, casual, first person, at most 3 short sentences and 300 characters. Greet the client by first name if known. Use the date, time and services exactly as given.',
    'Do not invent details (no prices, discounts, reasons, policies, or other times). No links, hashtags, or sign-off with a name; links are added separately.',
    input.toneExamples?.trim()
      ? `Match the voice of these example texts by the stylist (style only; never copy facts from them):\n"""\n${input.toneExamples.trim().slice(0, 1500)}\n"""`
      : 'Keep it friendly and professional; no emojis.',
    'Reply with only JSON: {"text":"…"}.',
  ].join('\n');
  const user = JSON.stringify({
    kind: input.kind,
    clientFirstName: firstName(input.clientName),
    when: input.start ? formatReplyWhen(input.start, input.timeZone) : null,
    services: input.services,
    clientMessage: input.clientMessage?.slice(0, 500) ?? null,
  });
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

const responseSchema = z.object({ text: z.string().trim().min(1).max(MAX_REPLY_TEXT) });

/** Model text → reply text, tolerating code fences and prose around the JSON. */
export function parseReplyDraft(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = responseSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data.text : null;
  } catch {
    return null;
  }
}

/** Asks the model for the reply (no tools), falling back to the template. */
export async function draftReply(
  llm: LLMProvider,
  input: ReplyDraftInput,
  onUsage?: (usage: TokenUsage, model: string) => Promise<void> | void,
): Promise<ReplyDraft> {
  const result = await llm.chat(replyMessages(input), undefined, {
    maxOutputTokens: 250,
    temperature: 0.7,
  });
  await onUsage?.(result.usage, result.model);
  const text = parseReplyDraft(result.text ?? '');
  return text ? { text: finishReply(text, input), source: 'ai' } : templateReply(input);
}
