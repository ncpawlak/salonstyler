import type { AiErrorBody } from '@chairside/ai';
import type {
  AssistantCardResponse,
  AssistantClientResponse,
  AssistantMessageResponse,
  AssistantRequest,
  AssistantStatusResponse,
} from '@chairside/ai/assistant-server';
import type { ChairsideClient } from '@chairside/db';

import { AiRequestError } from '@/features/ai-settings/api';

type Req<A extends AssistantRequest['action']> = Omit<
  Extract<AssistantRequest, { action: A }>,
  'action' | 'salonId'
>;

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
  return new AiRequestError('network', error instanceof Error ? error.message : String(error));
}

async function invoke<T>(supabase: ChairsideClient, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>('ai-assistant', { body });
  if (error) throw await readError(error);
  if (!data) throw new AiRequestError('invalid_response', 'Empty response from Ask Chairside');
  return data;
}

/**
 * Calls the `ai-assistant` Edge Function. The model, the salon's key and every tool run
 * server-side; bookings it suggests are held drafts until the owner taps Confirm.
 */
export function assistantApi(supabase: ChairsideClient, salonId: string) {
  return {
    status: () => invoke<AssistantStatusResponse>(supabase, { action: 'status', salonId }),
    message: (r: Req<'message'>) =>
      invoke<AssistantMessageResponse>(supabase, { action: 'message', salonId, ...r }),
    propose: (r: Req<'propose'>) =>
      invoke<AssistantCardResponse>(supabase, { action: 'propose', salonId, ...r }),
    confirm: (appointmentId: string) =>
      invoke<AssistantCardResponse>(supabase, { action: 'confirm', salonId, appointmentId }),
    discard: (appointmentId: string) =>
      invoke<AssistantCardResponse>(supabase, { action: 'discard', salonId, appointmentId }),
    createClient: (r: Req<'create_client'>) =>
      invoke<AssistantClientResponse>(supabase, { action: 'create_client', salonId, ...r }),
  };
}

export type AssistantApi = ReturnType<typeof assistantApi>;
