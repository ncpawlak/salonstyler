import type { AiProvider } from './providers.ts';
import type { ChatResult, FinishReason, TokenUsage, ToolCall } from './types.ts';

export function buildResult(args: {
  provider: AiProvider;
  model: string;
  text: string | null;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}): ChatResult {
  const inputTokens = args.inputTokens ?? 0;
  const outputTokens = args.outputTokens ?? 0;
  const usage: TokenUsage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  const base = { provider: args.provider, model: args.model, usage };
  if (args.toolCalls.length > 0) {
    return {
      ...base,
      type: 'tool_calls',
      text: args.text,
      toolCalls: args.toolCalls,
      finishReason: 'tool_calls',
    };
  }
  return {
    ...base,
    type: 'text',
    text: args.text ?? '',
    toolCalls: [],
    finishReason: args.finishReason,
  };
}
