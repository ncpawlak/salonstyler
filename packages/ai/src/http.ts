import type { AiProvider } from './providers.ts';
import type { FetchLike } from './types.ts';

export type AiErrorCode =
  | 'auth' // bad / revoked key, or no access to the model
  | 'rate_limit' // provider rate limit or quota
  | 'bad_request' // invalid model id, schema, etc.
  | 'unavailable' // provider 5xx / overloaded
  | 'network'
  | 'invalid_response';

/** Provider failure with a message that is safe to show the stylist (API keys are redacted). */
export class AiProviderError extends Error {
  readonly code: AiErrorCode;
  readonly provider: AiProvider;
  readonly status: number | undefined;

  constructor(provider: AiProvider, code: AiErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'AiProviderError';
    this.provider = provider;
    this.code = code;
    this.status = status;
  }
}

const KEY_LIKE = /\b(?:sk-[A-Za-z0-9_-]{4,}|AIza[A-Za-z0-9_-]{8,})[A-Za-z0-9_*.-]*/g;

/** Removes the key (and anything key-shaped) from provider error text. */
export function redactSecrets(text: string, apiKey?: string): string {
  let out = text;
  if (apiKey && apiKey.length >= 8) out = out.split(apiKey).join('[redacted]');
  return out.replace(KEY_LIKE, '[redacted]');
}

function codeForStatus(status: number, body: unknown): AiErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'unavailable';
  // Gemini reports a bad key as 400 INVALID_ARGUMENT with reason API_KEY_INVALID.
  if (JSON.stringify(body ?? '').includes('API_KEY_INVALID')) return 'auth';
  return 'bad_request';
}

function extractErrorMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error: unknown }).error;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object' && 'message' in err) {
      const message = (err as { message: unknown }).message;
      if (typeof message === 'string') return message;
    }
  }
  return undefined;
}

export interface PostJsonArgs {
  provider: AiProvider;
  apiKey: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

export async function postJson<T>(args: PostJsonArgs): Promise<T> {
  const doFetch: FetchLike = args.fetch ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await doFetch(args.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...args.headers },
      body: JSON.stringify(args.body),
      signal: args.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AiProviderError(
      args.provider,
      'network',
      redactSecrets(`Could not reach ${args.provider}: ${message}`, args.apiKey),
    );
  }

  const raw = await response.text();
  let json: unknown;
  try {
    json = raw ? JSON.parse(raw) : undefined;
  } catch {
    json = undefined;
  }

  if (!response.ok) {
    const detail = extractErrorMessage(json) ?? `HTTP ${response.status}`;
    throw new AiProviderError(
      args.provider,
      codeForStatus(response.status, json),
      redactSecrets(detail, args.apiKey),
      response.status,
    );
  }
  if (json === undefined || json === null || typeof json !== 'object') {
    throw new AiProviderError(
      args.provider,
      'invalid_response',
      'Provider returned non-JSON output',
    );
  }
  return json as T;
}

export function parseToolArguments(provider: AiProvider, raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === '') return {};
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new AiProviderError(
        provider,
        'invalid_response',
        'Tool call arguments were not valid JSON',
      );
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AiProviderError(
      provider,
      'invalid_response',
      'Tool call arguments must be a JSON object',
    );
  }
  return value as Record<string, unknown>;
}

export const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
