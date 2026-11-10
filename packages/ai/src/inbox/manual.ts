/**
 * Manual capture (Bridge E, #2): the stylist pastes a client's message, shares it from another app
 * (iOS Share Extension), or shares a screenshot of the thread. Called from the app with the
 * stylist's JWT through the same `inbox` Edge Function, it feeds the same pipeline as the Shortcut
 * bridge: parse, match the client, let the engine hold a slot, capture for approval.
 *
 * A screenshot is first transcribed by the salon's vision model into `{ sender, text }`, so a
 * screenshot of an Instagram DM and the same message forwarded as a text produce the same request.
 */
import { toSalonDate, parseLocalDate, zonedToUtc } from '@chairside/core';
import { z } from 'zod';

import { formatDayLabel } from '../assistant/tools.ts';
import { AiProviderError } from '../http.ts';
import { createProvider as defaultCreateProvider } from '../registry.ts';
import { type AiErrorBody, type AiServiceDeps, providerFailure } from '../server/handler.ts';
import type { ImagePart } from '../types.ts';
import {
  type CaptureDeps,
  captureInboxMessage,
  type InboxOutcome,
  type InboxPort,
  type InboxRequest,
} from './handler.ts';
import {
  DEMO_SCREENSHOT_CONVERSATION,
  readScreenshot,
  type ScreenshotConversation,
  screenshotChannel,
} from './screenshot.ts';

/** Same cap as the menu-screenshot import. */
export const MAX_CAPTURE_IMAGE_BASE64_CHARS = 8 * 1024 * 1024;
export const CAPTURE_SOURCES = ['paste', 'share', 'screenshot'] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

export const manualCaptureSchema = z
  .object({
    action: z.literal('capture'),
    salonId: z.uuid(),
    source: z.enum(CAPTURE_SOURCES),
    text: z.string().trim().max(4000).optional(),
    /** Who sent it (name or phone), when the stylist knows. Overrides what a screenshot shows. */
    sender: z.string().trim().max(200).optional(),
    senderPhone: z.string().trim().max(60).nullish(),
    image: z
      .object({
        mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
        data: z.string().min(1).max(MAX_CAPTURE_IMAGE_BASE64_CHARS),
      })
      .optional(),
  })
  .refine((b) => Boolean(b.text) || Boolean(b.image), {
    message: 'Send the message text or a screenshot',
  });
export type ManualCaptureRequest = z.infer<typeof manualCaptureSchema>;

export interface ManualCaptureDeps extends CaptureDeps, Pick<AiServiceDeps, 'getMemberRole'> {
  createPort(salonId: string): InboxPort;
  createProvider?: typeof defaultCreateProvider;
}

/** What the app shows after a capture; `read` is what the screenshot was transcribed as. */
export type ManualCaptureResponse = InboxOutcome & {
  source: CaptureSource;
  read?: ScreenshotConversation & { parser: 'llm' | 'demo' };
};

export type ManualCaptureResult =
  | { status: 200; body: ManualCaptureResponse }
  | { status: 400 | 401 | 403 | 409 | 422 | 429 | 500 | 502; body: AiErrorBody };

const fail = (
  status: Exclude<ManualCaptureResult['status'], 200>,
  code: string,
  message: string,
): ManualCaptureResult => ({ status, body: { error: { code, message } } });

/** True for a body meant for manual capture (vs. the Shortcut's forwarded text). */
export function isManualCapture(rawBody: unknown): boolean {
  return (
    !!rawBody &&
    typeof rawBody === 'object' &&
    (rawBody as { action?: unknown }).action === 'capture'
  );
}

const clockMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export async function handleManualCapture(
  rawBody: unknown,
  deps: ManualCaptureDeps,
): Promise<ManualCaptureResult> {
  const body = manualCaptureSchema.safeParse(rawBody);
  if (!body.success) return fail(400, 'invalid_request', z.prettifyError(body.error));
  const request = body.data;

  const role = await deps.getMemberRole(request.salonId);
  if (!role) return fail(403, 'forbidden', 'You are not a member of this salon');

  const port = deps.createPort(request.salonId);
  const now = deps.now ?? (() => Date.now());

  let forwarded: InboxRequest = {
    sender: request.sender ?? '',
    senderPhone: request.senderPhone ?? null,
    text: request.text ?? '',
    receivedAt: null,
    bridgeVersion: null,
    channel: request.source,
  };
  let read: ManualCaptureResponse['read'];

  if (request.image) {
    const today = toSalonDate(now(), 'UTC');
    let schedule: Awaited<ReturnType<InboxPort['getSchedule']>>;
    try {
      schedule = await port.getSchedule({ from: today, to: today });
    } catch (error) {
      return fail(500, 'inbox_error', error instanceof Error ? error.message : String(error));
    }
    const timeZone = schedule.hours.timeZone;
    const localToday = toSalonDate(now(), timeZone);
    const outcome = await transcribe(
      { type: 'image', mimeType: request.image.mimeType, data: request.image.data },
      {
        today: localToday,
        todayLabel: formatDayLabel(localToday),
        timeZone,
        salonName: schedule.salonName,
      },
      request.salonId,
      deps,
    );
    if ('status' in outcome) return outcome;
    const { conversation, parser } = outcome;
    read = { ...conversation, parser };
    forwarded = {
      sender: request.sender || conversation.sender || '',
      senderPhone: request.senderPhone ?? conversation.senderPhone,
      // Text typed alongside the screenshot adds to what it shows.
      text: [conversation.text, request.text].filter(Boolean).join('\n').slice(0, 4000),
      receivedAt:
        conversation.sentOn && conversation.sentTime
          ? new Date(
              zonedToUtc(
                parseLocalDate(conversation.sentOn),
                clockMinutes(conversation.sentTime),
                timeZone,
              ),
            ).toISOString()
          : null,
      bridgeVersion: null,
      channel: screenshotChannel(conversation.platform),
    };
  }

  const result = await captureInboxMessage(
    // No bridge involved: no custom keyword to strip and never an auto-reply.
    { salonId: request.salonId, keyword: '', rateLimited: false, autoReply: false },
    forwarded,
    port,
    deps,
    { manual: true, sentOn: read?.sentOn ?? null },
  );
  if (result.status !== 200) return result;
  return {
    status: 200,
    body: { ...result.body, source: request.source, ...(read ? { read } : {}) },
  };
}

async function transcribe(
  image: ImagePart,
  ctx: Parameters<typeof readScreenshot>[2],
  salonId: string,
  deps: ManualCaptureDeps,
): Promise<{ conversation: ScreenshotConversation; parser: 'llm' | 'demo' } | ManualCaptureResult> {
  if (deps.demo) return { conversation: DEMO_SCREENSHOT_CONVERSATION, parser: 'demo' };

  const config = await deps.loadConfig(salonId);
  if (!config) {
    return fail(
      409,
      'not_configured',
      'Reading a screenshot needs AI. Add a key in Settings → AI, or paste the message as text.',
    );
  }
  if ((await deps.tokensUsedThisMonth(salonId)) >= config.monthlyTokenBudget) {
    return fail(429, 'budget_exceeded', 'This salon has used its monthly AI token budget');
  }
  try {
    const llm = (deps.createProvider ?? defaultCreateProvider)(config.provider, {
      apiKey: config.apiKey,
      model: config.model,
    });
    const out = await readScreenshot(llm, image, ctx);
    await deps.recordUsage({
      salonId,
      provider: config.provider,
      model: out.model,
      purpose: 'inbox_screenshot',
      inputTokens: out.usage.inputTokens,
      outputTokens: out.usage.outputTokens,
    });
    if (!out.conversation) {
      return fail(
        422,
        'no_message_found',
        'Couldn’t find a client’s message in that screenshot. Crop it to the conversation, or paste the text.',
      );
    }
    return { conversation: out.conversation, parser: 'llm' };
  } catch (error) {
    if (error instanceof AiProviderError) {
      return { status: 502, body: providerFailure(error, config.apiKey).body as AiErrorBody };
    }
    throw error;
  }
}
