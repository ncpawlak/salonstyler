import { formatDuration } from '@chairside/core';
import type { AppointmentWithDetails } from '@chairside/db';
import { Pressable, View } from 'react-native';

import { Avatar, Badge, Button, Card, Icon, Text } from '@/components/ui';
import { haptics } from '@/lib/haptics';

import { formatTime } from '../appointments/format';
import { ServicePills } from './service-pills';
import { clientSpan, formatCountdown } from './summary';

/** The hero card: who's next, how long until they arrive, what they're in for. */
export function NextClientCard({
  appointment,
  now,
  timeZone,
  onOpen,
}: {
  appointment: AppointmentWithDetails;
  now: number;
  timeZone: string;
  onOpen: (appt: AppointmentWithDetails) => void;
}) {
  const span = clientSpan(appointment);
  const name = appointment.client?.name ?? 'Walk-in';
  const minutes = Math.round((span.end - span.start) / 60_000);
  const note = [appointment.notes, appointment.client?.notes].filter(Boolean).join(' · ');
  const countdown = formatCountdown(span.start - now);

  return (
    <Card elevation="md" className="gap-4" accessible={false} testID="next-client-card">
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <Badge label="Next up" tone="primary" />
          {appointment.status === 'held' ? <Badge label="Hold" tone="warning" /> : null}
        </View>
        <Text variant="subhead" tone="muted" numeric>
          {formatTime(span.start, timeZone)} – {formatTime(span.end, timeZone)}
        </Text>
      </View>

      <Text
        variant="display"
        numeric
        accessibilityLabel={`${name} ${countdown}, at ${formatTime(span.start, timeZone)}`}
      >
        {countdown}
      </Text>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${name}'s appointment`}
        onPress={() => {
          haptics.selection();
          onOpen(appointment);
        }}
        className="-mx-2 flex-row items-center gap-3 rounded-xl px-2 py-1 active:bg-muted"
      >
        <Avatar name={name} size={48} />
        <View className="flex-1">
          <Text variant="title3" numberOfLines={1}>
            {name}
          </Text>
          <Text variant="subhead" tone="muted" numberOfLines={1} numeric>
            {[formatDuration(minutes), appointment.client?.phone].filter(Boolean).join(' · ')}
          </Text>
        </View>
        <Icon name="chevron-forward" size={18} color="muted-foreground" />
      </Pressable>

      <ServicePills services={appointment.services} />

      {note ? (
        <View className="flex-row gap-2 rounded-lg bg-muted px-3 py-2.5">
          <Icon name="document-text-outline" size={16} color="muted-foreground" />
          <Text variant="subhead" className="flex-1" numberOfLines={2}>
            {note}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

/** Slim "in the chair" line shown above the next client while someone is being served. */
export function InChairRow({
  appointment,
  now,
  timeZone,
  onOpen,
}: {
  appointment: AppointmentWithDetails;
  now: number;
  timeZone: string;
  onOpen: (appt: AppointmentWithDetails) => void;
}) {
  const span = clientSpan(appointment);
  const name = appointment.client?.name ?? 'Walk-in';
  const left = Math.max(0, span.end - now);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`In the chair: ${name}, done ${formatCountdown(left)}`}
      onPress={() => {
        haptics.selection();
        onOpen(appointment);
      }}
      className="mb-3 flex-row items-center gap-3 rounded-xl bg-primary-soft px-4 py-3 active:opacity-80"
    >
      <View className="h-2.5 w-2.5 rounded-full bg-primary" />
      <Text variant="subhead" className="flex-1 font-semibold" numberOfLines={1}>
        In the chair · {name}
      </Text>
      <Text variant="footnote" tone="muted" numeric>
        until {formatTime(span.end, timeZone)}
      </Text>
    </Pressable>
  );
}

export function NoNextClient({
  onBook,
  hasBookings,
}: {
  onBook: () => void;
  hasBookings: boolean;
}) {
  return (
    <Card elevation="md" className="gap-3" testID="next-client-card">
      <View className="flex-row items-center gap-2">
        <Icon name={hasBookings ? 'checkmark-done' : 'cafe-outline'} size={22} color="success" />
        <Text variant="title3">
          {hasBookings ? 'That’s everyone for today' : 'Nobody booked yet'}
        </Text>
      </View>
      <Text variant="subhead" tone="muted">
        {hasBookings
          ? 'No more clients on the books. Nice work.'
          : 'Your day is wide open. Book someone in or share your booking link.'}
      </Text>
      <Button label="Book a client" icon="add" onPress={onBook} />
    </Card>
  );
}
