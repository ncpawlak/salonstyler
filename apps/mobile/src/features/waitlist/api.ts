import type { AiErrorBody } from '@chairside/ai';
import { toSalonDate } from '@chairside/core';
import {
  addWaitlistEntry,
  type AddWaitlistEntryInput,
  dismissWaitlistOffer,
  getWaitlistSettings,
  listWaitlist,
  removeWaitlistEntry,
  sendWaitlistOffer,
  type WaitlistAcceptResponse,
  type WaitlistJoinResponse,
  type WaitlistProcessResponse,
  type WaitlistRequest,
  type WaitlistSendOfferResponse,
  type WaitlistSettings,
  type WaitlistViewResponse,
  updateWaitlistSettings,
} from '@chairside/db/waitlist';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { AiRequestError } from '@/features/ai-settings/api';
import { bookingClient } from '@/features/public-booking/api';
import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

export { AiRequestError as WaitlistRequestError };

async function readError(error: unknown): Promise<AiRequestError> {
  const context = (error as { context?: unknown }).context;
  if (context instanceof Response) {
    try {
      const body = (await context.json()) as Partial<AiErrorBody>;
      if (body.error) return new AiRequestError(body.error.code, body.error.message);
    } catch {
      // fall through
    }
  }
  return new AiRequestError('network', 'Can’t reach the salon right now. Check your connection.');
}

/** Calls the `waitlist` Edge Function as the salon member, or a booking-page client. */
async function invoke<T>(body: WaitlistRequest, client = supabase): Promise<T> {
  const { data, error } = await client.functions.invoke<T>('waitlist', { body });
  if (error) throw await readError(error);
  if (!data) throw new AiRequestError('invalid_response', 'Empty response from the salon');
  return data;
}

// --- The stylist's waitlist ------------------------------------------------------------------

const listKey = (salonId: string) => ['waitlist', salonId] as const;
const settingsKey = (salonId: string) => ['waitlist-settings', salonId] as const;

export function useWaitlist(timeZone: string) {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: listKey(salon.id),
    queryFn: () => listWaitlist(supabase, salon.id, toSalonDate(Date.now(), timeZone)),
  });
}

export function useWaitlistSettings() {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: settingsKey(salon.id),
    queryFn: () => getWaitlistSettings(supabase, salon.id),
  });
}

export function useUpdateWaitlistSettings() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: Partial<WaitlistSettings>) =>
      updateWaitlistSettings(supabase, salon.id, changes),
    onSuccess: (data) => queryClient.setQueryData(settingsKey(salon.id), data),
  });
}

function useWaitlistMutation<T, R>(fn: (input: T) => Promise<R>) {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: listKey(salon.id) }),
  });
}

export function useAddWaitlistEntry() {
  const salon = useCurrentSalon();
  return useWaitlistMutation((input: AddWaitlistEntryInput) =>
    addWaitlistEntry(supabase, salon.id, input),
  );
}

export function useRemoveWaitlistEntry() {
  return useWaitlistMutation((entryId: string) => removeWaitlistEntry(supabase, entryId));
}

export function useDismissWaitlistOffer() {
  return useWaitlistMutation((offerId: string) => dismissWaitlistOffer(supabase, offerId));
}

/** Text: marks the offer sent and returns the link to text. Email: the function emails it. */
export function useSendWaitlistOffer() {
  return useWaitlistMutation(
    async ({ offerId, via }: { offerId: string; via: 'text' | 'email' }) => {
      if (via === 'email') {
        await invoke<WaitlistSendOfferResponse>({ action: 'send_offer', offerId });
        return null;
      }
      const result = await sendWaitlistOffer(supabase, offerId, 'text');
      if (!result.ok) {
        throw new Error(
          result.message ?? 'That time isn’t available anymore. Pull to refresh the waitlist.',
        );
      }
      return result;
    },
  );
}

/** Matches any freed time now instead of waiting for the next minute's check. */
export function useCheckWaitlist() {
  const salon = useCurrentSalon();
  return useWaitlistMutation(() =>
    invoke<WaitlistProcessResponse>({ action: 'process', salonId: salon.id }),
  );
}

// --- Clients ---------------------------------------------------------------------------------

/** "Join the waitlist" on the booking page: needs the client's verified-email session. */
export function joinWaitlist(
  request: Omit<Extract<WaitlistRequest, { action: 'join' }>, 'action'>,
): Promise<WaitlistJoinResponse> {
  return invoke<WaitlistJoinResponse>({ action: 'join', ...request }, bookingClient());
}

/** The client's waitlist link (/w/{token}, signed out). The token is the only credential. */
export function waitlistLinkApi(token: string) {
  return {
    view: () => invoke<WaitlistViewResponse>({ action: 'view', token }),
    accept: (offerId: string) =>
      invoke<WaitlistAcceptResponse>({ action: 'accept', token, offerId }),
    leave: () => invoke<WaitlistViewResponse>({ action: 'leave', token }),
  };
}
