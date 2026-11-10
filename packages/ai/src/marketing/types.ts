import type {
  ClaimedMarketingMessage,
  MarketingChannel,
  MarketingSendOutcome,
  MarketingSubscriptionView,
  NudgeCandidate,
  RebookNudgeDraft,
} from '@chairside/db/marketing';

/**
 * Data access for the `marketing` Edge Function. Backed by a service-role client: the RPCs refuse
 * anything else.
 */
export interface MarketingPort {
  /** One page of clients who might be due a nudge, most recent visit first. */
  nudgeCandidates(
    limit: number,
    before: { startsAt: string; clientId: string } | null,
  ): Promise<NudgeCandidate[]>;
  saveNudges(nudges: RebookNudgeDraft[]): Promise<{ saved: number; queued: number }>;
  claim(channels: MarketingChannel[], limit: number): Promise<ClaimedMarketingMessage[]>;
  finish(results: MarketingSendOutcome[]): Promise<number>;
  getSubscription(token: string): Promise<MarketingSubscriptionView | null>;
  setSubscription(token: string, subscribed: boolean): Promise<MarketingSubscriptionView | null>;
  /** Counts one hit; false once `key` is over `limit` in the current window. */
  hitRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean>;
  salonName(salonId: string): Promise<string | null>;
}

/**
 * One way of reaching a client. Email is wired today; SMS plugs in here once the salon has a
 * sending number (#22) without touching the queue, the drafts or the opt-out handling. Messages
 * on a channel nobody delivers stay queued.
 */
export interface MarketingChannelSender {
  channel: MarketingChannel;
  /**
   * Delivers one claimed message (copy still has its {placeholders}). Throw an error with
   * `permanent: true` for failures that won't fix themselves (bad address); others are retried.
   */
  send(message: ClaimedMarketingMessage): Promise<{ providerId?: string }>;
}
