import type { ChairsideClient } from '@chairside/db';
import {
  claimMarketingMessages,
  finishMarketingMessages,
  getMarketingSubscription,
  marketingNudgeCandidates,
  saveRebookNudges,
  setMarketingSubscription,
} from '@chairside/db/marketing';

import type { MarketingPort } from './types.ts';

/** `service` must be a service-role client: the marketing RPCs refuse anything else. */
export function createSupabaseMarketingPort(service: ChairsideClient): MarketingPort {
  return {
    nudgeCandidates: (limit, before) => marketingNudgeCandidates(service, { limit, before }),
    saveNudges: (nudges) => saveRebookNudges(service, nudges),
    claim: (channels, limit) => claimMarketingMessages(service, channels, limit),
    finish: (results) => finishMarketingMessages(service, results),
    getSubscription: (token) => getMarketingSubscription(service, token),
    setSubscription: (token, subscribed) => setMarketingSubscription(service, token, subscribed),

    async hitRateLimit(key, limit, windowSeconds) {
      const { data, error } = await service.rpc('hit_rate_limit', {
        p_key: key,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      });
      if (error) throw error;
      return data;
    },

    async salonName(salonId) {
      const { data, error } = await service
        .from('salons')
        .select('name')
        .eq('id', salonId)
        .maybeSingle();
      if (error) throw error;
      return data?.name ?? null;
    },
  };
}
