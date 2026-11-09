import {
  formatDuration,
  getWorkingBlocks,
  parseLocalDate,
  zonedParts,
  zonedToUtc,
  type ServiceColorTag,
  type WorkHours,
} from '@chairside/core';
import type { AppointmentWithDetails } from '@chairside/db/appointments';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import {
  GestureDetector,
  useCompetingGestures,
  useLongPressGesture,
  usePanGesture,
  useTapGesture,
} from 'react-native-gesture-handler';

import { Text } from '@/components/ui';
import { haptics } from '@/lib/haptics';
import { useTheme } from '@/theme/theme-provider';

import { COLOR_HEX } from '../services/colors';
import { formatTime } from './format';

const HOUR_HEIGHT = 76;
const GUTTER = 52;
const MS_PER_PX = 3_600_000 / HOUR_HEIGHT;

export interface DayTimelineProps {
  /** Local `YYYY-MM-DD` in the salon's time zone. */
  date: string;
  hours: WorkHours;
  appointments: readonly AppointmentWithDetails[];
  gridMinutes: number;
  now: number;
  /** Long-press on empty time (snapped to the grid). */
  onCreate: (start: number) => void;
  onSelect: (appointment: AppointmentWithDetails) => void;
  /** Drag-and-drop finished; `deltaMinutes` is already snapped to the grid. */
  onMove: (appointment: AppointmentWithDetails, deltaMinutes: number) => void;
  /** Appointment ids with a move in flight, drawn at their pending offset. */
  pendingMoves?: Readonly<Record<string, number>>;
}

interface Layout {
  appt: AppointmentWithDetails;
  start: number;
  end: number;
  /** 1 = booked inside another appointment's processing time. */
  column: 0 | 1;
  colorTag: ServiceColorTag;
}

function layoutAppointments(appointments: readonly AppointmentWithDetails[]): Layout[] {
  const processing = appointments.flatMap((a) =>
    a.segments
      .filter((s) => s.kind === 'processing')
      .map((s) => ({ id: a.id, start: Date.parse(s.start), end: Date.parse(s.end) })),
  );
  return appointments.map((appt) => {
    const clientStart = Date.parse(appt.starts_at);
    const nested = processing.some(
      (p) => p.id !== appt.id && clientStart >= p.start && clientStart < p.end,
    );
    return {
      appt,
      start: Math.min(...appt.segments.map((s) => Date.parse(s.start))),
      end: Math.max(...appt.segments.map((s) => Date.parse(s.end))),
      column: nested ? 1 : 0,
      colorTag: (appt.services[0]?.colorTag as ServiceColorTag | undefined) ?? 'indigo',
    };
  });
}

