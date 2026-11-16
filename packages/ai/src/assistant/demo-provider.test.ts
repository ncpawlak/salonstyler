import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../types.ts';
import {
  DemoAssistantProvider,
  parseNoteRequest,
  parseScheduleRequest,
  parseStockChange,
} from './demo-provider.ts';
import { COLOR, createFakePort, CUT, KARINA, MARIA, NOW, type FakePort } from './fake-salon.ts';
import { runAssistantTurn, type AssistantTurnResult as AssistantTurn } from './loop.ts';
import type { DraftCard, SlotsCard } from './types.ts';

const prompt = { salonName: 'Studio K', timeZone: 'America/Chicago' };
const UNSUPPORTED = /can't move or cancel booked appointments.*calendar/;

/** Today is Tue, Dec 1 2026 (fake salon); open Tue–Sat 9–5. */
async function ask(text: string, opts: { port?: FakePort; history?: ChatMessage[] } = {}) {
  const port = opts.port ?? createFakePort();
  const turn = await runAssistantTurn({
    llm: new DemoAssistantProvider(),
    tools: { port, now: () => NOW },
    prompt,
    history: opts.history ?? [],
    text,
  });
  return { port, turn };
}

/** Tool calls the demo model made this turn, with their arguments. */
const callsOf = (turn: AssistantTurn) =>
  turn.messages.flatMap((m) =>
    m.role === 'assistant'
      ? (m.toolCalls ?? []).map((c) => ({ name: c.name, args: c.arguments }))
      : [],
  );

