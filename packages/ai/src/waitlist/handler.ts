import { addDays, formatLocalDate, parseLocalDate, toSalonDate } from '@chairside/core';
import type {
  WaitlistAcceptResponse,
  WaitlistErrorBody,
  WaitlistJoinResponse,
  WaitlistLinkRow,
  WaitlistLinkView,
  WaitlistProcessResponse,
  WaitlistSendOfferResponse,
  WaitlistViewResponse,
} from '@chairside/db/waitlist';
import { z } from 'zod';

import { normalizePhone } from '../inbox/text.ts';
import { PublicBookingError, resolvePublicItems } from '../public-booking/booking.ts';
import { matchOpening, planAcceptance } from './match.ts';
import type { WaitlistPort } from './types.ts';

/** Hits allowed per window, like the booking page and the manage link. */
export const WAITLIST_LIMITS = {
  view: { limit: 60, windowSeconds: 60 },
  joinIp: { limit: 10, windowSeconds: 3600 },
  joinUser: { limit: 10, windowSeconds: 3600 },
  changeIp: { limit: 20, windowSeconds: 3600 },
  changeToken: { limit: 10, windowSeconds: 3600 },
  process: { limit: 20, windowSeconds: 60 },
} as const;

/** Days ahead a client may wait for. */
export const WAITLIST_MAX_DAYS_AHEAD = 90;
/** Days one client may wait for at a time. */
export const MAX_ACTIVE_WAITLIST_ENTRIES = 3;

const token = z.string().regex(/^[0-9a-f]{64}$/, 'Invalid link');
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/);

export const waitlistRequestSchema = z.discriminatedUnion('action', [
  /** The notifier secret (pg_net on cancel / cron), or a member's token for one salon. */
  z.object({ action: z.literal('process'), salonId: z.uuid().optional() }),
  /** Needs the client's access token (after the email code), like booking. */
  z.object({
    action: z.literal('join'),
    slug,
    date: localDate,
    windowStart: clock.nullish(),
    windowEnd: clock.nullish(),
    items: z
      .array(z.object({ serviceId: z.uuid(), variantId: z.uuid().nullish() }))
      .min(1)
      .max(3),
    name: z.string().trim().min(1).max(80).optional(),
    phone: z.string().trim().max(32).optional(),
    notes: z.string().trim().max(500).optional(),
  }),
  z.object({ action: z.literal('view'), token }),
  z.object({ action: z.literal('accept'), token, offerId: z.uuid() }),
  z.object({ action: z.literal('leave'), token }),
  /** A member emails a drafted offer. */
  z.object({ action: z.literal('send_offer'), offerId: z.uuid() }),
]);

export interface WaitlistDeps {
  port: WaitlistPort;
  now?: () => number;
}

export interface WaitlistRequestMeta {
  ip: string;
  /** A signed-in user's access token (member or verified client), if any. */
  accessToken: string | null;
  /** The request carried the shared notifier secret (the database poking the function). */
  trusted: boolean;
}

export type WaitlistResult =
  | {
      status: 200;
      body:
        | WaitlistProcessResponse
        | WaitlistJoinResponse
        | WaitlistViewResponse
        | WaitlistAcceptResponse
        | WaitlistSendOfferResponse;
    }
  | { status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503; body: WaitlistErrorBody };

const fail = (
  status: Exclude<WaitlistResult['status'], 200>,
  code: string,
  message: string,
): WaitlistResult => ({ status, body: { error: { code, message } } });

const SLOW_DOWN = 'Too many requests. Please wait a bit and try again.';
const NOT_FOUND = 'This waitlist link doesn’t work anymore. Contact the salon.';

/** What the client may see: never the salon or client ids or the segment layout. */
export function toLinkView(row: WaitlistLinkRow): WaitlistLinkView {
  return {
    entry: row.entry,
    offer: row.offer
      ? {
          offerId: row.offer.offerId,
          startsAt: row.offer.startsAt,
          endsAt: row.offer.endsAt,
          expiresAt: row.offer.expiresAt,
          priceCents: row.offer.priceCents,
        }
      : null,
    booking: row.booking,
    salon: row.salon,
  };
}