export function DayTimeline({
  date,
  hours,
  appointments,
  gridMinutes,
  now,
  onCreate,
  onSelect,
  onMove,
  pendingMoves,
}: DayTimelineProps) {
  const { colors } = useTheme();
  const tz = hours.timeZone;
  const local = parseLocalDate(date);
  const working = useMemo(() => getWorkingBlocks(hours, date), [hours, date]);
  const layouts = useMemo(() => layoutAppointments(appointments), [appointments]);

  // Visible hours: 8 AM–7 PM, widened to fit work hours and bookings.
  const localHour = (ms: number) => zonedParts(ms, tz).minutes / 60;
  const instants = [
    ...working.open,
    ...working.tentative,
    ...layouts.map((l) => ({ start: l.start, end: l.end })),
  ];
  const dayStart = zonedToUtc(local, 0, tz);
  const dayEnd = zonedToUtc(local, 24 * 60, tz);
  let firstHour = 8;
  let lastHour = 19;
  for (const r of instants) {
    if (r.start >= dayStart) firstHour = Math.min(firstHour, Math.floor(localHour(r.start)));
    else firstHour = 0;
    if (r.end <= dayEnd)
      lastHour = Math.max(lastHour, Math.ceil(localHour(r.end - 1) + 1 / 60) || 24);
    else lastHour = 24;
  }
  const origin = zonedToUtc(local, firstHour * 60, tz);
  const end = zonedToUtc(local, lastHour * 60, tz);
  const y = (ms: number) => (ms - origin) / MS_PER_PX;
  const height = y(end);
  const hourMarks = Array.from({ length: lastHour - firstHour + 1 }, (_, i) => firstHour + i);

  const longPress = useLongPressGesture({
    minDuration: 400,
    runOnJS: true,
    onActivate: (e) => {
      const grid = gridMinutes * 60_000;
      const at = origin + Math.max(0, e.y) * MS_PER_PX;
      // Snap down so the slot starts where the finger is.
      const start = Math.floor((at - dayStart) / grid) * grid + dayStart;
      haptics.heavy();
      onCreate(start);
    },
  });

  return (
    <View style={{ height: height + 24 }} className="mt-2">
      {/* Work hours shading */}
      {[...working.open, ...working.tentative].map((r, i) => (
        <View
          key={`h${i}`}
          pointerEvents="none"
          className="absolute right-0 rounded-md"
          style={{
            left: GUTTER,
            top: Math.max(0, y(r.start)),
            height: Math.min(height, y(r.end)) - Math.max(0, y(r.start)),
            backgroundColor: i < working.open.length ? colors.card : colors.muted,
          }}
        />
      ))}

      {hourMarks.map((h) => (
        <View
          key={h}
          pointerEvents="none"
          className="absolute left-0 right-0 flex-row items-start"
          style={{ top: y(zonedToUtc(local, h * 60, tz)) }}
        >
          <Text variant="caption" tone="muted" style={{ width: GUTTER, marginTop: -8 }} numeric>
            {h % 12 === 0 ? 12 : h % 12} {h >= 12 && h < 24 ? 'PM' : 'AM'}
          </Text>
          <View className="h-px flex-1 bg-border" />
        </View>
      ))}

      <GestureDetector gesture={longPress}>
        <View
          accessibilityLabel="Day timeline. Long-press an empty time to book."
          testID="day-timeline-grid"
          className="absolute right-0"
          style={{ left: GUTTER, top: 0, height }}
        />
      </GestureDetector>

      {layouts.map((l) => (
        <AppointmentBlock
          key={l.appt.id}
          layout={l}
          y={y}
          timeZone={tz}
          gridMinutes={gridMinutes}
          pendingMinutes={pendingMoves?.[l.appt.id]}
          onSelect={onSelect}
          onMove={onMove}
        />
      ))}

      {now >= origin && now <= end ? (
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          className="absolute right-0 flex-row items-center"
          style={{ top: y(now) - 4, left: GUTTER - 6 }}
        >
          <View className="h-2 w-2 rounded-full bg-destructive" />
          <View className="h-0.5 flex-1 bg-destructive" />
        </View>
      ) : null}
    </View>
  );
}

