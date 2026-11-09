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

// https://docs.anthropic.com/en/api/messages
const ANTHROPIC_VERSION = '2023-06-01';

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

interface AnthropicResponse {
  model?: string;
  stop_reason?: string;
  content?: (
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: string }
  )[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

function toBlocks(content: string | ContentPart[]): AnthropicBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data } },
  );
}

/** Anthropic takes `system` separately and requires strictly alternating user/assistant turns. */
export function toAnthropicMessages(messages: ChatMessage[]): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  const system: string[] = [];
  const out: AnthropicMessage[] = [];
  const push = (role: AnthropicMessage['role'], blocks: AnthropicBlock[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        system.push(message.content);
        break;
      case 'user':
        push('user', toBlocks(message.content));
        break;
      case 'assistant': {
        const blocks: AnthropicBlock[] = [];
        if (message.content) blocks.push({ type: 'text', text: message.content });
        for (const call of message.toolCalls ?? []) {
          blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
        }
        push('assistant', blocks);
        break;
      }
      case 'tool':
        push('user', [
          { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content },
        ]);
        break;
    }
  }
  return { system: system.length ? system.join('\n\n') : undefined, messages: out };
}

function finishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'content_filter';
    default:
      return 'other';
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic' as const;
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
    const converted = toAnthropicMessages(messages);
    const body = {
      model: this.model,
      max_tokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      ...(converted.system ? { system: converted.system } : {}),
      messages: converted.messages,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(tools.length
        ? {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          }
        : {}),
    };

    const json = await postJson<AnthropicResponse>({
      provider: this.id,
      apiKey: this.#options.apiKey,
      url: `${this.#options.baseUrl ?? 'https://api.anthropic.com/v1'}/messages`,
      headers: { 'x-api-key': this.#options.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body,
      fetch: this.#options.fetch,
      signal: options.signal,
    });

    const texts: string[] = [];
    const toolCalls = [];
    for (const block of json.content ?? []) {
      if (block.type === 'text' && 'text' in block) texts.push(block.text);
      if (block.type === 'tool_use' && 'id' in block) {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: parseToolArguments(this.id, block.input),
        });
      }
    }

    return buildResult({
      provider: this.id,
      model: json.model ?? this.model,
      text: texts.length ? texts.join('') : null,
      toolCalls,
      finishReason: finishReason(json.stop_reason),
      inputTokens: json.usage?.input_tokens,
      outputTokens: json.usage?.output_tokens,
    });
  }
}
