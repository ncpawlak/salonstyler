import type { DayUtilization } from '@chairside/core';
import { View } from 'react-native';

import { Card, Text } from '@/components/ui';

import { DayRing, LegendSwatch, minutesOf } from './day-ring';
import { formatMinutes, stateLabel } from './palette';
import { bookedLabel, dayRingFill, freeLabel } from './ring-fill';

/**
 * Day view header: the ring (whole ring = today's working hours, fill = booked) plus how those
 * hours split up. The timeline below shows *when*.
 */
export function DaySummary({ day }: { day: DayUtilization }) {
  const fill = dayRingFill(day);
  const states = (['booked', 'open', 'tentative'] as const).filter(
    (s) => s !== 'tentative' || day.tentativeMinutes > 0 || day.bookedTentativeMinutes > 0,
  );
  return (
    <Card className="flex-row items-center gap-4">
      <DayRing day={day} size={104} />
      <View className="flex-1 gap-1.5">
        <Text variant="headline">
          {fill.closed
            ? 'Day off'
            : `${day.appointmentCount} ${day.appointmentCount === 1 ? 'appointment' : 'appointments'}`}
        </Text>
        {fill.closed ? (
          <Text variant="subhead" tone="muted">
            No working hours
          </Text>
        ) : (
          <>
            <Text variant="subhead" tone="muted" numeric>
              {bookedLabel(fill)} ·{' '}
              {fill.freeMinutes > 0
                ? `${freeLabel(fill)} of ${formatMinutes(fill.workMinutes)}`
                : `${formatMinutes(fill.workMinutes)} day`}
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
          </>
        )}
      </View>
    </Card>
  );
}
