import { type ColumnMapping, guessColumnMapping } from '@chairside/core';
import { z } from 'zod';

import { AiProviderError, redactSecrets } from '../http.ts';
import { columnMappingPrompt, columnMappingTool, readColumnMapping } from '../import/mapping.ts';
import { type AiProvider, aiProviderSchema } from '../providers.ts';
import { createProvider as defaultCreateProvider } from '../registry.ts';
import type { ChatMessage, ChatResult, ToolDefinition } from '../types.ts';

const MAX_IMAGE_BASE64_CHARS = 8 * 1024 * 1024;

const contentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image'),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    data: z.string().min(1).max(MAX_IMAGE_BASE64_CHARS),
  }),
]);

const toolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});

export const chatMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string() }),
  z.object({ role: z.literal('user'), content: z.union([z.string(), z.array(contentPartSchema)]) }),
  z.object({
    role: z.literal('assistant'),
    content: z.string().nullable().optional(),
    toolCalls: z.array(toolCallSchema).optional(),
  }),
  z.object({
    role: z.literal('tool'),
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    content: z.string(),
  }),
]);

export const toolDefinitionSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/),
  description: z.string().max(2000),
  parameters: z.record(z.string(), z.unknown()),
});

const modelSchema = z.string().trim().min(1).max(100);

export const aiRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('test'),
    salonId: z.uuid(),
    /** Omit provider/model/apiKey to test the saved configuration. */
    provider: aiProviderSchema.optional(),
    model: modelSchema.optional(),
    apiKey: z.string().trim().min(20).max(500).optional(),
  }),
  z.object({
    action: z.literal('chat'),
    salonId: z.uuid(),
    messages: z.array(chatMessageSchema).min(1).max(100),
    tools: z.array(toolDefinitionSchema).max(64).optional(),
    maxOutputTokens: z.int().min(1).max(8192).optional(),
    temperature: z.number().min(0).max(2).optional(),
    purpose: z
      .string()
      .regex(/^[a-z][a-z0-9_.-]{0,39}$/)
      .optional(),
  }),
  z.object({
    action: z.literal('map_columns'),
    salonId: z.uuid(),
    kind: z.enum(['clients', 'appointments']),
    headers: z.array(z.string().max(120)).min(1).max(100),
    /** Redacted sample values per column (see `redactedColumnSamples` in @chairside/core). */
    samples: z.array(z.array(z.string().max(60)).max(5)).max(100),
  }),
]);
export type AiRequest = z.infer<typeof aiRequestSchema>;

export interface StoredAiConfig {
  provider: AiProvider;
  model: string;
  apiKey: string;
  monthlyTokenBudget: number;
}

export interface UsageEntry {
  salonId: string;
  provider: AiProvider;
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
}

/** Everything the handler needs from the outside world (Supabase in production, fakes in tests). */
export interface AiServiceDeps {
  /** Role of the calling user in the salon, or null if not a member. */
  getMemberRole(salonId: string): Promise<'owner' | 'stylist' | null>;
  /** Server-side only: includes the decrypted key. */
  loadConfig(salonId: string): Promise<StoredAiConfig | null>;
  tokensUsedThisMonth(salonId: string): Promise<number>;
  recordUsage(entry: UsageEntry): Promise<void>;
  createProvider?: typeof defaultCreateProvider;
  now?: () => number;
  /**
   * Local development only (CHAIRSIDE_AI_DEMO): `map_columns` answers with the deterministic
   * header guess instead of calling a model. Never set in production.
   */
  demoMapping?: boolean;
}

export type AiErrorBody = { error: { code: string; message: string } };

export type AiTestResponse = { ok: true; provider: AiProvider; model: string; latencyMs: number };
export type AiChatResponse = {
  result: ChatResult;
  usage: { usedThisMonth: number; monthlyTokenBudget: number };
};
export type AiMapColumnsResponse = {
  mapping: ColumnMapping;
  source: 'ai' | 'demo';
};

export type AiServiceResult =
  | { status: 200; body: AiTestResponse | AiChatResponse | AiMapColumnsResponse }
  | { status: 400 | 401 | 403 | 409 | 429 | 500 | 502; body: AiErrorBody };

const fail = (
  status: Exclude<AiServiceResult['status'], 200>,
  code: string,
  message: string,
): AiServiceResult => ({ status, body: { error: { code, message } } });

