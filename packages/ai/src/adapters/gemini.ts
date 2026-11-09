import { DEFAULT_MAX_OUTPUT_TOKENS, parseToolArguments, postJson } from '../http.ts';
import { buildResult } from '../result.ts';
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  ContentPart,
  FinishReason,
  JsonSchema,
  LLMProvider,
  ProviderOptions,
  ToolCall,
  ToolDefinition,
} from '../types.ts';

// https://ai.google.dev/api/generate-content
type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { id?: string; name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponse {
  modelVersion?: string;
  candidates?: {
    finishReason?: string;
    content?: { parts?: (Partial<{ text: string; thought: boolean }> & Partial<GeminiPart>)[] };
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
}

function toParts(content: string | ContentPart[]): GeminiPart[] {
  if (typeof content === 'string') return [{ text: content }];
  return content.map((part) =>
    part.type === 'text'
      ? { text: part.text }
      : { inlineData: { mimeType: part.mimeType, data: part.data } },
  );
}

function toFunctionResponse(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { result: parsed };
  } catch {
    return { result: content };
  }
}

/** Gemini's `parameters` is an OpenAPI 3 subset: drop JSON Schema keywords it rejects. */
export function toGeminiSchema(schema: JsonSchema): JsonSchema {
  const UNSUPPORTED = new Set(['$schema', '$id', 'additionalProperties', '$defs', 'definitions']);
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !UNSUPPORTED.has(key))
          .map(([key, inner]) => [key, walk(inner)]),
      );
    }
    return value;
  };
  return walk(schema) as JsonSchema;
}

// Gemini pairs function responses with calls by name and order, so ids are never sent.
export function toGeminiContents(messages: ChatMessage[]): {
  systemInstruction: { parts: { text: string }[] } | undefined;
  contents: GeminiContent[];
} {
  const system: string[] = [];
  const contents: GeminiContent[] = [];
  const push = (role: GeminiContent['role'], parts: GeminiPart[]) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        system.push(message.content);
        break;
      case 'user':
        push('user', toParts(message.content));
        break;
      case 'assistant': {
        const parts: GeminiPart[] = [];
        if (message.content) parts.push({ text: message.content });
        for (const call of message.toolCalls ?? []) {
          parts.push({ functionCall: { name: call.name, args: call.arguments } });
        }
        push('model', parts);
        break;
      }
      case 'tool':
        push('user', [
          {
            functionResponse: {
              name: message.name,
              response: toFunctionResponse(message.content),
            },
          },
        ]);
        break;
    }
  }
  return {
    systemInstruction: system.length ? { parts: [{ text: system.join('\n\n') }] } : undefined,
    contents,
  };
}

function finishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    default:
      return 'other';
  }
}

export class GeminiProvider implements LLMProvider {
  readonly id = 'gemini' as const;
  readonly model: string;
  readonly #options: ProviderOptions;

  constructor(options: ProviderOptions) {
    this.#options = options;
    this.model = options.model;
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[] = [],
    options: ChatOptions = {},
  ): Promise<ChatResult> {
    const converted = toGeminiContents(messages);
    const body = {
      ...(converted.systemInstruction ? { systemInstruction: converted.systemInstruction } : {}),
      contents: converted.contents,
      ...(tools.length
        ? {
            tools: [
              {
                functionDeclarations: tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: toGeminiSchema(tool.parameters),
                })),
              },
            ],
          }
        : {}),
      generationConfig: {
        maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      },
    };

    const base = this.#options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    const json = await postJson<GeminiResponse>({
      provider: this.id,
      apiKey: this.#options.apiKey,
      url: `${base}/models/${encodeURIComponent(this.model)}:generateContent`,
      headers: { 'x-goog-api-key': this.#options.apiKey },
      body,
      fetch: this.#options.fetch,
      signal: options.signal,
    });

    const candidate = json.candidates?.[0];
    const texts: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.thought) continue;
      if ('functionCall' in part && part.functionCall) {
        toolCalls.push({
          id: part.functionCall.id ?? `gemini_call_${toolCalls.length}`,
          name: part.functionCall.name,
          arguments: parseToolArguments(this.id, part.functionCall.args),
        });
      } else if (typeof part.text === 'string') {
        texts.push(part.text);
      }
    }

    const usage = json.usageMetadata;
    return buildResult({
      provider: this.id,
      model: json.modelVersion ?? this.model,
      text: texts.length ? texts.join('') : null,
      toolCalls,
      finishReason: json.promptFeedback?.blockReason
        ? 'content_filter'
        : finishReason(candidate?.finishReason),
      inputTokens: usage?.promptTokenCount,
      // Thinking models bill "thoughts" as output tokens.
      outputTokens:
        usage === undefined
          ? undefined
          : (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    });
  }
}
