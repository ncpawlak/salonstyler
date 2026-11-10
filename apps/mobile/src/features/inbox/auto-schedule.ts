import type { AutoScheduleRequest, AutoScheduleResponse } from '@chairside/ai/inbox';
import type { BookingSegment } from '@chairside/core';
import type { ChairsideClient } from '@chairside/db';
import type { AppointmentServiceSnapshot } from '@chairside/db/appointments';
import { scheduleCapturedRequest } from '@chairside/db/auto-schedule';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

import { AiRequestError } from '../ai-settings/api';
import { capturedRequestsKey } from './api';
import { readError } from './capture-api';

/** Asks the `inbox` function to read the request's "when" and rank engine-checked slots (#84). */
export async function autoSchedule(
  client: ChairsideClient,
  salonId: string,
  requestId: string,
): Promise<AutoScheduleResponse> {
  const body: AutoScheduleRequest = { action: 'auto_schedule', salonId, requestId };
  const { data, error } = await client.functions.invoke<AutoScheduleResponse>('inbox', { body });
  if (error) throw await readError(error);
  if (!data) throw new AiRequestError('invalid_response', 'Empty response from the inbox service');
  return data;
}

export function useAutoSchedule() {
  const salon = useCurrentSalon();
  return useMutation({
    mutationFn: (requestId: string) => autoSchedule(supabase, salon.id, requestId),
  });
}

export interface ScheduleRequestInput {
  requestId: string;
  segments: readonly BookingSegment[];
  services: readonly AppointmentServiceSnapshot[];
  priceCents: number | null;
}

/** Books / moves the picked slot and approves the request; the card leaves the Inbox. */
export function useScheduleCapturedRequest() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ScheduleRequestInput) =>
      scheduleCapturedRequest(supabase, {
        requestId: input.requestId,
        segments: input.segments,
        services: input.services.length ? input.services : null,
        priceCents: input.priceCents,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['appointments', salon.id] }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: capturedRequestsKey(salon.id) }),
  });
}
