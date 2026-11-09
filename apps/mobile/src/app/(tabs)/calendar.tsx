import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { DayView, MonthView, WeekView } from '@/components/mockups/calendar-views';
import { SegmentTimeline } from '@/components/mockups/segment-timeline';
import { Screen } from '@/components/shell/screen';
import { Button, Chip, SegmentedControl, Sheet, Text } from '@/components/ui';
import {
  MOCK_TODAY,
  appointmentMinutes,
  appointmentPrice,
  formatDuration,
  formatTime,
  serviceById,
  type Appointment,
} from '@/mocks/data';

type Mode = 'day' | 'week' | 'month';

const modes = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
] as const;

export default function CalendarScreen() {
  const [mode, setMode] = useState<Mode>('day');
  const [day, setDay] = useState(MOCK_TODAY);
  const [selected, setSelected] = useState<Appointment | null>(null);

  const pickDay = (d: Date) => {
    setDay(d);
    setMode('day');
  };

  return (
    <Screen
      title="Calendar"
      subtitle={
        mode === 'day'
          ? day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
          : mode === 'week'
            ? 'This week'
            : MOCK_TODAY.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      }
      toolbar={
        <SegmentedControl
          accessibilityLabel="Calendar view"
          options={modes}
          value={mode}
          onChange={setMode}
        />
      }
    >
      {mode === 'day' ? <DayView onSelect={setSelected} /> : null}
      {mode === 'week' ? <WeekView onPickDay={pickDay} /> : null}
      {mode === 'month' ? <MonthView onPickDay={pickDay} /> : null}

      <Sheet
        open={!!selected}
        onOpenChange={(open) => !open && setSelected(null)}
        title={selected?.client}
        subtitle={
          selected && selected.status !== 'blocked'
            ? `${formatTime(selected.start)} · ${formatDuration(appointmentMinutes(selected))} · $${appointmentPrice(selected)}`
            : 'Blocked time'
        }
      >
        {selected && selected.status !== 'blocked' ? (
          <View className="gap-4">
            {selected.serviceIds.map((id) => {
              const s = serviceById(id);
              return (
                <View key={id} className="gap-2">
                  <Chip label={s.name} tag={s.tag} />
                  <SegmentTimeline segments={s.segments} tag={s.tag} />
                </View>
              );
            })}
            {selected.note ? (
              <Text variant="subhead" tone="muted">
                Note: {selected.note}
              </Text>
            ) : null}
            <View className="flex-row gap-3">
              <Button variant="secondary" label="Reschedule" icon="calendar-outline" grow />
              <Button
                label="Checkout"
                icon="card-outline"
                grow
                onPress={() => {
                  setSelected(null);
                  router.push('/mockups/checkout');
                }}
              />
            </View>
          </View>
        ) : (
          <Button
            variant="destructive"
            label="Remove block"
            fullWidth
            onPress={() => setSelected(null)}
          />
        )}
      </Sheet>
    </Screen>
  );
}
