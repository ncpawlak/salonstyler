import { z } from 'zod';

import { AiProviderError } from '../http.ts';
import { createProvider as defaultCreateProvider } from '../registry.ts';
import type { ChatMessage, LLMProvider } from '../types.ts';
import { runAssistantTurn } from '../assistant/loop.ts';
import {
  cancelDraft,
  confirmDraft,
  proposeBooking,
  ToolError,
  type ToolContext,
} from '../assistant/tools.ts';
import type {
  AssistantCard,
  AssistantClient,
  AssistantPort,
  DraftCard,
} from '../assistant/types.ts';
import {
  type AiErrorBody,
  type AiServiceDeps,
  chatMessageSchema,
  providerFailure,
} from './handler.ts';

/** Messages of earlier turns the app may resend; older ones are dropped. */
export const MAX_HISTORY_MESSAGES = 60;

const itemSchema = z.object({
  serviceId: z.string().min(1),
  variantId: z.string().min(1).nullish(),
});

export const assistantRequestSchema = z.discriminatedUnion('action', [
  /** Is the assistant usable for this salon? (No key needed to ask.) */
  z.object({ action: z.literal('status'), salonId: z.uuid() }),
  z.object({
    action: z.literal('message'),
    salonId: z.uuid(),
    /** The conversation so far, exactly as returned in earlier `messages`. */
    history: z.array(chatMessageSchema).max(400).default([]),
    text: z.string().trim().min(1).max(2000),
  }),
  /** The owner tapped a slot card. */
  z.object({
    action: z.literal('propose'),
    salonId: z.uuid(),
    clientId: z.uuid(),
    start: z.iso.datetime({ offset: true }),
    services: z.array(itemSchema).min(1).max(5).optional(),
  }),
  /** The owner tapped Confirm / Change on a draft. Confirm is never available to the model. */
  z.object({ action: z.literal('confirm'), salonId: z.uuid(), appointmentId: z.uuid() }),
  z.object({ action: z.literal('discard'), salonId: z.uuid(), appointmentId: z.uuid() }),
  /** Quick-create a client the assistant didn't find. */
  z.object({
    action: z.literal('create_client'),
    salonId: z.uuid(),
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().max(40).nullish(),
  }),
]);
export type AssistantRequest = z.infer<typeof assistantRequestSchema>;

export interface AssistantServiceDeps extends Omit<AiServiceDeps, 'createProvider'> {
  /** Data access for the salon, scoped to the caller (RLS via their JWT). */
  createPort(salonId: string): AssistantPort;
  createProvider?: typeof defaultCreateProvider;
  /**
   * Local development only: a scripted provider used instead of the salon's saved key. Usage is
   * not metered. Never set in production.
   */
  demoProvider?: () => LLMProvider;
}

export type AssistantUsage = { usedThisMonth: number; monthlyTokenBudget: number } | null;

export type AssistantStatusResponse = { configured: boolean; demo: boolean };
export type AssistantMessageResponse = {
  reply: string;
  cards: AssistantCard[];
  /** Append to `history` for the next message. */
  messages: ChatMessage[];
  usage: AssistantUsage;
};
export type AssistantCardResponse = { card: DraftCard };
export type AssistantClientResponse = { client: AssistantClient };

export type AssistantServiceResult =
  | {
      status: 200;
      body:
        | AssistantStatusResponse
        | AssistantMessageResponse
        | AssistantCardResponse
        | AssistantClientResponse;
    }
  | { status: 400 | 401 | 403 | 409 | 429 | 500 | 502; body: AiErrorBody };

const fail = (
  status: Exclude<AssistantServiceResult['status'], 200>,
  code: string,
  message: string,
): AssistantServiceResult => ({ status, body: { error: { code, message } } });

/**
 * Drops system messages (the server writes its own) and keeps the most recent history, starting
 * at a user message so no tool result is left without the call that produced it.
 */
export function trimHistory(history: ChatMessage[], max = MAX_HISTORY_MESSAGES): ChatMessage[] {
  const kept = history.filter((m) => m.role !== 'system').slice(-max);
  const firstUser = kept.findIndex((m) => m.role === 'user');
  return firstUser < 0 ? [] : kept.slice(firstUser);
}