/** The reply only mentions days and times that are actually on the slots card. */
function expectHonestSlots(turn: AssistantTurn) {
  const card = turn.cards.find((c): c is SlotsCard => c.type === 'slots');
  if (!card) return;
  const open = card.days.filter((d) => d.slots.length > 0);
  const others = open.filter((d) => d.date !== card.requestedDate);
  for (const time of turn.reply.match(/\b\d{1,2}:\d{2} [AP]M\b/g) ?? []) {
    expect(open.some((d) => d.slots.some((s) => s.time === time))).toBe(true);
  }
  const also = /(?:Also open|Closest openings[^:]*): (.+?)\./.exec(turn.reply)?.[1];
  if (others.length === 0) expect(turn.reply).not.toMatch(/Also open|Closest|nearby/i);
  for (const label of also?.match(/[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}/g) ?? []) {
    expect(others.map((d) => d.label)).toContain(label);
  }
  expect(turn.reply).not.toMatch(/\([^)]*\(/);
}

type Case = {
  text: string;
  tools: { name: string; args?: Record<string, unknown> }[];
  reply?: RegExp;
  not?: RegExp;
};

const CASES: Case[] = [
  {
    text: 'schedule karina for a 6 week followup',
    tools: [
      { name: 'find_client', args: { query: 'karina' } },
      { name: 'find_slots', args: { clientId: KARINA, date: '2027-01-12' } },
    ],
    reply: /Tue, Jan 12/,
  },
  {
    text: 'book karina in 3 weeks',
    tools: [
      { name: 'find_client', args: { query: 'karina' } },
      { name: 'find_slots', args: { date: '2026-12-22' } },
    ],
  },
  {
    text: 'book karina tomorrow',
    tools: [{ name: 'find_client' }, { name: 'find_slots', args: { date: '2026-12-02' } }],
  },
  {
    text: 'fit karina in thursday afternoon',
    tools: [
      { name: 'find_client', args: { query: 'karina' } },
      { name: 'find_slots', args: { date: '2026-12-03', timeOfDay: 'afternoon' } },
    ],
  },
  {
    text: 'schedule karina for dec 18 in the morning',
    tools: [
      { name: 'find_client' },
      { name: 'find_slots', args: { date: '2026-12-18', timeOfDay: 'morning' } },
    ],
  },
  {
    text: 'schedule karina for a cut and color on friday',
    tools: [
      { name: 'find_client', args: { query: 'karina' } },
      { name: 'list_services' },
      {
        name: 'find_slots',
        args: { date: '2026-12-04', services: [{ serviceId: CUT }, { serviceId: COLOR }] },
      },
    ],
  },
  {
    text: "book karina's haircut on 12/18",
    tools: [
      { name: 'find_client', args: { query: 'karina' } },
      { name: 'list_services' },
      { name: 'find_slots', args: { date: '2026-12-18', services: [{ serviceId: CUT }] } },
    ],
    reply: /Women's Haircut on Fri, Dec 18/,
  },
  {
    text: 'schedule maria for dec 15',
    tools: [{ name: 'find_client' }, { name: 'find_slots' }, { name: 'list_services' }],
    reply: /Which service/,
  },
  {
    text: 'schedule Jessica for dec 18',
    tools: [{ name: 'find_client', args: { query: 'Jessica' } }],
    reply: /add them/,
  },
  {
    text: "put karina's color on the 18th",
    tools: [
      { name: 'find_client' },
      { name: 'list_services' },
      { name: 'find_slots', args: { date: '2026-12-18', services: [{ serviceId: COLOR }] } },
    ],
  },
  {
    text: 'schedule karina for the week after christmas',
    tools: [{ name: 'find_client' }, { name: 'list_services' }],
    reply: /Which day should I look at/,
  },
  {
    text: 'book karina on the 45th',
    tools: [{ name: 'find_client' }],
    reply: /Which day should I look at/,
  },
  { text: 'move karina to next friday', tools: [], reply: UNSUPPORTED },
  { text: 'reschedule maria to the 18th', tools: [], reply: UNSUPPORTED },
  { text: 'cancel 3pm', tools: [], reply: UNSUPPORTED },
  { text: "cancel karina's appointment", tools: [], reply: UNSUPPORTED },
  {
    text: "what's open tomorrow",
    tools: [{ name: 'get_day_summary', args: { date: '2026-12-02' } }],
    reply: /Nothing is booked on Wed, Dec 2 yet\. Tell me who it’s for/,
    not: /wide open/,
  },
  {
    text: "what's on dec 18?",
    tools: [{ name: 'get_day_summary', args: { date: '2026-12-18' } }],
    reply: /Fri, Dec 18: 9:00 AM–11:30 AM Maria Garcia; 2:30 PM–4:00 PM Karen Smith\.$/,
  },
  {
    text: 'any openings sunday?',
    tools: [{ name: 'get_day_summary', args: { date: '2026-12-06' } }],
    reply: /off on Sun, Dec 6/,
  },
  {
    text: 'how much 6N do I have?',
    tools: [{ name: 'inventory_lookup', args: { query: '6N' } }],
    reply: /^You have 5 tube of .*6N/,
  },
  {
    text: 'what do I need to reorder?',
    tools: [{ name: 'inventory_lookup', args: { lowStockOnly: true } }],
    reply: /Time to reorder: .*6NB.*Color Extend Shampoo/,
  },
  {
    text: 'used 2 tubes of 6N',
    tools: [{ name: 'adjust_stock', args: { product: '6N', quantity: 2, action: 'use' } }],
    reply: /Drafted −2 tube.*Tap Apply/,
    not: /updated|removed/i,
  },
  {
    text: 'got 6 shampoo in',
    tools: [{ name: 'adjust_stock', args: { product: 'shampoo', quantity: 6, action: 'receive' } }],
    reply: /Drafted \+6/,
  },
  {
    text: 'save formula for karina: 7N + 7G 20 vol, 35 min',
    tools: [
      { name: 'find_client', args: { query: 'karina' } },
      {
        name: 'add_client_note',
        args: { clientId: KARINA, kind: 'formula', text: '7N + 7G 20 vol, 35 min' },
      },
    ],
    reply: /Formula saved to Karina Lopez's profile/,
  },
  {
    text: "I'm running 15 late",
    tools: [{ name: 'running_late', args: { minutes: 15 } }],
  },
  {
    text: 'how did I do last month?',
    tools: [{ name: 'get_sales_report', args: { period: 'last_month' } }],
    reply: /in sales/,
  },
  { text: 'book the 12:30 pm', tools: [], reply: /Demo mode understands/ },
  { text: 'hello', tools: [], reply: /Demo mode understands/ },
];

describe('demo Ask: realistic owner messages', () => {
  it.each(CASES)('$text', async ({ text, tools, reply, not }) => {
    const { turn } = await ask(text);
    const calls = callsOf(turn);
    expect(calls.map((c) => c.name)).toEqual(tools.map((t) => t.name));
    tools.forEach((t, i) => {
      if (t.args) expect(calls[i]!.args).toMatchObject(t.args);
    });
    if (reply) expect(turn.reply).toMatch(reply);
    if (not) expect(turn.reply).not.toMatch(not);
    expectHonestSlots(turn);
  });
});

describe('demo Ask: follow-ups', () => {
  const schedule = () => ask('schedule karina for december 18th');

  it('"a haircut" answers the which-service question', async () => {
    const first = await ask('schedule maria for dec 15');
    const { turn } = await ask('a haircut', { port: first.port, history: first.turn.messages });
    expect(callsOf(turn)).toEqual([
      {
        name: 'find_slots',
        args: { clientId: MARIA, date: '2026-12-15', services: [{ serviceId: CUT }] },
      },
    ]);
    expect(turn.reply).toMatch(/^Maria's Women's Haircut on Tue, Dec 15/);
    expectHonestSlots(turn);
  });

  it('a time that is not on the card is refused, not booked', async () => {
    const first = await schedule();
    const { turn } = await ask('book the 11 pm', {
      port: first.port,
      history: first.turn.messages,
    });
    expect(callsOf(turn)).toEqual([]);
    expect(turn.reply).toMatch(/isn't one of the open slots/);
  });

  it('"change it to <time>" releases the hold and holds the new time', async () => {
    const first = await schedule();
    const port = first.port;
    const held = await ask('book the 12:30 pm', { port, history: first.turn.messages });
    const old = held.turn.cards[0] as DraftCard;
    const other = (first.turn.cards[0] as SlotsCard).days.find(
      (d) => d.date !== '2026-12-18' && d.slots.length,
    )!;
    const { turn } = await ask(`change it to ${other.slots[0]!.time} on ${other.label}`, {
      port,
      history: [...first.turn.messages, ...held.turn.messages],
    });
    expect(callsOf(turn).map((c) => c.name)).toEqual(['cancel_draft', 'propose_booking']);
    expect(port.appointments.find((a) => a.id === old.appointmentId)!.status).toBe('cancelled');
    expect(turn.cards.at(-1)).toMatchObject({
      type: 'draft',
      label: `${other.label} · ${other.slots[0]!.time}`,
    });
    expect(turn.reply).toMatch(/^I've held/);
  });

  it('"cancel 3pm" while a 12:30 hold is live does not release it', async () => {
    const first = await schedule();
    const held = await ask('book the 12:30 pm', { port: first.port, history: first.turn.messages });
    const history = [...first.turn.messages, ...held.turn.messages];
    const wrong = await ask('cancel 3pm', { port: first.port, history });
    expect(callsOf(wrong.turn)).toEqual([]);
    expect(wrong.turn.reply).toMatch(UNSUPPORTED);
    const right = await ask('cancel the 12:30 pm', { port: first.port, history });
    expect(callsOf(right.turn).map((c) => c.name)).toEqual(['cancel_draft']);
    expect(right.turn.reply).toBe('Okay, I released that hold.');
  });

  it('a released hold is not released twice', async () => {
    const first = await schedule();
    const held = await ask('book the 12:30 pm', { port: first.port, history: first.turn.messages });
    const history = [...first.turn.messages, ...held.turn.messages];
    const released = await ask('never mind', { port: first.port, history });
    const again = await ask('never mind', {
      port: first.port,
      history: [...history, ...released.turn.messages],
    });
    expect(callsOf(again.turn)).toEqual([]);
  });
});

describe('demo Ask parsers', () => {
  it.each([
    ['schedule dana for a 6 week followup', { name: 'dana', when: 'a 6 week followup' }],
    ['fit karina in thursday afternoon', { name: 'karina', when: 'thursday afternoon' }],
    ['book dana smith next friday', { name: 'dana smith', when: 'next friday' }],
    ["put karina's color on the 18th", { name: 'karina', when: 'color the 18th' }],
    ['squeeze maria in tomorrow', { name: 'maria', when: 'tomorrow' }],
    ['book the 2:00 PM', null],
    ['book it for friday', null],
  ])('parseScheduleRequest(%j)', (text, expected) => {
    const got = parseScheduleRequest(text);
    if (expected === null) expect(got).toBeNull();
    else expect(got).toMatchObject(expected);
  });

  it('parses notes and stock changes', () => {
    expect(parseNoteRequest('add a note to Dana - prefers mornings')).toEqual({
      kind: 'note',
      name: 'Dana',
      text: 'prefers mornings',
    });
    expect(parseStockChange('threw out a bottle of developer')).toEqual({
      action: 'remove',
      quantity: 1,
      product: 'developer',
    });
    expect(parseStockChange('used two tubes of 6NB')).toEqual({
      action: 'use',
      quantity: 2,
      product: '6NB',
    });
  });
});
