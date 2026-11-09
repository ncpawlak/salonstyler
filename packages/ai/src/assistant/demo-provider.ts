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

/** Parses "december 18th", "dec 18", "12/18", "tomorrow", "friday" relative to `today`. */
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
  const named =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(
      t,
    );
  if (named) return next(MONTHS.indexOf(named[1]!), Number(named[2]));
  const numeric = /\b(\d{1,2})\/(\d{1,2})\b/.exec(t);
  if (numeric) return next(Number(numeric[1]) - 1, Number(numeric[2]));
  const wd = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/.exec(t);
  if (wd) {
    const diff = (WEEKDAYS.indexOf(wd[1]!) - base.getUTCDay() + 7) % 7;
    return iso(new Date(base.getTime() + diff * 86_400_000));
  }
  return null;
}

type ToolResultMessage = Extract<ChatMessage, { role: 'tool' }>;
type Json = Record<string, unknown>;

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

  private start(messages: ChatMessage[], text: string, today: string): ChatResult {
    const t = text.trim();
    const late =
      /\b(?:running|am|i'?m)\s+(?:about\s+)?(\d{1,3})\s*(?:min(?:ute)?s?\s+)?(?:late|behind)\b/i.exec(
        t,
      );
    if (late) return this.call('running_late', { minutes: Number(late[1]) });

    const schedule = /\b(?:schedule|book|put)\s+(.+?)\s+(?:in\s+)?(?:for|on)\s+(.+)$/i.exec(t);
    if (schedule && !/^(the|that|option)\b/i.test(schedule[1]!)) {
      return this.call('find_client', { query: schedule[1]!.replace(/'s$/i, '') });
    }

    const pickTime = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i.exec(t);
    const slots = this.lastResult(messages, 'find_slots');
    if (/\b(book|take|grab|do)\b/i.test(t) && pickTime && slots) {
      const want = pickTime[1]!.replace(/\s+/g, '').toLowerCase();
      const date = parseDemoDate(t, today);
      const days =
        (slots.days as { date: string; slots: { start: string; time: string }[] }[]) ?? [];
      const ordered = date
        ? days.filter((d) => d.date === date)
        : [...days].sort(
            (a, b) =>
              Number(b.date === slots.requestedDate) - Number(a.date === slots.requestedDate),
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

    if (/\b(never ?mind|cancel|scrap|change)\b/i.test(t)) {
      const draft = this.lastResult(messages, 'propose_booking');
      if (draft?.appointmentId) {
        return this.call('cancel_draft', { appointmentId: draft.appointmentId });
      }
    }

    const services = this.lastResult(messages, 'list_services');
    const pendingSlots = this.lastArgs(messages, 'find_slots');
    if (services && pendingSlots) {
      const list = (services.services as { id: string; name: string }[]) ?? [];
      const best = list
        .map((s) => ({ s, score: nameMatchScore(t, s.name) }))
        .sort((a, b) => b.score - a.score)[0];
      if (best && best.score >= 0.55) {
        return this.call('find_slots', { ...pendingSlots, services: [{ serviceId: best.s.id }] });
      }
    }

    const day = /\b(what'?s|how'?s|show|am i)\b/i.test(t) ? parseDemoDate(t, today) : null;
    if (day || /\bmy day\b/i.test(t)) return this.call('get_day_summary', { date: day ?? today });

    return this.say(
      'Demo mode understands things like “schedule Karina for December 18th”, “book the 2:00 PM”, or “what’s on Friday?”.',
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
      case 'find_client': {
        const matches =
          (result.matches as { id: string; name: string; confidence: number }[]) ?? [];
        const confident = matches.filter((m) => m.confidence >= 0.85);
        if (confident.length === 1) {
          const date = parseDemoDate(text, today) ?? today;
          return this.call('find_slots', { clientId: confident[0]!.id, date });
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
        const who = client ? ` for ${client.split(' ')[0]}` : '';
        const service = String(result.serviceSummary ?? '').split(' · ')[0];
        if (requested && requested.slots.length > 0) {
          const times = requested.slots.map((s) => s.time).join(', ');
          return this.say(
            `${requested.label}${who} (${service}): ${times} are open. Nearby days are below too. Tap one to hold it.`,
          );
        }
        const nearby = days.filter((d) => d.slots.length > 0).slice(0, 2);
        return this.say(
          `${String(result.requestedNote ?? 'Nothing open that day.')}${
            nearby.length
              ? ` Closest openings${who}: ${nearby.map((d) => `${d.label} at ${d.slots[0]!.time}`).join(', ')}.`
              : ' Nothing nearby either; try another week.'
          }`,
        );
      }
      case 'list_services': {
        const list = (result.services as { name: string }[]) ?? [];
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
          `I've held ${String(result.label)} (${String(result.serviceSummary)}). Tap Confirm to book it, or Change to pick another time.`,
        );
      case 'cancel_draft':
        return this.say(error ? error.message : 'Okay, I released that hold.');
      case 'running_late': {
        if (error) return this.say(error.message);
        const moves = (result.moves as { client: string; change: string }[]) ?? [];
        if (moves.length === 0) return this.say('Nobody left today needs to move.');
        return this.say(
          `${moves.map((m) => `${m.client.split(' ')[0]} ${m.change}`).join('; ')}. Tap Review to check the texts and update the calendar.`,
        );
      }
      case 'get_day_summary': {
        const appts = (result.appointments as { time: string; client: string | null }[]) ?? [];
        if (result.status === 'closed' && appts.length === 0) {
          return this.say(`You're off on ${String(result.label)}.`);
        }
        return this.say(
          appts.length
            ? `${String(result.label)}: ${appts.map((a) => `${a.time} ${a.client ?? 'Blocked'}`).join('; ')}.`
            : `${String(result.label)} is wide open.`,
        );
      }
      default:
        return this.say(error ? error.message : 'Done.');
    }
  }
}
