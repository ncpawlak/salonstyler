import {
  formatLocalDate,
  parseLocalDate,
  type DayUtilization,
  utilizationLevel,
} from '@chairside/core';
import { Pressable, View } from 'react-native';

import { Button, Card, EmptyState, Skeleton, Text } from '@/components/ui';
import { haptics } from '@/lib/haptics';
import { cn } from '@/lib/cn';

import { DayRing } from './day-ring';
import { formatDate, formatMinutes, useUtilizationPalette } from './palette';
import { bookedLabel, bookedPercent, dayRingFill, freeLabel } from './ring-fill';
import { useRangeUtilization } from './use-calendar-data';
import { Legend } from './week-view';

/** First and last local dates of the month containing `date`. */
export function monthRange(date: string): { from: string; to: string } {
  const { year, month } = parseLocalDate(date);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: formatLocalDate({ year, month, day: 1 }),
    to: formatLocalDate({ year, month, day: last }),
  };
}

function shiftMonth(date: string, months: number): string {
  const { year, month } = parseLocalDate(date);
  const index = year * 12 + (month - 1) + months;
  return formatLocalDate({ year: Math.floor(index / 12), month: (index % 12) + 1, day: 1 });
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function MonthView({
  date,
  today,
  onDateChange,
  onPickDay,
}: {
  date: string;
  today: string;
  onDateChange: (date: string) => void;
  onPickDay: (date: string) => void;
}) {
  const { from, to } = monthRange(date);
  const { days, summary, isLoading, isError, refetch } = useRangeUtilization(from, to);
  const thisMonth = monthRange(today).from === from;

  const shift = (months: number) => {
    haptics.selection();
    onDateChange(shiftMonth(date, months));
  };

  return (
    <View className="gap-3">
      <View className="flex-row items-center gap-2">
        <Button
          variant="secondary"
          size="icon"
          icon="chevron-back"
          accessibilityLabel="Previous month"
          onPress={() => shift(-1)}
        />
        <Button
          variant={thisMonth ? 'secondary' : 'outline'}
          size="sm"
          label="This month"
          onPress={() => onDateChange(today)}
        />
        <Button
          variant="secondary"
          size="icon"
          icon="chevron-forward"
          accessibilityLabel="Next month"
          onPress={() => shift(1)}
        />
        <View className="flex-1" />
        <Text variant="headline">{formatDate(from, { month: 'long', year: 'numeric' })}</Text>
      </View>

      {isError ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load this month"
          message="Check your connection and try again."
          actionLabel="Retry"
          onAction={refetch}
        />
      ) : isLoading || !days || !summary ? (
        <View className="gap-2">
          <Skeleton height={56} />
          <Skeleton height={320} />
        </View>
      ) : (
        <>
          <Card className="flex-row items-center justify-between">
            <Stat
              value={`${bookedPercent(summary.bookedMinutes, summary.capacityMinutes)}%`}
              label="booked"
            />
            <Stat value={String(summary.appointmentCount)} label="appointments" />
            <Stat value={formatMinutes(summary.openMinutes)} label="open" />
          </Card>
          <MonthGrid days={days} today={today} onPickDay={onPickDay} />
          <HeatLegend />
          <Legend />
        </>
      )}
    </View>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View className="flex-1 items-center">
      <Text variant="title2" numeric>
        {value}
      </Text>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
    </View>
  );
}

function MonthGrid({
  days,
  today,
  onPickDay,
}: {
  days: DayUtilization[];
  today: string;
  onPickDay: (date: string) => void;
}) {
  const palette = useUtilizationPalette();
  const lead = days[0]?.weekday ?? 0;
  const cells: (DayUtilization | null)[] = [...Array.from({ length: lead }, () => null), ...days];
  while (cells.length % 7) cells.push(null);
  const rows = Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));

  return (
    <View className="gap-1">
      <View className="flex-row">
        {WEEKDAYS.map((d, i) => (
          <Text key={i} variant="caption" tone="muted" className="flex-1 text-center">
            {d}
          </Text>
        ))}
      </View>
      {rows.map((row, r) => (
        <View key={r} className="flex-row">
          {row.map((d, i) => {
            if (!d) return <View key={i} className="m-0.5 flex-1" />;
            const level = utilizationLevel(d);
            const isToday = d.date === today;
            const fill = dayRingFill(d);
            return (
              <Pressable
                key={d.date}
                accessibilityRole="button"
                accessibilityLabel={`${formatDate(d.date, { weekday: 'long', month: 'long', day: 'numeric' })}, ${
                  level === null
                    ? 'off'
                    : `${bookedLabel(fill)}, ${freeLabel(fill)}, ${d.appointmentCount} ${d.appointmentCount === 1 ? 'appointment' : 'appointments'}`
                }`}
                accessibilityHint="Opens the day"
                onPress={() => {
                  haptics.selection();
                  onPickDay(d.date);
                }}
                className={cn(
                  'm-0.5 flex-1 items-center gap-1 rounded-xl border py-1.5 active:opacity-70',
                  isToday ? 'border-primary' : 'border-transparent',
                )}
                style={{ backgroundColor: level === null ? undefined : palette.heat[level] }}
              >
                <Text
                  variant="footnote"
                  numeric
                  className={isToday ? 'font-bold' : 'font-medium'}
                  tone={isToday ? 'primary' : level === null ? 'subtle' : 'default'}
                >
                  {Number(d.date.slice(8))}
                </Text>
                {level === null ? (
                  <View style={{ height: 26 }} />
                ) : (
                  <DayRing day={d} size={26} strokeWidth={4} showLabel={false} />
                )}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function HeatLegend() {
  const palette = useUtilizationPalette();
  return (
    <View
      className="flex-row items-center justify-center gap-1.5"
      accessible
      accessibilityLabel="Darker days are busier"
    >
      <Text variant="caption" tone="muted">
        Quiet
      </Text>
      {palette.heat.map((tint, i) => (
        <View
          key={i}
          className="h-3.5 w-5 rounded border border-border"
          style={{ backgroundColor: tint }}
        />
      ))}
      <Text variant="caption" tone="muted">
        Busy
      </Text>
    </View>
  );
}
