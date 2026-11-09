import type { AppointmentWithDetails, CapturedRequestWithDetails } from '@chairside/db';

/** One row in the Inbox: a texted request the agent captured, or any other pending booking. */
export type InboxItem =
  | { kind: 'captured'; id: string; request: CapturedRequestWithDetails }
  | { kind: 'appointment'; id: string; appointment: AppointmentWithDetails };

/**
 * Captured texts first (newest first), then requested appointments that came in another way. A
 * held slot from a text shows once, on its request's card.
 */
export function mergeInbox(
  captured: CapturedRequestWithDetails[],
  requested: AppointmentWithDetails[],
): InboxItem[] {
  const held = new Set(captured.map((r) => r.appointment_id).filter(Boolean));
  return [
    ...captured.map((request) => ({ kind: 'captured' as const, id: request.id, request })),
    ...requested
      .filter((a) => !held.has(a.id))
      .map((appointment) => ({ kind: 'appointment' as const, id: appointment.id, appointment })),
  ];
}
