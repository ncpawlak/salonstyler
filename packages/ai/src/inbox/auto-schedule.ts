/**
 * Auto-Schedule (#84): the stylist taps a captured request ("any chance we can move my appointment
 * to next week? Mornings are best") and gets the best slots for it, or a clear "doesn't fit" with
 * the nearest alternatives. The salon's model only interprets *when* the client can come in; the
 * engine (`suggestSlots` in `@chairside/core/scheduling`) does every bit of slot math and ranks
 * the openings by the request and the client's booking habits. Nothing is booked here: the app
 * shows the list and the stylist's tap books it (`schedule_captured_request`).
 *
 * Without a usable model (no key, budget spent, provider error, local demo) the window comes from
 * the request's stored parse plus simple phrase rules, so the button always answers.
 */
import {
  addDays,
  type BookingSegment,
  formatLocalDate,
  parseLocalDate,
  planBooking,
  toSalonDate,
  type TimeOfDay,
} from '@chairside/core';
import { rebookInterval, type RebookService } from '@chairside/core/rebook';
import {
  analyzeHabits,
  dueDate,
  formatTime12,
  hasHabits,
  suggestSlots,
  type RequestWindow,
  type SuggestionReason,
  type Weekday,
} from '@chairside/core/scheduling';
import type { AppointmentServiceSnapshot } from '@chairside/db/appointments';
import { z } from 'zod';

import { formatDayLabel } from '../assistant/tools.ts';
import { resolveItems, usualItems } from '../assistant/menu.ts';
import type { AssistantPort, BookingItem } from '../assistant/types.ts';
import { AiProviderError } from '../http.ts';
import { createProvider as defaultCreateProvider } from '../registry.ts';
import type { AiErrorBody, AiServiceDeps } from '../server/handler.ts';
import type { ChatMessage, LLMProvider, TokenUsage, ToolDefinition } from '../types.ts';
import { type CaptureDeps, formatSlotLabel, type InboxPort } from './handler.ts';
import { extractJson } from './parse.ts';

const DAY = 86_400_000;
const WEEKDAY_WORDS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export const autoScheduleSchema = z.object({
  action: z.literal('auto_schedule'),
  salonId: z.uuid(),
  requestId: z.uuid(),
});
export type AutoScheduleRequest = z.infer<typeof autoScheduleSchema>;

/** True for a body meant for Auto-Schedule. */
export function isAutoSchedule(rawBody: unknown): boolean {
  return (
    !!rawBody &&
    typeof rawBody === 'object' &&
    (rawBody as { action?: unknown }).action === 'auto_schedule'
  );
}

/** A captured request as stored (`captured_requests`). */
export interface StoredCapturedRequest {
  id: string;
  status: string;
  intent: 'booking' | 'reschedule' | 'cancel';
  message: string;
  parsed: Record<string, unknown>;
  clientId: string | null;
  /** The `requested` hold the pipeline made, if any. */
  appointmentId: string | null;
  targetAppointmentId: string | null;
  receivedAt: string;
}

export interface AutoSchedulePort extends InboxPort, Pick<AssistantPort, 'clientOverrides'> {
  getCapturedRequest(id: string): Promise<StoredCapturedRequest | null>;
  /** `services.rebook_interval_days` by service id (#42). */
  serviceRebookIntervals(): Promise<Map<string, number | null>>;
}

export interface AutoScheduleDeps
  extends
    Pick<
      CaptureDeps,
      'loadConfig' | 'tokensUsedThisMonth' | 'recordUsage' | 'createProvider' | 'demo' | 'now'
    >,
    Pick<AiServiceDeps, 'getMemberRole'> {
  createPort(salonId: string): AutoSchedulePort;
  createProvider?: typeof defaultCreateProvider;
}

/** When the client can come in, as the model (or the fallback rules) understood it. */
export interface SchedulingWindow {
  /** Salon-local dates, inclusive; null when the client didn't say. */
  dateFrom: string | null;
  dateTo: string | null;
  timeOfDay: TimeOfDay | null;
  /** `HH:MM` when they named a clock time. */
  time: string | null;
  /** 0 = Sunday; empty = any day. */
  weekdays: Weekday[];
}

export interface AutoScheduleSuggestion {
  start: string;
  end: string;
  localDate: string;
  localTime: string;
  /** "Mon, Dec 7 · 9:00 AM". */
  label: string;
  tentative: boolean;
  reasons: SuggestionReason[];
  /** Ready for `schedule_captured_request` (includes buffers). */
  segments: BookingSegment[];
}

