import { describe, expect, it } from 'vitest';

import type { ChatMessage, ChatResult, LLMProvider, ToolCall } from '../types.ts';
import { DemoAssistantProvider, parseDemoDate } from './demo-provider.ts';
import { appointment, createFakePort, KARINA, MARIA, NOW } from './fake-salon.ts';
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

  it('parses relative offsets and follow-ups', () => {
    const today = '2026-11-16';
    expect(parseDemoDate('schedule dana for a 6 week followup', today)).toBe('2026-12-28');
    expect(parseDemoDate('6-week follow-up', today)).toBe('2026-12-28');
    expect(parseDemoDate('two weeks out', today)).toBe('2026-11-30');
    expect(parseDemoDate('in 6 weeks', today)).toBe('2026-12-28');
    expect(parseDemoDate('in 3 days', today)).toBe('2026-11-19');
    expect(parseDemoDate('in a month', today)).toBe('2026-12-16');
    expect(parseDemoDate('in 6 months', today)).toBe('2027-05-16');
    expect(parseDemoDate('next week', today)).toBe('2026-11-23');
    expect(parseDemoDate('next month', today)).toBe('2026-12-16');
    expect(parseDemoDate('next month', '2027-01-31')).toBe('2027-02-28');
    expect(parseDemoDate('next friday', today)).toBe('2026-11-20');
  });

  it('routes "schedule <name> for a 6 week followup" and "book <name> in 3 weeks"', async () => {
    for (const [text, date] of [
      ['schedule karina for a 6 week followup', '2027-01-12'],
      ['book karina lopez in 3 weeks', '2026-12-22'],
    ] as const) {
      const { tools } = setup();
      const turn = await runAssistantTurn({
        llm: new DemoAssistantProvider(),
        tools,
        prompt,
        history: [],
        text,
      });
      expect(turn.toolCalls.map((c) => c.name)).toEqual(['find_client', 'find_slots']);
      expect((turn.cards[0] as SlotsCard).requestedDate).toBe(date);
    }
  });

  it('only mentions other days when the card has them, with correct grammar', async () => {
    const { port, tools } = setup();
    // Karina's color fits only at 12:30 on Fri Dec 18; fill Dec 15–17 and 19, and every day
    // after, so no other day has openings.
    for (let day = 15; day <= 31; day++) {
      if (day === 18) continue;
      port.appointments.push(
        appointment(MARIA, [
          {
            kind: 'busy',
            start: `2026-12-${day}T15:00:00Z`,
            end: `2026-12-${day}T23:00:00Z`,
          },
        ]),
      );
    }
    for (let day = 1; day <= 8; day++) {
      port.appointments.push(
        appointment(MARIA, [
          {
            kind: 'busy',
            start: `2027-01-0${day}T15:00:00Z`,
            end: `2027-01-0${day}T23:00:00Z`,
          },
        ]),
      );
    }
    const turn = await runAssistantTurn({
      llm: new DemoAssistantProvider(),
      tools,
      prompt,
      history: [],
      text: 'schedule karina for december 18th',
    });
    expect((turn.cards[0] as SlotsCard).days.map((d) => d.date)).toEqual(['2026-12-18']);
    expect(turn.reply).toBe(
      "Karina's All-over Color on Fri, Dec 18: 12:30 PM is open. Tap a time to hold it.",
    );
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
    expect(first.reply).toBe(
      "Karina's All-over Color on Fri, Dec 18: 12:30 PM is open. Also open: Thu, Dec 17, Sat, Dec 19 and Wed, Dec 16. Tap a time to hold it.",
    );
    expect(first.reply).not.toMatch(/\(.*\(/);
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

  it('"I\'m running 30 late" → a running-late card; nothing moves', async () => {
    const port = createFakePort();
    const turn = await runAssistantTurn({
      llm: new DemoAssistantProvider(),
      tools: { port, now: () => Date.parse('2026-12-18T14:50:00Z') },
      prompt,
      history: [],
      text: "I'm running 30 min late",
    });
    expect(turn.toolCalls).toEqual([{ name: 'running_late', ok: true }]);
    expect(turn.cards[0]).toMatchObject({ type: 'running_late', delayMinutes: 30 });
    expect(turn.reply).toMatch(/Maria 9:00 AM → 9:30 AM.*Review/);
  });
});
