import { z } from 'zod';

import { AiProviderError, redactSecrets } from '../http.ts';
import { normalizePhone } from '../inbox/text.ts';
import { createProvider as defaultCreateProvider } from '../registry.ts';
import type { LLMProvider } from '../types.ts';
import type { AiErrorBody, AiServiceDeps } from '../server/handler.ts';
import { PublicBookingError, planPublicBooking, publicMenu, publicSlots } from './booking.ts';
import { type ConciergeMessage, runConciergeTurn } from './concierge.ts';
import type {
  ConciergeCard,
  PublicBookingDeposit,
  PublicBookingPort,
  PublicClientBooking,
  PublicService,
  PublicSlotsCard,
} from './types.ts';

/**
 * Hits allowed per window. IP limits stop scraping and bots; email/phone limits stop someone
 * spamming codes to a stranger; the per-salon chat limit protects the salon's AI budget.
 */
export const PUBLIC_LIMITS = {
  page: { limit: 60, windowSeconds: 60 },
  slots: { limit: 60, windowSeconds: 60 },
  sendCodeIp: { limit: 10, windowSeconds: 3600 },
  sendCodeEmail: { limit: 4, windowSeconds: 3600 },
  sendCodePhone: { limit: 4, windowSeconds: 3600 },
  bookIp: { limit: 10, windowSeconds: 3600 },
  bookUser: { limit: 5, windowSeconds: 3600 },
  bookPhone: { limit: 5, windowSeconds: 86_400 },
  myBookings: { limit: 30, windowSeconds: 60 },
  chatIp: { limit: 30, windowSeconds: 600 },
  chatSalon: { limit: 500, windowSeconds: 86_400 },
} as const;

/** Upcoming online bookings one client may hold at a time. */
export const MAX_UPCOMING_PUBLIC_BOOKINGS = 3;

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
const items = z
  .array(z.object({ serviceId: z.uuid(), variantId: z.uuid().nullish() }))
  .min(1)
  .max(3);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const phone = z
  .string()
  .trim()
  .max(32)
  .transform((s, ctx) => {
    const normalized = normalizePhone(s);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number' });
      return z.NEVER;
    }
    return normalized;
  });

export const publicBookingRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('page'), slug }),
  z.object({
    action: z.literal('slots'),
    slug,
    services: items,
    date: localDate,
    timeOfDay: z.enum(['morning', 'afternoon', 'evening']).nullish(),
  }),
  z.object({
    action: z.literal('send_code'),
    slug,
    email: z.email().max(254),
    phone,
  }),
  /** Needs the client's access token (after the email code). */
  z.object({
    action: z.literal('book'),
    slug,
    services: items,
    start: z.iso.datetime({ offset: true }),
    name: z.string().trim().min(1).max(80),
    phone,
    notes: z.string().trim().max(500).nullish(),
  }),
  z.object({ action: z.literal('my_bookings'), slug }),
  z.object({
    action: z.literal('chat'),
    slug,
    history: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().max(2000),
        }),
      )
      .max(40)
      .default([]),
    text: z.string().trim().min(1).max(500),
  }),
]);
export type PublicBookingRequest = z.infer<typeof publicBookingRequestSchema>;

export interface PublicBookingDeps extends Pick<
  AiServiceDeps,
  'loadConfig' | 'tokensUsedThisMonth' | 'recordUsage'
> {
  port: PublicBookingPort;
  createProvider?: typeof defaultCreateProvider;
  /** Local development only: a scripted concierge instead of the salon's key. */
  demoProvider?: () => LLMProvider;
  now?: () => number;
}

export interface PublicRequestMeta {
  /** Caller IP (from the edge proxy), for rate limiting. */
  ip: string;
  /** The client's access token after email verification, if any. */
  accessToken: string | null;
}

export type PublicPageResponse = {
  page: {
    name: string;
    slug: string;
    timezone: string;
    currency: string;
    enabled: boolean;
    intro: string | null;
    faq: string | null;
    autoConfirm: boolean;
    concierge: boolean;
  };
  services: PublicService[];
};
export type PublicSlotsResponse = { card: PublicSlotsCard };
export type PublicSendCodeResponse = { sent: true };
export type PublicBookResponse = {
  booking: {
    appointmentId: string;
    /** `held` while a deposit is due: send the client to `/pay/{deposit.payToken}`. */
    status: 'confirmed' | 'requested' | 'held';
    start: string;
    end: string;
    label: string;
    serviceSummary: string;
    deposit?: PublicBookingDeposit;
  };
};
export type PublicMyBookingsResponse = { bookings: PublicClientBooking[] };
export type PublicChatResponse = {
  reply: string;
  cards: ConciergeCard[];
  messages: ConciergeMessage[];
};

