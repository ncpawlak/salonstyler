import { planBooking, serviceFromSegments, type WorkHours } from '@chairside/core';
import type { AppointmentWithDetails } from '@chairside/db/appointments';
import { useCallback } from 'react';

import { errorMessage, useRescheduleAppointment } from './api';

export type MoveResult = { ok: true; warning?: string } | { ok: false; message: string };

/**
 * Moves an appointment as-is by `deltaMinutes`, checking the new time with the engine first so a
 * conflict shows a clear message without a round-trip (the DB constraint is the backstop).
 */
export function useMoveAppointment(
  hours: WorkHours | undefined,
  appointments: readonly AppointmentWithDetails[],
) {
  const { mutateAsync, isPending } = useRescheduleAppointment();
  const move = useCallback(
    async (appt: AppointmentWithDetails, deltaMinutes: number): Promise<MoveResult> => {
      if (!hours) return { ok: false, message: 'Work hours are still loading.' };
      const { service, start } = serviceFromSegments(appt.segments);
      const others = appointments.filter((a) => a.id !== appt.id);
      const plan = planBooking({
        service,
        start: start + deltaMinutes * 60_000,
        hours,
        existing: others.map((a) => ({ id: a.id, segments: a.segments })),
        names: Object.fromEntries(others.map((a) => [a.id, a.client?.name ?? 'a walk-in'])),
        now: Date.now(),
      });
      if (!plan.ok) return { ok: false, message: plan.message };
      try {
        await mutateAsync({ id: appt.id, segments: plan.segments });
        return {
          ok: true,
          warning: plan.warning === 'outside-hours' ? 'Moved outside your work hours.' : undefined,
        };
      } catch (e) {
        return { ok: false, message: errorMessage(e) };
      }
    },
    [hours, appointments, mutateAsync],
  );
  return { move, isPending };
}
