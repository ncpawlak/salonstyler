import type { ClientServiceOverride, ExistingAppointment } from '@chairside/core';
import type { ServiceMenu } from '@chairside/db/services';
import type {
  AcceptWaitlistOfferResult,
  ClaimedOpening,
  JoinWaitlistInput,
  JoinWaitlistResult,
  SaveWaitlistOffersResult,
  SendWaitlistOfferResult,
  SentWaitlistOffer,
  WaitlistLinkRow,
  WaitlistOfferDraft,
  WaitlistSegment,
} from '@chairside/db/waitlist';

import type { SalonSchedule } from '../assistant/types.ts';
import type { PublicSalonPage, PublicVerifiedUser } from '../public-booking/types.ts';

/**
 * Data access for the `waitlist` Edge Function. Backed by a service-role client: matching reads
 * one salon's hours, menu and anonymous busy time; the client's link reads only the entry behind
 * its token.
 */
export interface WaitlistPort {
  claimOpenings(salonId?: string): Promise<ClaimedOpening[]>;
  saveOffers(openingId: string, offers: WaitlistOfferDraft[]): Promise<SaveWaitlistOffersResult>;
  getSchedule(salonId: string, range: { from: string; to: string }): Promise<SalonSchedule>;
  getMenu(salonId: string): Promise<ServiceMenu>;
  /** The client's duration overrides ("Karina's color +20m"). */
  clientOverrides(salonId: string, clientId: string): Promise<ClientServiceOverride[]>;
  /** Blocking time on the calendar overlapping `[from, to)`: ids and segments only. */
  listBusy(salonId: string, range: { from: string; to: string }): Promise<ExistingAppointment[]>;
  /** Counts one hit; false once `key` is over `limit` in the current window. */
  hitRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean>;

  getPage(slug: string): Promise<PublicSalonPage | null>;
  /** The client behind an access token, if their email is verified. */
  getVerifiedUser(accessToken: string): Promise<PublicVerifiedUser | null>;
  join(salonId: string, userId: string, entry: JoinWaitlistInput): Promise<JoinWaitlistResult>;

  getLink(token: string): Promise<WaitlistLinkRow | null>;
  leave(token: string): Promise<{ ok: boolean }>;
  accept(
    token: string,
    offerId: string,
    segments: WaitlistSegment[],
  ): Promise<AcceptWaitlistOfferResult>;

  /** The signed-in user behind an access token, if they belong to the salon. */
  memberUserId(accessToken: string, salonId: string): Promise<string | null>;
  /** The salon an offer belongs to (to check the caller is a member before sending it). */
  offerSalonId(offerId: string): Promise<string | null>;
  sendOffer(offerId: string, via: 'email' | 'text'): Promise<SendWaitlistOfferResult>;
  /** Null when client email isn't configured (EMAIL_FROM / PUBLIC_APP_URL / a provider). */
  sendOfferEmail: ((offer: SentWaitlistOffer) => Promise<void>) | null;
}
