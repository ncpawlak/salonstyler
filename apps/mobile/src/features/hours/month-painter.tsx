import {
  formatBlocks,
  getWorkingBlocks,
  getWorkingBlocksRange,
  toSalonDate,
  type Paint,
  type WorkHours,
} from '@chairside/core';
import { useMemo, useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';

import {
  PAINTS,
  PAINT_LABEL,
  PaintChip,
  STATUS_BG,
  STATUS_TEXT,
  Section,
  WEEKDAY_SHORT,
} from './ui';

type Brush = Paint | 'reset';

interface Props {
  hours: WorkHours;
  paint: (paint: Paint, from: string, to?: string) => void;
  reset: (from: string, to?: string) => void;
}

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Month calendar: pick a brush, tap days (or a range) to paint them Open / Tentative / Closed. */
export function MonthPainter({ hours, paint, reset }: Props) {
  const [today] = useState(() => toSalonDate(Date.now(), hours.timeZone));
  const [cursor, setCursor] = useState(() => ({
    year: Number(today.slice(0, 4)),
    month: Number(today.slice(5, 7)),
  }));
  const [brush, setBrush] = useState<Brush>('closed');
  const [rangeMode, setRangeMode] = useState(false);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [selected, setSelected] = useState(today);

  const days = useMemo(() => {
    const last = new Date(Date.UTC(cursor.year, cursor.month, 0)).getUTCDate();
    const prefix = `${cursor.year}-${pad(cursor.month)}`;
    return getWorkingBlocksRange(hours, `${prefix}-01`, `${prefix}-${pad(last)}`);
  }, [hours, cursor]);

  const lead = days[0]?.weekday ?? 0;
  const detail = getWorkingBlocks(hours, selected);

  const move = (delta: number) => {
    setAnchor(null);
    setCursor(({ year, month }) => {
      const m = month - 1 + delta;
      return { year: year + Math.floor(m / 12), month: (((m % 12) + 12) % 12) + 1 };
    });
  };

  const apply = (from: string, to: string) =>
    brush === 'reset' ? reset(from, to) : paint(brush, from, to);

  const onDay = (date: string) => {
    setSelected(date);
    if (!rangeMode) return apply(date, date);
    if (!anchor) return setAnchor(date);
    const [from, to] = anchor <= date ? [anchor, date] : [date, anchor];
    setAnchor(null);
    apply(from, to);
  };

  return (
    <Section
      title="Calendar"
      hint={
        rangeMode
          ? anchor
            ? `Tap the last day to paint from ${anchor}.`
            : 'Tap the first day of the range.'
          : 'Pick a brush, then tap days to paint them.'
      }
    >
      <View className="flex-row gap-2">
        {PAINTS.map((p) => (
          <PaintChip key={p} paint={p} selected={brush === p} onPress={() => setBrush(p)} />
        ))}
      </View>
      <View className="flex-row items-center justify-between">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: brush === 'reset' }}
          onPress={() => setBrush('reset')}
          className={`min-h-11 justify-center rounded-full px-4 ${
            brush === 'reset' ? 'bg-black dark:bg-white' : 'bg-neutral-200 dark:bg-neutral-800'
          }`}
        >
          <Text
            className={`text-sm font-medium ${brush === 'reset' ? 'text-white dark:text-black' : 'text-black dark:text-white'}`}
          >
            Reset to weekly
          </Text>
        </Pressable>
        <View className="flex-row items-center gap-2">
          <Text className="text-sm text-black dark:text-white">Range</Text>
          <Switch
            value={rangeMode}
            onValueChange={(v) => {
              setRangeMode(v);
              setAnchor(null);
            }}
          />
        </View>
      </View>

      <View className="flex-row items-center justify-between">
        <Pressable
          accessibilityLabel="Previous month"
          onPress={() => move(-1)}
          className="h-11 w-11 items-center justify-center"
        >
          <Text className="text-2xl text-black dark:text-white">‹</Text>
        </Pressable>
        <Text className="text-base font-semibold text-black dark:text-white">
          {MONTHS[cursor.month - 1]} {cursor.year}
        </Text>
        <Pressable
          accessibilityLabel="Next month"
          onPress={() => move(1)}
          className="h-11 w-11 items-center justify-center"
        >
          <Text className="text-2xl text-black dark:text-white">›</Text>
        </Pressable>
      </View>

      <View className="flex-row">
        {WEEKDAY_SHORT.map((d) => (
          <Text key={d} className="flex-1 text-center text-xs uppercase text-neutral-500">
            {d}
          </Text>
        ))}
      </View>
      <View className="flex-row flex-wrap">
        {Array.from({ length: lead }, (_, i) => (
          <View key={`lead-${i}`} className="aspect-square w-[14.2857%]" />
        ))}
        {days.map((d) => {
          const isAnchor = anchor === d.date;
          const isSelected = selected === d.date;
          return (
            <View key={d.date} className="aspect-square w-[14.2857%] p-0.5">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${d.date}: ${d.status === 'mixed' ? 'Open and tentative' : PAINT_LABEL[d.status]}, ${formatBlocks(d.blocks)}`}
                onPress={() => onDay(d.date)}
                className={`flex-1 items-center justify-center rounded-lg ${STATUS_BG[d.status]} ${
                  isAnchor || isSelected ? 'border-2 border-black dark:border-white' : ''
                }`}
              >
                <Text className={`text-sm font-semibold ${STATUS_TEXT[d.status]}`}>
                  {Number(d.date.slice(8))}
                </Text>
                {d.source === 'override' ? (
                  <View className="absolute bottom-1 h-1 w-1 rounded-full bg-black/60" />
                ) : null}
              </Pressable>
            </View>
          );
        })}
      </View>

      <View className="gap-1 rounded-xl bg-white p-3 dark:bg-black">
        <Text className="text-base font-semibold text-black dark:text-white">{detail.date}</Text>
        <Text className="text-sm text-black dark:text-white">
          {detail.blocks.length
            ? detail.blocks
                .map((b) => `${formatBlocks([b])}${b.type === 'tentative' ? ' (tentative)' : ''}`)
                .join(' · ')
            : 'Closed'}
        </Text>
        <Text className="text-xs text-neutral-500">
          {detail.source === 'override'
            ? `Changed for this ${detail.override?.to && detail.override.to !== detail.override.from ? 'range' : 'day'}${
                detail.override?.note ? ` · ${detail.override.note}` : ''
              }`
            : 'Weekly hours'}
          {` · ${hours.timeZone}`}
        </Text>
      </View>
    </Section>
  );
}
