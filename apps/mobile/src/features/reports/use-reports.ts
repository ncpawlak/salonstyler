import {
  addDays,
  parseLocalDate,
  rangeUtilization,
  summarizeUtilization,
  toSalonDate,
  zonedToUtc,
  type DayUtilization,
} from '@chairside/core';
import { chunkRange, type DateRange } from '@chairside/core/reports';
import { getSalesReport } from '@chairside/db/reports';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { useAppointments } from '@/features/appointments/api';
import { useWorkHours } from '@/features/hours/use-work-hours';
import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

/** Today's salon-local date, fixed when the screen opens. */
export function useSalonToday() {
  const salon = useCurrentSalon();
  const [today] = useState(() => toSalonDate(Date.now(), salon.timezone));
  return today;
}

/** Sales, tips, clients and appointment outcomes from the `sales_report` RPC. */
export function useSalesReport(range: DateRange | null) {
  const salon = useCurrentSalon();
  return useQuery({
    queryKey: ['sales-report', salon.id, range?.from, range?.to],
    queryFn: () => getSalesReport(supabase, salon.id, range ?? {}),
    enabled: range != null,
  });
}

/**
 * Booked share of working time per day, from the same engine as the calendar's donuts and
 * heatmap. The engine handles ≤ 62 days at a time, so longer ranges are computed in chunks.
 */
export function useReportUtilization(range: DateRange) {
  const salon = useCurrentSalon();
  const workHours = useWorkHours(salon.id);
  const hours = workHours.data?.hours;
  const tz = hours?.timeZone ?? salon.timezone;

  const instants = useMemo(
    () => ({
      from: new Date(zonedToUtc(parseLocalDate(range.from), 0, tz)).toISOString(),
      to: new Date(zonedToUtc(addDays(parseLocalDate(range.to), 1), 0, tz)).toISOString(),
    }),
    [range.from, range.to, tz],
  );
  const appointments = useAppointments(instants);

  const days = useMemo<DayUtilization[] | null>(() => {
    if (!hours || !appointments.data) return null;
    const list = appointments.data;
    return chunkRange(range).flatMap((c) => rangeUtilization(hours, c.from, c.to, list));
  }, [hours, appointments.data, range]);
  const summary = useMemo(() => (days ? summarizeUtilization(days) : null), [days]);

  return {
    days,
    summary,
    isLoading: workHours.isLoading || appointments.isLoading,
    isError: workHours.isError || appointments.isError,
  };
}
