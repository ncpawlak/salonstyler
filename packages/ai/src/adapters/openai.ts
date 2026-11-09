import { DEFAULT_MAX_OUTPUT_TOKENS, parseToolArguments, postJson } from '../http.ts';
import { buildResult } from '../result.ts';
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  ContentPart,
  FinishReason,
  LLMProvider,
  ProviderOptions,
  ToolDefinition,
} from '../types.ts';

// https://platform.openai.com/docs/api-reference/chat/create
interface OpenAiResponse {
  model?: string;
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function toOpenAiContent(content: string | ContentPart[]) {
  if (typeof content === 'string') return content;
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } },
  );
}

export function toOpenAiMessages(messages: ChatMessage[]) {
  return messages.map((message) => {
    switch (message.role) {
      case 'system':
        return { role: 'system', content: message.content };
      case 'user':
        return { role: 'user', content: toOpenAiContent(message.content) };
      case 'assistant':
        return {
          role: 'assistant',
          content: message.content ?? null,
          ...(message.toolCalls?.length
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              }
            : {}),
        };
      case 'tool':
        return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    }
  });
}

function finishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'other';
  }
}

export class OpenAiProvider implements LLMProvider {
  readonly id = 'openai' as const;
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
    const body = {
      model: this.model,
      messages: toOpenAiMessages(messages),
      max_completion_tokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(tools.length
        ? {
            tools: tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }
        : {}),
    };

    const json = await postJson<OpenAiResponse>({
      provider: this.id,
      apiKey: this.#options.apiKey,
      url: `${this.#options.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`,
      headers: { authorization: `Bearer ${this.#options.apiKey}` },
      body,
      fetch: this.#options.fetch,
      signal: options.signal,
    });

    const choice = json.choices?.[0];
    const toolCalls = (choice?.message?.tool_calls ?? [])
      .filter((call) => call.type === 'function')
      .map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: parseToolArguments(this.id, call.function.arguments),
      }));

    return buildResult({
      provider: this.id,
      model: json.model ?? this.model,
      text: choice?.message?.content ?? null,
      toolCalls,
      finishReason: finishReason(choice?.finish_reason),
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: json.usage?.completion_tokens,
    });
  }
}
