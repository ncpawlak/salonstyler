import { DEFAULT_ACTION_ID } from './categories.ts';

/** The `data` payload the database attaches to each push (see notifications_outbox.data). */
export interface NotificationData {
  type?:
    | 'request'
    | 'request_nudge'
    | 'cancellation'
    | 'daily_agenda'
    | 'payout_summary'
    | 'public_booking';
  salonId?: string;
  appointmentId?: string;
  date?: string;
}

export type NotificationIntent =
  | { kind: 'approve'; appointmentId: string }
  | { kind: 'decline'; appointmentId: string }
  | { kind: 'ignore'; appointmentId: string }
  | { kind: 'open'; href: string }
  | { kind: 'none' };

function asData(value: unknown): NotificationData {
  return value && typeof value === 'object' ? (value as NotificationData) : {};
}

/**
 * Maps a notification response (the action button pressed + the push's data) to what the app
 * should do. Approve / Decline / Ignore change the appointment; everything else opens a screen.
 */
export function notificationIntent(
  actionId: string | null | undefined,
  rawData: unknown,
): NotificationIntent {
  const data = asData(rawData);
  const id = typeof data.appointmentId === 'string' ? data.appointmentId : undefined;
  const isRequest = data.type === 'request' || data.type === 'request_nudge';

  if (id && isRequest) {
    switch (actionId) {
      case 'approve':
        return { kind: 'approve', appointmentId: id };
      case 'decline':
        return { kind: 'decline', appointmentId: id };
      case 'ignore':
        return { kind: 'ignore', appointmentId: id };
      case 'otherTime':
      case 'respond':
      case DEFAULT_ACTION_ID:
      case null:
      case undefined:
        return { kind: 'open', href: `/requests/${id}` };
      default:
        return { kind: 'none' };
    }
  }

  if (actionId && actionId !== DEFAULT_ACTION_ID) return { kind: 'none' };
  if (data.type === 'daily_agenda') return { kind: 'open', href: '/' };
  if (data.type === 'cancellation' || data.type === 'public_booking') {
    return { kind: 'open', href: '/calendar' };
  }
  if (data.type === 'payout_summary') return { kind: 'open', href: '/settings/payments' };
  return { kind: 'none' };
}