export type PublicBookingResult =
  | {
      status: 200;
      body:
        | PublicPageResponse
        | PublicSlotsResponse
        | PublicSendCodeResponse
        | PublicBookResponse
        | PublicMyBookingsResponse
        | PublicChatResponse;
    }
  | { status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502 | 503; body: AiErrorBody };

const fail = (
  status: Exclude<PublicBookingResult['status'], 200>,
  code: string,
  message: string,
): PublicBookingResult => ({ status, body: { error: { code, message } } });

const SLOW_DOWN = 'Too many requests. Please wait a bit and try again.';

/**
 * The public booking page's API. Nothing here needs an account except `book` and `my_bookings`,
 * which need a client token whose email was verified with a code. Every action is rate limited.
 */
export async function handlePublicBookingRequest(
  rawBody: unknown,
  meta: PublicRequestMeta,
  deps: PublicBookingDeps,
): Promise<PublicBookingResult> {
  const parsed = publicBookingRequestSchema.safeParse(rawBody);
  if (!parsed.success) return fail(400, 'invalid_request', z.prettifyError(parsed.error));
  const request = parsed.data;
  const now = deps.now ?? (() => Date.now());
  const { port } = deps;
  const limited = async (key: string, rule: { limit: number; windowSeconds: number }) =>
    !(await port.hitRateLimit(key, rule.limit, rule.windowSeconds));

  const ipRule =
    request.action === 'page'
      ? PUBLIC_LIMITS.page
      : request.action === 'slots'
        ? PUBLIC_LIMITS.slots
        : request.action === 'send_code'
          ? PUBLIC_LIMITS.sendCodeIp
          : request.action === 'book'
            ? PUBLIC_LIMITS.bookIp
            : request.action === 'my_bookings'
              ? PUBLIC_LIMITS.myBookings
              : PUBLIC_LIMITS.chatIp;
  if (await limited(`ip:${request.action}:${meta.ip}`, ipRule)) {
    return fail(429, 'rate_limited', SLOW_DOWN);
  }

  const page = await port.getPage(request.slug);
  if (!page) return fail(404, 'not_found', 'This booking page doesn’t exist.');
  if (!page.enabled && request.action !== 'page' && request.action !== 'my_bookings') {
    return fail(403, 'disabled', `${page.name} isn’t taking online bookings right now.`);
  }

  try {
    switch (request.action) {
      case 'page': {
        const concierge = page.enabled && (await conciergeAvailable(page.salonId, deps));
        const services = page.enabled ? publicMenu(await port.getMenu(page.salonId)) : [];
        return {
          status: 200,
          body: {
            page: {
              name: page.name,
              slug: page.slug,
              timezone: page.timezone,
              currency: page.currency,
              enabled: page.enabled,
              intro: page.intro,
              faq: page.faq,
              autoConfirm: page.autoConfirm,
              concierge,
            },
            services,
          },
        };
      }
      case 'slots': {
        const card = await publicSlots(
          port,
          page.salonId,
          {
            items: request.services,
            date: request.date,
            radiusDays: 3,
            timeOfDay: request.timeOfDay ?? null,
          },
          now(),
        );
        return { status: 200, body: { card } };
      }
      case 'send_code': {
        const email = request.email.trim().toLowerCase();
        if (
          (await limited(`email:send_code:${email}`, PUBLIC_LIMITS.sendCodeEmail)) ||
          (await limited(`phone:send_code:${request.phone}`, PUBLIC_LIMITS.sendCodePhone))
        ) {
          return fail(429, 'rate_limited', SLOW_DOWN);
        }
        await port.sendCode(email);
        return { status: 200, body: { sent: true } };
      }
      case 'book': {
        const user = meta.accessToken ? await port.getVerifiedUser(meta.accessToken) : null;
        if (!user) {
          return fail(401, 'verify_required', 'Confirm your email with the code we sent first.');
        }
        if (
          (await limited(`user:book:${user.id}`, PUBLIC_LIMITS.bookUser)) ||
          (await limited(`phone:book:${request.phone}`, PUBLIC_LIMITS.bookPhone))
        ) {
          return fail(429, 'rate_limited', SLOW_DOWN);
        }
        const plan = await planPublicBooking(
          port,
          page.salonId,
          { items: request.services, start: request.start },
          now(),
        );
        const booked = await port.book(page.salonId, user.id, {
          name: request.name,
          phone: request.phone,
          segments: plan.segments,
          services: plan.services,
          priceCents: plan.priceCents,
          notes: request.notes ? `Online booking: ${request.notes}` : 'Online booking',
          requiresApproval: plan.requiresApproval,
        });
        if (!booked.ok) {
          if (booked.reason === 'conflict') {
            return fail(409, 'slot_unavailable', 'That time was just taken. Pick another time.');
          }
          if (booked.reason === 'limit') {
            return fail(
              409,
              'limit',
              `You already have ${MAX_UPCOMING_PUBLIC_BOOKINGS} upcoming bookings here. Contact ${page.name} to book more.`,
            );
          }
          return fail(403, 'disabled', `${page.name} isn’t taking online bookings right now.`);
        }
        return {
          status: 200,
          body: {
            booking: {
              appointmentId: booked.appointmentId,
              status: booked.status,
              start: plan.start,
              end: plan.end,
              label: plan.label,
              serviceSummary: plan.serviceSummary,
              ...(booked.deposit ? { deposit: booked.deposit } : {}),
            },
          },
        };
      }
      case 'my_bookings': {
        const user = meta.accessToken ? await port.getVerifiedUser(meta.accessToken) : null;
        if (!user) return fail(401, 'verify_required', 'Confirm your email first.');
        return { status: 200, body: { bookings: await port.myBookings(page.salonId, user.id) } };
      }
      case 'chat': {
        if (await limited(`salon:chat:${page.salonId}`, PUBLIC_LIMITS.chatSalon)) {
          return fail(429, 'rate_limited', 'The assistant is busy. Pick a service above instead.');
        }
        const resolved = await resolveConcierge(page.salonId, deps);
        if ('status' in resolved) return resolved;
        const user = meta.accessToken ? await port.getVerifiedUser(meta.accessToken) : null;
        try {
          const turn = await runConciergeTurn({
            llm: resolved.llm,
            ctx: { port, page, now, userId: user?.id ?? null },
            history: trimVisibleHistory(request.history),
            text: request.text,
            onUsage: resolved.meter,
          });
          return {
            status: 200,
            body: { reply: turn.reply, cards: turn.cards, messages: turn.messages },
          };
        } catch (error) {
          if (error instanceof AiProviderError) {
            // Never show provider details (or the key) to the public.
            console.warn(
              'concierge provider failed',
              redactSecrets(error.message, resolved.apiKey),
            );
            return fail(502, 'assistant_unavailable', 'The assistant is unavailable right now.');
          }
          throw error;
        }
      }
    }
  } catch (error) {
    if (error instanceof PublicBookingError) {
      return fail(error.code === 'slot_unavailable' ? 409 : 400, error.code, error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    return fail(500, 'internal', message);
  }
}

/** Keeps the latest visible turns, starting with a client message. */
export function trimVisibleHistory(history: ConciergeMessage[], max = 20): ConciergeMessage[] {
  const kept = history.slice(-max);
  const first = kept.findIndex((m) => m.role === 'user');
  return first < 0 ? [] : kept.slice(first);
}

async function conciergeAvailable(salonId: string, deps: PublicBookingDeps): Promise<boolean> {
  if (deps.demoProvider) return true;
  const config = await deps.loadConfig(salonId);
  if (!config) return false;
  return (await deps.tokensUsedThisMonth(salonId)) < config.monthlyTokenBudget;
}

type ResolvedConcierge = {
  llm: LLMProvider;
  apiKey: string;
  meter?: (u: { inputTokens: number; outputTokens: number }, model: string) => Promise<void>;
};

async function resolveConcierge(
  salonId: string,
  deps: PublicBookingDeps,
): Promise<ResolvedConcierge | PublicBookingResult> {
  if (deps.demoProvider) return { llm: deps.demoProvider(), apiKey: '' };
  const unavailable = fail(503, 'assistant_unavailable', 'The assistant isn’t available here.');
  const config = await deps.loadConfig(salonId);
  if (!config) return unavailable;
  if ((await deps.tokensUsedThisMonth(salonId)) >= config.monthlyTokenBudget) return unavailable;
  return {
    llm: (deps.createProvider ?? defaultCreateProvider)(config.provider, {
      apiKey: config.apiKey,
      model: config.model,
    }),
    apiKey: config.apiKey,
    meter: (u, model) =>
      deps.recordUsage({
        salonId,
        provider: config.provider,
        model,
        purpose: 'concierge',
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
      }),
  };
}
