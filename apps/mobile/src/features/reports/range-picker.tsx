import {
  MAX_REPORT_DAYS,
  periodRange,
  rangeDays,
  type DateRange,
  type ReportPeriod,
} from '@chairside/core/reports';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { Button, Input, SegmentedControl, Text } from '@/components/ui';
import { formatDate } from '@/features/calendar/palette';

const PERIODS = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Qtr' },
  { value: 'year', label: 'Year' },
  { value: 'custom', label: 'Custom' },
] as const satisfies readonly { value: ReportPeriod; label: string }[];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ReportRangeState = ReturnType<typeof useReportRange>;

/** Week / month / quarter / year with back/forward steps, or a custom from–to. */
export function useReportRange(today: string) {
  const [period, setPeriod] = useState<ReportPeriod>('month');
  const [offset, setOffset] = useState(0);
  const [custom, setCustom] = useState<{ from: string; to: string }>(() => ({
    from: periodRange('month', today, -1).from,
    to: today,
  }));

  const customError = useMemo(() => {
    if (!DATE_RE.test(custom.from) || !DATE_RE.test(custom.to)) return 'Use YYYY-MM-DD dates.';
    const real = (d: string) => {
      const t = Date.parse(`${d}T00:00:00Z`);
      return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
    };
    if (!real(custom.from) || !real(custom.to)) return 'That date doesn’t exist.';
    if (custom.from > custom.to) return 'Start must be on or before the end.';
    if (rangeDays(custom) > MAX_REPORT_DAYS) return 'Reports cover at most a year.';
    return null;
  }, [custom]);

  const range: DateRange | null =
    period === 'custom' ? (customError ? null : custom) : periodRange(period, today, offset);

  return {
    period,
    range,
    offset,
    custom,
    customError,
    setPeriod: (p: ReportPeriod) => {
      setPeriod(p);
      setOffset(0);
    },
    step: (by: -1 | 1) => setOffset((o) => Math.min(0, o + by)),
    setCustom,
  };
}

/** "October 2026", "Q4 2026", "2026", "Nov 15 – 21", "Sep 1 – Oct 15, 2026". */
export function rangeLabel(period: ReportPeriod, { from, to }: DateRange): string {
  if (period === 'month') return formatDate(from, { month: 'long', year: 'numeric' });
  if (period === 'quarter')
    return `Q${Math.floor((Number(from.slice(5, 7)) - 1) / 3) + 1} ${from.slice(0, 4)}`;
  if (period === 'year') return from.slice(0, 4);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  const sameMonth = sameYear && from.slice(5, 7) === to.slice(5, 7);
  const start = formatDate(from, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  const end = sameMonth
    ? formatDate(to, { day: 'numeric' })
    : formatDate(to, { month: 'short', day: 'numeric', year: 'numeric' });
  return `${start} – ${end}`;
}

export function RangePicker({ state }: { state: ReportRangeState }) {
  const { period, range, offset, custom, customError } = state;
  return (
    <View className="gap-3">
      <SegmentedControl
        options={PERIODS}
        value={period}
        onChange={state.setPeriod}
        accessibilityLabel="Report period"
      />
      {period === 'custom' ? (
        <View className="gap-1">
          <View className="flex-row gap-3">
            <View className="flex-1">
              <Input
                label="From"
                value={custom.from}
                onChangeText={(from) => state.setCustom({ ...custom, from: from.trim() })}
                placeholder="YYYY-MM-DD"
                autoCapitalize="none"
                inputMode="numeric"
              />
            </View>
            <View className="flex-1">
              <Input
                label="To"
                value={custom.to}
                onChangeText={(to) => state.setCustom({ ...custom, to: to.trim() })}
                placeholder="YYYY-MM-DD"
                autoCapitalize="none"
                inputMode="numeric"
              />
            </View>
          </View>
          {customError ? (
            <Text variant="footnote" tone="destructive" className="px-1">
              {customError}
            </Text>
          ) : null}
        </View>
      ) : range ? (
        <View className="flex-row items-center justify-between">
          <Button
            variant="ghost"
            size="icon"
            icon="chevron-back"
            accessibilityLabel={`Previous ${period}`}
            onPress={() => state.step(-1)}
          />
          <Text variant="headline" accessibilityRole="header">
            {rangeLabel(period, range)}
          </Text>
          <Button
            variant="ghost"
            size="icon"
            icon="chevron-forward"
            accessibilityLabel={`Next ${period}`}
            disabled={offset >= 0}
            onPress={() => state.step(1)}
          />
        </View>
      ) : null}
    </View>
  );
}
