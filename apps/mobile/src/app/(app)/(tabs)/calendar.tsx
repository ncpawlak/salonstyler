import {
  addDays,
  dayUtilization,
  formatLocalDate,
  parseLocalDate,
  toSalonDate,
  zonedToUtc,
} from '@chairside/core';
import type { AppointmentWithDetails } from '@chairside/db/appointments';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import { Screen } from '@/components/shell/screen';
import { Button, EmptyState, SegmentedControl, Skeleton, Text } from '@/components/ui';
import { useAppointments } from '@/features/appointments/api';
import { AppointmentSheet } from '@/features/appointments/appointment-sheet';
import { BookingSheet, type BookingTarget } from '@/features/appointments/booking-sheet';
import { DayTimeline } from '@/features/appointments/day-timeline';
import { formatLocalDateLong } from '@/features/appointments/format';
import { useMoveAppointment } from '@/features/appointments/use-move';
import { DaySummary } from '@/features/calendar/day-summary';
import { MonthView } from '@/features/calendar/month-view';
import { useAppointmentsRealtime } from '@/features/calendar/use-calendar-data';
import { WeekView } from '@/features/calendar/week-view';
import { useWorkHours } from '@/features/hours/use-work-hours';
import { haptics } from '@/lib/haptics';
import { useCurrentSalon } from '@/providers/session-provider';

type Mode = 'day' | 'week' | 'month';

const modes = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
] as const;

function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export default function CalendarScreen() {
  const salon = useCurrentSalon();
  const workHours = useWorkHours(salon.id);
  const tz = workHours.data?.hours.timeZone ?? salon.timezone;
  const now = useNow();
  const today = toSalonDate(now, tz);

  const [mode, setMode] = useState<Mode>('day');
  const [date, setDate] = useState(today);
  useAppointmentsRealtime();

  const pickDay = (d: string) => {
    setDate(d);
    setMode('day');
  };

  const subtitle =
    mode === 'day'
      ? formatLocalDateLong(date)
      : mode === 'week'
        ? 'How busy each day is'
        : 'Busier days are darker';

  return (
    <Screen
      title="Calendar"
      subtitle={subtitle}
      toolbar={
        <SegmentedControl
          accessibilityLabel="Calendar view"
          options={modes}
          value={mode}
          onChange={setMode}
        />
      }
    >
      {mode === 'day' ? (
        <DayMode date={date} today={today} now={now} onDateChange={setDate} />
      ) : null}
      {mode === 'week' ? (
        <WeekView date={date} today={today} now={now} onDateChange={setDate} onPickDay={pickDay} />
      ) : null}
      {mode === 'month' ? (
        <MonthView date={date} today={today} onDateChange={setDate} onPickDay={pickDay} />
      ) : null}
    </Screen>
  );
}

