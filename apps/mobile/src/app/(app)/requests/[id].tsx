import { formatDuration } from '@chairside/core';
import type { AppointmentStatus } from '@chairside/db';
import { getAppointment } from '@chairside/db/appointments';
import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import { Badge, Button, Card, EmptyState, SkeletonRow, Text } from '@/components/ui';
import {
  errorMessage,
  useAppointments,
  useSetAppointmentStatus,
} from '@/features/appointments/api';
import { formatDay, formatTime } from '@/features/appointments/format';
import { useMoveAppointment } from '@/features/appointments/use-move';
import { useWorkHours } from '@/features/hours/use-work-hours';
import { formatPrice } from '@/features/services/data';
import { haptics } from '@/lib/haptics';
import { supabase } from '@/lib/supabase';
import { useCurrentSalon } from '@/providers/session-provider';

const HANDLED: Partial<Record<AppointmentStatus, string>> = {
  held: 'Hold',
  confirmed: 'Approved',
  cancelled: 'Released',
  completed: 'Completed',
  no_show: 'No-show',
};

/** A booking request opened from a push (Other time / Respond): approve, move, decline or ignore. */
export default function RequestScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const salon = useCurrentSalon();
  const appointment = useQuery({
    queryKey: ['appointments', salon.id, 'one', id],
    queryFn: () => getAppointment(supabase, id),
  });
  const workHours = useWorkHours(salon.id);
  const appt = appointment.data;
  const tz = workHours.data?.hours.timeZone ?? salon.timezone;

  // Neighbouring appointments, so "Other time" is checked for conflicts before saving.
  const windowStart = appt ? Date.parse(appt.starts_at) - 12 * 3_600_000 : 0;
  const nearby = useAppointments({
    from: new Date(windowStart).toISOString(),
    to: new Date(windowStart + 24 * 3_600_000).toISOString(),
  });
  const { move } = useMoveAppointment(workHours.data?.hours, nearby.data ?? []);
  const setStatus = useSetAppointmentStatus();

  const [delta, setDelta] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const finish = async (status: AppointmentStatus, reason?: string) => {
    if (!appt) return;
    setBusy(true);
    setMessage(null);
    try {
      if (status === 'confirmed' && delta !== 0) {
        const moved = await move(appt, delta);
        if (!moved.ok) throw new Error(moved.message);
      }
      await setStatus.mutateAsync({ id: appt.id, status, reason });
      if (status === 'cancelled') haptics.warning();
      else haptics.success();
      setDelta(0);
      await appointment.refetch();
    } catch (e) {
      haptics.error();
      setMessage(e instanceof Error && !('code' in e) ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const grid = workHours.data?.rules.slotGridMinutes ?? 15;
  const shift = delta * 60_000;

  return (
    <DetailScreen title="Booking request" close>
      {appointment.isPending ? (
        <View className="gap-3">
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : appointment.error ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load this request"
          message={errorMessage(appointment.error)}
          actionLabel="Try again"
          onAction={() => void appointment.refetch()}
        />
      ) : !appt ? (
        <EmptyState
          icon="calendar-outline"
          title="Request not found"
          message="It may have been removed."
          actionLabel="Open calendar"
          onAction={() => router.replace('/calendar')}
        />
      ) : (
        <View className="gap-5">
          <Card className="gap-1.5">
            <View className="flex-row items-center gap-2">
              <Text variant="title3" className="flex-1">
                {appt.client?.name ?? 'Walk-in'}
              </Text>
              <Badge
                label={appt.status === 'requested' ? 'Requested' : (HANDLED[appt.status] ?? '')}
                tone={
                  appt.status === 'requested'
                    ? 'warning'
                    : appt.status === 'confirmed'
                      ? 'primary'
                      : 'neutral'
                }
              />
            </View>
            <Text variant="subhead" numeric>
              {formatDay(Date.parse(appt.starts_at) + shift, tz)} ·{' '}
              {formatTime(Date.parse(appt.starts_at) + shift, tz)} –{' '}
              {formatTime(Date.parse(appt.ends_at) + shift, tz)} ·{' '}
              {formatDuration(
                Math.round((Date.parse(appt.ends_at) - Date.parse(appt.starts_at)) / 60_000),
              )}
            </Text>
            <Text variant="body">
              {appt.services
                .map((s) => (s.variantName ? `${s.name} (${s.variantName})` : s.name))
                .join(' + ') || 'No services'}
            </Text>
            {appt.price_cents != null ? (
              <Text variant="subhead" tone="muted">
                {formatPrice(appt.price_cents)}
              </Text>
            ) : null}
            {appt.client?.phone ? (
              <Text variant="subhead" tone="muted">
                {appt.client.phone}
              </Text>
            ) : null}
          </Card>

          {appt.status !== 'requested' ? (
            <View className="gap-3">
              <Text variant="body" tone="muted">
                This request has already been handled.
              </Text>
              <Button
                variant="secondary"
                label="Open calendar"
                icon="calendar-outline"
                fullWidth
                onPress={() => router.replace('/calendar')}
              />
            </View>
          ) : (
            <View className="gap-3">
              <Text variant="headline">Other time</Text>
              <View className="flex-row items-center gap-3 rounded-xl bg-card px-2 py-1.5">
                <Button
                  variant="ghost"
                  size="icon"
                  icon="remove"
                  accessibilityLabel={`${grid} minutes earlier`}
                  disabled={busy}
                  onPress={() => {
                    haptics.selection();
                    setDelta((d) => d - grid);
                  }}
                />
                <Text variant="headline" numeric className="flex-1 text-center">
                  {formatTime(Date.parse(appt.starts_at) + shift, tz)}
                </Text>
                <Button
                  variant="ghost"
                  size="icon"
                  icon="add"
                  accessibilityLabel={`${grid} minutes later`}
                  disabled={busy}
                  onPress={() => {
                    haptics.selection();
                    setDelta((d) => d + grid);
                  }}
                />
              </View>

              {message ? (
                <View
                  accessibilityRole="alert"
                  accessibilityLiveRegion="polite"
                  className="rounded-xl bg-destructive/10 px-4 py-3"
                >
                  <Text variant="subhead" tone="destructive">
                    {message}
                  </Text>
                </View>
              ) : null}

              <Button
                label={delta === 0 ? 'Approve' : 'Save time & approve'}
                icon="checkmark-circle-outline"
                fullWidth
                loading={busy}
                disabled={busy || (delta !== 0 && !workHours.data)}
                onPress={() => void finish('confirmed')}
              />
              <View className="flex-row gap-3">
                <Button
                  variant="secondary"
                  label="Decline"
                  icon="close-circle-outline"
                  grow
                  disabled={busy}
                  onPress={() => void finish('cancelled', 'declined')}
                />
                <Button
                  variant="ghost"
                  label="Ignore"
                  grow
                  disabled={busy}
                  onPress={() => void finish('cancelled', 'ignored')}
                />
              </View>
              <Text variant="footnote" tone="muted">
                Declining or ignoring frees the time.
              </Text>
            </View>
          )}
        </View>
      )}
    </DetailScreen>
  );
}
