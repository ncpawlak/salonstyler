import { formatDuration } from '@chairside/core';
import { View } from 'react-native';

import { Card, Donut, Text } from '@/components/ui';

import type { TodaySummary } from './summary';

const minutes = (ms: number) => Math.round(ms / 60_000);

/** How busy am I: the day ring plus booked / free time. */
export function DayCard({ summary }: { summary: TodaySummary }) {
  const { utilization: u, clientCount, remainingCount } = summary;
  const pct = Math.round(u.share * 100);
  const free = Math.max(0, u.availableMs - u.bookedMs);
  const clients = `${clientCount} ${clientCount === 1 ? 'client' : 'clients'}`;

  return (
    <Card
      className="flex-1 flex-row items-center gap-4"
      accessible
      accessibilityLabel={
        u.isOpen
          ? `${pct}% booked. ${clients}, ${remainingCount} still to come. ${formatDuration(minutes(free))} free.`
          : `Day off. ${clients}.`
      }
      testID="day-card"
    >
      <Donut value={u.share} size={84} label={u.isOpen ? `${pct}% booked` : 'Day off'} />
      <View className="flex-1 gap-1">
        <Text variant="title3" numeric>
          {u.isOpen ? `${pct}% booked` : 'Day off'}
        </Text>
        <Text variant="subhead" tone="muted" numeric>
          {clients}
          {remainingCount ? ` · ${remainingCount} to go` : ''}
        </Text>
        {u.isOpen ? (
          <Text variant="footnote" tone="muted" numeric>
            {formatDuration(minutes(u.bookedMs))} booked · {formatDuration(minutes(free))} free
          </Text>
        ) : u.overtimeMs ? (
          <Text variant="footnote" tone="warning" numeric>
            {formatDuration(minutes(u.overtimeMs))} booked on your day off
          </Text>
        ) : null}
        {u.isOpen && u.overtimeMs ? (
          <Text variant="footnote" tone="warning" numeric>
            +{formatDuration(minutes(u.overtimeMs))} outside hours
          </Text>
        ) : null}
      </View>
    </Card>
  );
}
