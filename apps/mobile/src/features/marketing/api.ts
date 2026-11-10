import {
  approveMarketingMessage,
  cancelMarketingCampaign,
  countMarketingAudience,
  dismissMarketingMessage,
  getMarketingSettings,
  listMarketingCampaigns,
  listMarketingMessages,
  type MarketingAudience,
  type MarketingDraftCopyResponse,
  type MarketingErrorBody,
  type MarketingRequest,
  type MarketingSettings,
  type MarketingSubscriptionResponse,
  saveMarketingCampaign,
  type SaveMarketingCampaignInput,
  sendMarketingCampaign,
  updateMarketingSettings,
} from '@chairside/db/marketing';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { AiRequestError } from '@/features/ai-settings/api';
import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

async function readError(error: unknown): Promise<AiRequestError> {
  const context = (error as { context?: unknown }).context;
  if (context instanceof Response) {
    try {
      const body = (await context.json()) as Partial<MarketingErrorBody>;
      if (body.error) return new AiRequestError(body.error.code, body.error.message);
    } catch {
      // fall through
    }
  }
  return new AiRequestError('network', 'Can’t reach the salon right now. Check your connection.');
}

/** Calls the `marketing` Edge Function (as the member, or signed out for /u/{token}). */
async function invoke<T>(body: MarketingRequest): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>('marketing', { body });
  if (error) throw await readError(error);
  if (!data) throw new AiRequestError('invalid_response', 'Empty response from the salon');
  return data;
}

const draftsKey = (salonId: string) => ['marketing', salonId, 'drafts'] as const;
const historyKey = (salonId: string) => ['marketing', salonId, 'history'] as const;
const campaignsKey = (salonId: string) => ['marketing', salonId, 'campaigns'] as const;
const settingsKey = (salonId: string) => ['marketing-settings', salonId] as const;

export function useMarketingSettings() {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: settingsKey(salon.id),
    queryFn: () => getMarketingSettings(supabase, salon.id),
  });
}

export function useUpdateMarketingSettings() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: Partial<MarketingSettings>) =>
      updateMarketingSettings(supabase, salon.id, changes),
    onSuccess: (data) => queryClient.setQueryData(settingsKey(salon.id), data),
  });
}

/** Nudges and review requests waiting for the stylist. */
export function useMarketingDrafts() {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: draftsKey(salon.id),
    queryFn: () =>
      listMarketingMessages(supabase, salon.id, {
        statuses: ['draft'],
        kinds: ['rebook_nudge', 'review_request'],
      }),
  });
}

/** Recent one-to-one messages (queued, sent, failed). */
export function useMarketingHistory() {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: historyKey(salon.id),
    queryFn: () =>
      listMarketingMessages(supabase, salon.id, {
        statuses: ['queued', 'sending', 'sent', 'skipped', 'failed'],
        kinds: ['rebook_nudge', 'review_request'],
        limit: 30,
      }),
  });
}

export function useMarketingCampaigns() {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: campaignsKey(salon.id),
    queryFn: () => listMarketingCampaigns(supabase, salon.id),
  });
}

function useMarketingMutation<T, R>(fn: (input: T) => Promise<R>) {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['marketing', salon.id] }),
  });
}

export function useApproveMarketingMessage() {
  return useMarketingMutation(
    ({ id, subject, body }: { id: string; subject?: string; body?: string }) =>
      approveMarketingMessage(supabase, id, { subject, body }),
  );
}

export function useDismissMarketingMessage() {
  return useMarketingMutation((id: string) => dismissMarketingMessage(supabase, id));
}

export function useSaveCampaign() {
  const salon = useCurrentSalon();
  return useMarketingMutation((input: SaveMarketingCampaignInput) =>
    saveMarketingCampaign(supabase, salon.id, input),
  );
}

export function useSendCampaign() {
  return useMarketingMutation(({ id, sendAt }: { id: string; sendAt?: string | null }) =>
    sendMarketingCampaign(supabase, id, sendAt),
  );
}

export function useCancelCampaign() {
  return useMarketingMutation((id: string) => cancelMarketingCampaign(supabase, id));
}

/** How many opted-in clients the audience reaches right now. */
export function useAudienceCount(audience: MarketingAudience) {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: ['marketing', salon.id, 'audience', audience],
    queryFn: () => countMarketingAudience(supabase, salon.id, audience),
  });
}

/** Suggested subject and body (AI when set up, else a template). The stylist edits it. */
export function useDraftCopy() {
  const salon = useCurrentSalon();
  return useMutation({
    mutationFn: (input: { kind: 'campaign' | 'rebook_nudge' | 'review_request'; brief?: string }) =>
      invoke<MarketingDraftCopyResponse>({ action: 'draft_copy', salonId: salon.id, ...input }),
  });
}

/** The client's unsubscribe link (/u/{token}, signed out). The token is the only credential. */
export function subscriptionApi(token: string) {
  return {
    view: () => invoke<MarketingSubscriptionResponse>({ action: 'view', token }),
    unsubscribe: () => invoke<MarketingSubscriptionResponse>({ action: 'unsubscribe', token }),
    resubscribe: () => invoke<MarketingSubscriptionResponse>({ action: 'resubscribe', token }),
  };
}
