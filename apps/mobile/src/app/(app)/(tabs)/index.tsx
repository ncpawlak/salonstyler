import { addDays, parseLocalDate, toSalonDate, zonedToUtc } from '@chairside/core';
import { getAppointment, type AppointmentWithDetails } from '@chairside/db/appointments';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import { Screen } from '@/components/shell/screen';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  ListGroup,
  ListRow,
  SectionHeader,
  Skeleton,
  Text,
} from '@/components/ui';
import { errorMessage, useAppointments } from '@/features/appointments/api';
import { AppointmentSheet } from '@/features/appointments/appointment-sheet';
import { BookingSheet, type BookingTarget } from '@/features/appointments/booking-sheet';
import { formatLocalDateLong, formatTime } from '@/features/appointments/format';
import { useMoveAppointment } from '@/features/appointments/use-move';
import { ReminderQueueCard } from '@/features/client-self-service/reminder-queue-card';
import { MissingFormsCard } from '@/features/forms/missing-forms-card';
import { useWorkHours } from '@/features/hours/use-work-hours';
import { usePendingRequests, useRespondToRequest } from '@/features/today/api';
import { DayCard } from '@/features/today/day-card';
import { InChairRow, NextClientCard, NoNextClient } from '@/features/today/next-client-card';
import { ProcessingTimers } from '@/features/today/processing-timers';
import { QuickActions } from '@/features/today/quick-actions';
import { RequestStack, type RequestDecision } from '@/features/today/request-stack';
import { parseLateParam } from '@/features/today/running-late';
import { RunningLateSheet } from '@/features/today/running-late-sheet';
import { serviceColor } from '@/features/today/service-pills';
import { checkoutCandidate, clientSpan, summarizeToday } from '@/features/today/summary';
import { haptics } from '@/lib/haptics';
import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Home: who's next, how busy am I, and what needs my attention. */
export default function TodayScreen() {
  const salon = useCurrentSalon();
  const workHours = useWorkHours(salon.id);
  const hours = workHours.data?.hours;
  const grid = workHours.data?.rules.slotGridMinutes ?? 15;
  const tz = hours?.timeZone ?? salon.timezone;
  const now = useNow(15_000);
  const today = toSalonDate(now, tz);

  const range = useMemo(() => {
    const local = parseLocalDate(today);
    return {
      from: new Date(zonedToUtc(local, 0, tz)).toISOString(),
      to: new Date(zonedToUtc(addDays(local, 1), 0, tz)).toISOString(),
    };
  }, [today, tz]);
  const appointments = useAppointments(range);
  const list = useMemo(() => appointments.data ?? [], [appointments.data]);
  const requests = usePendingRequests();
  const respond = useRespondToRequest();

  const summary = useMemo(
    () => (hours ? summarizeToday(hours, today, list, now) : null),
    [hours, today, list, now],
  );

  const [booking, setBooking] = useState<BookingTarget | null>(null);
  const [selected, setSelected] = useState<AppointmentWithDetails | null>(null);
  const [late, setLate] = useState<{ delay: number | null } | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const { move } = useMoveAppointment(hours, list);

  // Hand-offs from global search / Ask Chairside: open an appointment, start a booking for a
  // client, or open "Running late" with a delay.
  const params = useLocalSearchParams<{
    appointment?: string;
    bookClient?: string;
    bookClientName?: string;
    bookClientPhone?: string;
    late?: string;
  }>();
  useEffect(() => {
    if (!hours || appointments.isLoading || !params.late) return;
    const delay = parseLateParam(params.late);
    router.setParams({ late: undefined });
    setTimeout(() => setLate({ delay }), 0);
  }, [hours, appointments.isLoading, params.late]);
  useEffect(() => {
    if (!hours) return;
    if (params.appointment) {
      const id = params.appointment;
      router.setParams({ appointment: undefined });
      getAppointment(supabase, id)
        .then((appt) => appt && setSelected(appt))
        .catch(() => {});
    } else if (params.bookClient) {
      const gridMs = grid * 60_000;
      const target: BookingTarget = {
        kind: 'new',
        start: Math.ceil(Date.now() / gridMs) * gridMs,
        client: {
          id: params.bookClient,
          name: params.bookClientName ?? '',
          phone: params.bookClientPhone || null,
        },
      };
      // Deferred: clearing the params re-runs this effect, so no cleanup here.
      setTimeout(() => setBooking(target), 0);
      router.setParams({
        bookClient: undefined,
        bookClientName: undefined,
        bookClientPhone: undefined,
      });
    }
  }, [
    hours,
    grid,
    params.appointment,
    params.bookClient,
    params.bookClientName,
    params.bookClientPhone,
  ]);

  const book = () => {
    const gridMs = grid * 60_000;
    setBooking({ kind: 'new', start: Math.ceil(Date.now() / gridMs) * gridMs });
  };

  const decide = (appt: AppointmentWithDetails, decision: RequestDecision) => {
    setRequestError(null);
    respond.mutate(
      { id: appt.id, approve: decision === 'approve' },
      {
        onError: (e) => {
          haptics.error();
          setRequestError(
            `Couldn't ${decision} ${appt.client?.name ?? 'the request'}: ${errorMessage(e)}`,
          );
        },
      },
    );
  };

  const pending = requests.data ?? [];
  const later = summary
    ? list.filter(
        (a) =>
          a.id !== summary.next?.id &&
          a.status !== 'requested' &&
          a.status !== 'completed' &&
          clientSpan(a).start > now,
      )
    : [];
  const loading = !hours || appointments.isLoading;

  return (
    <Screen title="Today" subtitle={formatLocalDateLong(today)}>
      {loading ? (
        <View className="gap-3">
          <Skeleton height={220} />
          <Skeleton height={116} />
          <Skeleton height={140} />
        </View>
      ) : appointments.isError || !summary ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load your day"
          message="Check your connection and try again."
          actionLabel="Retry"
          onAction={() => appointments.refetch()}
        />
      ) : (
        <>
          {summary.current && summary.current.id !== summary.next?.id ? (
            <InChairRow
              appointment={summary.current}
              now={now}
              timeZone={tz}
              onOpen={setSelected}
            />
          ) : null}
          {summary.next ? (
            <NextClientCard
              appointment={summary.next}
              now={now}
              timeZone={tz}
              onOpen={setSelected}
            />
          ) : (
            <NoNextClient onBook={book} hasBookings={summary.clientCount > 0} />
          )}

          <View className="mt-3 gap-3">
            <DayCard summary={summary} />
            <ProcessingTimers appointments={list} />
          </View>

          <SectionHeader
            title={pending.length ? `Needs you · ${pending.length}` : 'Needs you'}
            action={
              pending.length > 1 ? (
                <Text variant="footnote" tone="subtle">
                  Swipe → approve · ← decline
                </Text>
              ) : undefined
            }
          />
          {requestError ? (
            <View
              accessibilityRole="alert"
              className="mb-3 flex-row items-center gap-2 rounded-xl bg-destructive/10 px-4 py-3"
            >
              <Text variant="subhead" tone="destructive" className="flex-1">
                {requestError}
              </Text>
              <Button
                variant="ghost"
                size="icon"
                icon="close"
                accessibilityLabel="Dismiss"
                onPress={() => setRequestError(null)}
              />
            </View>
          ) : null}
          {requests.isLoading ? (
            <Skeleton height={150} />
          ) : pending.length ? (
            <RequestStack requests={pending} timeZone={tz} onDecide={decide} onOpen={setSelected} />
          ) : (
            <Card className="flex-row items-center gap-3" testID="requests-caught-up">
              <Icon name="checkmark-done" color="success" />
              <Text variant="subhead" tone="muted">
                You’re all caught up. No requests waiting.
              </Text>
            </Card>
          )}

          <SectionHeader title="Quick actions" />
          <QuickActions
            actions={[
              { id: 'book', icon: 'add', label: 'Book', onPress: book },
              { id: 'block', icon: 'remove-circle-outline', label: 'Block time' },
              {
                id: 'late',
                icon: 'time-outline',
                label: 'Running late',
                onPress: () => setLate({ delay: null }),
              },
              {
                id: 'checkout',
                icon: 'card-outline',
                label: 'Checkout',
                onPress: () => {
                  const candidate = checkoutCandidate(list, now);
                  router.push(candidate ? `/checkout/${candidate.id}` : '/checkout');
                },
              },
            ]}
          />

          <ReminderQueueCard timeZone={tz} />
          <MissingFormsCard timeZone={tz} />

          {later.length ? (
            <>
              <SectionHeader
                title="Later today"
                action={
                  <Button
                    variant="ghost"
                    size="sm"
                    label="Calendar"
                    haptic="selection"
                    onPress={() => router.push('/calendar')}
                  />
                }
              />
              <ListGroup>
                {later.slice(0, 6).map((a, i, arr) => (
                  <ListRow
                    key={a.id}
                    title={a.client?.name ?? 'Walk-in'}
                    subtitle={a.services.map((s) => s.name).join(' + ') || 'Appointment'}
                    leading={
                      <View className="w-16">
                        <Text variant="subhead" numeric className="font-semibold">
                          {formatTime(clientSpan(a).start, tz)}
                        </Text>
                      </View>
                    }
                    trailing={
                      a.status === 'held' ? (
                        <Badge label="Hold" tone="warning" />
                      ) : (
                        <View
                          className="h-3 w-3 rounded-full"
                          style={{ backgroundColor: serviceColor(a.services[0]?.colorTag) }}
                        />
                      )
                    }
                    last={i === arr.length - 1}
                    onPress={() => setSelected(a)}
                  />
                ))}
              </ListGroup>
            </>
          ) : null}
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
          <RunningLateSheet
            open={!!late}
            onClose={() => setLate(null)}
            appointments={list}
            hours={hours}
            now={now}
            initialDelay={late?.delay}
          />
        </>
      ) : null}
    </Screen>
  );
}
