import type {
  PaymentsAccountResponse,
  PaymentsErrorBody,
  PaymentsLinkResponse,
  PaymentsRequest,
} from '@chairside/payments';
import type { ChairsideClient } from '@chairside/db';

export class PaymentsRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentsRequestError';
  }
}

/** Turns a `functions.invoke` error into the function's `{ error: { code, message } }`. */
export async function readFunctionError(error: unknown): Promise<PaymentsRequestError> {
  const context = (error as { context?: unknown }).context;
  if (context instanceof Response) {
    try {
      const body = (await context.json()) as Partial<PaymentsErrorBody>;
      if (body.error) return new PaymentsRequestError(body.error.code, body.error.message);
    } catch {
      // fall through
    }
  }
  return new PaymentsRequestError(
    'network',
    error instanceof Error ? error.message : String(error),
  );
}

/** Calls the `payments` Edge Function, which holds the Stripe secret key server-side. */
export async function invokePayments(
  supabase: ChairsideClient,
  request: Extract<PaymentsRequest, { action: 'status' }>,
): Promise<PaymentsAccountResponse>;
export async function invokePayments(
  supabase: ChairsideClient,
  request: Extract<PaymentsRequest, { action: 'onboard' | 'dashboard' }>,
): Promise<PaymentsLinkResponse>;
export async function invokePayments(
  supabase: ChairsideClient,
  request: PaymentsRequest,
): Promise<PaymentsAccountResponse | PaymentsLinkResponse> {
  const { data, error } = await supabase.functions.invoke<
    PaymentsAccountResponse | PaymentsLinkResponse
  >('payments', { body: request });
  if (error) throw await readFunctionError(error);
  if (!data) throw new PaymentsRequestError('invalid_response', 'Empty response from payments');
  return data;
}
