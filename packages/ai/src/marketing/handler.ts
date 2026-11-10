import type {
  MarketingDraftCopyResponse,
  MarketingErrorBody,
  MarketingScanResponse,
  MarketingSendOutcome,
  MarketingSendResponse,
  MarketingSubscriptionResponse,
} from '@chairside/db/marketing';
import { z } from 'zod';

import { createProvider as defaultCreateProvider } from '../registry.ts';
import type { AiServiceDeps } from '../server/handler.ts';
import { draftMarketingCopy, templateMarketingCopy } from './copy.ts';
import { draftRebookNudges } from './nudges.ts';
import type { MarketingChannelSender, MarketingPort } from './types.ts';

/** Hits allowed per window. Unsubscribes come from mail providers' servers, so IP limits are loose. */
export const MARKETING_LIMITS = {
  view: { limit: 120, windowSeconds: 60 },
  changeIp: { limit: 120, windowSeconds: 3600 },
  changeToken: { limit: 10, windowSeconds: 3600 },
  draftCopy: { limit: 30, windowSeconds: 3600 },
} as const;

/** Candidates per page and pages per scan (the scan runs hourly). */
export const NUDGE_PAGE_SIZE = 200;
export const NUDGE_MAX_PAGES = 25;
/** Messages per claim and claims per send. */
export const SEND_BATCH = 50;
export const SEND_MAX_BATCHES = 10;

const token = z.string().regex(/^[0-9a-f]{64}$/, 'Invalid link');

export const marketingRequestSchema = z.discriminatedUnion('action', [
  /** The database (shared secret). */
  z.object({ action: z.literal('scan') }),
  z.object({ action: z.literal('send') }),
  /** A member (JWT). */
  z.object({
    action: z.literal('draft_copy'),
    salonId: z.uuid(),
    kind: z.enum(['campaign', 'rebook_nudge', 'review_request']),
    brief: z.string().trim().max(1000).optional(),
  }),
  /** /u/{token} and the one-click List-Unsubscribe POST. */
  z.object({ action: z.literal('view'), token }),
  z.object({ action: z.literal('unsubscribe'), token }),
  z.object({ action: z.literal('resubscribe'), token }),
]);

export interface MarketingDeps {
  port: MarketingPort;
  /** Channels that can deliver right now (email when configured; SMS once #22 lands). */
  channels: MarketingChannelSender[];
  /** The signed-in member's AI wiring, for `draft_copy`. */
  ai?: AiServiceDeps | null;
  now?: () => number;
}

export interface MarketingRequestMeta {
  ip: string;
  /** The request carried the shared notifier secret (the database poking the function). */
  trusted: boolean;
}

export type MarketingResult =
  | {
      status: 200;
      body:
        | MarketingScanResponse
        | MarketingSendResponse
        | MarketingDraftCopyResponse
        | MarketingSubscriptionResponse;
    }
  | { status: 400 | 401 | 403 | 404 | 429 | 500; body: MarketingErrorBody };

const fail = (
  status: Exclude<MarketingResult['status'], 200>,
  code: string,
  message: string,
): MarketingResult => ({ status, body: { error: { code, message } } });

const SLOW_DOWN = 'Too many requests. Please wait a bit and try again.';
const NOT_FOUND = 'This link doesn’t work anymore. Contact the salon.';

/** Finds clients due back and saves their nudges (drafts, or queued with auto-send). */
export async function scanRebookNudges(
  port: MarketingPort,
  now: number,
): Promise<MarketingScanResponse> {
  const summary: MarketingScanResponse = { candidates: 0, saved: 0, queued: 0 };
  let before: { startsAt: string; clientId: string } | null = null;
  for (let page = 0; page < NUDGE_MAX_PAGES; page++) {
    const candidates = await port.nudgeCandidates(NUDGE_PAGE_SIZE, before);
    summary.candidates += candidates.length;
    const drafts = draftRebookNudges(candidates, now);
    if (drafts.length) {
      const saved = await port.saveNudges(drafts);
      summary.saved += saved.saved;
      summary.queued += saved.queued;
    }
    const last = candidates.at(-1);
    if (!last || candidates.length < NUDGE_PAGE_SIZE) break;
    before = { startsAt: last.visit.startsAt, clientId: last.clientId };
  }
  return summary;
}

