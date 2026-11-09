import { z } from 'zod';

import type { ChatMessage, LLMProvider, TokenUsage } from '../types.ts';
import { formatTime } from './tools.ts';

/**
 * "Running late" texts (issue #37). The schedule math is done by `planRunningLate` in
 * `@chairside/core`; the model only words a short, personal text per affected client. Any
 * appointment the model skips or garbles falls back to a template, so a draft always exists.
 */

/** Marks the drafting system prompt (the demo provider keys off it). */
export const RUNNING_LATE_PROMPT_TAG = '[running-late-texts]';

export interface RunningLateDraftItem {
  appointmentId: string;
  clientName: string | null;
  /** ISO instants. */
  oldStart: string;
  newStart: string;
}

export interface RunningLateDraftInput {
  salonName: string;
  timeZone: string;
  delayMinutes: number;
  items: readonly RunningLateDraftItem[];
}

/** A text for one client, ready for the reply editor / one-tap send (#7) to pick up. */
export interface ClientTextDraft {
  appointmentId: string;
  clientName: string | null;
  text: string;
  source: 'ai' | 'template';
}

export const MAX_RUNNING_LATE_TEXT = 320;

const firstName = (name: string | null) => name?.trim().split(/\s+/)[0] || null;

/** The deterministic fallback: "Hi Maya, I'm running about 15 minutes behind…". */
export function templateRunningLateText(
  item: RunningLateDraftItem,
  ctx: Pick<RunningLateDraftInput, 'timeZone' | 'delayMinutes'>,
): string {
  const name = firstName(item.clientName);
  const oldTime = formatTime(item.oldStart, ctx.timeZone);
  const newTime = formatTime(item.newStart, ctx.timeZone);
  const shift = Math.round((Date.parse(item.newStart) - Date.parse(item.oldStart)) / 60_000);
  const greeting = name ? `Hi ${name}, ` : 'Hi, ';
  if (shift <= 0) {
    return `${greeting}I'm running about ${ctx.delayMinutes} minutes behind today, but your ${oldTime} appointment should still start on time. See you soon!`;
  }
  return `${greeting}I'm running about ${shift} minutes behind today. Could we start your ${oldTime} appointment at ${newTime} instead? Sorry for the wait, see you soon!`;
}

export function runningLateMessages(input: RunningLateDraftInput): ChatMessage[] {
  const system = [
    RUNNING_LATE_PROMPT_TAG,
    `You write short text messages from a hairstylist at ${input.salonName} to clients whose appointment today is moving because the stylist is running late.`,
    'Write one message per appointment in the input. Each message: warm, casual, first person, at most 2 sentences and 300 characters, greet the client by first name if known, say the new start time exactly as given, and apologise briefly.',
    'Do not invent details (no discounts, reasons, or other times). No emojis or hashtags. No sign-off with a name.',
    'Reply with only JSON: {"drafts":[{"appointmentId":"…","text":"…"}]}.',
  ].join('\n');
  const user = JSON.stringify({
    runningLateMinutes: input.delayMinutes,
    appointments: input.items.map((item) => ({
      appointmentId: item.appointmentId,
      clientFirstName: firstName(item.clientName),
      originalStart: formatTime(item.oldStart, input.timeZone),
      newStart: formatTime(item.newStart, input.timeZone),
    })),
  });
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

const responseSchema = z.object({
  drafts: z.array(
    z.object({
      appointmentId: z.string(),
      text: z.string().trim().min(1).max(MAX_RUNNING_LATE_TEXT),
    }),
  ),
});

/** Model text → `appointmentId → text`, tolerating code fences and prose around the JSON. */
export function parseRunningLateDrafts(text: string): Map<string, string> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return new Map();
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    return new Map();
  }
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) return new Map();
  return new Map(parsed.data.drafts.map((d) => [d.appointmentId, d.text]));
}

export function templateRunningLateDrafts(input: RunningLateDraftInput): ClientTextDraft[] {
  return input.items.map((item) => ({
    appointmentId: item.appointmentId,
    clientName: item.clientName,
    text: templateRunningLateText(item, input),
    source: 'template',
  }));
}

/** Asks the model for drafts (no tools), filling any gaps from the template. */
export async function draftRunningLateTexts(
  llm: LLMProvider,
  input: RunningLateDraftInput,
  onUsage?: (usage: TokenUsage, model: string) => Promise<void> | void,
): Promise<ClientTextDraft[]> {
  if (input.items.length === 0) return [];
  const result = await llm.chat(runningLateMessages(input), undefined, {
    maxOutputTokens: 200 + 120 * input.items.length,
    temperature: 0.7,
  });
  await onUsage?.(result.usage, result.model);
  const texts = parseRunningLateDrafts(result.text ?? '');
  return input.items.map((item) => {
    const text = texts.get(item.appointmentId);
    return text
      ? { appointmentId: item.appointmentId, clientName: item.clientName, text, source: 'ai' }
      : {
          appointmentId: item.appointmentId,
          clientName: item.clientName,
          text: templateRunningLateText(item, input),
          source: 'template',
        };
  });
}