export interface AutoScheduleResponse {
  ok: true;
  requestId: string;
  intent: 'booking' | 'reschedule';
  interpreter: 'llm' | 'demo' | 'parsed';
  timeZone: string;
  window: (SchedulingWindow & { label: string }) | null;
  /** Whether anything fits inside the window (null without one). */
  fits: boolean | null;
  services: AppointmentServiceSnapshot[];
  /** "All-over Color + Women's Haircut". */
  serviceSummary: string;
  priceCents: number | null;
  /** The appointment a reschedule moves. */
  moving: { appointmentId: string; startsAt: string; label: string } | null;
  suggestions: AutoScheduleSuggestion[];
}

export type AutoScheduleResult =
  | { status: 200; body: AutoScheduleResponse }
  | { status: 400 | 403 | 404 | 409 | 422 | 500; body: AiErrorBody };

const fail = (
  status: Exclude<AutoScheduleResult['status'], 200>,
  code: string,
  message: string,
): AutoScheduleResult => ({ status, body: { error: { code, message } } });

// ---------------------------------------------------------------------------------------------
// Interpretation
// ---------------------------------------------------------------------------------------------

export interface WindowContext {
  /** Salon-local `YYYY-MM-DD`. */
  today: string;
  todayLabel: string;
  timeZone: string;
  salonName: string;
  /** Salon-local date the message was sent; relative days resolve from it. */
  sentOn: string;
  /** "Thu, Nov 12 · 11:00 AM" for a reschedule. */
  currentAppointment: string | null;
}

export const SUBMIT_WINDOW_TOOL: ToolDefinition = {
  name: 'submit_window',
  description: 'Record when the client can come in. Call exactly once.',
  parameters: {
    type: 'object',
    properties: {
      dateFrom: {
        type: ['string', 'null'],
        description:
          'First day that works, YYYY-MM-DD. "next week" is next Monday; a single day is both dateFrom and dateTo. Null if they give no days.',
      },
      dateTo: {
        type: ['string', 'null'],
        description: 'Last day that works, YYYY-MM-DD (inclusive). "next week" ends on Sunday.',
      },
      weekdays: {
        type: 'array',
        description:
          'Days of the week they can do, 0 = Sunday … 6 = Saturday ("mondays" = [1], "weekends" = [0, 6]). Empty if any day.',
        items: { type: 'integer', minimum: 0, maximum: 6 },
      },
      timeOfDay: {
        type: ['string', 'null'],
        enum: ['morning', 'afternoon', 'evening', null],
      },
      time: {
        type: ['string', 'null'],
        description: 'A clock time they name, as 24-hour HH:MM ("2pm" is "14:00"), or null.',
      },
    },
    required: ['dateFrom', 'dateTo', 'weekdays', 'timeOfDay', 'time'],
  },
};

export function windowPrompt(ctx: WindowContext): string {
  return [
    `You read a client's text to ${ctx.salonName}, a hair salon, and record when they can come in by calling submit_window.`,
    `Today is ${ctx.todayLabel} (${ctx.today}), time zone ${ctx.timeZone}.`,
    ctx.sentOn < ctx.today
      ? `The message was sent on ${ctx.sentOn}. Resolve relative days ("tomorrow", "next week") from that date.`
      : 'Resolve relative days ("tomorrow", "next week") from today.',
    ...(ctx.currentAppointment
      ? [`They are moving their appointment on ${ctx.currentAppointment}.`]
      : []),
    'You only interpret the message. Never suggest or choose a time; the scheduling engine does that.',
  ].join('\n');
}

const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullish()
  .catch(null);

export const windowSchema = z.object({
  dateFrom: localDate,
  dateTo: localDate,
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).nullish().catch(null),
  timeOfDay: z.enum(['morning', 'afternoon', 'evening']).nullish().catch(null),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullish()
    .catch(null),
});

/** Cleans a window: one-sided ranges, reversed ranges and past days. Null if unusable. */
export function normalizeWindow(raw: unknown, today: string): SchedulingWindow | null {
  const parsed = windowSchema.safeParse(raw);
  if (!parsed.success) return null;
  let from = parsed.data.dateFrom ?? parsed.data.dateTo ?? null;
  let to = parsed.data.dateTo ?? parsed.data.dateFrom ?? null;
  if (from && to && to < from) [from, to] = [to, from];
  if (to && to < today) [from, to] = [null, null];
  else if (from && from < today) from = today;
  return {
    dateFrom: from,
    dateTo: to,
    weekdays: [...new Set(parsed.data.weekdays ?? [])].sort() as Weekday[],
    timeOfDay: parsed.data.timeOfDay ?? null,
    time: parsed.data.time ?? null,
  };
}

