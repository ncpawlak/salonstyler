import type { AiProvider } from '../providers.ts';
import { parseDemoDate } from '../assistant/demo-provider.ts';
import { normalizeName } from '../assistant/fuzzy.ts';
import type { ChatMessage, ChatResult, LLMProvider } from '../types.ts';

/**
 * A deterministic stand-in for the concierge's LLM, for local demos and tests only (enabled by
 * `CHAIRSIDE_AI_DEMO=1` against a local stack). It understands "can I get a haircut friday",
 * "where do I park?" and "what are my bookings?", and drives the same tools a real model would.
 */

type Json = Record<string, unknown>;
type ToolMessage = Extract<ChatMessage, { role: 'tool' }>;

const parse = (s: string): Json => {
  try {
    return JSON.parse(s) as Json;
  } catch {
    return {};
  }
};

const STOP = new Set(['with', 'and', 'the', 'hair', 'for', 'womens', 'mens', 'women', 'men']);
const words = (s: string) =>
  normalizeName(s)
    .split(' ')
    .map((w) => w.replace(/s$/, ''))
    .filter((w) => w.length >= 3 && !STOP.has(w));

/** The listed service whose name shares the most words with the message (null if none). */
export function demoMatchService<T extends { name: string }>(
  text: string,
  services: T[],
): T | null {
  const said = new Set(words(text));
  let best: { s: T; score: number } | null = null;
  for (const s of services) {
    const score = words(s.name).filter((w) => said.has(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { s, score };
  }
  return best?.s ?? null;
}

export class DemoConciergeProvider implements LLMProvider {
  readonly id: AiProvider = 'openai';
  readonly model = 'chairside-demo';
  private counter = 0;

  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    const system = messages.find((m) => m.role === 'system');
    const today =
      (system && /\((\d{4}-\d{2}-\d{2})\)/.exec(system.content as string)?.[1]) ??
      new Date().toISOString().slice(0, 10);
    const lastUser = messages.map((m) => m.role).lastIndexOf('user');
    const userMessage = messages[lastUser];
    const text = typeof userMessage?.content === 'string' ? userMessage.content : '';
    const tool = [...messages.slice(lastUser + 1)]
      .reverse()
      .find((m): m is ToolMessage => m.role === 'tool');
    if (!tool) return this.start(text);
    return this.afterTool(tool, text, today);
  }

  private start(text: string): ChatResult {
    if (/\b(my|our)\s+(booking|appointment|visit)s?\b/i.test(text)) {
      return this.call('my_bookings', {});
    }
    if (
      /\b(park|parking|where|address|cancel|policy|policies|deposit|located|prep)\b/i.test(text)
    ) {
      return this.call('get_salon_info', {});
    }
    return this.call('list_services', {});
  }

  private afterTool(tool: ToolMessage, text: string, today: string): ChatResult {
    const result = parse(tool.content);
    const error = result.error as { code: string; message: string } | undefined;
    switch (tool.name) {
      case 'list_services': {
        const services = (result.services as { id: string; name: string }[]) ?? [];
        const match = demoMatchService(text, services);
        if (!match) {
          return this.say(
            `What would you like to book? For example: ${services
              .slice(0, 4)
              .map((s) => s.name)
              .join(', ')}.`,
          );
        }
        const timeOfDay = /\bmorning\b/i.test(text)
          ? 'morning'
          : /\bafternoon\b/i.test(text)
            ? 'afternoon'
            : /\bevening\b/i.test(text)
              ? 'evening'
              : undefined;
        return this.call('find_slots', {
          services: [{ serviceId: match.id }],
          date: parseDemoDate(text, today) ?? today,
          ...(timeOfDay ? { timeOfDay } : {}),
        });
      }
      case 'find_slots': {
        if (error) return this.say(error.message);
        const days = (result.days as { date: string; label: string; times: string[] }[]) ?? [];
        const service = String(result.serviceSummary ?? '').split(' · ')[0];
        const requested = days.find((d) => d.date === result.requestedDate);
        if (requested && requested.times.length > 0) {
          return this.say(
            `${requested.label} for ${service}: ${requested.times.join(', ')}. Tap a time to book it.`,
          );
        }
        const nearby = days.filter((d) => d.times.length > 0).slice(0, 2);
        return this.say(
          `${String(result.requestedNote ?? 'Nothing open that day.')}${
            nearby.length
              ? ` Closest openings: ${nearby.map((d) => `${d.label} at ${d.times[0]}`).join(', ')}. Tap one to book.`
              : ' Nothing nearby either. Try another week.'
          }`,
        );
      }
      case 'get_salon_info': {
        const faq = typeof result.faq === 'string' ? result.faq : null;
        return this.say(
          faq
            ? `From ${String(result.name)}: ${faq}`
            : `I don't have that info. Please ask ${String(result.name)} directly.`,
        );
      }
      case 'my_bookings': {
        if (error) return this.say('Verify your email below first, then I can look that up.');
        const list =
          (result.bookings as { when: string; services: string; status: string }[]) ?? [];
        return this.say(
          list.length
            ? list.map((b) => `${b.when}: ${b.services} (${b.status})`).join('; ')
            : 'You have no upcoming bookings here.',
        );
      }
      default:
        return this.say(error ? error.message : 'Done.');
    }
  }

  private call(name: string, args: Json): ChatResult {
    return {
      ...this.base('tool_calls'),
      type: 'tool_calls',
      text: null,
      toolCalls: [{ id: `demo_${++this.counter}`, name, arguments: args }],
    };
  }

  private say(text: string): ChatResult {
    return { ...this.base('stop'), type: 'text', text, toolCalls: [] };
  }

  private base(finishReason: ChatResult['finishReason']) {
    return {
      provider: this.id,
      model: this.model,
      finishReason,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }
}
