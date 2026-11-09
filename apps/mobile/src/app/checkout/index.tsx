import { addDays, parseLocalDate, toSalonDate, zonedToUtc } from '@chairside/core';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { DetailScreen } from '@/components/shell/screen';
import { Badge, EmptyState, ListGroup, ListRow, SkeletonRow } from '@/components/ui';
import { errorMessage, useAppointments } from '@/features/appointments/api';
import { formatTime } from '@/features/appointments/format';
import { useCurrentSalon } from '@/providers/session-provider';

/** Today's appointments to ring up, when Today can't tell who's checking out. */
export default function CheckoutPicker() {
  const salon = useCurrentSalon();
  const tz = salon.timezone;
  const [openedAt] = useState(() => Date.now());
  const range = useMemo(() => {
    const local = parseLocalDate(toSalonDate(openedAt, tz));
    return {
      from: new Date(zonedToUtc(local, 0, tz)).toISOString(),
      to: new Date(zonedToUtc(addDays(local, 1), 0, tz)).toISOString(),
    };
  }, [openedAt, tz]);
  const appointments = useAppointments(range);
  const list = (appointments.data ?? [])
    .filter((a) => a.status === 'confirmed' || a.status === 'completed')
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));

  return (
    <DetailScreen title="Checkout" close>
      {appointments.isPending ? (
        <View className="gap-3">
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : appointments.error ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn’t load today"
          message={errorMessage(appointments.error)}
          actionLabel="Try again"
          onAction={() => void appointments.refetch()}
        />
      ) : list.length === 0 ? (
        <EmptyState
          icon="card-outline"
          title="Nobody to check out"
          message="Confirmed appointments from today show up here."
        />
      ) : (
        <ListGroup>
          {list.map((a, i) => (
            <ListRow
              key={a.id}
              title={a.client?.name ?? 'Walk-in'}
              subtitle={`${formatTime(Date.parse(a.starts_at), tz)} · ${a.services
                .map((s) => s.name)
                .join(', ')}`}
              trailing={
                a.status === 'completed' ? <Badge label="Done" tone="success" /> : undefined
              }
              onPress={() => router.replace(`/checkout/${a.id}`)}
              last={i === list.length - 1}
            />
          ))}
        </ListGroup>
      )}
    </DetailScreen>
  );
}
