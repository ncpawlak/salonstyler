import type { AiChatResponse, AiErrorBody, AiRequest, AiTestResponse } from '@chairside/ai';
import type { ChairsideClient } from '@chairside/db';

export class AiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AiRequestError';
  }
}

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

/** Calls the `ai` Edge Function, which reads the salon's key from Vault server-side. */
export async function invokeAi(
  supabase: ChairsideClient,
  request: Extract<AiRequest, { action: 'test' }>,
): Promise<AiTestResponse>;
export async function invokeAi(
  supabase: ChairsideClient,
  request: Extract<AiRequest, { action: 'chat' }>,
): Promise<AiChatResponse>;
export async function invokeAi(
  supabase: ChairsideClient,
  request: AiRequest,
): Promise<AiTestResponse | AiChatResponse> {
  const { data, error } = await supabase.functions.invoke<AiTestResponse | AiChatResponse>('ai', {
    body: request,
  });
  if (error) throw await readError(error);
  if (!data) throw new AiRequestError('invalid_response', 'Empty response from AI service');
  return data;
}
