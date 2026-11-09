// The notifier: drains notifications_outbox and delivers through Expo Push. Pure logic with
// injected dependencies so it can be unit tested; supabase/functions/notifier wires it up.
import {
  chunk,
  EXPO_CHUNK_SIZE,
  type ExpoPushMessage,
  type ExpoPushTicket,
  type FetchLike,
  sendExpoPush,
} from './expo.ts';

export { EXPO_PUSH_URL, ExpoPushError, sendExpoPush } from './expo.ts';
export type { ExpoPushMessage, ExpoPushTicket, FetchLike } from './expo.ts';

/** The columns of notifications_outbox the notifier uses. */
export interface OutboxRow {
  id: string;
  salon_id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  category: string | null;
  data: Record<string, unknown> | null;
}

export interface PushTokenRow {
  salon_id: string;
  user_id: string;
  token: string;
}

export interface NotificationResult {
  id: string;
  outcome: 'sent' | 'skipped' | 'retry';
  error?: string;
  tickets?: ExpoPushTicket[];
}

export interface NotifierDeps {
  /** public.claim_notifications(limit) */
  claim(limit: number): Promise<OutboxRow[]>;
  /** Push tokens for these recipients (push_tokens rows). */
  tokensFor(recipients: { salonId: string; userId: string }[]): Promise<PushTokenRow[]>;
  /** Removes tokens Expo reported as DeviceNotRegistered. */
  deleteTokens(tokens: string[]): Promise<void>;
  /** public.finish_notifications(results) */
  finish(results: NotificationResult[]): Promise<void>;
  /** Defaults to the Expo Push API. */
  send?: (messages: ExpoPushMessage[]) => Promise<ExpoPushTicket[]>;
  fetch?: FetchLike;
  expoAccessToken?: string;
  batchSize?: number;
  maxBatches?: number;
}

export interface NotifierSummary {
  claimed: number;
  sent: number;
  skipped: number;
  retried: number;
  removedTokens: number;
}

const isDeviceGone = (t: ExpoPushTicket) =>
  t.status === 'error' && t.details?.error === 'DeviceNotRegistered';

export function toExpoMessage(row: OutboxRow, token: string): ExpoPushMessage {
  return {
    to: token,
    title: row.title,
    body: row.body,
    data: { ...(row.data ?? {}), notificationId: row.id },
    ...(row.category ? { categoryId: row.category } : {}),
    sound: 'default',
    priority: 'high',
  };
}

/** Delivers one claimed batch and reports each row's outcome. */
export async function deliverBatch(
  rows: OutboxRow[],
  deps: NotifierDeps,
): Promise<{ results: NotificationResult[]; removedTokens: string[] }> {
  const send =
    deps.send ??
    ((messages: ExpoPushMessage[]) =>
      sendExpoPush(messages, { fetch: deps.fetch, accessToken: deps.expoAccessToken }));

  const recipientKey = (salonId: string, userId: string) => `${salonId}:${userId}`;
  const recipients = [
    ...new Map(
      rows.map((r) => [
        recipientKey(r.salon_id, r.user_id),
        { salonId: r.salon_id, userId: r.user_id },
      ]),
    ).values(),
  ];
  const tokens = recipients.length > 0 ? await deps.tokensFor(recipients) : [];
  const byRecipient = new Map<string, string[]>();
  for (const t of tokens) {
    const key = recipientKey(t.salon_id, t.user_id);
    byRecipient.set(key, [...(byRecipient.get(key) ?? []), t.token]);
  }

  const outgoing: { rowId: string; message: ExpoPushMessage }[] = [];
  for (const row of rows) {
    for (const token of byRecipient.get(recipientKey(row.salon_id, row.user_id)) ?? []) {
      outgoing.push({ rowId: row.id, message: toExpoMessage(row, token) });
    }
  }

  const tickets = new Map<string, ExpoPushTicket[]>();
  const failures = new Map<string, string>();
  const gone = new Set<string>();
  for (const part of chunk(outgoing, EXPO_CHUNK_SIZE)) {
    try {
      const result = await send(part.map((p) => p.message));
      part.forEach((p, i) => {
        const ticket = result[i];
        if (!ticket) return;
        tickets.set(p.rowId, [...(tickets.get(p.rowId) ?? []), ticket]);
        if (isDeviceGone(ticket)) gone.add(p.message.to);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const p of part) failures.set(p.rowId, message);
    }
  }

  const results = rows.map((row): NotificationResult => {
    const rowTickets = tickets.get(row.id) ?? [];
    if (rowTickets.some((t) => t.status === 'ok')) {
      return { id: row.id, outcome: 'sent', tickets: rowTickets };
    }
    const failure = failures.get(row.id);
    if (failure) return { id: row.id, outcome: 'retry', error: failure };
    const transient = rowTickets.find((t) => t.status === 'error' && !isDeviceGone(t));
    if (transient?.status === 'error') {
      return { id: row.id, outcome: 'retry', error: transient.message, tickets: rowTickets };
    }
    if (rowTickets.length > 0) {
      return {
        id: row.id,
        outcome: 'skipped',
        error: 'device_not_registered',
        tickets: rowTickets,
      };
    }
    return { id: row.id, outcome: 'skipped', error: 'no_push_tokens' };
  });

  return { results, removedTokens: [...gone] };
}

/** Claims and delivers batches until the outbox has nothing due (bounded by maxBatches). */
export async function runNotifier(deps: NotifierDeps): Promise<NotifierSummary> {
  const batchSize = deps.batchSize ?? 100;
  const maxBatches = deps.maxBatches ?? 10;
  const summary: NotifierSummary = {
    claimed: 0,
    sent: 0,
    skipped: 0,
    retried: 0,
    removedTokens: 0,
  };

  for (let i = 0; i < maxBatches; i++) {
    const rows = await deps.claim(batchSize);
    if (rows.length === 0) break;
    summary.claimed += rows.length;

    const { results, removedTokens } = await deliverBatch(rows, deps);
    if (removedTokens.length > 0) {
      await deps.deleteTokens(removedTokens);
      summary.removedTokens += removedTokens.length;
    }
    await deps.finish(results);
    for (const r of results) {
      if (r.outcome === 'sent') summary.sent++;
      else if (r.outcome === 'skipped') summary.skipped++;
      else summary.retried++;
    }
    if (rows.length < batchSize) break;
  }
  return summary;
}