/** Delivers queued messages on the channels that are wired up. */
export async function sendQueuedMarketing(
  port: MarketingPort,
  channels: readonly MarketingChannelSender[],
): Promise<MarketingSendResponse> {
  const summary: MarketingSendResponse = { claimed: 0, sent: 0, skipped: 0, retried: 0 };
  const byChannel = new Map(channels.map((c) => [c.channel, c]));
  if (byChannel.size === 0) return summary;
  for (let batch = 0; batch < SEND_MAX_BATCHES; batch++) {
    const claimed = await port.claim([...byChannel.keys()], SEND_BATCH);
    summary.claimed += claimed.length;
    const results: MarketingSendOutcome[] = [];
    for (const message of claimed) {
      const sender = byChannel.get(message.channel);
      if (!sender) {
        results.push({ id: message.id, outcome: 'retry', error: 'no_channel' });
        summary.retried++;
        continue;
      }
      try {
        const { providerId } = await sender.send(message);
        results.push({ id: message.id, outcome: 'sent', ...(providerId ? { providerId } : {}) });
        summary.sent++;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        if ((e as { permanent?: boolean } | null)?.permanent) {
          results.push({ id: message.id, outcome: 'skipped', error });
          summary.skipped++;
        } else {
          results.push({ id: message.id, outcome: 'retry', error });
          summary.retried++;
        }
      }
    }
    await port.finish(results);
    if (claimed.length < SEND_BATCH) break;
  }
  return summary;
}

/**
 * The marketing API. `scan` and `send` are for the database (shared secret); `draft_copy` needs
 * a member; the /u/{token} actions use the client's 256-bit marketing token as the only
 * credential and only ever change that client's consent.
 */
export async function handleMarketingRequest(
  rawBody: unknown,
  meta: MarketingRequestMeta,
  deps: MarketingDeps,
): Promise<MarketingResult> {
  const parsed = marketingRequestSchema.safeParse(rawBody);
  if (!parsed.success) return fail(400, 'invalid_request', z.prettifyError(parsed.error));
  const request = parsed.data;
  const now = deps.now ?? (() => Date.now());
  const { port } = deps;
  const limited = async (key: string, rule: { limit: number; windowSeconds: number }) =>
    !(await port.hitRateLimit(key, rule.limit, rule.windowSeconds));

  switch (request.action) {
    case 'scan':
    case 'send': {
      if (!meta.trusted) return fail(401, 'unauthorized', 'Not allowed.');
      return {
        status: 200,
        body:
          request.action === 'scan'
            ? await scanRebookNudges(port, now())
            : await sendQueuedMarketing(port, deps.channels),
      };
    }

    case 'draft_copy': {
      const ai = deps.ai;
      if (!ai) return fail(401, 'unauthorized', 'Sign in to draft messages.');
      const role = await ai.getMemberRole(request.salonId);
      if (!role) return fail(403, 'forbidden', 'You’re not a member of this salon.');
      const salonName = (await port.salonName(request.salonId)) ?? 'our salon';
      const input = { kind: request.kind, salonName, brief: request.brief ?? null };
      const template = () => ({ status: 200 as const, body: templateMarketingCopy(input) });

      if (await limited(`salon:marketing:copy:${request.salonId}`, MARKETING_LIMITS.draftCopy)) {
        return template();
      }
      const config = await ai.loadConfig(request.salonId);
      if (!config) return template();
      if ((await ai.tokensUsedThisMonth(request.salonId)) >= config.monthlyTokenBudget) {
        return template();
      }
      const create = ai.createProvider ?? defaultCreateProvider;
      try {
        const llm = create(config.provider, { apiKey: config.apiKey, model: config.model });
        const copy = await draftMarketingCopy(llm, input, (usage, model) =>
          ai.recordUsage({
            salonId: request.salonId,
            provider: config.provider,
            model,
            purpose: 'marketing_copy',
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          }),
        );
        return { status: 200, body: copy };
      } catch (e) {
        console.error('marketing copy failed', e instanceof Error ? e.name : 'error');
        return template();
      }
    }

    case 'view': {
      if (await limited(`ip:marketing:view:${meta.ip}`, MARKETING_LIMITS.view)) {
        return fail(429, 'rate_limited', SLOW_DOWN);
      }
      const subscription = await port.getSubscription(request.token);
      if (!subscription) return fail(404, 'not_found', NOT_FOUND);
      return { status: 200, body: { subscription } };
    }

    case 'unsubscribe':
    case 'resubscribe': {
      if (
        (await limited(`ip:marketing:change:${meta.ip}`, MARKETING_LIMITS.changeIp)) ||
        (await limited(`token:marketing:${request.token}`, MARKETING_LIMITS.changeToken))
      ) {
        return fail(429, 'rate_limited', SLOW_DOWN);
      }
      const subscription = await port.setSubscription(
        request.token,
        request.action === 'resubscribe',
      );
      if (!subscription) return fail(404, 'not_found', NOT_FOUND);
      return { status: 200, body: { subscription } };
    }
  }
}
