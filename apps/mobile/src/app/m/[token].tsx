import { addDays, formatLocalDate, parseLocalDate, toSalonDate } from '@chairside/core';
import type { ManageBookingView, ManageSlot } from '@chairside/db/client-self-service';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Badge, Button, Card, Chip, EmptyState, Icon, SkeletonRow, Text } from '@/components/ui';
import { formatDay, formatTime } from '@/features/appointments/format';
import { manageBookingApi } from '@/features/client-self-service/api';

const shiftDate = (date: string, days: number) =>
  formatLocalDate(addDays(parseLocalDate(date), days));

const STATUS: Record<ManageBookingView['status'], { label: string; tone?: 'success' | 'warning' }> =
  {
    held: { label: 'Held', tone: 'warning' },
    requested: { label: 'Requested', tone: 'warning' },
    confirmed: { label: 'Confirmed', tone: 'success' },
    completed: { label: 'Completed' },
    cancelled: { label: 'Cancelled' },
    no_show: { label: 'Missed' },
  };

/**
 * A client's manage link (`/m/<token>`), from their confirmation and reminder emails or a text.
 * Signed out: the token alone unlocks this one appointment. Cancel, or move it to another open
 * time the scheduling engine offers for the same services.
 */
export default function ManageBookingScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const api = manageBookingApi(token);
  const queryClient = useQueryClient();
  const view = useQuery({
    queryKey: ['manage-booking', token],
    queryFn: api.view,
    retry: false,
  });
  const setBooking = (booking: ManageBookingView) =>
    queryClient.setQueryData(['manage-booking', token], { booking });

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <View className="w-full max-w-2xl flex-1 self-center">
        {router.canGoBack() ? (
          <View className="flex-row px-2 pt-1">
            <Button
              variant="ghost"
              size="icon"
              icon="chevron-back"
              accessibilityLabel="Back"
              onPress={() => router.back()}
            />
          </View>
        ) : null}
        <ScrollView className="flex-1" contentContainerClassName="px-4 pb-24 pt-6">
          {view.isPending ? (
            <View className="gap-3">
              <SkeletonRow />
              <SkeletonRow />
            </View>
          ) : view.error || !view.data ? (
            <EmptyState
              icon="calendar-outline"
              title="Appointment not found"
              message={
                view.error?.message ??
                'This link may be mistyped or expired. Contact the salon to change your appointment.'
              }
            />
          ) : (
            <ManageView token={token} booking={view.data.booking} onChange={setBooking} />
          )}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

function ManageView({
  token,
  booking,
  onChange,
}: {
  token: string;
  booking: ManageBookingView;
  onChange: (b: ManageBookingView) => void;
}) {
  const [mode, setMode] = useState<'view' | 'cancel' | 'move'>('view');
  const [notice, setNotice] = useState<string | null>(null);
  const tz = booking.salon.timezone;
  const start = Date.parse(booking.startsAt);
  const status = STATUS[booking.status];
  const api = manageBookingApi(token);

  const cancel = useMutation({
    mutationFn: api.cancel,
    onSuccess: (r) => {
      onChange(r.booking);
      setMode('view');
      setNotice('Your appointment is cancelled. The salon has been told.');
    },
  });

  return (
    <View className="gap-4">
      <View className="items-center gap-1">
        <Text variant="title2" accessibilityRole="header" className="text-center">
          {booking.salon.name}
        </Text>
        <Text variant="subhead" tone="muted" className="text-center">
          {booking.clientFirstName ? `Hi ${booking.clientFirstName}, ` : ''}here’s your appointment
        </Text>
      </View>

      <Card className="gap-2" testID="manage-booking-card">
        <View className="flex-row items-center justify-between gap-3">
          <Text variant="headline" className="flex-1">
            {booking.services ?? 'Appointment'}
          </Text>
          <Badge label={status.label} tone={status.tone} />
        </View>
        <View className="flex-row items-center gap-2">
          <Icon name="calendar-outline" size={18} color="muted-foreground" />
          <Text
            variant="body"
            testID="manage-booking-when"
            className={booking.status === 'cancelled' ? 'line-through' : undefined}
          >
            {formatDay(start, tz)} · {formatTime(start, tz)}
          </Text>
        </View>
      </Card>

      {notice ? (
        <Text
          variant="subhead"
          tone="success"
          accessibilityLiveRegion="polite"
          testID="manage-notice"
        >
          {notice}
        </Text>
      ) : null}
      {booking.policyMessage ? (
        <Text variant="footnote" tone="muted">
          {booking.policyMessage}
        </Text>
      ) : null}

      {booking.status === 'cancelled' ? (
        <Button
          variant="outline"
          label="Book again"
          fullWidth
          onPress={() => router.push(`/b/${booking.salon.slug}`)}
        />
      ) : mode === 'move' ? (
        <MovePicker
          token={token}
          booking={booking}
          onCancel={() => setMode('view')}
          onMoved={(b) => {
            onChange(b);
            setMode('view');
            const at = Date.parse(b.startsAt);
            setNotice(`Moved to ${formatDay(at, tz)} at ${formatTime(at, tz)}. See you then!`);
          }}
        />
      ) : mode === 'cancel' ? (
        <Card className="gap-3">
          <Text variant="body">Cancel this appointment?</Text>
          {booking.feeCents > 0 ? (
            <Text variant="footnote" tone="warning">
              A late-cancellation fee of ${(booking.feeCents / 100).toFixed(2)} applies.
            </Text>
          ) : null}
          {cancel.error ? (
            <Text variant="footnote" tone="destructive" accessibilityLiveRegion="polite">
              {cancel.error.message}
            </Text>
          ) : null}
          <View className="flex-row gap-2">
            <Button
              grow
              variant="outline"
              label="Keep it"
              disabled={cancel.isPending}
              onPress={() => setMode('view')}
            />
            <Button
              grow
              variant="destructive"
              label="Yes, cancel"
              loading={cancel.isPending}
              onPress={() => cancel.mutate()}
            />
          </View>
        </Card>
      ) : booking.canCancel || booking.canReschedule ? (
        <View className="gap-2">
          {booking.canReschedule ? (
            <Button
              label="Reschedule"
              icon="calendar-outline"
              fullWidth
              onPress={() => {
                setNotice(null);
                setMode('move');
              }}
            />
          ) : null}
          {booking.canCancel ? (
            <Button
              variant="outline"
              label="Cancel appointment"
              fullWidth
              onPress={() => {
                setNotice(null);
                setMode('cancel');
              }}
            />
          ) : null}
        </View>
      ) : !booking.policyMessage ? (
        <Text variant="footnote" tone="muted" className="text-center">
          Contact the salon to change this appointment.
        </Text>
      ) : null}
    </View>
  );
}