export async function interpretWithLlm(
  llm: LLMProvider,
  message: string,
  ctx: WindowContext,
): Promise<{ window: SchedulingWindow | null; usage: TokenUsage; model: string }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: windowPrompt(ctx) },
    { role: 'user', content: message },
  ];
  const result = await llm.chat(messages, [SUBMIT_WINDOW_TOOL], {
    maxOutputTokens: 200,
    temperature: 0,
  });
  const call = result.toolCalls.find((c) => c.name === SUBMIT_WINDOW_TOOL.name);
  const raw = call ? call.arguments : extractJson(result.text);
  return { window: normalizeWindow(raw, ctx.today), usage: result.usage, model: result.model };
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/**
 * The window from the stored parse (a day, a time of day, a clock time) plus a few phrases the
 * parse has no field for: "next week", "this week", "weekends", "mondays".
 */
export function fallbackWindow(
  message: string,
  parsed: Record<string, unknown>,
  ctx: Pick<WindowContext, 'today' | 'sentOn'>,
): SchedulingWindow {
  const t = message.toLowerCase();
  const base = ctx.sentOn < ctx.today ? ctx.sentOn : ctx.today;
  const baseDate = parseLocalDate(base);
  const dow = new Date(Date.UTC(baseDate.year, baseDate.month - 1, baseDate.day)).getUTCDay();
  const date = (offset: number) => formatLocalDate(addDays(baseDate, offset));

  let from: string | null = null;
  let to: string | null = null;
  const toMonday = (8 - dow) % 7 || 7;
  if (/\bnext week\b/.test(t)) [from, to] = [date(toMonday), date(toMonday + 6)];
  else if (/\bthis week\b/.test(t)) [from, to] = [base, date((7 - dow) % 7)];
  else if (str(parsed.date)) from = to = str(parsed.date);

  const weekdays = new Set<Weekday>();
  if (/\bweekends?\b/.test(t)) [0, 6].forEach((d) => weekdays.add(d as Weekday));
  if (/\bweekdays\b/.test(t)) [1, 2, 3, 4, 5].forEach((d) => weekdays.add(d as Weekday));
  for (const m of t.matchAll(/\b(sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?)days\b/g)) {
    weekdays.add(WEEKDAY_WORDS.indexOf(m[1]!.slice(0, 3) as never) as Weekday);
  }
  if (weekdays.size && from === to && str(parsed.date) && from === str(parsed.date)) {
    // "mondays" was read as "next Monday": keep the weekday, drop the single date.
    [from, to] = [null, null];
  }

  const timeOfDay = (['morning', 'afternoon', 'evening'] as const).find(
    (p) => parsed.timeOfDay === p || new RegExp(`\\b${p}s?\\b`).test(t),
  );
  return normalizeWindow(
    {
      dateFrom: from,
      dateTo: to,
      weekdays: [...weekdays],
      timeOfDay: timeOfDay ?? null,
      time: str(parsed.time),
    },
    ctx.today,
  )!;
}

const WEEKDAY_PLURALS = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
];