function AppointmentBlock({
  layout,
  y,
  timeZone,
  gridMinutes,
  pendingMinutes,
  onSelect,
  onMove,
}: {
  layout: Layout;
  y: (ms: number) => number;
  timeZone: string;
  gridMinutes: number;
  pendingMinutes?: number;
  onSelect: (a: AppointmentWithDetails) => void;
  onMove: (a: AppointmentWithDetails, deltaMinutes: number) => void;
}) {
  const { colors } = useTheme();
  const { appt, column } = layout;
  const [dragPx, setDragPx] = useState<number | null>(null);
  const snap = (px: number) => Math.round((px * MS_PER_PX) / 60_000 / gridMinutes) * gridMinutes;

  const tap = useTapGesture({
    runOnJS: true,
    onActivate: () => {
      haptics.selection();
      onSelect(appt);
    },
  });
  const pan = usePanGesture({
    activateAfterLongPress: 300,
    runOnJS: true,
    onActivate: () => {
      haptics.heavy();
      setDragPx(0);
    },
    onUpdate: (e) => setDragPx(e.translationY),
    onDeactivate: (e) => {
      setDragPx(null);
      const delta = snap(e.translationY);
      if (!e.canceled && delta !== 0) onMove(appt, delta);
    },
  });
  const gesture = useCompetingGestures(pan, tap);

  const hex = COLOR_HEX[layout.colorTag];
  const deltaMinutes = dragPx !== null ? snap(dragPx) : (pendingMinutes ?? 0);
  const offset = (deltaMinutes * 60_000) / MS_PER_PX;
  const clientStart = Date.parse(appt.starts_at) + deltaMinutes * 60_000;
  const clientEnd = Date.parse(appt.ends_at) + deltaMinutes * 60_000;
  const minutes = Math.round((clientEnd - clientStart) / 60_000);
  const held = appt.status === 'held' || appt.status === 'requested';
  const done = appt.status === 'completed';
  const name = appt.client?.name ?? 'Walk-in';
  const services = appt.services.map((s) => s.name).join(' + ') || 'Appointment';
  const top = y(layout.start);

  return (
    <GestureDetector gesture={gesture}>
      <View
        accessibilityRole="button"
        accessibilityLabel={`${name}, ${services}, ${formatTime(clientStart, timeZone)} to ${formatTime(clientEnd, timeZone)}, ${appt.status}. Tap for details, hold and drag to move.`}
        testID={`appointment-${appt.id}`}
        pointerEvents="box-none"
        className="absolute"
        style={{
          top: top + offset,
          height: y(layout.end) - top,
          left: column === 1 ? '58%' : GUTTER,
          right: 0,
          opacity: dragPx !== null ? 0.85 : done ? 0.6 : 1,
          zIndex: dragPx !== null ? 10 : column + 1,
        }}
      >
        {appt.segments.map((s, i) => {
          const segTop = y(Date.parse(s.start)) - top;
          const segHeight = Math.max(6, y(Date.parse(s.end)) - y(Date.parse(s.start)) - 1);
          const processing = s.kind === 'processing';
          const buffer = s.kind === 'buffer';
          const first = i === appt.segments.findIndex((x) => x.kind !== 'buffer');
          return (
            <View
              key={i}
              className="absolute left-0 overflow-hidden rounded-md px-2"
              style={{
                top: segTop,
                height: segHeight,
                right: processing && column === 0 ? '48%' : 0,
                backgroundColor: buffer ? colors.muted : processing ? 'transparent' : `${hex}2e`,
                borderLeftWidth: buffer ? 0 : processing ? 1 : 3,
                borderWidth: processing || held ? 1 : 0,
                borderStyle: processing || held ? 'dashed' : 'solid',
                borderColor: hex,
                paddingVertical: segHeight < 24 ? 0 : 3,
              }}
            >
              {first && segHeight >= 18 ? (
                <Text variant="footnote" numberOfLines={1} className="font-semibold">
                  {held ? `${appt.status === 'held' ? 'Hold' : 'Request'} · ` : ''}
                  {name}
                </Text>
              ) : processing && segHeight >= 18 ? (
                <Text variant="caption" tone="muted" numberOfLines={1}>
                  {s.label ?? 'Processing'} · free
                </Text>
              ) : null}
              {first && segHeight > 40 ? (
                <Text variant="caption" tone="muted" numberOfLines={1}>
                  {formatTime(clientStart, timeZone)} · {services} · {formatDuration(minutes)}
                </Text>
              ) : null}
            </View>
          );
        })}
        {dragPx !== null ? (
          <View
            pointerEvents="none"
            className="absolute -top-6 left-0 rounded-md bg-foreground px-2 py-0.5"
          >
            <Text variant="caption" style={{ color: colors.background }}>
              {formatTime(clientStart, timeZone)}
            </Text>
          </View>
        ) : null}
      </View>
    </GestureDetector>
  );
}
