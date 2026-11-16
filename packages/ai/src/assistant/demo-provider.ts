import type { AiProvider } from '../providers.ts';
import type { ChatMessage, ChatResult, LLMProvider, ToolCall } from '../types.ts';
import { nameMatchScore } from './fuzzy.ts';
import { REPLY_PROMPT_TAG } from './reply.ts';
import { RUNNING_LATE_PROMPT_TAG } from './running-late.ts';

/**
 * A deterministic, rule-based stand-in for an LLM, for local development demos and tests only
 * (enabled in the Edge Function by `CHAIRSIDE_AI_DEMO=1` against a local stack). It understands a
 * few phrasings ("schedule karina for december 18th", "book the 2:00 PM", "what's on friday",
 * "never mind") and drives the same tools a real model would.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];
const AMOUNT = `(\\d{1,2}|an?|${NUMBER_WORDS.join('|')})`;
const UNIT = '(day|week|month)s?';
/** "in 6 weeks", "in a month", "in three days". */
const IN_AMOUNT = new RegExp(`\\bin\\s+${AMOUNT}[\\s-]+${UNIT}\\b`);
/** "6 week follow-up", "6-week followup", "6 weeks out", "two weeks from now", "a month later". */
const AMOUNT_OUT = new RegExp(
  `\\b${AMOUNT}[\\s-]+${UNIT}[\\s-]*(?:follow[\\s-]?ups?|check[\\s-]?ins?|out|from\\s+(?:now|today)|later|away)\\b`,
);
const NEXT_UNIT = /\bnext\s+(week|month)\b/;
/** True when the text names a relative date ("in 6 weeks", "a 6 week follow-up", "next month"). */

const amount = (word: string) =>
  /^\d+$/.test(word) ? Number(word) : word.startsWith('a') ? 1 : NUMBER_WORDS.indexOf(word);

function addUnits(base: Date, n: number, unit: string): string {
  if (unit === 'day') return iso(new Date(base.getTime() + n * 86_400_000));
  if (unit === 'week') return iso(new Date(base.getTime() + n * 7 * 86_400_000));
  // Months keep the day of month, clamped to the target month's last day (Jan 31 + 1 → Feb 28).
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(y, m, Math.min(base.getUTCDate(), last))));
}

/**
 * Parses "december 18th", "dec 18", "12/18", "tomorrow", "friday", "in 3 days",
 * "the 18th", "a 6 week follow-up", "next week" or "next month" relative to `today`.
 */
export function parseDemoDate(text: string, today: string): string | null {
  const t = text.toLowerCase();
  const base = new Date(`${today}T00:00:00Z`);
  const next = (month: number, day: number) => {
    let d = new Date(Date.UTC(base.getUTCFullYear(), month, day));
    if (d < base) d = new Date(Date.UTC(base.getUTCFullYear() + 1, month, day));
    return d.getUTCMonth() === month ? iso(d) : null;
  };
  if (/\btoday\b/.test(t)) return today;
  if (/\btomorrow\b/.test(t)) return iso(new Date(base.getTime() + 86_400_000));
  // Before weekdays/months: "6 months" would otherwise read as "mon".
  const rel = IN_AMOUNT.exec(t) ?? AMOUNT_OUT.exec(t);
  if (rel) return addUnits(base, amount(rel[1]!), rel[2]!);
  const nextUnit = NEXT_UNIT.exec(t);
  if (nextUnit) return addUnits(base, 1, nextUnit[1]!);
  const named =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(
      t,
    );
  if (named) return next(MONTHS.indexOf(named[1]!), Number(named[2]));
  const numeric = /\b(\d{1,2})\/(\d{1,2})\b/.exec(t);
  if (numeric) return next(Number(numeric[1]) - 1, Number(numeric[2]));
  // "the 18th": this month if it's still ahead, otherwise next month.
  const ordinal = /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/.exec(t);
  if (ordinal) {
    const day = Number(ordinal[1]);
    const month = base.getUTCMonth() + (day < base.getUTCDate() ? 1 : 0);
    return next(month % 12, day);
  }
  const wd = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/.exec(t);
  if (wd) {
    const diff = (WEEKDAYS.indexOf(wd[1]!) - base.getUTCDay() + 7) % 7;
    return iso(new Date(base.getTime() + diff * 86_400_000));
  }
  return null;
}

