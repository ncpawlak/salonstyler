import { z } from 'zod';

import type { ChatMessage, LLMProvider, TokenUsage } from '../types.ts';
import { NUDGE_SUBJECT } from './nudges.ts';

/**
 * Suggested copy for marketing emails (#27). The model only words the message; it never picks
 * recipients or sends anything, and the stylist edits and approves the result. Without AI (or if
 * the model's reply is unusable) a template is returned, so a draft always exists.
 */

/** Marks the drafting system prompt. */
export const MARKETING_COPY_PROMPT_TAG = '[marketing-copy]';

export type MarketingCopyKind = 'campaign' | 'rebook_nudge' | 'review_request';

export interface MarketingCopyInput {
  kind: MarketingCopyKind;
  salonName: string;
  /** What the stylist wants to say ("closed Dec 24-26, open late Dec 23"). */
  brief?: string | null;
}

export interface MarketingCopy {
  subject: string;
  body: string;
  source: 'ai' | 'template';
}

export const MAX_COPY_SUBJECT = 150;
export const MAX_COPY_BODY = 2000;

export function templateMarketingCopy(input: MarketingCopyInput): MarketingCopy {
  const brief = input.brief?.trim();
  switch (input.kind) {
    case 'rebook_nudge':
      return {
        subject: NUDGE_SUBJECT,
        body: [
          'Hi {firstName},',
          '',
          "It's been a little while since your last visit, so you're probably due for a refresh.",
          '',
          'Grab a time that works for you: {bookingLink}',
          '',
          'See you soon!',
          '{salonName}',
        ].join('\n'),
        source: 'template',
      };
    case 'review_request':
      return {
        subject: 'Thanks for visiting {salonName}!',
        body: [
          'Hi {firstName},',
          '',
          'Thanks for coming in! If you have a minute, a quick review would mean a lot to us:',
          '{reviewLink}',
          '',
          'See you next time!',
        ].join('\n'),
        source: 'template',
      };
    case 'campaign':
      return {
        subject: `News from {salonName}`,
        body: [
          'Hi {firstName},',
          '',
          brief || 'We have some news to share with you.',
          '',
          'Book your next visit: {bookingLink}',
          '',
          'See you soon!',
          '{salonName}',
        ].join('\n'),
        source: 'template',
      };
  }
}

const PURPOSE: Record<MarketingCopyKind, string> = {
  campaign: 'a short marketing email to all of the salon’s opted-in clients',
  rebook_nudge:
    'a short "time for a touch-up?" email to a client who is due back for their regular appointment',
  review_request:
    'a short thank-you email sent a few hours after a visit, asking the client for an online review',
};

export function marketingCopyMessages(input: MarketingCopyInput): ChatMessage[] {
  const system = [
    MARKETING_COPY_PROMPT_TAG,
    `You write email copy for ${input.salonName}, an independent hair salon. Write ${PURPOSE[input.kind]}.`,
    'Warm, personal, first person plural ("we"), plain text, at most 4 short paragraphs and 120 words. Subject at most 60 characters.',
    'Use these placeholders exactly where they fit; they are filled in per client: {firstName} (greeting), {salonName}, ' +
      (input.kind === 'review_request'
        ? '{reviewLink} (on its own line, the review page).'
        : '{bookingLink} (on its own line, the online booking page).'),
    'Only use facts from the brief. Do not invent discounts, prices, dates or opening hours. No emojis, hashtags or unsubscribe text (it is added automatically).',
    'Reply with only JSON: {"subject":"…","body":"…"}.',
  ].join('\n');
  const user = JSON.stringify({ brief: input.brief?.trim() || null });
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

const responseSchema = z.object({
  subject: z.string().trim().min(1).max(MAX_COPY_SUBJECT),
  body: z.string().trim().min(1).max(MAX_COPY_BODY),
});

/** Model text → copy, tolerating code fences and prose around the JSON. */
export function parseMarketingCopy(text: string): { subject: string; body: string } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = responseSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Asks the model for copy (no tools), falling back to the template. */
export async function draftMarketingCopy(
  llm: LLMProvider,
  input: MarketingCopyInput,
  onUsage?: (usage: TokenUsage, model: string) => Promise<void> | void,
): Promise<MarketingCopy> {
  const result = await llm.chat(marketingCopyMessages(input), undefined, {
    maxOutputTokens: 600,
    temperature: 0.7,
  });
  await onUsage?.(result.usage, result.model);
  const copy = parseMarketingCopy(result.text ?? '');
  return copy ? { ...copy, source: 'ai' } : templateMarketingCopy(input);
}
