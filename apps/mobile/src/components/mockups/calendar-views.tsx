import { Pressable, View } from 'react-native';

import { Donut, Text } from '@/components/ui';
import { haptics } from '@/lib/haptics';
import { cn } from '@/lib/cn';
import {
  MOCK_NOW_MINUTES,
  MOCK_TODAY,
  WORK_DAY,
  busyness,
  serviceById,
  todayAppointments,
  type Appointment,
} from '@/mocks/data';
import { useTheme } from '@/theme/theme-provider';

const HOUR_HEIGHT = 76;
const GUTTER = 52;

export function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

type Block = {
  key: string;
  appt: Appointment;
  label: string;
  start: number;
  minutes: number;
  kind: 'work' | 'processing' | 'finish' | 'blocked';
  tag?: ReturnType<typeof serviceById>['tag'];
  first: boolean;
};

function buildBlocks(appts: Appointment[]): (Block & { column: 0 | 1 })[] {
  const blocks: Block[] = [];
  for (const a of appts) {
    if (a.status === 'blocked') {
      blocks.push({
        key: a.id,
        appt: a,
        label: 'Lunch',
        start: a.start,
        minutes: 45,
        kind: 'blocked',
        first: true,
      });
      continue;
    }
    let t = a.start;
    let first = true;
    for (const id of a.serviceIds) {
      const s = serviceById(id);
      for (const [i, seg] of s.segments.entries()) {
        blocks.push({
          key: `${a.id}-${id}-${i}`,
          appt: a,
          label: first ? a.client : seg.label,
          start: t,
          minutes: seg.minutes,
          kind: seg.kind,
          tag: s.tag,
          first,
        });
        first = false;
        t += seg.minutes;
      }
    }
  }
  // Appointments booked inside another client's processing window go in the second column.
  const processing = blocks.filter((b) => b.kind === 'processing');
  return blocks.map((b) => {
    const nested = processing.some(
      (p) =>
        p.appt.id !== b.appt.id && b.appt.start >= p.start && b.appt.start < p.start + p.minutes,
    );
    return { ...b, column: nested ? 1 : 0 };
  });
}

export function DayView({ onSelect }: { onSelect: (a: Appointment) => void }) {
  const { tag, colors } = useTheme();
  const hours = [];
  for (let h = WORK_DAY.start; h <= WORK_DAY.end; h += 60) hours.push(h);
  const blocks = buildBlocks(todayAppointments);
  const y = (m: number) => ((m - WORK_DAY.start) / 60) * HOUR_HEIGHT;

  return (
    <View style={{ height: y(WORK_DAY.end) + 24 }} className="mt-2">
      {hours.map((h) => (
        <View
          key={h}
          className="absolute left-0 right-0 flex-row items-start"
          style={{ top: y(h) }}
        >
          <Text variant="caption" tone="muted" style={{ width: GUTTER, marginTop: -8 }} numeric>
            {h % 720 === 0 ? 12 : Math.floor(h / 60) % 12} {h >= 720 ? 'PM' : 'AM'}
          </Text>
          <View className="h-px flex-1 bg-border" />
        </View>
      ))}

      {blocks.map((b) => {
        const c = b.tag ? tag(b.tag) : undefined;
        const processing = b.kind === 'processing';
        const height = Math.max(12, (b.minutes / 60) * HOUR_HEIGHT - 2);
        const time = `${Math.floor(b.start / 60) % 12 || 12}:${String(b.start % 60).padStart(2, '0')}`;
        return (
          <Pressable
            key={b.key}
            accessibilityRole="button"
            accessibilityLabel={`${b.appt.client}, ${b.label}, ${time}, ${b.minutes} minutes${processing ? ', processing, free to book' : ''}`}
            onPress={() => {
              haptics.selection();
              onSelect(b.appt);
            }}
            className={cn(
              'absolute overflow-hidden rounded-md px-2',
              height < 24 ? 'py-0' : 'py-1',
            )}
            style={{
              top: y(b.start) + 1,
              height,
              left: b.column === 1 ? `${55}%` : GUTTER,
              right: b.column === 1 ? 0 : processing ? '48%' : 0,
              backgroundColor:
                b.kind === 'blocked' ? colors.muted : processing ? 'transparent' : c?.soft,
              borderLeftWidth: processing ? 1 : 3,
              borderWidth: processing ? 1 : 0,
              borderStyle: processing ? 'dashed' : 'solid',
              borderColor: c?.solid ?? colors.border,
            }}
          >
            {height >= 20 ? (
              <Text
                variant="footnote"
                numberOfLines={1}
                className={b.first ? 'font-semibold' : undefined}
                style={{ color: b.kind === 'blocked' ? colors['muted-foreground'] : c?.text }}
              >
                {processing ? `${b.label} · free` : b.label}
              </Text>
            ) : null}
            {height > 40 && b.first ? (
              <Text
                variant="caption"
                numberOfLines={1}
                style={{ color: c?.text ?? colors['muted-foreground'] }}
              >
                {time} ·{' '}
                {b.appt.serviceIds.map((id) => serviceById(id).name).join(' + ') || 'Blocked'}
              </Text>
            ) : null}
          </Pressable>
        );
      })}

      <View
        pointerEvents="none"
        accessibilityElementsHidden
        className="absolute right-0 flex-row items-center"
        style={{ top: y(MOCK_NOW_MINUTES) - 4, left: GUTTER - 6 }}
      >
        <View className="h-2 w-2 rounded-full bg-destructive" />
        <View className="h-0.5 flex-1 bg-destructive" />
      </View>
    </View>
  );
}

