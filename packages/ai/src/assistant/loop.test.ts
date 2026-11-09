import { describe, expect, it } from 'vitest';

import type { ChatMessage, ChatResult, LLMProvider, ToolCall } from '../types.ts';
import { DemoAssistantProvider, parseDemoDate } from './demo-provider.ts';
import { createFakePort, KARINA, NOW } from './fake-salon.ts';
import { runAssistantTurn } from './loop.ts';
import type { DraftCard, SlotsCard } from './types.ts';

type Step = (messages: ChatMessage[]) => ChatResult;

/** A fake LLM that plays back scripted steps and records what it was sent. */
class ScriptedProvider implements LLMProvider {
  readonly id = 'openai' as const;
  readonly model = 'scripted';
  readonly seen: ChatMessage[][] = [];
  constructor(private readonly steps: Step[]) {}
  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    this.seen.push(structuredClone(messages));
    const step = this.steps.shift();
    if (!step) throw new Error('script exhausted');
    return step(messages);
  }
}

const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
const calls =
  (...toolCalls: ToolCall[]): Step =>
  () => ({
    provider: 'openai',
    model: 'scripted',
    finishReason: 'tool_calls',
    usage,
    type: 'tool_calls',
    text: null,
    toolCalls,
  });
const say =
  (text: string): Step =>
  () => ({
    provider: 'openai',
    model: 'scripted',
    finishReason: 'stop',
    usage,
    type: 'text',
    text,
    toolCalls: [],
  });
const lastTool = (messages: ChatMessage[]) => {
  const m = messages.at(-1)!;
  if (m.role !== 'tool') throw new Error('expected a tool result');
  return JSON.parse(m.content) as Record<string, unknown>;
};

const setup = () => {
  const port = createFakePort();
  return { port, tools: { port, now: () => NOW } };
};
const prompt = { salonName: 'Studio K', timeZone: 'America/Chicago' };

