import {
  WEEKDAYS,
  formatBlocks,
  formatClock12,
  type BlanketScheduleInput,
  type Paint,
  type TimeRange,
  type Weekday,
  type WorkHours,
} from '@chairside/core';
import { useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';

import { Chip, PaintChip, Section, TimeStepper, WEEKDAY_SHORT } from './ui';

const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Props {
  hours: WorkHours;
  applyBlanket: (input: BlanketScheduleInput) => void;
  setWeekday: (day: Weekday, paint: Paint, range?: TimeRange, breaks?: TimeRange[]) => void;
}

/** Blanket weekly schedule: pick days + hours + lunch, apply; then tweak single weekdays. */
export function WeeklySchedule({ hours, applyBlanket, setWeekday }: Props) {
  const [days, setDays] = useState<Weekday[]>([2, 3, 4, 5, 6]);
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('18:00');
  const [type, setType] = useState<'open' | 'tentative'>('open');
  const [hasLunch, setHasLunch] = useState(true);
  const [lunchStart, setLunchStart] = useState('12:00');
  const [lunchEnd, setLunchEnd] = useState('13:00');
  const [error, setError] = useState<string | null>(null);

  const toggleDay = (d: Weekday) =>
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()));

  const apply = () => {
    try {
      applyBlanket({
        weekdays: days,
        start,
        end,
        type,
        breaks: hasLunch ? [{ start: lunchStart, end: lunchEnd }] : [],
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Section title="Weekly hours" hint="Set your usual week, then fine-tune any day.">
      <View className="flex-row flex-wrap gap-2">
        {WEEKDAYS.map((d) => (
          <Chip
            key={d}
            label={WEEKDAY_SHORT[d]}
            selected={days.includes(d)}
            onPress={() => toggleDay(d)}
          />
        ))}
      </View>
      <View className="flex-row gap-3">
        <TimeStepper label="Start" value={start} onChange={setStart} />
        <TimeStepper label="End" value={end} onChange={setEnd} />
      </View>
      <View className="flex-row items-center justify-between">
        <Text className="text-base text-black dark:text-white">Lunch break</Text>
        <Switch value={hasLunch} onValueChange={setHasLunch} />
      </View>
      {hasLunch ? (
        <View className="flex-row gap-3">
          <TimeStepper label="Lunch from" value={lunchStart} onChange={setLunchStart} />
          <TimeStepper label="Lunch to" value={lunchEnd} onChange={setLunchEnd} />
        </View>
      ) : null}
      <View className="flex-row gap-2">
        <PaintChip paint="open" selected={type === 'open'} onPress={() => setType('open')} />
        <PaintChip
          paint="tentative"
          selected={type === 'tentative'}
          onPress={() => setType('tentative')}
        />
      </View>
      {error ? <Text className="text-sm text-red-600">{error}</Text> : null}
      <Pressable
        accessibilityRole="button"
        onPress={apply}
        disabled={days.length === 0}
        className={`min-h-12 items-center justify-center rounded-xl ${
          days.length ? 'bg-black dark:bg-white' : 'bg-neutral-300'
        }`}
      >
        <Text className="font-semibold text-white dark:text-black">
          Apply to {days.length} day{days.length === 1 ? '' : 's'}
        </Text>
      </Pressable>

      <View className="gap-2 pt-2">
        {WEEKDAYS.map((d) => {
          const day = hours.weekly[d];
          const blocks = day?.blocks.filter((b) => b.type !== 'closed') ?? [];
          const current: Paint =
            blocks[0]?.type === 'tentative' ? 'tentative' : blocks.length ? 'open' : 'closed';
          const range: TimeRange = blocks[0]
            ? { start: blocks[0].start, end: blocks.at(-1)!.end }
            : { start, end };
          const breaks = day?.breaks ?? [];
          return (
            <View key={d} className="gap-2 rounded-xl bg-white p-3 dark:bg-black">
              <View className="flex-row items-baseline justify-between">
                <Text className="text-base font-semibold text-black dark:text-white">
                  {WEEKDAY_LONG[d]}
                </Text>
                <Text className="text-sm text-neutral-500">
                  {formatBlocks(blocks)}
                  {breaks.length
                    ? ` · break ${breaks.map((b) => `${formatClock12(b.start)}–${formatClock12(b.end)}`).join(', ')}`
                    : ''}
                </Text>
              </View>
              <View className="flex-row gap-2">
                {(['open', 'tentative', 'closed'] as const).map((p) => (
                  <PaintChip
                    key={p}
                    paint={p}
                    selected={current === p}
                    onPress={() => setWeekday(d, p, range, breaks)}
                  />
                ))}
              </View>
            </View>
          );
        })}
      </View>
    </Section>
  );
}
