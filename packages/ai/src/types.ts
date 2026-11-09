import type { AiProvider } from './providers.ts';

/** JSON Schema (draft 2020-12 subset) describing a tool's arguments. */
export type JsonSchema = { [key: string]: unknown };

export interface TextPart {
  type: 'text';
  text: string;
}

/** Base64 image (e.g. a screenshot of a client's text). URLs are not accepted: not every provider fetches them. */
export interface ImagePart {
  type: 'image';
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** Base64 without the `data:` prefix. */
  data: string;
}

export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content?: string | null; toolCalls?: ToolCall[] }
  | {
      role: 'tool';
      toolCallId: string;
      /** Name of the tool that produced this result (Gemini needs it). */
      name: string;
      /** Tool output, usually JSON.stringify(result). */
      content: string;
    };

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ChatOptions {
  /** Defaults to 1024. */
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'other';

interface ChatResultBase {
  provider: AiProvider;
  model: string;
  finishReason: FinishReason;
  usage: TokenUsage;
}

/** Normalized result: either plain text, or one or more tool calls (optionally with accompanying text). */
export type ChatResult =
  | (ChatResultBase & { type: 'text'; text: string; toolCalls: [] })
  | (ChatResultBase & { type: 'tool_calls'; text: string | null; toolCalls: ToolCall[] });

export interface LLMProvider {
  readonly id: AiProvider;
  readonly model: string;
  chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatResult>;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ProviderOptions {
  apiKey: string;
  model: string;
  /** Override for tests, proxies, or recording fixtures. Defaults to global fetch. */
  fetch?: FetchLike;
  /** Override the API base URL (e.g. an Azure/OpenAI-compatible gateway). */
  baseUrl?: string;
}
