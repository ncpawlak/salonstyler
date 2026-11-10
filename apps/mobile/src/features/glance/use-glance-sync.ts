import { addDays, parseLocalDate, toSalonDate, zonedToUtc } from '@chairside/core';
import { useEffect, useMemo, useState } from 'react';

import { useAppointments } from '@/features/appointments/api';
import { useWorkHours } from '@/features/hours/use-work-hours';
import { useInbox } from '@/features/inbox/api';
import { syncLiveActivities } from '@/features/timers/live-activities';
import { syncTimerAlerts } from '@/features/timers/timer-alerts';
import { useProcessingTimers } from '@/features/timers/use-processing-timers';
import { useCurrentSalon } from '@/providers/session-provider';

import { buildGlance } from './glance';
import { syncWidgets } from './widget-sync';

function useTick(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * Keeps the outside-the-app surfaces in step with today's book (#40): processing-timer Live
 * Activities and "done" alerts, and the Home/Lock Screen widgets. Mounted once for the signed-in
 * tabs; uses the same queries as Today, so realtime changes flow straight through.
 */
export function useGlanceSync(): void {
  const salon = useCurrentSalon();
  const hours = useWorkHours(salon.id).data?.hours;
  const tz = hours?.timeZone ?? salon.timezone;
  const now = useTick(15_000);
  const today = toSalonDate(now, tz);

  const range = useMemo(() => {
    const local = parseLocalDate(today);
    return {
      from: new Date(zonedToUtc(local, 0, tz)).toISOString(),
      to: new Date(zonedToUtc(addDays(local, 1), 0, tz)).toISOString(),
    };
  }, [today, tz]);
  const appointments = useAppointments(range);
  const pending = useInbox().items?.length;

  const list = appointments.data;
  const { board, prefs, loaded } = useProcessingTimers(list ?? [], now);

  useEffect(() => {
    if (!loaded || !list) return;
    void syncLiveActivities(board, prefs.liveActivities, now);
    void syncTimerAlerts(board.running, prefs.alerts, now);
  }, [loaded, list, board, prefs.liveActivities, prefs.alerts, now]);

  useEffect(() => {
    if (!hours || !list || pending === undefined) return;
    syncWidgets(
      buildGlance({
        hours,
        date: today,
        appointments: list,
        pendingRequests: pending,
        now,
        dayEnd: Date.parse(range.to),
      }),
    );
  }, [hours, today, list, pending, now, range.to]);
}
