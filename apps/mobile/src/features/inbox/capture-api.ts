import type { ManualCaptureRequest, ManualCaptureResponse } from '@chairside/ai/inbox';
import type { ChairsideClient } from '@chairside/db';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

import { AiRequestError } from '../ai-settings/api';

export type CaptureInput = Omit<ManualCaptureRequest, 'action' | 'salonId'>;

async function readError(error: unknown): Promise<AiRequestError> {
  const context = (error as { context?: unknown }).context;
  if (context instanceof Response) {
    try {
      const body = (await context.json()) as { error?: { code: string; message: string } };
      if (body.error) return new AiRequestError(body.error.code, body.error.message);
    } catch {
      // fall through
    }
  }
  return new AiRequestError('network', error instanceof Error ? error.message : String(error));
}

/**
 * Sends a pasted, shared or screenshotted message through the same `inbox` pipeline as the
 * Shortcut: the AI reads it, the engine holds a slot, and it lands on an Inbox card.
 */
export async function captureRequest(
  client: ChairsideClient,
  salonId: string,
  input: CaptureInput,
): Promise<ManualCaptureResponse> {
  const body: ManualCaptureRequest = { action: 'capture', salonId, ...input };
  const { data, error } = await client.functions.invoke<ManualCaptureResponse>('inbox', { body });
  if (error) throw await readError(error);
  if (!data) throw new AiRequestError('invalid_response', 'Empty response from the inbox service');
  return data;
}

export function useCaptureRequest() {
  const salon = useCurrentSalon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CaptureInput) => captureRequest(supabase, salon.id, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['appointments', salon.id] }),
  });
}
