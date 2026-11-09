import type { DayUtilization } from '@chairside/core';
import { View } from 'react-native';

import { Card, Text } from '@/components/ui';

import { DayRing, LegendSwatch, minutesOf } from './day-ring';
import { formatMinutes, stateLabel } from './palette';

/** Day view header: the 24h ring plus how the day's hours split up. */
export function DaySummary({ day, now }: { day: DayUtilization; now?: number }) {
  const closed = day.capacityMinutes === 0;
  const states = (['booked', 'open', 'tentative', 'closed'] as const).filter(
    (s) => s !== 'tentative' || day.tentativeMinutes > 0 || day.bookedTentativeMinutes > 0,
  );
  return (
    <Card className="flex-row items-center gap-4">
      <DayRing day={day} size={104} now={now} />
      <View className="flex-1 gap-1.5">
        <Text variant="headline">
          {closed
            ? 'Day off'
            : `${day.appointmentCount} ${day.appointmentCount === 1 ? 'appointment' : 'appointments'}`}
        </Text>
        {states.map((s) => (
          <View key={s} className="flex-row items-center gap-2">
            <LegendSwatch state={s} size={12} />
            <Text variant="subhead" tone="muted" className="flex-1">
              {stateLabel[s]}
            </Text>
            <Text variant="subhead" numeric>
              {formatMinutes(minutesOf(day, s))}
            </Text>
          </View>
        ))}
      </View>
    </Card>
  );
}
