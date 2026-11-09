import { describe, expect, it } from 'vitest';

import type { ChatMessage, ChatResult, LLMProvider } from '../types.ts';
import { DemoAssistantProvider } from './demo-provider.ts';
import {
  draftReply,
  finishReply,
  formatReplyWhen,
  parseReplyDraft,
  REPLY_PROMPT_TAG,
  replyMessages,
  type ReplyDraftInput,
  templateReply,
} from './reply.ts';

const base: ReplyDraftInput = {
  kind: 'confirm',
  salonName: 'Studio K',
  timeZone: 'America/Chicago',
  clientName: 'Maya Lopez',
  start: '2026-12-18T19:30:00Z',
  services: ['Cut', 'Color'],
};

function scripted(text: string): LLMProvider & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    id: 'openai',
    model: 'm',
    calls,
    chat: async (messages): Promise<ChatResult> => {
      calls.push(messages);
      return {
        provider: 'openai',
        model: 'm',
        finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
        type: 'text',
        text,
        toolCalls: [],
      };
    },
  };
}

describe('templateReply', () => {
  it('words each kind with the real date, time and services', () => {
    expect(formatReplyWhen(base.start!, base.timeZone)).toBe('Fri, Dec 18 at 1:30 PM');
    expect(templateReply(base).text).toBe(
      "Hi Maya! You're booked for Cut and Color on Fri, Dec 18 at 1:30 PM. See you then!",
    );
    expect(templateReply({ ...base, kind: 'offer', confirmKeyword: 'Chairside' }).text).toBe(
      'Hi Maya! I have Fri, Dec 18 at 1:30 PM open for Cut and Color. Does that work for you? Reply "Chairside yes" to confirm.',
    );
    expect(templateReply({ ...base, kind: 'decline' }).text).toMatch(/^Hi Maya! So sorry/);
    expect(templateReply({ ...base, kind: 'cancelled' }).text).toContain(
      'your Fri, Dec 18 at 1:30 PM appointment is cancelled',
    );
    expect(templateReply({ ...base, kind: 'other' }).text).toBe('Hi Maya! ');
  });

  it('skips placeholder names for unknown senders', () => {
    expect(templateReply({ ...base, clientName: 'Text from (312) 555-0199' }).text).toMatch(
      /^Hi! You're booked/,
    );
  });
});

describe('finishReply', () => {
  it('appends the booking link and the reply-yes instruction once', () => {
    const input = {
      ...base,
      kind: 'decline' as const,
      bookingLink: 'https://book.example.com/k',
    };
    const once = finishReply('Sorry!', input);
    expect(once).toBe('Sorry!\nBook another time here: https://book.example.com/k');
    expect(finishReply(once, input)).toBe(once);

    const offer = { ...base, kind: 'offer' as const, confirmKeyword: 'Chairside' };
    expect(finishReply('Works? Reply CHAIRSIDE YES', offer)).toBe('Works? Reply CHAIRSIDE YES');
    expect(finishReply('Works?', { ...offer, start: null })).toBe('Works?');
  });

  it('teaches the keyword on texted confirmations, once', () => {
    const confirm = { ...base, kind: 'confirm' as const, teachKeyword: 'Chairside' };
    const taught = finishReply("You're booked!", confirm);
    expect(taught).toMatch(/^You're booked! .*Chairside/);
    expect(finishReply(taught, confirm)).toBe(taught);
    expect(finishReply("You're booked!", { ...confirm, kind: 'decline' })).toBe("You're booked!");
  });
});

describe('parseReplyDraft', () => {
  it('reads JSON, tolerating fences, and rejects junk', () => {
    expect(parseReplyDraft('```json\n{"text":" Hi! "}\n```')).toBe('Hi!');
    expect(parseReplyDraft('{"text":""}')).toBeNull();
    expect(parseReplyDraft('nope')).toBeNull();
    expect(parseReplyDraft(`{"text":"${'x'.repeat(600)}"}`)).toBeNull();
  });
});

describe('draftReply', () => {
  it('prompts with the tag, tone examples and facts, then finishes the text', async () => {
    const llm = scripted('{"text":"Hey Maya, you are set for Fri!"}');
    const draft = await draftReply(llm, {
      ...base,
      toneExamples: 'heyy love! see u soon xx',
      bookingLink: 'https://book.example.com/k',
    });
    expect(draft).toEqual({
      text: 'Hey Maya, you are set for Fri!\nBook anytime: https://book.example.com/k',
      source: 'ai',
    });
    const [system, user] = llm.calls[0]!;
    expect(system!.content).toContain(REPLY_PROMPT_TAG);
    expect(system!.content).toContain('heyy love!');
    expect(JSON.parse(user!.content as string)).toMatchObject({
      kind: 'confirm',
      clientFirstName: 'Maya',
      when: 'Fri, Dec 18 at 1:30 PM',
    });
  });

  it('falls back to the template when the answer is unusable', async () => {
    expect(await draftReply(scripted('sure!'), base)).toEqual(templateReply(base));
  });

  it('the demo provider drafts every kind', async () => {
    const demo = new DemoAssistantProvider();
    for (const kind of ['confirm', 'offer', 'decline', 'cancelled', 'other'] as const) {
      const draft = await draftReply(demo, { ...base, kind });
      expect(draft.source).toBe('ai');
      expect(draft.text.length).toBeGreaterThan(5);
    }
    expect(replyMessages(base)).toHaveLength(2);
  });
});