const TEST_PROMPT: ChatMessage[] = [
  { role: 'system', content: 'You are a connection test. Reply with the single word OK.' },
  { role: 'user', content: 'Ping' },
];

export function providerFailure(error: unknown, apiKey: string): AiServiceResult {
  if (error instanceof AiProviderError) {
    return fail(502, `provider_${error.code}`, redactSecrets(error.message, apiKey));
  }
  const message = error instanceof Error ? error.message : String(error);
  return fail(502, 'provider_error', redactSecrets(message, apiKey));
}

export async function handleAiRequest(
  rawBody: unknown,
  deps: AiServiceDeps,
): Promise<AiServiceResult> {
  const parsed = aiRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail(400, 'invalid_request', z.prettifyError(parsed.error));
  }
  const request = parsed.data;
  const create = deps.createProvider ?? defaultCreateProvider;
  const now = deps.now ?? (() => Date.now());

  const role = await deps.getMemberRole(request.salonId);
  if (!role) return fail(403, 'forbidden', 'You are not a member of this salon');

  if (request.action === 'test') {
    if (role !== 'owner') return fail(403, 'forbidden', 'Only salon owners can test AI settings');

    const saved = await deps.loadConfig(request.salonId);
    const provider = request.provider ?? saved?.provider;
    if (!provider) return fail(409, 'not_configured', 'Choose an AI provider first');
    // A saved key belongs to the saved provider; never send it to a different one.
    const apiKey = request.apiKey ?? (saved?.provider === provider ? saved.apiKey : undefined);
    if (!apiKey) return fail(409, 'not_configured', 'Paste an API key to test');
    const model = request.model ?? (saved?.provider === provider ? saved.model : undefined);
    if (!model) return fail(400, 'invalid_request', 'Choose a model to test');

    const started = now();
    try {
      const llm = create(provider, { apiKey, model });
      const result = await llm.chat(TEST_PROMPT, [], { maxOutputTokens: 16, temperature: 0 });
      await deps.recordUsage({
        salonId: request.salonId,
        provider,
        model: result.model,
        purpose: 'connection_test',
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
      return {
        status: 200,
        body: { ok: true, provider, model: result.model, latencyMs: now() - started },
      };
    } catch (error) {
      return providerFailure(error, apiKey);
    }
  }

  const config = await deps.loadConfig(request.salonId);
  if (request.action === 'map_columns' && deps.demoMapping) {
    return {
      status: 200,
      body: { mapping: guessColumnMapping(request.kind, request.headers), source: 'demo' },
    };
  }
  if (!config) {
    return fail(
      409,
      'not_configured',
      'AI is not set up for this salon. Add a key in Settings → AI.',
    );
  }
  const used = await deps.tokensUsedThisMonth(request.salonId);
  if (used >= config.monthlyTokenBudget) {
    return fail(429, 'budget_exceeded', 'This salon has used its monthly AI token budget');
  }

  try {
    const llm = create(config.provider, { apiKey: config.apiKey, model: config.model });
    if (request.action === 'map_columns') {
      const result = await llm.chat(
        columnMappingPrompt(request.kind, request.headers, request.samples),
        [columnMappingTool(request.kind)],
        { maxOutputTokens: 1024, temperature: 0 },
      );
      await deps.recordUsage({
        salonId: request.salonId,
        provider: config.provider,
        model: result.model,
        purpose: 'import_mapping',
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
      const mapping = readColumnMapping(request.kind, request.headers, result);
      if (!mapping) return fail(502, 'provider_bad_response', 'The model did not return a mapping');
      return { status: 200, body: { mapping, source: 'ai' } };
    }
    const result = await llm.chat(
      request.messages as ChatMessage[],
      (request.tools ?? []) as ToolDefinition[],
      { maxOutputTokens: request.maxOutputTokens, temperature: request.temperature },
    );
    await deps.recordUsage({
      salonId: request.salonId,
      provider: config.provider,
      model: result.model,
      purpose: request.purpose ?? 'chat',
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
    return {
      status: 200,
      body: {
        result,
        usage: {
          usedThisMonth: used + result.usage.totalTokens,
          monthlyTokenBudget: config.monthlyTokenBudget,
        },
      },
    };
  } catch (error) {
    return providerFailure(error, config.apiKey);
  }
}