/**
 * Matches pending openings: the engine finds who fits each freed slot, Postgres stores the
 * offers (drafts, or sent with auto-offer) and the function emails the auto-sent ones.
 */
export async function processOpenings(
  port: WaitlistPort,
  now: number,
  salonId?: string,
): Promise<WaitlistProcessResponse> {
  const summary: WaitlistProcessResponse = { openings: 0, offers: 0, sent: 0 };
  const openings = await port.claimOpenings(salonId);
  for (const opening of openings) {
    summary.openings++;
    const drafts = opening.enabled ? await matchOpening(port, opening, now) : [];
    const saved = await port.saveOffers(opening.openingId, drafts);
    if (!saved.ok) continue;
    summary.offers += saved.saved;
    for (const offer of saved.sent) {
      if (!port.sendOfferEmail || !offer.email) continue;
      try {
        await port.sendOfferEmail(offer);
        summary.sent++;
      } catch (e) {
        // The offer stays sent: the stylist sees it and can text the link instead.
        console.error('waitlist offer email failed', e instanceof Error ? e.message : e);
      }
    }
  }
  return summary;
}

/**
 * The waitlist API. `process` is for the database (shared secret) or a member's "Check now";
 * `join` needs a verified client; the /w/{token} actions use the 256-bit token as the only
 * credential and never return other clients.
 */
