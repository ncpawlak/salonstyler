import type { ReplyKind } from '@chairside/ai/assistant';
import {
  getReplySettings,
  listRequestReplies,
  recordClientReply,
  type RecordClientReplyInput,
  type ReplySettings,
  updateReplySettings,
} from '@chairside/db/replies';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

import { assistantApi } from '../assistant/api';

// Realtime refreshes everything under `['replies', salonId]` when a client_replies row changes.
const repliesKey = (salonId: string) => ['replies', salonId] as const;
const settingsKey = (salonId: string) => ['reply-settings', salonId] as const;

export function useReplySettings() {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: settingsKey(salon.id),
    queryFn: () => getReplySettings(supabase, salon.id),
  });
}

export function useUpdateReplySettings() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<ReplySettings>) => updateReplySettings(supabase, salon.id, patch),
    onSettled: () => queryClient.invalidateQueries({ queryKey: settingsKey(salon.id) }),
  });
}

/** Replies already sent (or queued) for these Inbox requests, newest first. */
export function useRequestReplies(requestIds: readonly string[]) {
  const salon = useCurrentSalon();
  const ids = [...requestIds].sort();
  return useQuery({
    queryKey: [...repliesKey(salon.id), 'requests', ids.join(',')],
    queryFn: () => listRequestReplies(supabase, salon.id, ids),
    enabled: ids.length > 0,
  });
}

export function useRecordReply() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RecordClientReplyInput) => recordClientReply(supabase, salon.id, input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: repliesKey(salon.id) }),
  });
}

export interface ReplyDraftRequest {
  kind: ReplyKind;
  requestId?: string | null;
  appointmentId?: string | null;
  clientId?: string | null;
}

/** Asks the server for a draft; the model only words it, and it's never sent from here. */
export function useReplyDraft(request: ReplyDraftRequest | null) {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: [
      'reply-draft',
      salon.id,
      request?.kind,
      request?.requestId,
      request?.appointmentId,
      request?.clientId,
    ],
    queryFn: () =>
      assistantApi(supabase, salon.id).draftReply({
        kind: request!.kind,
        ...(request!.requestId ? { requestId: request!.requestId } : {}),
        ...(request!.appointmentId ? { appointmentId: request!.appointmentId } : {}),
        ...(request!.clientId ? { clientId: request!.clientId } : {}),
      }),
    enabled: !!request,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
}