describe('runAssistantTurn', () => {
  it('"schedule karina for december 18th" → engine slots on Dec 18 and nearby days', async () => {
    const { port, tools } = setup();
    let karinaId = '';
    const llm = new ScriptedProvider([
      calls({ id: 'c1', name: 'find_client', arguments: { query: 'karina' } }),
      (messages) => {
        karinaId = (lastTool(messages).matches as { id: string }[])[0]!.id;
        return calls({
          id: 'c2',
          name: 'find_slots',
          arguments: { clientId: karinaId, date: '2026-12-18' },
        })(messages);
      },
      (messages) => {
        const result = lastTool(messages) as { days: { date: string }[] };
        expect(result.days.map((d) => d.date)).toContain('2026-12-18');
        return say('Fri, Dec 18 has 12:30 PM open for Karina. Nearby days are below.')(messages);
      },
    ]);

    const turn = await runAssistantTurn({
      llm,
      tools,
      prompt,
      history: [],
      text: 'schedule karina for december 18th',
    });

    expect(karinaId).toBe(KARINA);
    expect(turn.reply).toMatch(/12:30 PM/);
    expect(turn.toolCalls).toEqual([
      { name: 'find_client', ok: true },
      { name: 'find_slots', ok: true },
    ]);
    expect(turn.cards).toHaveLength(1);
    const card = turn.cards[0] as SlotsCard;
    expect(card.type).toBe('slots');
    expect(card.days.find((d) => d.date === '2026-12-18')!.slots.map((s) => s.time)).toEqual([
      '12:30 PM',
    ]);
    expect(card.days.filter((d) => d.date !== '2026-12-18' && d.slots.length > 0).length).toBe(4);

    // System prompt carries today's date so the model can resolve "december 18th".
    const system = llm.seen[0]![0]!;
    expect(system.role).toBe('system');
    expect(system.content).toContain('2026-12-01');
    expect(system.content).toContain('Studio K');

    // Conversation to persist: user, assistant(tool call), tool, assistant(tool call), tool, reply.
    expect(turn.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(turn.usage.totalTokens).toBe(360);
    expect(port.audits.map((a) => a.details.tool)).toEqual(['find_client', 'find_slots']);
    // Nothing was booked.
    expect(port.appointments.filter((a) => a.status === 'held')).toHaveLength(0);
  });

  it('feeds tool errors back to the model so it can recover', async () => {
    const { tools } = setup();
    const llm = new ScriptedProvider([
      calls({ id: 'c1', name: 'find_slots', arguments: { date: 'next friday' } }),
      (messages) => {
        expect(lastTool(messages)).toMatchObject({ error: { code: 'invalid_arguments' } });
        return say('Which date did you mean?')(messages);
      },
    ]);
    const turn = await runAssistantTurn({ llm, tools, prompt, history: [], text: 'book friday' });
    expect(turn.reply).toBe('Which date did you mean?');
    expect(turn.toolCalls).toEqual([{ name: 'find_slots', ok: false }]);
  });

  it('stops after maxSteps tool rounds', async () => {
    const { tools } = setup();
    const loop = calls({ id: 'x', name: 'list_services', arguments: {} });
    const llm = new ScriptedProvider([loop, loop, loop]);
    const turn = await runAssistantTurn({
      llm,
      tools,
      prompt,
      history: [],
      text: 'hi',
      maxSteps: 3,
    });
    expect(turn.reply).toMatch(/couldn't finish/);
    expect(llm.seen).toHaveLength(3);
  });

  it('meters usage per model call', async () => {
    const { tools } = setup();
    const metered: number[] = [];
    await runAssistantTurn({
      llm: new ScriptedProvider([
        calls({ id: 'a', name: 'list_services', arguments: {} }),
        say('ok'),
      ]),
      tools,
      prompt,
      history: [],
      text: 'what do I offer?',
      onUsage: async (u) => void metered.push(u.totalTokens),
    });
    expect(metered).toEqual([120, 120]);
  });
});

describe('DemoAssistantProvider', () => {
  it('parses dates relative to today', () => {
    expect(parseDemoDate('schedule karina for december 18th', '2026-12-01')).toBe('2026-12-18');
    expect(parseDemoDate('dec 3', '2026-12-10')).toBe('2027-12-03');
    expect(parseDemoDate('12/18', '2026-12-01')).toBe('2026-12-18');
    expect(parseDemoDate('tomorrow', '2026-12-01')).toBe('2026-12-02');
    expect(parseDemoDate("what's on friday", '2026-12-01')).toBe('2026-12-04');
    expect(parseDemoDate('hello', '2026-12-01')).toBeNull();
  });

  it('drives the full schedule → hold → change flow through the real tools', async () => {
    const { port, tools } = setup();
    const llm = new DemoAssistantProvider();

    const first = await runAssistantTurn({
      llm,
      tools,
      prompt,
      history: [],
      text: 'schedule karina for december 18th',
    });
    expect(first.toolCalls.map((c) => c.name)).toEqual(['find_client', 'find_slots']);
    expect(first.reply).toContain('Fri, Dec 18 for Karina');
    expect(first.reply).toContain('12:30 PM');
    expect(first.cards[0]!.type).toBe('slots');

    const second = await runAssistantTurn({
      llm,
      tools,
      prompt,
      history: first.messages,
      text: 'book the 12:30 pm',
    });
    expect(second.toolCalls).toEqual([{ name: 'propose_booking', ok: true }]);
    const draft = second.cards[0] as DraftCard;
    expect(draft).toMatchObject({ type: 'draft', status: 'held', label: 'Fri, Dec 18 · 12:30 PM' });
    expect(second.reply).toMatch(/Tap Confirm/);

    const third = await runAssistantTurn({
      llm,
      tools,
      prompt,
      history: [...first.messages, ...second.messages],
      text: 'never mind',
    });
    expect(third.toolCalls).toEqual([{ name: 'cancel_draft', ok: true }]);
    expect(port.appointments.find((a) => a.id === draft.appointmentId)!.status).toBe('cancelled');
  });

  it('offers to add an unknown client', async () => {
    const { tools } = setup();
    const turn = await runAssistantTurn({
      llm: new DemoAssistantProvider(),
      tools,
      prompt,
      history: [],
      text: 'schedule Jessica for dec 18',
    });
    expect(turn.cards).toEqual([{ type: 'client_not_found', query: 'Jessica', suggestions: [] }]);
    expect(turn.reply).toMatch(/add them/);
  });
});