function DayMode({
  date,
  today,
  now,
  onDateChange,
}: {
  date: string;
  today: string;
  now: number;
  onDateChange: (date: string) => void;
}) {
  const salon = useCurrentSalon();
  const workHours = useWorkHours(salon.id);
  const hours = workHours.data?.hours;
  const grid = workHours.data?.rules.slotGridMinutes ?? 15;
  const tz = hours?.timeZone ?? salon.timezone;

  const range = useMemo(() => {
    const local = parseLocalDate(date);
    return {
      from: new Date(zonedToUtc(local, 0, tz)).toISOString(),
      to: new Date(zonedToUtc(addDays(local, 1), 0, tz)).toISOString(),
    };
  }, [date, tz]);
  const appointments = useAppointments(range);
  const list = useMemo(() => appointments.data ?? [], [appointments.data]);
  const utilization = useMemo(
    () => (hours && appointments.data ? dayUtilization(hours, date, appointments.data) : null),
    [hours, appointments.data, date],
  );

  const [booking, setBooking] = useState<BookingTarget | null>(null);
  const [selected, setSelected] = useState<AppointmentWithDetails | null>(null);
  const [pendingMoves, setPendingMoves] = useState<Record<string, number>>({});
  const [banner, setBanner] = useState<{ text: string; tone: 'destructive' | 'muted' } | null>(
    null,
  );
  const { move } = useMoveAppointment(hours, list);

  useEffect(() => {
    if (!banner) return;
    const id = setTimeout(() => setBanner(null), 8_000);
    return () => clearTimeout(id);
  }, [banner]);

  const shiftDay = (days: number) => {
    haptics.selection();
    onDateChange(formatLocalDate(addDays(parseLocalDate(date), days)));
  };

  const newAppointment = useCallback(() => {
    // Default to the next grid slot today, otherwise 10 AM.
    const gridMs = grid * 60_000;
    const start =
      date === today
        ? Math.ceil(Date.now() / gridMs) * gridMs
        : zonedToUtc(parseLocalDate(date), 10 * 60, tz);
    setBooking({ kind: 'new', start });
  }, [date, today, grid, tz]);

  const dragMove = async (appt: AppointmentWithDetails, deltaMinutes: number) => {
    setPendingMoves((m) => ({ ...m, [appt.id]: deltaMinutes }));
    const result = await move(appt, deltaMinutes);
    setPendingMoves(({ [appt.id]: _, ...rest }) => rest);
    if (result.ok) {
      haptics.success();
      setBanner(result.warning ? { text: result.warning, tone: 'muted' } : null);
    } else {
      haptics.error();
      setBanner({ text: result.message, tone: 'destructive' });
    }
  };

  return (
    <View className="gap-3">
      <View className="flex-row items-center gap-2">
        <Button
          variant="secondary"
          size="icon"
          icon="chevron-back"
          accessibilityLabel="Previous day"
          onPress={() => shiftDay(-1)}
        />
        <Button
          variant={date === today ? 'secondary' : 'outline'}
          size="sm"
          label="Today"
          onPress={() => onDateChange(today)}
        />
        <Button
          variant="secondary"
          size="icon"
          icon="chevron-forward"
          accessibilityLabel="Next day"
          onPress={() => shiftDay(1)}
        />
        <View className="flex-1" />
        <Button
          size="sm"
          icon="add"
          label="New"
          accessibilityLabel="New appointment"
          disabled={!hours}
          onPress={newAppointment}
        />
      </View>

      {banner ? (
        <View
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className={
            banner.tone === 'destructive'
              ? 'flex-row items-center gap-2 rounded-xl bg-destructive/10 px-4 py-3'
              : 'flex-row items-center gap-2 rounded-xl bg-muted px-4 py-3'
          }
        >
          <Text variant="subhead" tone={banner.tone} className="flex-1">
            {banner.text}
          </Text>
          <Button
            variant="ghost"
            size="icon"
            icon="close"
            accessibilityLabel="Dismiss"
            onPress={() => setBanner(null)}
          />
        </View>
      ) : null}

      {!hours || appointments.isLoading ? (
        <View className="gap-3">
          <Skeleton height={64} />
          <Skeleton height={96} />
          <Skeleton height={64} />
        </View>
      ) : appointments.isError ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load appointments"
          message="Check your connection and try again."
          actionLabel="Retry"
          onAction={() => appointments.refetch()}
        />
      ) : (
        <>
          {utilization ? <DaySummary day={utilization} now={now} /> : null}
          {list.length === 0 ? (
            <Text variant="footnote" tone="muted">
              Nothing booked. Long-press a time or tap New to book.
            </Text>
          ) : null}
          <DayTimeline
            date={date}
            hours={hours}
            appointments={list}
            gridMinutes={grid}
            now={now}
            pendingMoves={pendingMoves}
            onCreate={(start) => setBooking({ kind: 'new', start })}
            onSelect={setSelected}
            onMove={dragMove}
          />
        </>
      )}

      {hours ? (
        <>
          <BookingSheet
            target={booking}
            onClose={() => setBooking(null)}
            hours={hours}
            gridMinutes={grid}
            appointments={list}
          />
          <AppointmentSheet
            appointment={selected}
            onClose={() => setSelected(null)}
            hours={hours}
            gridMinutes={grid}
            onMove={move}
            onEditServices={(appt) => {
              setSelected(null);
              setBooking({ kind: 'edit', appointment: appt });
            }}
          />
        </>
      ) : null}
    </View>
  );
}
