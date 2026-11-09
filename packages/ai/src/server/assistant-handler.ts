import { MAX_RUNNING_LATE_MINUTES } from '@chairside/core';
import { z } from 'zod';

import { AiProviderError } from '../http.ts';
import { createProvider as defaultCreateProvider } from '../registry.ts';
import type { ChatMessage, LLMProvider } from '../types.ts';
import { runAssistantTurn } from '../assistant/loop.ts';
import {
  draftReply,
  type ReplyDraft,
  type ReplyDraftInput,
  templateReply,
} from '../assistant/reply.ts';
import {
  type ClientTextDraft,
  draftRunningLateTexts,
  type RunningLateDraftInput,
  type RunningLateDraftItem,
  templateRunningLateDrafts,
} from '../assistant/running-late.ts';
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
  /**
   * Draft texts for a "running late" cascade planned by `planRunningLate` (before it's applied).
   * Names and current times are read from the database; only the new start comes from the app.
   */
  z.object({
    action: z.literal('draft_running_late'),
    salonId: z.uuid(),
    delayMinutes: z.number().int().min(1).max(MAX_RUNNING_LATE_MINUTES),
    moves: z
      .array(z.object({ appointmentId: z.uuid(), newStart: z.iso.datetime({ offset: true }) }))
      .min(1)
      .max(50),
  }),
  /**
   * Draft a reply to a client (#7): about an inbox request, an appointment, or neither ("other").
   * Who, when and what are read from the database; the model only words the text.
   */
  z.object({
    action: z.literal('draft_reply'),
    salonId: z.uuid(),
    kind: z.enum(['confirm', 'offer', 'decline', 'cancelled', 'other']),
    requestId: z.uuid().optional(),
    appointmentId: z.uuid().optional(),
    clientId: z.uuid().optional(),
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
export type AssistantRunningLateResponse = {
  drafts: ClientTextDraft[];
  /** Why the texts are templates rather than AI-written, if they are. */
  notice: string | null;
  usage: AssistantUsage;
};

export type AssistantReplyResponse = {
  draft: ReplyDraft;
  /** The client's number (client record, else the sender's), or null if unknown. */
  to: string | null;
  clientId: string | null;
  appointmentId: string | null;
  notice: string | null;
  usage: AssistantUsage;
};

export type AssistantServiceResult =
  | {
      status: 200;
      body:
        | AssistantStatusResponse
        | AssistantMessageResponse
        | AssistantCardResponse
        | AssistantClientResponse
        | AssistantRunningLateResponse
        | AssistantReplyResponse;
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
      case 'draft_running_late':
        return await draftRunningLate(request, deps, ctx);
      case 'draft_reply':
        return await draftClientReply(request, deps, ctx);
    }
  } catch (error) {
    if (error instanceof ToolError) return fail(409, error.code, error.message);
    const message = error instanceof Error ? error.message : String(error);
    return fail(500, 'assistant_error', message);
  }
}

type ResolvedProvider = {
  llm: LLMProvider;
  usage: AssistantUsage;
  apiKey: string;
  meter?: (u: { inputTokens: number; outputTokens: number }, model: string) => Promise<void>;
};

/** The demo provider, or the salon's own key with budget check and usage metering. */
async function resolveProvider(
  salonId: string,
  deps: AssistantServiceDeps,
  purpose: string,
): Promise<ResolvedProvider | AssistantServiceResult> {
  if (deps.demoProvider) return { llm: deps.demoProvider(), usage: null, apiKey: '' };
  const config = await deps.loadConfig(salonId);
  if (!config) {
    return fail(
      409,
      'not_configured',
      'Ask Chairside needs an AI provider. Add a key in Settings → AI assistant.',
    );
  }
  const used = await deps.tokensUsedThisMonth(salonId);
  if (used >= config.monthlyTokenBudget) {
    return fail(429, 'budget_exceeded', 'This salon has used its monthly AI token budget');
  }
  const usage = { usedThisMonth: used, monthlyTokenBudget: config.monthlyTokenBudget };
  return {
    llm: (deps.createProvider ?? defaultCreateProvider)(config.provider, {
      apiKey: config.apiKey,
      model: config.model,
    }),
    usage,
    apiKey: config.apiKey,
    meter: async (u, model) => {
      usage.usedThisMonth += u.inputTokens + u.outputTokens;
      await deps.recordUsage({
        salonId,
        provider: config.provider,
        model,
        purpose,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
      });
    },
  };
}

