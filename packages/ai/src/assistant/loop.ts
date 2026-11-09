import type { ChatMessage, LLMProvider, TokenUsage } from '../types.ts';
import { assistantSystemPrompt, type PromptContext } from './prompt.ts';
import { ASSISTANT_TOOLS, runTool, type ToolContext } from './tools.ts';
import type { AssistantCard } from './types.ts';

/** Model round-trips per user message before giving up (each may run several tools). */
export const MAX_ASSISTANT_STEPS = 6;
const GIVE_UP = "Sorry, I couldn't finish that. Could you say it another way?";

export interface AssistantTurnInput {
  llm: LLMProvider;
  tools: ToolContext;
  prompt: Omit<PromptContext, 'now'>;
  /** Earlier user/assistant/tool messages (no system message). */
  history: ChatMessage[];
  /** The owner's new message. */
  text: string;
  maxSteps?: number;
  maxOutputTokens?: number;
  /** Called after every model call, e.g. to meter usage. */
  onUsage?: (usage: TokenUsage, model: string) => Promise<void>;
}

export interface AssistantTurnResult {
  reply: string;
  cards: AssistantCard[];
  /** New messages to append to the conversation, starting with the user's. */
  messages: ChatMessage[];
  usage: TokenUsage;
  toolCalls: { name: string; ok: boolean }[];
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * One owner message through the tool-calling loop. The model only interprets the request and picks
 * tools; every fact (clients, slots, bookings) comes from the tool handlers and the engine.
 */
export async function runAssistantTurn(input: AssistantTurnInput): Promise<AssistantTurnResult> {
  const maxSteps = input.maxSteps ?? MAX_ASSISTANT_STEPS;
  const system: ChatMessage = {
    role: 'system',
    content: assistantSystemPrompt({ ...input.prompt, now: input.tools.now() }),
  };
  const added: ChatMessage[] = [{ role: 'user', content: input.text }];
  const cards: AssistantCard[] = [];
  const toolCalls: AssistantTurnResult['toolCalls'] = [];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  for (let step = 0; step < maxSteps; step++) {
    const result = await input.llm.chat([system, ...input.history, ...added], ASSISTANT_TOOLS, {
      maxOutputTokens: input.maxOutputTokens ?? 1024,
      temperature: 0.2,
    });
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    usage.totalTokens += result.usage.totalTokens;
    await input.onUsage?.(result.usage, result.model);

    if (result.type === 'text') {
      const reply = result.text.trim() || (cards.length ? 'Here you go.' : GIVE_UP);
      added.push({ role: 'assistant', content: reply });
      return { reply, cards, messages: added, usage, toolCalls };
    }

    added.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls });
    for (const call of result.toolCalls) {
      const output = await runTool(input.tools, call.name, call.arguments);
      toolCalls.push({ name: call.name, ok: output.ok });
      if (output.card) cards.push(output.card);
      await input.tools.port.audit('assistant.tool_call', {
        tool: call.name,
        arguments: call.arguments,
        ok: output.ok,
        ...(output.ok ? {} : { error: output.result }),
      });
      added.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: truncate(JSON.stringify(output.result), 12_000),
      });
    }
  }

  added.push({ role: 'assistant', content: GIVE_UP });
  return { reply: GIVE_UP, cards, messages: added, usage, toolCalls };
}