/** "Next week · mornings", "Fri, Dec 4 · around 2 PM", "Weekends". */
export function describeWindow(window: SchedulingWindow, today: string): string {
  const parts: string[] = [];
  const { dateFrom: from, dateTo: to } = window;
  if (from && to) {
    const d = parseLocalDate(today);
    const dow = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
    const toMonday = (8 - dow) % 7 || 7;
    const nextMonday = formatLocalDate(addDays(d, toMonday));
    const nextSunday = formatLocalDate(addDays(d, toMonday + 6));
    if (from === nextMonday && to === nextSunday) parts.push('Next week');
    else if (from === to) parts.push(formatDayLabel(from));
    else parts.push(`${formatDayLabel(from)} – ${formatDayLabel(to)}`);
  }
  const w = window.weekdays;
  if (w.length === 2 && w.includes(0) && w.includes(6)) parts.push('weekends');
  else if (w.length === 5 && [1, 2, 3, 4, 5].every((x) => w.includes(x as Weekday)))
    parts.push('weekdays');
  else if (w.length) parts.push(w.map((x) => WEEKDAY_PLURALS[x]!).join(', '));
  if (window.time) {
    const [h, m] = window.time.split(':').map(Number) as [number, number];
    parts.push(`around ${formatTime12(h * 60 + m)}`);
  } else if (window.timeOfDay) {
    parts.push(`${window.timeOfDay}s`);
  }
  const label = parts.join(' · ') || 'As requested';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** The window the engine searches: dates (default the next four weeks) + time preference. */
function requestWindow(
  window: SchedulingWindow,
  today: string,
  label: string,
): RequestWindow | null {
  const any =
    window.dateFrom || window.weekdays.length || window.timeOfDay || window.time ? true : false;
  if (!any) return null;
  const from = window.dateFrom ?? today;
  const to = window.dateTo ?? formatLocalDate(addDays(parseLocalDate(from), 27));
  let preference: RequestWindow['preference'] = window.timeOfDay;
  if (window.time) {
    const [h, m] = window.time.split(':').map(Number) as [number, number];
    const at = h * 60 + m;
    const clock = (x: number) =>
      `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
    preference = { start: clock(Math.max(0, at - 60)), end: clock(Math.min(24 * 60, at + 60)) };
  }
  return { from, to, preference, weekdays: window.weekdays, label };
}

// ---------------------------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------------------------

async function interpret(
  request: StoredCapturedRequest,
  ctx: WindowContext,
  salonId: string,
  deps: AutoScheduleDeps,
): Promise<{ window: SchedulingWindow; interpreter: AutoScheduleResponse['interpreter'] }> {
  const fallback = () => fallbackWindow(request.message, request.parsed, ctx);
  if (deps.demo) return { window: fallback(), interpreter: 'demo' };
  const config = await deps.loadConfig(salonId);
  if (!config || (await deps.tokensUsedThisMonth(salonId)) >= config.monthlyTokenBudget) {
    return { window: fallback(), interpreter: 'parsed' };
  }
  try {
    const llm = (deps.createProvider ?? defaultCreateProvider)(config.provider, {
      apiKey: config.apiKey,
      model: config.model,
    });
    const out = await interpretWithLlm(llm, request.message, ctx);
    await deps.recordUsage({
      salonId,
      provider: config.provider,
      model: out.model,
      purpose: 'inbox_auto_schedule',
      inputTokens: out.usage.inputTokens,
      outputTokens: out.usage.outputTokens,
    });
    return out.window
      ? { window: out.window, interpreter: 'llm' }
      : { window: fallback(), interpreter: 'parsed' };
  } catch (error) {
    // The stored parse still answers; the stylist isn't blocked by a provider hiccup.
    if (error instanceof AiProviderError) return { window: fallback(), interpreter: 'parsed' };
    throw error;
  }
}

const ACTIVE = new Set(['held', 'requested', 'confirmed']);

export async function handleAutoSchedule(
  rawBody: unknown,
  deps: AutoScheduleDeps,
): Promise<AutoScheduleResult> {
  const body = autoScheduleSchema.safeParse(rawBody);
  if (!body.success) return fail(400, 'invalid_request', z.prettifyError(body.error));
  const { salonId, requestId } = body.data;

  const role = await deps.getMemberRole(salonId);
  if (!role) return fail(403, 'forbidden', 'You are not a member of this salon');

  try {
    const port = deps.createPort(salonId);
    const now = (deps.now ?? (() => Date.now()))();
    const request = await port.getCapturedRequest(requestId);
    if (!request) return fail(404, 'not_found', 'That request is gone');
    if (request.status !== 'pending') {
      return fail(409, 'already_handled', 'That request was already handled');
    }
    if (request.intent === 'cancel') {
      return fail(422, 'not_schedulable', 'A cancellation has nothing to schedule');
    }

    const utcToday = toSalonDate(now, 'UTC');
    const [schedule0, menu] = await Promise.all([
      port.getSchedule({ from: utcToday, to: utcToday }),
      port.getMenu(),
    ]);
    const timeZone = schedule0.hours.timeZone;
    const today = toSalonDate(now, timeZone);

    const target =
      request.intent === 'reschedule' && request.targetAppointmentId
        ? await port.getAppointment(request.targetAppointmentId)
        : null;
    const moving = target && ACTIVE.has(target.status) ? target : null;
    const intent = moving ? 'reschedule' : 'booking';

    const visits = request.clientId ? await port.clientVisits(request.clientId, 20) : [];
    const overrides = request.clientId ? await port.clientOverrides(request.clientId) : [];

    const stored = Array.isArray(request.parsed.services)
      ? (request.parsed.services as { serviceId?: unknown; variantId?: unknown }[])
          .filter((s) => typeof s?.serviceId === 'string')
          .map((s) => ({ serviceId: s.serviceId as string, variantId: str(s.variantId) }))
      : [];
    let items: BookingItem[] | null = stored.length ? stored : null;
    if (!items && moving?.services.length) {
      items = moving.services.map((s) => ({
        serviceId: s.serviceId,
        variantId: s.variantId ?? null,
      }));
    }
    if (!items) items = usualItems(menu, visits);
    let resolved: ReturnType<typeof resolveItems>;
    try {
      if (!items) throw new Error('no services');
      resolved = resolveItems(menu, items, overrides);
    } catch {
      return fail(
        422,
        'no_service',
        'Couldn’t tell which service. Open the request and pick a time by hand.',
      );
    }

    const ctx: WindowContext = {
      today,
      todayLabel: formatDayLabel(today),
      timeZone,
      salonName: schedule0.salonName,
      sentOn: toSalonDate(request.receivedAt, timeZone),
      currentAppointment: moving ? formatSlotLabel(moving.starts_at, timeZone) : null,
    };
    const { window, interpreter } = await interpret(request, ctx, salonId, deps);
    const label = describeWindow(window, ctx.sentOn < today ? ctx.sentOn : today);
    const searchWindow = requestWindow(window, today, label);

    const habits = analyzeHabits(
      visits.map((v) => ({ startsAt: v.startsAt, status: v.status })),
      timeZone,
      { now },
    );
    let due = null;
    if (intent === 'booking') {
      const intervals = await port.serviceRebookIntervals();
      const services: RebookService[] = resolved.snapshots.map((s) => {
        const service = menu.services.find((m) => m.id === s.serviceId);
        return {
          id: s.serviceId,
          name: s.name,
          category: service?.category ?? null,
          rebookIntervalDays: intervals.get(s.serviceId) ?? null,
        };
      });
      const history = visits.map((v) => ({
        startsAt: v.startsAt,
        serviceIds: v.services.map((s) => s.serviceId),
      }));
      due = dueDate(habits, rebookInterval(services, history));
    }
    let popular = null;
    if (!hasHabits(habits)) {
      const past = await port.listAppointments({
        from: new Date(now - 56 * DAY).toISOString(),
        to: new Date(now).toISOString(),
      });
      popular = analyzeHabits(
        past.map((a) => ({ startsAt: a.starts_at, status: a.status })),
        timeZone,
        { recent: 500 },
      );
    }

    const lastDay = [
      searchWindow?.to,
      due?.date,
      formatLocalDate(addDays(parseLocalDate(today), 42)),
    ]
      .filter((d): d is string => !!d)
      .sort()
      .at(-1)!;
    const horizonEnd = Date.parse(`${lastDay}T00:00:00Z`) + 10 * DAY;
    const [schedule, appointments] = await Promise.all([
      port.getSchedule({ from: today, to: toSalonDate(horizonEnd, 'UTC') }),
      port.listAppointments({
        from: new Date(now - DAY).toISOString(),
        to: new Date(horizonEnd).toISOString(),
      }),
    ]);
    const existing = appointments
      .filter((a) => a.id !== moving?.id && a.id !== request.appointmentId)
      .map((a) => ({ id: a.id, segments: a.segments }));

    const { suggestions, fits } = suggestSlots({
      service: resolved.service,
      hours: schedule.hours,
      existing,
      rules: schedule.rules,
      now,
      habits,
      due,
      popular,
      request: searchWindow,
    });

    const out: AutoScheduleSuggestion[] = [];
    for (const s of suggestions) {
      const plan = planBooking({
        service: resolved.service,
        start: s.slot.start,
        hours: schedule.hours,
        existing,
        rules: schedule.rules,
        now,
      });
      if (!plan.ok) continue;
      out.push({
        start: s.slot.start,
        end: s.slot.end,
        localDate: s.slot.localDate,
        localTime: s.slot.localTime,
        label: formatSlotLabel(s.slot.start, timeZone),
        tentative: s.tentative,
        reasons: s.reasons,
        segments: plan.segments.map((x) => ({ kind: x.kind, start: x.start, end: x.end })),
      });
    }

    return {
      status: 200,
      body: {
        ok: true,
        requestId,
        intent,
        interpreter,
        timeZone,
        window: searchWindow ? { ...window, label } : null,
        fits,
        services: resolved.snapshots,
        serviceSummary: resolved.summary,
        priceCents: resolved.service.priceCents ?? null,
        moving: moving
          ? {
              appointmentId: moving.id,
              startsAt: moving.starts_at,
              label: formatSlotLabel(moving.starts_at, timeZone),
            }
          : null,
        suggestions: out,
      },
    };
  } catch (error) {
    return fail(500, 'inbox_error', error instanceof Error ? error.message : String(error));
  }
}