export async function handleAssistantRequest(
  rawBody: unknown,
  deps: AssistantServiceDeps,
): Promise<AssistantServiceResult> {
  const parsed = assistantRequestSchema.safeParse(rawBody);
  if (!parsed.success) return fail(400, 'invalid_request', z.prettifyError(parsed.error));
  const request = parsed.data;
  const now = deps.now ?? (() => Date.now());

  const role = await deps.getMemberRole(request.salonId);
  if (!role) return fail(403, 'forbidden', 'You are not a member of this salon');

  const port = deps.createPort(request.salonId);
  const ctx: ToolContext = { port, now };

  try {
    switch (request.action) {
      case 'status': {
        if (deps.demoProvider) return { status: 200, body: { configured: true, demo: true } };
        const config = await deps.loadConfig(request.salonId);
        return { status: 200, body: { configured: Boolean(config), demo: false } };
      }
      case 'propose': {
        const out = await proposeBooking(ctx, request);
        await port.audit('assistant.propose', { appointmentId: out.card.appointmentId });
        return { status: 200, body: { card: out.card } };
      }
      case 'confirm': {
        const out = await confirmDraft(ctx, request.appointmentId);
        await port.audit('assistant.confirm', { appointmentId: request.appointmentId });
        return { status: 200, body: { card: out.card } };
      }
      case 'discard': {
        const out = await cancelDraft(ctx, request.appointmentId);
        await port.audit('assistant.discard', { appointmentId: request.appointmentId });
        return { status: 200, body: { card: out.card } };
      }
      case 'create_client': {
        const client = await port.createClient({ name: request.name, phone: request.phone });
        await port.audit('assistant.create_client', { clientId: client.id });
        return { status: 200, body: { client } };
      }
      case 'message':
        return await message(request, deps, ctx);
    }
  } catch (error) {
    if (error instanceof ToolError) return fail(409, error.code, error.message);
    const message = error instanceof Error ? error.message : String(error);
    return fail(500, 'assistant_error', message);
  }
}

async function message(
  request: Extract<AssistantRequest, { action: 'message' }>,
  deps: AssistantServiceDeps,
  ctx: ToolContext,
): Promise<AssistantServiceResult> {
  let llm: LLMProvider;
  let usage: AssistantUsage = null;
  let apiKey = '';
  let meter:
    | ((u: { inputTokens: number; outputTokens: number }, model: string) => Promise<void>)
    | undefined;

  if (deps.demoProvider) {
    llm = deps.demoProvider();
  } else {
    const config = await deps.loadConfig(request.salonId);
    if (!config) {
      return fail(
        409,
        'not_configured',
        'Ask Chairside needs an AI provider. Add a key in Settings → AI assistant.',
      );
    }
    const used = await deps.tokensUsedThisMonth(request.salonId);
    if (used >= config.monthlyTokenBudget) {
      return fail(429, 'budget_exceeded', 'This salon has used its monthly AI token budget');
    }
    apiKey = config.apiKey;
    llm = (deps.createProvider ?? defaultCreateProvider)(config.provider, {
      apiKey: config.apiKey,
      model: config.model,
    });
    usage = { usedThisMonth: used, monthlyTokenBudget: config.monthlyTokenBudget };
    meter = async (u, model) => {
      usage!.usedThisMonth += u.inputTokens + u.outputTokens;
      await deps.recordUsage({
        salonId: request.salonId,
        provider: config.provider,
        model,
        purpose: 'assistant',
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
      });
    };
  }

  const today = new Date(ctx.now()).toISOString().slice(0, 10);
  const schedule = await ctx.port.getSchedule({ from: today, to: today });

  try {
    const turn = await runAssistantTurn({
      llm,
      tools: ctx,
      prompt: { salonName: schedule.salonName, timeZone: schedule.hours.timeZone },
      history: trimHistory(request.history as ChatMessage[]),
      text: request.text,
      onUsage: meter,
    });
    return {
      status: 200,
      body: { reply: turn.reply, cards: turn.cards, messages: turn.messages, usage },
    };
  } catch (error) {
    if (error instanceof AiProviderError) {
      return { status: 502, body: providerFailure(error, apiKey).body as AiErrorBody };
    }
    throw error;
  }
}