function MovePicker({
  token,
  booking,
  onCancel,
  onMoved,
}: {
  token: string;
  booking: ManageBookingView;
  onCancel: () => void;
  onMoved: (b: ManageBookingView) => void;
}) {
  const tz = booking.salon.timezone;
  const [today] = useState(() => toSalonDate(Date.now(), tz));
  const current = toSalonDate(booking.startsAt, tz);
  const [date, setDate] = useState(current < today ? today : current);
  const [picked, setPicked] = useState<ManageSlot | null>(null);
  const api = manageBookingApi(token);

  const slots = useQuery({
    queryKey: ['manage-booking-slots', token, date],
    queryFn: () => api.slots(date),
    retry: false,
  });
  const move = useMutation({
    mutationFn: (start: string) => api.reschedule(start),
    onSuccess: (r) => onMoved(r.booking),
    onError: () => void slots.refetch(),
  });
  const days = (slots.data?.days ?? []).filter((d) => d.slots.length > 0);
  const earlier = shiftDate(date, -7);

  return (
    <Card className="gap-3" testID="manage-move">
      <View className="flex-row items-center justify-between">
        <Button
          variant="ghost"
          size="icon"
          icon="chevron-back"
          accessibilityLabel="Earlier dates"
          disabled={shiftDate(date, -3) <= today}
          onPress={() => {
            setPicked(null);
            setDate(earlier < today ? today : earlier);
          }}
        />
        <Text variant="headline">Pick a new time</Text>
        <Button
          variant="ghost"
          size="icon"
          icon="chevron-forward"
          accessibilityLabel="Later dates"
          onPress={() => {
            setPicked(null);
            setDate(shiftDate(date, 7));
          }}
        />
      </View>

      {slots.isPending ? (
        <SkeletonRow />
      ) : slots.error ? (
        <Text variant="footnote" tone="destructive">
          {slots.error.message}
        </Text>
      ) : days.length === 0 ? (
        <Text variant="subhead" tone="muted">
          No open times this week. Try later dates.
        </Text>
      ) : (
        days.map((d) => (
          <View key={d.date} className="gap-2">
            <Text variant="subhead" className="font-semibold">
              {d.label}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {d.slots.map((s) => (
                <Chip
                  key={s.start}
                  label={s.time}
                  selected={picked?.start === s.start}
                  onPress={() => setPicked(s)}
                />
              ))}
            </View>
          </View>
        ))
      )}

      {move.error ? (
        <Text variant="footnote" tone="destructive" accessibilityLiveRegion="polite">
          {move.error.message}
        </Text>
      ) : null}
      <View className="flex-row gap-2">
        <Button grow variant="outline" label="Back" disabled={move.isPending} onPress={onCancel} />
        <Button
          grow
          label={
            picked
              ? `Move to ${formatDay(Date.parse(picked.start), tz)} · ${picked.time}`
              : 'Pick a time'
          }
          disabled={!picked}
          loading={move.isPending}
          onPress={() => picked && move.mutate(picked.start)}
        />
      </View>
    </Card>
  );
}