export async function handleWaitlistRequest(
  rawBody: unknown,
  meta: WaitlistRequestMeta,
  deps: WaitlistDeps,
): Promise<WaitlistResult> {
  const parsed = waitlistRequestSchema.safeParse(rawBody);
  if (!parsed.success) return fail(400, 'invalid_request', z.prettifyError(parsed.error));
  const request = parsed.data;
  const now = deps.now ?? (() => Date.now());
  const { port } = deps;
  const limited = async (key: string, rule: { limit: number; windowSeconds: number }) =>
    !(await port.hitRateLimit(key, rule.limit, rule.windowSeconds));

  switch (request.action) {
    case 'process': {
      if (meta.trusted) {
        return { status: 200, body: await processOpenings(port, now(), request.salonId) };
      }
      if (!request.salonId || !meta.accessToken) {
        return fail(401, 'unauthorized', 'Sign in to check the waitlist.');
      }
      const userId = await port.memberUserId(meta.accessToken, request.salonId);
      if (!userId) return fail(403, 'forbidden', 'You’re not a member of this salon.');
      if (await limited(`user:waitlist:process:${userId}`, WAITLIST_LIMITS.process)) {
        return fail(429, 'rate_limited', SLOW_DOWN);
      }
      return { status: 200, body: await processOpenings(port, now(), request.salonId) };
    }

    case 'send_offer': {
      if (!meta.accessToken) return fail(401, 'unauthorized', 'Sign in to send offers.');
      const salonId = await port.offerSalonId(request.offerId);
      const userId = salonId ? await port.memberUserId(meta.accessToken, salonId) : null;
      if (!salonId || !userId) return fail(404, 'not_found', 'That offer doesn’t exist.');
      if (!port.sendOfferEmail) {
        return fail(
          503,
          'email_not_configured',
          'Client email isn’t set up yet. Text the offer instead.',
        );
      }
      const sent = await port.sendOffer(request.offerId, 'email');
      if (!sent.ok) {
        return fail(
          sent.reason === 'not_found' ? 404 : 409,
          sent.reason,
          sent.message ?? 'This offer can’t be sent.',
        );
      }
      await port.sendOfferEmail(sent);
      return { status: 200, body: { sent: true, email: sent.email ?? '' } };
    }

    case 'join': {
      if (await limited(`ip:waitlist:join:${meta.ip}`, WAITLIST_LIMITS.joinIp)) {
        return fail(429, 'rate_limited', SLOW_DOWN);
      }
      const page = await port.getPage(request.slug);
      if (!page) return fail(404, 'not_found', 'This booking page doesn’t exist.');
      if (!page.enabled) {
        return fail(403, 'disabled', `${page.name} isn’t taking online bookings right now.`);
      }
      const user = meta.accessToken ? await port.getVerifiedUser(meta.accessToken) : null;
      if (!user) {
        return fail(401, 'verify_required', 'Confirm your email with the code we sent first.');
      }
      if (await limited(`user:waitlist:join:${user.id}`, WAITLIST_LIMITS.joinUser)) {
        return fail(429, 'rate_limited', SLOW_DOWN);
      }

      const today = toSalonDate(now(), page.timezone);
      const lastDay = formatLocalDate(addDays(parseLocalDate(today), WAITLIST_MAX_DAYS_AHEAD));
      try {
        parseLocalDate(request.date);
      } catch {
        return fail(400, 'invalid_date', 'Pick a valid date.');
      }
      if (request.date < today || request.date > lastDay) {
        return fail(400, 'invalid_date', 'Pick a day in the next three months.');
      }
      const windowStart = request.windowStart ?? null;
      const windowEnd = request.windowEnd ?? null;
      if (!windowStart !== !windowEnd || (windowStart && windowEnd && windowStart >= windowEnd)) {
        return fail(400, 'invalid_window', 'Pick a time window that ends after it starts.');
      }
      let phone: string | null = null;
      if (request.phone) {
        phone = normalizePhone(request.phone);
        if (!phone) return fail(400, 'invalid_phone', 'Enter a valid phone number');
      }

      let summary: string;
      try {
        summary = resolvePublicItems(await port.getMenu(page.salonId), request.items).summary;
      } catch (e) {
        if (e instanceof PublicBookingError) return fail(400, e.code, e.message);
        throw e;
      }

      let joined;
      try {
        joined = await port.join(page.salonId, user.id, {
          name: request.name ?? null,
          phone,
          day: request.date,
          windowStart,
          windowEnd,
          items: request.items,
          servicesLabel: summary,
          notes: request.notes || null,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : '';
        if (/Name is required/.test(message)) {
          return fail(400, 'name_required', 'Add your name to join the waitlist.');
        }
        throw e;
      }
      if (!joined.ok) {
        return joined.reason === 'limit'
          ? fail(
              409,
              'limit',
              `You can wait for up to ${MAX_ACTIVE_WAITLIST_ENTRIES} days at a time. Leave one first.`,
            )
          : fail(403, 'disabled', `${page.name} isn’t taking waitlist sign-ups right now.`);
      }
      return { status: 200, body: { token: joined.token, day: joined.day } };
    }

    case 'view': {
      if (await limited(`ip:waitlist:view:${meta.ip}`, WAITLIST_LIMITS.view)) {
        return fail(429, 'rate_limited', SLOW_DOWN);
      }
      const row = await port.getLink(request.token);
      if (!row) return fail(404, 'not_found', NOT_FOUND);
      return { status: 200, body: { link: toLinkView(row) } };
    }

    case 'leave':
    case 'accept': {
      if (
        (await limited(`ip:waitlist:change:${meta.ip}`, WAITLIST_LIMITS.changeIp)) ||
        (await limited(`token:waitlist:${request.token}`, WAITLIST_LIMITS.changeToken))
      ) {
        return fail(429, 'rate_limited', SLOW_DOWN);
      }
      const row = await port.getLink(request.token);
      if (!row) return fail(404, 'not_found', NOT_FOUND);

      if (request.action === 'leave') {
        await port.leave(request.token);
        const after = await port.getLink(request.token);
        return { status: 200, body: { link: toLinkView(after ?? row) } };
      }

      const offer = row.offer;
      if (!offer || offer.offerId !== request.offerId) {
        return fail(
          409,
          'taken',
          'This opening isn’t available anymore. You’re still on the list.',
        );
      }
      const segments = await planAcceptance(port, { ...row, offer }, now());
      if (!segments) {
        return fail(
          409,
          'taken',
          'This opening isn’t available anymore. You’re still on the list.',
        );
      }
      const result = await port.accept(request.token, offer.offerId, segments);
      if (!result.ok) {
        return result.reason === 'not_found'
          ? fail(404, 'not_found', NOT_FOUND)
          : result.reason === 'expired'
            ? fail(409, 'expired', 'This offer expired. You’re still on the list.')
            : fail(409, 'taken', 'Someone else just took it. You’re still on the list.');
      }
      const after = await port.getLink(request.token);
      return { status: 200, body: { link: toLinkView(after ?? row) } };
    }
  }
}
