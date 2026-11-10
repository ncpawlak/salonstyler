import {
  addDays,
  formatLocalDate,
  parseLocalDate,
  type DayUtilization,
  type UtilizationSummary,
} from '@chairside/core';
import { useMemo } from 'react';
import { Pressable, View } from 'react-native';

import { Button, Card, EmptyState, Skeleton, Text } from '@/components/ui';
import { haptics } from '@/lib/haptics';
import { cn } from '@/lib/cn';

import { DayRing, LegendSwatch } from './day-ring';
import { DayStrip, hourTicks, hourWindow } from './day-strip';
import { formatDate, formatMinutes, stateLabel } from './palette';
import { bookedLabel, bookedPercent, dayRingFill, freeLabel } from './ring-fill';
import { useRangeUtilization } from './use-calendar-data';

/** Sunday-start week containing `date`. */
export function weekRange(date: string): { from: string; to: string } {
  const d = parseLocalDate(date);
  const weekday = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
  const start = addDays(d, -weekday);
  return { from: formatLocalDate(start), to: formatLocalDate(addDays(start, 6)) };
}

const DATE_COL = 44;
const RING = 44;

export function WeekView({
  date,
  today,
  now,
  onDateChange,
  onPickDay,
}: {
  date: string;
  today: string;
  now: number;
  onDateChange: (date: string) => void;
  onPickDay: (date: string) => void;
}) {
  const { from, to } = weekRange(date);
  const { days, summary, timeZone, isLoading, isError, refetch } = useRangeUtilization(from, to);
  const window = useMemo(() => (days ? hourWindow(days, timeZone) : null), [days, timeZone]);
  const thisWeek = weekRange(today).from === from;

  const shift = (weeks: number) => {
    haptics.selection();
    onDateChange(formatLocalDate(addDays(parseLocalDate(date), weeks * 7)));
  };

  return (
    <View className="gap-3">
      <View className="flex-row items-center gap-2">
        <Button
          variant="secondary"
          size="icon"
          icon="chevron-back"
          accessibilityLabel="Previous week"
          onPress={() => shift(-1)}
        />
        <Button
          variant={thisWeek ? 'secondary' : 'outline'}
          size="sm"
          label="This week"
          onPress={() => onDateChange(today)}
        />
        <Button
          variant="secondary"
          size="icon"
          icon="chevron-forward"
          accessibilityLabel="Next week"
          onPress={() => shift(1)}
        />
        <View className="flex-1" />
        <Text variant="subhead" tone="muted" numeric>
          {formatDate(from, { month: 'short', day: 'numeric' })} –{' '}
          {formatDate(to, {
            month: from.slice(5, 7) === to.slice(5, 7) ? undefined : 'short',
            day: 'numeric',
          })}
        </Text>
      </View>

      {isError ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load this week"
          message="Check your connection and try again."
          actionLabel="Retry"
          onAction={refetch}
        />
      ) : isLoading || !days || !summary || !window ? (
        <View className="gap-2">
          <Skeleton height={112} />
          {Array.from({ length: 7 }, (_, i) => (
            <Skeleton key={i} height={68} />
          ))}
        </View>
      ) : (
        <>
          <WeekSummary summary={summary} />
          <View
            className="flex-row"
            style={{ paddingLeft: DATE_COL + 24, paddingRight: RING + 24 }}
          >
            <View className="h-4 flex-1">
              {hourTicks(window).map((t) => (
                <Text
                  key={t.hour}
                  variant="caption"
                  tone="subtle"
                  numeric
                  className="absolute"
                  style={{ left: `${t.left * 100}%`, transform: [{ translateX: -8 }] }}
                >
                  {t.label}
                </Text>
              ))}
            </View>
          </View>
          <View className="gap-2">
            {days.map((d) => (
              <WeekRow
                key={d.date}
                day={d}
                isToday={d.date === today}
                now={now}
                window={window}
                timeZone={timeZone}
                onPress={() => {
                  haptics.selection();
                  onPickDay(d.date);
                }}
              />
            ))}
          </View>
          <Legend />
        </>
      )}
    </View>
  );
}

function WeekSummary({ summary }: { summary: UtilizationSummary }) {
  const pct = bookedPercent(summary.bookedMinutes, summary.capacityMinutes);
  return (
    <Card className="flex-row items-center gap-4">
      <View className="items-center">
        <Text variant="display" numeric>
          {pct}%
        </Text>
        <Text variant="caption" tone="muted">
          booked
        </Text>
      </View>
      <View className="flex-1 gap-1">
        <Text variant="headline">
          {summary.appointmentCount}{' '}
          {summary.appointmentCount === 1 ? 'appointment' : 'appointments'}
        </Text>
        <Text variant="subhead" tone="muted">
          {formatMinutes(summary.bookedMinutes)} booked · {formatMinutes(summary.openMinutes)} open
          {summary.tentativeMinutes > 0
            ? ` · ${formatMinutes(summary.tentativeMinutes)} tentative`
            : ''}
        </Text>
        {summary.mostOpenDate ? (
          <Text variant="footnote" tone="success">
            Most open: {formatDate(summary.mostOpenDate, { weekday: 'long' })}
          </Text>
        ) : (
          <Text variant="footnote" tone="muted">
            No open time this week
          </Text>
        )}
      </View>
    </Card>
  );
}

function WeekRow({
  day,
  isToday,
  now,
  window,
  timeZone,
  onPress,
}: {
  day: DayUtilization;
  isToday: boolean;
  now: number;
  window: ReturnType<typeof hourWindow>;
  timeZone: string;
  onPress: () => void;
}) {
  const fill = dayRingFill(day);
  const { closed } = fill;
  const label = formatDate(day.date, { weekday: 'long', month: 'long', day: 'numeric' });
  const detail = closed
    ? 'Off'
    : [
        bookedLabel(fill),
        freeLabel(fill),
        `${day.appointmentCount} ${day.appointmentCount === 1 ? 'appt' : 'appts'}`,
      ].join(' · ');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${closed ? 'off' : detail}`}
      accessibilityHint="Opens the day"
      onPress={onPress}
      className={cn(
        'flex-row items-center gap-3 rounded-xl border bg-card px-3 py-2.5 active:bg-muted',
        isToday ? 'border-primary' : 'border-border',
      )}
    >
      <View className="items-center" style={{ width: DATE_COL }}>
        <Text variant="caption" tone={isToday ? 'primary' : 'muted'} className="uppercase">
          {formatDate(day.date, { weekday: 'short' })}
        </Text>
        <Text variant="title2" numeric tone={isToday ? 'primary' : closed ? 'subtle' : 'default'}>
          {Number(day.date.slice(8))}
        </Text>
      </View>
      <View className="flex-1 gap-1.5">
        <DayStrip day={day} window={window} timeZone={timeZone} now={isToday ? now : undefined} />
        <Text
          variant="footnote"
          numeric
          tone={closed ? 'subtle' : fill.freeMinutes === 0 ? 'warning' : 'muted'}
        >
          {detail}
        </Text>
      </View>
      <DayRing day={day} size={RING} />
    </Pressable>
  );
}

export function Legend({ className }: { className?: string }) {
  return (
    <View
      className={cn('flex-row flex-wrap items-center justify-center gap-x-4 gap-y-1', className)}
    >
      {(['booked', 'open', 'tentative', 'closed'] as const).map((s) => (
        <View key={s} className="flex-row items-center gap-1.5">
          <LegendSwatch state={s} />
          <Text variant="caption" tone="muted">
            {stateLabel[s]}
          </Text>
        </View>
      ))}
    </View>
  );
}