async function message(
  request: Extract<AssistantRequest, { action: 'message' }>,
  deps: AssistantServiceDeps,
  ctx: ToolContext,
): Promise<AssistantServiceResult> {
  const resolved = await resolveProvider(request.salonId, deps, 'assistant');
  if ('status' in resolved) return resolved;
  const { llm, usage, apiKey, meter } = resolved;

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

/**
 * Drafts a text per moved client. Times and names come from the database, not the request; the
 * model only words the message. Without a usable provider (no key, budget spent, provider down)
 * the template texts are returned instead, so the owner is never blocked.
 */
async function draftRunningLate(
  request: Extract<AssistantRequest, { action: 'draft_running_late' }>,
  deps: AssistantServiceDeps,
  ctx: ToolContext,
): Promise<AssistantServiceResult> {
  const today = new Date(ctx.now()).toISOString().slice(0, 10);
  const schedule = await ctx.port.getSchedule({ from: today, to: today });
  const items: RunningLateDraftItem[] = [];
  for (const move of request.moves) {
    const appt = await ctx.port.getAppointment(move.appointmentId);
    if (!appt || appt.salon_id !== request.salonId) {
      throw new ToolError('not_found', 'One of those appointments no longer exists');
    }
    items.push({
      appointmentId: appt.id,
      clientName: appt.client?.name ?? null,
      oldStart: appt.starts_at,
      newStart: new Date(move.newStart).toISOString(),
    });
  }
  const input: RunningLateDraftInput = {
    salonName: schedule.salonName,
    timeZone: schedule.hours.timeZone,
    delayMinutes: request.delayMinutes,
    items,
  };

  let drafts: ClientTextDraft[];
  let notice: string | null = null;
  let usage: AssistantUsage = null;
  const resolved = await resolveProvider(request.salonId, deps, 'running_late');
  if ('status' in resolved) {
    drafts = templateRunningLateDrafts(input);
    notice =
      resolved.status === 429
        ? 'Monthly AI budget used up, so these are standard texts.'
        : 'Add an AI provider in Settings → AI assistant for personal texts.';
  } else {
    usage = resolved.usage;
    try {
      drafts = await draftRunningLateTexts(resolved.llm, input, resolved.meter);
    } catch (error) {
      if (!(error instanceof AiProviderError)) throw error;
      drafts = templateRunningLateDrafts(input);
      notice = 'The AI provider didn’t respond, so these are standard texts.';
    }
  }
  await ctx.port.audit('assistant.running_late_drafts', {
    delayMinutes: request.delayMinutes,
    appointmentIds: items.map((i) => i.appointmentId),
    sources: drafts.map((d) => d.source),
  });
  return { status: 200, body: { drafts, notice, usage } };
}

const PHONE_LIKE = /^[+\d\s().\-]+$/;

/**
 * Drafts one reply. Without a usable provider (no key, budget spent, provider down) the template
 * is returned with a notice, so the stylist can always send something.
 */
async function draftClientReply(
  request: Extract<AssistantRequest, { action: 'draft_reply' }>,
  deps: AssistantServiceDeps,
  ctx: ToolContext,
): Promise<AssistantServiceResult> {
  const replyCtx = await ctx.port.getReplyContext(request.requestId ?? null);
  const req = replyCtx.request;
  if (request.requestId && !req) throw new ToolError('not_found', 'That request no longer exists');

  const appointmentId =
    request.appointmentId ??
    (req
      ? req.intent === 'cancel' || request.kind === 'cancelled'
        ? (req.targetAppointmentId ?? req.appointmentId)
        : (req.appointmentId ?? req.targetAppointmentId)
      : null);
  const appt = appointmentId ? await ctx.port.getAppointment(appointmentId) : null;
  if (appointmentId && (!appt || appt.salon_id !== request.salonId)) {
    throw new ToolError('not_found', 'That appointment no longer exists');
  }
  const clientId = appt?.client_id ?? req?.clientId ?? request.clientId ?? null;
  const client = appt?.client ?? (clientId ? await ctx.port.getClient(clientId) : null);
  const sender = req?.sender && !PHONE_LIKE.test(req.sender) ? req.sender : null;

  const today = new Date(ctx.now()).toISOString().slice(0, 10);
  const schedule = await ctx.port.getSchedule({ from: today, to: today });
  const input: ReplyDraftInput = {
    kind: request.kind,
    salonName: schedule.salonName,
    timeZone: schedule.hours.timeZone,
    clientName: client?.name ?? sender,
    start: appt?.starts_at ? new Date(appt.starts_at).toISOString() : null,
    services: (appt?.services ?? []).map((s) => s.name),
    clientMessage: req?.message ?? null,
    toneExamples: replyCtx.toneExamples,
    bookingLink: replyCtx.includeBookingLink ? replyCtx.bookingLink : null,
    confirmKeyword: replyCtx.bridgeKeyword,
    teachKeyword: req ? replyCtx.bridgeKeyword : null,
  };

  let draft: ReplyDraft;
  let notice: string | null = null;
  let usage: AssistantUsage = null;
  const resolved = await resolveProvider(request.salonId, deps, 'reply');
  if ('status' in resolved) {
    draft = templateReply(input);
    notice =
      resolved.status === 429
        ? 'Monthly AI budget used up, so this is a standard reply.'
        : 'Add an AI provider in Settings → AI assistant for personal replies.';
  } else {
    usage = resolved.usage;
    try {
      draft = await draftReply(resolved.llm, input, resolved.meter);
    } catch (error) {
      if (!(error instanceof AiProviderError)) throw error;
      draft = templateReply(input);
      notice = 'The AI provider didn’t respond, so this is a standard reply.';
    }
  }
  await ctx.port.audit('assistant.reply_draft', {
    kind: request.kind,
    requestId: req?.id ?? null,
    appointmentId: appt?.id ?? null,
    source: draft.source,
  });
  return {
    status: 200,
    body: {
      draft,
      to: client?.phone ?? req?.senderPhone ?? null,
      clientId,
      appointmentId: appt?.id ?? null,
      notice,
      usage,
    },
  };
}