export function weekOf(date: Date): Date[] {
  const start = new Date(date);
  start.setDate(date.getDate() - date.getDay());
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

export function WeekView({ onPickDay }: { onPickDay: (d: Date) => void }) {
  const { tag } = useTheme();
  const total = WORK_DAY.end - WORK_DAY.start;

  return (
    <View className="gap-2">
      {weekOf(MOCK_TODAY).map((d) => {
        const value = busyness(d);
        const closed = value === 0;
        const isToday = sameDay(d, MOCK_TODAY);
        return (
          <Pressable
            key={d.toISOString()}
            accessibilityRole="button"
            accessibilityLabel={`${d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}, ${closed ? 'closed' : `${Math.round(value * 100)}% booked`}`}
            onPress={() => {
              haptics.selection();
              onPickDay(d);
            }}
            className={cn(
              'flex-row items-center gap-3 rounded-xl border bg-card p-3 active:bg-muted',
              isToday ? 'border-primary' : 'border-border',
            )}
          >
            <View className="w-11 items-center">
              <Text variant="caption" tone={isToday ? 'primary' : 'muted'} className="uppercase">
                {d.toLocaleDateString('en-US', { weekday: 'short' })}
              </Text>
              <Text variant="title2" numeric tone={isToday ? 'primary' : 'default'}>
                {d.getDate()}
              </Text>
            </View>
            <View className="flex-1 gap-1.5">
              {closed ? (
                <Text variant="subhead" tone="muted">
                  Closed
                </Text>
              ) : (
                <>
                  <View className="h-3 flex-row overflow-hidden rounded-full bg-muted">
                    {todayAppointments
                      .filter((a) => a.status !== 'blocked')
                      .slice(0, Math.max(1, Math.round(value * 6)))
                      .map((a) => {
                        const s = serviceById(a.serviceIds[0] ?? '');
                        return (
                          <View
                            key={a.id}
                            className="absolute h-full rounded-full"
                            style={{
                              left: `${((a.start - WORK_DAY.start) / total) * 100}%`,
                              width: `${(45 / total) * 100}%`,
                              backgroundColor: tag(s.tag).solid,
                            }}
                          />
                        );
                      })}
                  </View>
                  <Text variant="footnote" tone="muted">
                    {Math.max(1, Math.round(value * 7))} appointments
                  </Text>
                </>
              )}
            </View>
            <Donut value={value} size={44} />
          </Pressable>
        );
      })}
    </View>
  );
}

export function MonthView({ onPickDay }: { onPickDay: (d: Date) => void }) {
  const year = MOCK_TODAY.getFullYear();
  const month = MOCK_TODAY.getMonth();
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (Date | null)[] = [
    ...Array.from({ length: first.getDay() }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1)),
  ];
  while (cells.length % 7) cells.push(null);
  const rows = Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));

  return (
    <View className="gap-1">
      <View className="flex-row">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
          <Text key={i} variant="caption" tone="muted" className="flex-1 text-center">
            {d}
          </Text>
        ))}
      </View>
      {rows.map((row, r) => (
        <View key={r} className="flex-row">
          {row.map((d, i) => {
            if (!d) return <View key={i} className="flex-1" />;
            const value = busyness(d);
            const isToday = sameDay(d, MOCK_TODAY);
            return (
              <Pressable
                key={i}
                accessibilityRole="button"
                accessibilityLabel={`${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}, ${value ? `${Math.round(value * 100)}% booked` : 'closed'}`}
                onPress={() => {
                  haptics.selection();
                  onPickDay(d);
                }}
                className={cn(
                  'm-0.5 flex-1 items-center gap-1 rounded-lg py-1.5 active:bg-muted',
                  isToday && 'bg-primary-soft',
                )}
              >
                <Text
                  variant="footnote"
                  numeric
                  className={isToday ? 'font-bold text-primary-soft-foreground' : 'font-medium'}
                  tone={value ? 'default' : 'subtle'}
                >
                  {d.getDate()}
                </Text>
                {value ? (
                  <Donut value={value} size={26} strokeWidth={4} showLabel={false} />
                ) : (
                  <View style={{ height: 26 }} />
                )}
              </Pressable>
            );
          })}
        </View>
      ))}
      <Text variant="footnote" tone="muted" className="mt-3 text-center">
        Rings show how booked each day is. Tap a day to open it.
      </Text>
    </View>
  );
}
