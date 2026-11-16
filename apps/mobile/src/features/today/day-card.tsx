import { View } from 'react-native';

import { Card, Donut, Text } from '@/components/ui';
import { formatMinutes } from '@/features/calendar/format';
import { bookedPercent } from '@/features/calendar/ring-fill';

import type { TodaySummary } from './summary';

const minutes = (ms: number) => Math.round(ms / 60_000);

/**
 * How busy am I: the same progress donut as the Calendar (whole ring = today's working hours,
 * fill = booked) plus booked / free time.
 */
export function DayCard({ summary }: { summary: TodaySummary }) {
  const { utilization: u, clientCount, remainingCount } = summary;
  const pct = u.isOpen ? bookedPercent(u.bookedMs, u.availableMs) : Math.round(u.share * 100);
  const free = Math.max(0, u.availableMs - u.bookedMs);
  const freeText = free > 0 ? `${formatMinutes(minutes(free))} free` : 'Fully booked';
  const clients = `${clientCount} ${clientCount === 1 ? 'client' : 'clients'}`;

  return (
    <Card
      className="flex-1 flex-row items-center gap-4"
      accessible
      accessibilityLabel={
        u.isOpen
          ? `${pct}% booked, ${free > 0 ? `${freeText} of ${formatMinutes(minutes(u.availableMs))}` : `all ${formatMinutes(minutes(u.availableMs))} taken`}. ${clients}, ${remainingCount} still to come.`
          : `Day off. ${clients}.`
      }
      testID="day-card"
    >
      <Donut value={pct / 100} size={84} label={u.isOpen ? `${pct}% booked` : 'Day off'} />
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
            {formatMinutes(minutes(u.bookedMs))} booked · {freeText}
          </Text>
        ) : u.overtimeMs ? (
          <Text variant="footnote" tone="warning" numeric>
            {formatMinutes(minutes(u.overtimeMs))} booked on your day off
          </Text>
        ) : null}
        {u.isOpen && u.overtimeMs ? (
          <Text variant="footnote" tone="warning" numeric>
            +{formatMinutes(minutes(u.overtimeMs))} outside hours
          </Text>
        ) : null}
      </View>
    </Card>
  );
}
