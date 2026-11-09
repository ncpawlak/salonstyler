import { formatClock12, type DayStatus, type Paint } from '@chairside/core';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const PAINTS: readonly Paint[] = ['open', 'tentative', 'closed'];
export const PAINT_LABEL: Record<Paint, string> = {
  open: 'Open',
  tentative: 'Tentative',
  closed: 'Closed',
};

/** Open = green, Tentative = amber (bookable as a request), Closed = neutral. */
export const STATUS_BG: Record<DayStatus, string> = {
  open: 'bg-emerald-500',
  tentative: 'bg-amber-400',
  mixed: 'bg-emerald-300',
  closed: 'bg-neutral-200 dark:bg-neutral-800',
};
export const STATUS_TEXT: Record<DayStatus, string> = {
  open: 'text-white',
  tentative: 'text-black',
  mixed: 'text-black',
  closed: 'text-neutral-500',
};

export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <View className="gap-3 rounded-2xl bg-neutral-50 p-4 dark:bg-neutral-900">
      <View className="gap-1">
        <Text className="text-lg font-semibold text-black dark:text-white">{title}</Text>
        {hint ? <Text className="text-sm text-neutral-500">{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  className = '',
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  className?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      onPress={onPress}
      className={`min-h-11 items-center justify-center rounded-full px-4 ${
        selected ? 'bg-black dark:bg-white' : 'bg-neutral-200 dark:bg-neutral-800'
      } ${className}`}
    >
      <Text
        className={`text-sm font-medium ${selected ? 'text-white dark:text-black' : 'text-black dark:text-white'}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function PaintChip({
  paint,
  selected,
  onPress,
}: {
  paint: Paint;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Paint ${PAINT_LABEL[paint]}`}
      accessibilityState={{ selected }}
      onPress={onPress}
      className={`min-h-11 flex-1 flex-row items-center justify-center gap-2 rounded-xl border-2 ${
        selected ? 'border-black dark:border-white' : 'border-transparent'
      } bg-white dark:bg-black`}
    >
      <View className={`h-4 w-4 rounded-full ${STATUS_BG[paint]}`} />
      <Text className="text-sm font-medium text-black dark:text-white">{PAINT_LABEL[paint]}</Text>
    </Pressable>
  );
}

const STEP = 30;

function toClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function fromClock(time: string): number {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/** A 30-minute time stepper (big tap targets, no picker sheet needed). */
export function TimeStepper({
  label,
  value,
  onChange,
  min = 0,
  max = 24 * 60,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: number;
  max?: number;
}) {
  const v = fromClock(value);
  const set = (next: number) => onChange(toClock(Math.max(min, Math.min(max, next))));
  return (
    <View className="flex-1 gap-1">
      <Text className="text-xs uppercase text-neutral-500">{label}</Text>
      <View className="flex-row items-center justify-between rounded-xl bg-white dark:bg-black">
        <Pressable
          accessibilityLabel={`${label} earlier`}
          onPress={() => set(v - STEP)}
          className="h-11 w-11 items-center justify-center"
        >
          <Text className="text-xl text-black dark:text-white">−</Text>
        </Pressable>
        <Text className="text-base font-semibold text-black dark:text-white">
          {formatClock12(value)}
        </Text>
        <Pressable
          accessibilityLabel={`${label} later`}
          onPress={() => set(v + STEP)}
          className="h-11 w-11 items-center justify-center"
        >
          <Text className="text-xl text-black dark:text-white">+</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function NumberStepper({
  label,
  value,
  options,
  format,
  onChange,
}: {
  label: string;
  value: number;
  options: readonly number[];
  format: (n: number) => string;
  onChange: (n: number) => void;
}) {
  const i = Math.max(0, options.indexOf(value));
  return (
    <View className="flex-row items-center justify-between">
      <Text className="text-base text-black dark:text-white">{label}</Text>
      <View className="flex-row items-center rounded-xl bg-white dark:bg-black">
        <Pressable
          accessibilityLabel={`Decrease ${label}`}
          disabled={i === 0}
          onPress={() => onChange(options[i - 1]!)}
          className="h-11 w-11 items-center justify-center"
        >
          <Text
            className={`text-xl ${i === 0 ? 'text-neutral-300' : 'text-black dark:text-white'}`}
          >
            −
          </Text>
        </Pressable>
        <Text className="min-w-20 text-center font-semibold text-black dark:text-white">
          {format(value)}
        </Text>
        <Pressable
          accessibilityLabel={`Increase ${label}`}
          disabled={i === options.length - 1}
          onPress={() => onChange(options[i + 1]!)}
          className="h-11 w-11 items-center justify-center"
        >
          <Text
            className={`text-xl ${i === options.length - 1 ? 'text-neutral-300' : 'text-black dark:text-white'}`}
          >
            +
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
