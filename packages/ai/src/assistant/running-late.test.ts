import { describe, expect, it } from 'vitest';

import type { ChatMessage, ChatResult, LLMProvider } from '../types.ts';
import { DemoAssistantProvider } from './demo-provider.ts';
import {
  draftRunningLateTexts,
  parseRunningLateDrafts,
  RUNNING_LATE_PROMPT_TAG,
  runningLateMessages,
  type RunningLateDraftInput,
  templateRunningLateText,
} from './running-late.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

const input: RunningLateDraftInput = {
  salonName: 'Studio K',
  timeZone: 'America/Chicago',
  delayMinutes: 15,
  items: [
    {
      appointmentId: A,
      clientName: 'Maya Lopez',
      oldStart: '2026-12-18T16:00:00Z',
      newStart: '2026-12-18T16:15:00Z',
    },
    {
      appointmentId: B,
      clientName: null,
      oldStart: '2026-12-18T17:00:00Z',
      newStart: '2026-12-18T17:00:00Z',
    },
  ],
};

function scripted(text: string): LLMProvider & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    id: 'openai',
    model: 'test',
    calls,
    chat: async (messages): Promise<ChatResult> => {
      calls.push(messages);
      return {
        provider: 'openai',
        model: 'test',
        finishReason: 'stop',
        usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 },
        type: 'text',
        text,
        toolCalls: [],
      };
    },
  };
}

describe('templateRunningLateText', () => {
  it('names the client and both local times', () => {
    expect(templateRunningLateText(input.items[0]!, input)).toBe(
      "Hi Maya, I'm running about 15 minutes behind today. Could we start your 10:00 AM appointment at 10:15 AM instead? Sorry for the wait, see you soon!",
    );
  });

  it('reassures clients whose time absorbed the delay', () => {
    expect(templateRunningLateText(input.items[1]!, input)).toMatch(
      /^Hi, .*11:00 AM appointment should still start on time/,
    );
  });
});

describe('runningLateMessages', () => {
  it('sends only first names and formatted times, tagged for the demo provider', () => {
    const [system, user] = runningLateMessages(input);
    expect(system!.content).toMatch(new RegExp(`^\\${RUNNING_LATE_PROMPT_TAG}`));
    const body = JSON.parse(user!.content as string) as Record<string, unknown>;
    expect(body).toEqual({
      runningLateMinutes: 15,
      appointments: [
        {
          appointmentId: A,
          clientFirstName: 'Maya',
          originalStart: '10:00 AM',
          newStart: '10:15 AM',
        },
        {
          appointmentId: B,
          clientFirstName: null,
          originalStart: '11:00 AM',
          newStart: '11:00 AM',
        },
      ],
    });
  });
});

describe('parseRunningLateDrafts', () => {
  it('reads JSON wrapped in prose or code fences', () => {
    const out = parseRunningLateDrafts(
      'Sure!\n```json\n{"drafts":[{"appointmentId":"x","text":" Hi! "}]}\n```',
    );
    expect([...out]).toEqual([['x', 'Hi!']]);
  });

  it('returns nothing for invalid output', () => {
    expect(parseRunningLateDrafts('no json here').size).toBe(0);
    expect(parseRunningLateDrafts('{"drafts":"nope"}').size).toBe(0);
    expect(
      parseRunningLateDrafts(`{"drafts":[{"appointmentId":"x","text":"${'a'.repeat(400)}"}]}`).size,
    ).toBe(0);
  });
});

describe('draftRunningLateTexts', () => {
  it('uses the model’s text and fills gaps from the template', async () => {
    const llm = scripted(JSON.stringify({ drafts: [{ appointmentId: A, text: 'Hey Maya!' }] }));
    const usage: number[] = [];
    const drafts = await draftRunningLateTexts(llm, input, (u) => void usage.push(u.totalTokens));
    expect(drafts.map((d) => [d.appointmentId, d.source])).toEqual([
      [A, 'ai'],
      [B, 'template'],
    ]);
    expect(drafts[0]!.text).toBe('Hey Maya!');
    expect(llm.calls[0]).toHaveLength(2);
    expect(usage).toEqual([60]);
  });

  it('works end to end with the demo provider', async () => {
    const drafts = await draftRunningLateTexts(new DemoAssistantProvider(), input);
    expect(drafts.every((d) => d.source === 'ai')).toBe(true);
    expect(drafts[0]!.text).toContain('10:15 AM instead of 10:00 AM');
    expect(drafts[1]!.text).toContain('still on for 11:00 AM');
  });

  it('skips the model when nothing moves', async () => {
    const llm = scripted('{}');
    expect(await draftRunningLateTexts(llm, { ...input, items: [] })).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });
});
