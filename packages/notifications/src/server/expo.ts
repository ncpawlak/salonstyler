// Minimal Expo Push API client (https://docs.expo.dev/push-notifications/sending-notifications/).
// No SDK so it runs unchanged in Deno (Edge Function) and Node (tests).

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** Expo accepts at most 100 messages per request. */
export const EXPO_CHUNK_SIZE = 100;

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  categoryId?: string;
  sound?: 'default' | null;
  priority?: 'default' | 'normal' | 'high';
  channelId?: string;
}

export type ExpoPushTicket =
  { status: 'ok'; id: string } | { status: 'error'; message: string; details?: { error?: string } };

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class ExpoPushError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ExpoPushError';
    this.status = status;
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Sends up to 100 messages; returns one ticket per message, in order. Throws on request failure. */
export async function sendExpoPush(
  messages: ExpoPushMessage[],
  options: { fetch?: FetchLike; accessToken?: string } = {},
): Promise<ExpoPushTicket[]> {
  if (messages.length === 0) return [];
  if (messages.length > EXPO_CHUNK_SIZE) {
    throw new ExpoPushError(`At most ${EXPO_CHUNK_SIZE} messages per request`);
  }
  const doFetch = options.fetch ?? (globalThis.fetch as FetchLike);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    'Content-Type': 'application/json',
  };
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;

  const res = await doFetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(messages),
  });
  let payload: { data?: ExpoPushTicket[]; errors?: { message?: string }[] } | undefined;
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    payload = undefined;
  }
  if (!res.ok || !Array.isArray(payload?.data)) {
    const detail = payload?.errors?.[0]?.message ?? `HTTP ${res.status}`;
    throw new ExpoPushError(`Expo push failed: ${detail}`, res.status);
  }
  if (payload.data.length !== messages.length) {
    throw new ExpoPushError('Expo push returned an unexpected number of tickets', res.status);
  }
  return payload.data;
}