type ToolResultMessage = Extract<ChatMessage, { role: 'tool' }>;
type Json = Record<string, unknown>;

const PICK_TIME = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i;
const TIME_OF_DAY = /\b(morning|afternoon|evening)\b/i;
const ASK_DAY =
  'Which day should I look at? Try “friday”, “dec 18”, “in 6 weeks” or “a 6 week follow-up”.';
const UNSUPPORTED_CHANGE =
  "I can't move or cancel booked appointments from here yet. Tap the appointment in your calendar to move or cancel it.";

/** Text that starts with a date phrase: "tomorrow", "next friday", "in 6 weeks", "dec 18", "12/18". */
const DATE_START = new RegExp(
  `(?:today|tomorrow|this\\s|next\\s|in\\s+${AMOUNT}[\\s-]+${UNIT}|${AMOUNT}[\\s-]+${UNIT}|(?:${MONTHS.join('|')})[a-z]*\\.?\\s+\\d|\\d{1,2}/\\d{1,2}|(?:${WEEKDAYS.join('|')})[a-z]*\\b)`.replace(
    // Non-capturing, so it can sit inside other patterns without shifting their groups.
    /\((?!\?)/g,
    '(?:',
  ),
);
const NOT_A_NAME = /^(?:the|that|this|it|option|a|an|me|us|in|someone|somebody)\b|\d/i;
const VERB = '(?:schedule|book|put|fit|squeeze|pencil)';

/**
 * "schedule karina for dec 18", "fit dana in thursday afternoon", "book dana smith next friday",
 * "schedule dana for a 6 week followup" → the client's name and the rest of the request.
 */
export function parseScheduleRequest(text: string): { name: string; when: string } | null {
  const t = text.trim();
  const attempts = [
    new RegExp(`\\b${VERB}\\s+(.+?)\\s+(?:in\\s+)?(?:for|on)\\s+(.+)$`, 'i'),
    /\b(?:fit|squeeze|put)\s+(.+?)\s+in\s+(.+)$/i,
    new RegExp(`\\b${VERB}\\s+(.+?)\\s+(?=${DATE_START.source})(.+)$`, 'i'),
  ];
  for (const re of attempts) {
    const m = re.exec(t);
    if (!m) continue;
    // "karina's haircut on friday": the name ends at the possessive; the rest is the request.
    const [rawName, ...owned] = m[1]!.split(/['’]s\b/i);
    const name = rawName!.trim();
    if (!name || NOT_A_NAME.test(name) || PICK_TIME.test(name)) continue;
    return { name, when: [owned.join(' '), m[2]!].join(' ').trim() };
  }
  return null;
}

/** "save formula for karina: 7N + 7G 20 vol" / "add a note to dana: prefers mornings". */
export function parseNoteRequest(
  text: string,
): { name: string; kind: 'note' | 'formula'; text: string } | null {
  const m =
    /\b(?:save|add|log|note|record)\b(?:\s+(?:a|this|her|his|the))?\s+(formula|note)\s+(?:for|to|on)\s+(.+?)\s*[:\-–]\s*(.+)$/i.exec(
      text.trim(),
    );
  if (!m) return null;
  return {
    kind: m[1]!.toLowerCase() === 'formula' ? 'formula' : 'note',
    name: m[2]!.replace(/'s(?:\s+(?:profile|file|card))?$/i, '').trim(),
    text: m[3]!.trim(),
  };
}

const STOCK_UNITS =
  '(?:tubes?|bottles?|units?|ml|oz|g|grams?|boxes?|jars?|cans?|packs?|bags?|liters?|litres?)';

/** "used 2 tubes of 6N", "got 6 shampoo in", "threw out a bottle of developer". */
export function parseStockChange(
  text: string,
): { product: string; quantity: number; action: 'use' | 'receive' | 'remove' } | null {
  const m = new RegExp(
    `\\b(used|use|got|received|receive|threw out|tossed|binned|broke)\\s+${AMOUNT}\\s+(?:${STOCK_UNITS}\\s+)?(?:of\\s+)?(?:the\\s+)?(.+?)(?:\\s+in)?\\s*\\.?$`,
    'i',
  ).exec(text.trim());
  if (!m) return null;
  const verb = m[1]!.toLowerCase();
  return {
    action: /^(?:used|use)$/.test(verb)
      ? 'use'
      : /^(?:got|received|receive)$/.test(verb)
        ? 'receive'
        : 'remove',
    quantity: amount(m[2]!.toLowerCase()),
    product: m[3]!.trim(),
  };
}

/** Words in a scheduling request that aren't about the date ("a cut and color" → cut, color). */
const FILLER = new Set(
  [
    'a an the for on in at and with to of or plus her his their them him usual regular same',
    'appointment appt appts visit slot time sometime please followup follow up check checkin',
    'out from now later away next this today tomorrow tonight morning afternoon evening',
    'week weeks day days month months st nd rd th another again sometime around early late',
    'monday tuesday wednesday thursday friday saturday sunday tues thur thurs sept',
    'january february march april june july august september october november december',
    ...MONTHS,
    ...WEEKDAYS,
    ...NUMBER_WORDS,
  ].flatMap((s) => s.split(' ')),
);
const serviceWords = (when: string) =>
  when
    .toLowerCase()
    .split(/[^a-z-]+/)
    .filter((w) => w.length >= 3 && !FILLER.has(w));

/** Menu items named in `text` ("cut and color" → haircut + color), best match per word. */
function matchServices(
  text: string,
  services: { id: string; name: string }[],
): { serviceId: string }[] {
  const ids: string[] = [];
  for (const word of serviceWords(text)) {
    const best = services
      .map((s) => ({ s, score: nameMatchScore(word, s.name) }))
      .sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= 0.65 && !ids.includes(best.s.id)) ids.push(best.s.id);
  }
  return ids.map((serviceId) => ({ serviceId }));
}

/** "a", "a and b", "a, b and c". */
const listOf = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

const parse = (s: string): Json => {
  try {
    return JSON.parse(s) as Json;
  } catch {
    return {};
  }
};

export class DemoAssistantProvider implements LLMProvider {
  readonly id: AiProvider = 'openai';
  readonly model = 'chairside-demo';
  private counter = 0;

  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    const system = messages.find((m) => m.role === 'system');
    if (typeof system?.content === 'string' && system.content.startsWith(RUNNING_LATE_PROMPT_TAG)) {
      return this.runningLate(messages);
    }
    if (typeof system?.content === 'string' && system.content.startsWith(REPLY_PROMPT_TAG)) {
      return this.reply(messages);
    }
    const today =
      (system && /\((\d{4}-\d{2}-\d{2})\)/.exec(system.content as string)?.[1]) ??
      new Date().toISOString().slice(0, 10);
    const lastUserIndex = messages.map((m) => m.role).lastIndexOf('user');
    const user = messages[lastUserIndex];
    const text = typeof user?.content === 'string' ? user.content : '';
    const since = messages.slice(lastUserIndex + 1);
    const lastTool = [...since].reverse().find((m): m is ToolResultMessage => m.role === 'tool');
    return lastTool
      ? this.afterTool(lastTool, messages, text, today)
      : this.start(messages, text, today);
  }

  /** Drafts {drafts:[…]} JSON for the running-late prompt, like a real model would. */
  private runningLate(messages: ChatMessage[]): ChatResult {
    const user = messages.find((m) => m.role === 'user');
    const input = parse(typeof user?.content === 'string' ? user.content : '{}');
    const minutes = Number(input.runningLateMinutes) || 0;
    type Item = {
      appointmentId: string;
      clientFirstName: string | null;
      originalStart: string;
      newStart: string;
    };
    const items = (input.appointments as Item[] | undefined) ?? [];
    const drafts = items.map((a) => {
      const hey = a.clientFirstName ? `Hey ${a.clientFirstName}!` : 'Hey!';
      return {
        appointmentId: a.appointmentId,
        text:
          a.newStart === a.originalStart
            ? `${hey} Quick heads-up: I'm about ${minutes} minutes behind, but we're still on for ${a.originalStart}.`
            : `${hey} I'm running a little behind today. Could you come in at ${a.newStart} instead of ${a.originalStart}? So sorry!`,
      };
    });
    return this.say(JSON.stringify({ drafts }));
  }

  private reply(messages: ChatMessage[]): ChatResult {
    const user = messages.find((m) => m.role === 'user');
    const input = parse(typeof user?.content === 'string' ? user.content : '{}');
    const name = typeof input.clientFirstName === 'string' ? input.clientFirstName : null;
    const when = typeof input.when === 'string' ? input.when : null;
    const hey = name ? `Hey ${name}!` : 'Hey!';
    const text =
      input.kind === 'confirm' && when
        ? `${hey} You're all booked for ${when}. Can't wait to see you!`
        : input.kind === 'offer' && when
          ? `${hey} I could do ${when}. Would that work?`
          : input.kind === 'cancelled'
            ? `${hey} Got it, you're cancelled. Hope to see you soon!`
            : input.kind === 'decline'
              ? `${hey} So sorry, I'm all booked up then.`
              : `${hey} Thanks for reaching out!`;
    return this.say(JSON.stringify({ text }));
  }

  private call(name: string, args: Json): ChatResult {
    const toolCalls: ToolCall[] = [{ id: `demo_${++this.counter}`, name, arguments: args }];
    return { ...this.base('tool_calls'), type: 'tool_calls', text: null, toolCalls };
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

  private lastResult(messages: ChatMessage[], name: string): Json | null {
    const m = [...messages].reverse().find((x) => x.role === 'tool' && x.name === name);
    return m && m.role === 'tool' ? parse(m.content) : null;
  }

  private lastArgs(messages: ChatMessage[], name: string): Json | null {
    for (const m of [...messages].reverse()) {
      if (m.role !== 'assistant') continue;
      const call = m.toolCalls?.find((c) => c.name === name);
      if (call) return call.arguments;
    }
    return null;
  }

  /** Messages since the owner's latest message (this turn's tool calls and results). */
  private turn(messages: ChatMessage[]): ChatMessage[] {
    return messages.slice(messages.map((m) => m.role).lastIndexOf('user') + 1);
  }

  /** The one client find_client was sure about this turn. */
  private confidentClient(turn: ChatMessage[]): string | null {
    const found = this.lastResult(turn, 'find_client');
    const sure = ((found?.matches as { id: string; confidence: number }[]) ?? []).filter(
      (m) => m.confidence >= 0.85,
    );
    return sure.length === 1 ? sure[0]!.id : null;
  }

  private slotArgs(clientId: string, when: string, today: string): Json {
    const timeOfDay = TIME_OF_DAY.exec(when)?.[1]?.toLowerCase();
    return {
      clientId,
      date: parseDemoDate(when, today) ?? today,
      ...(timeOfDay ? { timeOfDay } : {}),
    };
  }

  /** The newest draft from propose_booking that hasn't been released since. */
  private liveDraft(messages: ChatMessage[]): Json | null {
    const draft = this.lastResult(messages, 'propose_booking');
    if (!draft?.appointmentId) return null;
    const released = this.lastArgs(messages, 'cancel_draft');
    const confirmedOrReleased = released?.appointmentId === draft.appointmentId;
    return confirmedOrReleased ? null : draft;
  }

  /** "book the 2:00 PM" against the last slots card → propose_booking, or a reason it can't. */
  private pickSlot(messages: ChatMessage[], t: string, today: string): ChatResult | null {
    const pickTime = PICK_TIME.exec(t);
    const slots = this.lastResult(messages, 'find_slots');
    if (!pickTime || !slots?.days) return null;
    const want = pickTime[1]!.replace(/\s+/g, '').toLowerCase();
    const date = parseDemoDate(t, today);
    const days = (slots.days as { date: string; slots: { start: string; time: string }[] }[]) ?? [];
    const ordered = date
      ? days.filter((d) => d.date === date)
      : [...days].sort(
          (a, b) => Number(b.date === slots.requestedDate) - Number(a.date === slots.requestedDate),
        );
    for (const day of ordered) {
      const slot = day.slots.find((s) => {
        const label = s.time.replace(/\s+/g, '').toLowerCase();
        return label === want || label.replace(':00', '') === want;
      });
      if (slot) {
        const client = slots.client as { id: string } | null;
        if (!client) return this.say('Who is this for?');
        return this.call('propose_booking', {
          clientId: client.id,
          start: slot.start,
          services: slots.services,
        });
      }
    }
    return this.say(`${pickTime[1]} isn't one of the open slots. Tap one of the cards above.`);
  }

  private start(messages: ChatMessage[], text: string, today: string): ChatResult {
    const t = text.trim();
    const late =
      /\b(?:running|am|i'?m)\s+(?:about\s+)?(\d{1,3})\s*(?:min(?:ute)?s?\s+)?(?:late|behind)\b/i.exec(
        t,
      );
    if (late) return this.call('running_late', { minutes: Number(late[1]) });

    if (
      /\b(how (?:did|am|have) (?:i|we) (?:do|done|doing)|report|revenue|sales|takings)\b/i.test(t)
    ) {
      const when = /\b(this|last)\s+(week|month|quarter|year)\b/i.exec(t);
      const period = when ? `${when[1]!.toLowerCase()}_${when[2]!.toLowerCase()}` : 'last_month';
      return this.call('get_sales_report', { period });
    }

    const note = parseNoteRequest(t);
    if (note) return this.call('find_client', { query: note.name });

    if (/\b(reorder|re-order|running low|low on|need to order|order more)\b/i.test(t)) {
      return this.call('inventory_lookup', { lowStockOnly: true });
    }
    const stockQuery =
      /\bhow (?:much|many)\s+(?:of\s+)?(?:the\s+)?(.+?)\s+(?:do (?:i|we) have|is left|are left|left|in stock|on hand)\b/i.exec(
        t,
      );
    if (stockQuery) return this.call('inventory_lookup', { query: stockQuery[1]!.trim() });
    const stock = parseStockChange(t);
    if (stock) return this.call('adjust_stock', stock);

    // The assistant can't move or cancel booked appointments; say so instead of pretending.
    if (/\b(move|reschedule|re-schedule|push back|bump|shift)\b/i.test(t)) {
      return this.say(UNSUPPORTED_CHANGE);
    }

    if (/\b(never ?mind|cancel|scrap|release|drop|change|switch)\b/i.test(t)) {
      const draft = this.liveDraft(messages);
      const time = PICK_TIME.exec(t)?.[1]?.replace(/\s+/g, '').toLowerCase();
      const draftLabel = String(draft?.label ?? '')
        .replace(/\s+/g, '')
        .toLowerCase();
      const changing = /\b(change|switch)\b/i.test(t);
      // "cancel 3pm" only releases the draft when it's the 3 PM one; otherwise it's a real booking.
      if (draft && (!time || changing || draftLabel.includes(time))) {
        return this.call('cancel_draft', { appointmentId: draft.appointmentId });
      }
      if (/\bcancel\b/i.test(t)) return this.say(UNSUPPORTED_CHANGE);
    }

    const schedule = parseScheduleRequest(t);
    if (schedule) return this.call('find_client', { query: schedule.name });

    if (/\b(book|take|grab|hold|do|want)\b/i.test(t) && PICK_TIME.test(t)) {
      const draft = this.liveDraft(messages);
      // Picking another time while a draft is held: release it first (afterTool re-picks).
      if (draft && this.pickSlot(messages, t, today)?.toolCalls[0]?.name === 'propose_booking') {
        return this.call('cancel_draft', { appointmentId: draft.appointmentId });
      }
      const picked = this.pickSlot(messages, t, today);
      if (picked) return picked;
    }

    const services = this.lastResult(messages, 'list_services');
    const pendingSlots = this.lastArgs(messages, 'find_slots');
    if (services && pendingSlots) {
      const matched = matchServices(t, (services.services as { id: string; name: string }[]) ?? []);
      if (matched.length) return this.call('find_slots', { ...pendingSlots, services: matched });
    }

    const asksOpen = /\b(open|free|available|availability|openings?)\b/i.test(t);
    const day =
      /\b(what'?s|what is|how'?s|show|am i|anything|any)\b/i.test(t) || asksOpen
        ? parseDemoDate(t, today)
        : null;
    if (day || /\bmy day\b/i.test(t)) return this.call('get_day_summary', { date: day ?? today });

    return this.say(
      'Demo mode understands things like “schedule Karina for December 18th”, “fit Dana in Thursday afternoon”, “book the 2:00 PM”, “what’s on Friday?”, “how much 6N do I have?” or “I’m running 15 late”.',
    );
  }

  private afterTool(
    tool: ToolResultMessage,
    messages: ChatMessage[],
    text: string,
    today: string,
  ): ChatResult {
    const result = parse(tool.content);
    const error = result.error as { code: string; message: string } | undefined;

    switch (tool.name) {
      case 'get_sales_report': {
        if (error) return this.say(error.message);
        const top = (result.topServices as { name: string }[] | undefined)?.[0];
        const clients = result.clients as { new: number; returning: number };
        const appts = result.appointments as { noShows: number; cancelled: number };
        return this.say(
          `${String(result.from)} to ${String(result.to)}: ${String(result.sales)} in sales ` +
            `(${String(result.services)} services, ${String(result.retail)} retail) plus ` +
            `${String(result.tips)} in tips over ${String(result.checkouts)} checkouts` +
            (result.averageTicket ? `, ${String(result.averageTicket)} average ticket` : '') +
            `. ${clients.new} new and ${clients.returning} returning clients` +
            (top ? `; ${top.name} was your top service` : '') +
            `. ${appts.noShows} no-shows, ${appts.cancelled} cancellations` +
            (result.rebookRate ? `, ${String(result.rebookRate)} rebooked.` : '.'),
        );
      }
      case 'find_client': {
        const matches =
          (result.matches as { id: string; name: string; confidence: number }[]) ?? [];
        const confident = matches.filter((m) => m.confidence >= 0.85);
        if (confident.length === 1) {
          const client = confident[0]!;
          const note = parseNoteRequest(text);
          if (note) {
            return this.call('add_client_note', {
              clientId: client.id,
              kind: note.kind,
              text: note.text,
            });
          }
          const when = parseScheduleRequest(text)?.when ?? text;
          // "a cut and color on friday": look the services up before searching.
          if (serviceWords(when).length) return this.call('list_services', {});
          if (!parseDemoDate(when, today)) return this.say(ASK_DAY);
          return this.call('find_slots', this.slotArgs(client.id, when, today));
        }
        if (confident.length > 1) {
          return this.say(`Which one: ${confident.map((m) => m.name).join(' or ')}?`);
        }
        const query = this.lastArgs(messages, 'find_client')?.query ?? 'that name';
        return this.say(
          matches.length
            ? `I couldn't find "${String(query)}" for sure. Did you mean ${matches.map((m) => m.name).join(' or ')}? Or add them as a new client.`
            : `I don't have a client named "${String(query)}" yet. Want me to add them?`,
        );
      }
      case 'find_slots': {
        if (error?.code === 'service_required') return this.call('list_services', {});
        if (error) return this.say(error.message);
        const days =
          (result.days as { date: string; label: string; slots: { time: string }[] }[]) ?? [];
        const requested = days.find((d) => d.date === result.requestedDate);
        const client = (result.client as { name: string } | null)?.name;
        const first = client?.split(' ')[0];
        const who = first ? ` for ${first}` : '';
        const service = String(result.serviceSummary ?? '').split(' · ')[0];
        const offset = (d: { date: string }) =>
          Math.abs(Date.parse(d.date) - Date.parse(String(result.requestedDate)));
        const others = days
          .filter((d) => d !== requested && d.slots.length > 0)
          .sort((a, b) => offset(a) - offset(b));
        if (requested && requested.slots.length > 0) {
          const times = requested.slots.map((s) => s.time);
          const what = service ? `${first ? `${first}'s ` : ''}${service}` : `An opening${who}`;
          const also = others.length
            ? ` Also open: ${listOf(others.slice(0, 3).map((d) => d.label))}.`
            : '';
          return this.say(
            `${what} on ${requested.label}: ${listOf(times)} ${times.length === 1 ? 'is' : 'are'} open.${also} Tap a time to hold it.`,
          );
        }
        const nearby = others.slice(0, 2);
        return this.say(
          `${String(result.requestedNote ?? 'Nothing open that day.')}${
            nearby.length
              ? ` Closest openings${who}: ${listOf(nearby.map((d) => `${d.label} at ${d.slots[0]!.time}`))}.`
              : ' Nothing open in the next few weeks either.'
          }`,
        );
      }
      case 'list_services': {
        const list = (result.services as { id: string; name: string }[]) ?? [];
        const turn = this.turn(messages);
        const askedFor = this.lastResult(turn, 'find_slots');
        const client = this.confidentClient(turn);
        const pending =
          this.lastArgs(turn, 'find_slots') ??
          (client ? this.slotArgs(client, parseScheduleRequest(text)?.when ?? text, today) : null);
        const matched = matchServices(parseScheduleRequest(text)?.when ?? text, list);
        if (pending && matched.length)
          return this.call('find_slots', { ...pending, services: matched });
        // Nothing on the menu matched the extra words: fall back to the client's usual service,
        // unless the words were a date we can't read ("the week after christmas").
        if (pending && !askedFor) {
          if (!parseDemoDate(parseScheduleRequest(text)?.when ?? text, today))
            return this.say(ASK_DAY);
          return this.call('find_slots', pending);
        }
        return this.say(
          `Which service should I book? For example: ${list
            .slice(0, 5)
            .map((s) => s.name)
            .join(', ')}.`,
        );
      }
      case 'propose_booking':
        if (error) return this.say(`I couldn't hold that: ${error.message}`);
        return this.say(
          `I've held ${String(result.label)} for ${String(result.serviceSummary)}. Tap Confirm to book it, or Change to pick another time.`,
        );
      case 'cancel_draft': {
        if (error) return this.say(error.message);
        // "change it to 2pm" / "book the 2pm instead": the old hold is gone, now hold the new time.
        if (PICK_TIME.test(text) && !/\b(cancel|never ?mind|scrap|release|drop)\b/i.test(text)) {
          const picked = this.pickSlot(messages, text, today);
          if (picked?.toolCalls[0]) return picked;
        }
        return this.say(
          /\b(change|switch)\b/i.test(text)
            ? 'Okay, I released that hold. Tap another time above, or tell me which one.'
            : 'Okay, I released that hold.',
        );
      }
      case 'inventory_lookup': {
        if (error) return this.say(error.message);
        type Row = { name: string; onHand: string; low: boolean; order?: string };
        const reorder = result.reorder as Row[] | undefined;
        if (reorder) {
          return this.say(
            reorder.length
              ? `Time to reorder: ${listOf(reorder.map((p) => `${p.name} (${p.onHand} left, order ${p.order})`))}.`
              : 'Nothing is at or below its reorder point.',
          );
        }
        const matches = (result.matches as Row[] | undefined) ?? [];
        if (!matches.length) return this.say(String(result.note));
        const [top, ...rest] = matches;
        return this.say(
          `You have ${top!.onHand} of ${top!.name}${top!.low ? ', which is at or below its reorder point' : ''}.` +
            (rest.length
              ? ` Also similar: ${listOf(rest.slice(0, 2).map((p) => `${p.name} (${p.onHand})`))}.`
              : ''),
        );
      }
      case 'adjust_stock':
        if (error) return this.say(error.message);
        return this.say(
          `Drafted ${String(result.change)} for ${String(result.product)} (${String(result.onHand)} now, ${String(result.afterApply)} after). Tap Apply to update stock.`,
        );
      case 'add_client_note':
        if (error) return this.say(error.message);
        return this.say(
          `${result.kind === 'formula' ? 'Formula' : 'Note'} saved to ${(result.client as { name: string }).name}'s profile.`,
        );
      case 'running_late': {
        if (error) return this.say(error.message);
        const moves = (result.moves as { client: string; change: string }[]) ?? [];
        if (moves.length === 0) return this.say('Nobody left today needs to move.');
        return this.say(
          `${moves.map((m) => `${m.client.split(' ')[0]} ${m.change}`).join('; ')}. Tap Review to check the texts and update the calendar.`,
        );
      }
      case 'get_day_summary': {
        if (error) return this.say(error.message);
        type Appt = { time: string; client: string | null; status: string };
        const appts = (result.appointments as Appt[]) ?? [];
        if (result.status === 'closed' && appts.length === 0) {
          return this.say(`You're off on ${String(result.label)}.`);
        }
        const tag = (a: Appt) =>
          a.status === 'held' ? ' (held)' : a.status === 'requested' ? ' (requested)' : '';
        // Open times depend on the service, so the summary never claims specific openings.
        const hint = /\b(open|free|available|availability|openings?)\b/i.test(text)
          ? ' Tell me who it’s for (or the service) and I’ll find exact open times.'
          : '';
        return this.say(
          (appts.length
            ? `${String(result.label)}: ${appts.map((a) => `${a.time} ${a.client ?? 'Blocked'}${tag(a)}`).join('; ')}.`
            : `Nothing is booked on ${String(result.label)} yet.`) + hint,
        );
      }
      default:
        return this.say(error ? error.message : 'Done.');
    }
  }
}
