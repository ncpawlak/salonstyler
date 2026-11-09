import {
  addDays,
  parseLocalDate,
  zonedParts,
  zonedToUtc,
  type DayUtilization,
} from '@chairside/core';
import { useState } from 'react';
import { View } from 'react-native';
import Svg, { Line, Rect } from 'react-native-svg';

import { useTheme } from '@/theme/theme-provider';

import { StripeDefs, useStripeId } from './day-ring';
import { useUtilizationPalette } from './palette';

/** Local wall-clock hours shown by every strip in a view, e.g. `{ start: 8, end: 20 }`. */
export interface HourWindow {
  start: number;
  end: number;
}

/**
 * The tightest whole-hour window covering every day's working hours and bookings, so all strips
 * in a week line up. Falls back to 9–17 when nothing is scheduled.
 */
export function hourWindow(days: readonly DayUtilization[], timeZone: string): HourWindow {
  let start = Infinity;
  let end = -Infinity;
  for (const d of days) {
    for (const run of d.runs) {
      if (run.state === 'closed') continue;
      const from = zonedParts(run.start, timeZone).minutes;
      const to = run.end >= d.end ? 1440 : zonedParts(run.end, timeZone).minutes || 1440;
      start = Math.min(start, from);
      end = Math.max(end, to);
    }
  }
  if (!Number.isFinite(start)) return { start: 9, end: 17 };
  return {
    start: Math.floor(start / 60),
    end: Math.max(Math.floor(start / 60) + 1, Math.ceil(end / 60)),
  };
}

/** Horizontal timeline for one day: booked solid, open green, tentative striped, off gray. */
export function DayStrip({
  day,
  window,
  timeZone,
  height = 14,
}: {
  day: DayUtilization;
  window: HourWindow;
  timeZone: string;
  height?: number;
}) {
  const { colors } = useTheme();
  const palette = useUtilizationPalette();
  const stripeId = useStripeId();
  const [width, setWidth] = useState(0);
  const local = parseLocalDate(day.date);
  const from = zonedToUtc(local, window.start * 60, timeZone);
  const to =
    window.end >= 24
      ? zonedToUtc(addDays(local, 1), 0, timeZone)
      : zonedToUtc(local, window.end * 60, timeZone);
  const x = (ms: number) => ((Math.min(Math.max(ms, from), to) - from) / (to - from)) * width;
  const radius = height / 2;

  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ height, borderRadius: radius, overflow: 'hidden' }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {width > 0 ? (
        <Svg width={width} height={height}>
          <StripeDefs id={stripeId} color={palette.tentativeStripe} size={5} />
          <Rect width={width} height={height} fill={palette.closed} />
          {day.runs
            .filter((run) => run.state !== 'closed' && run.end > from && run.start < to)
            .map((run) => {
              const left = x(run.start);
              const w = x(run.end) - left;
              return [
                <Rect
                  key={`${run.start}-fill`}
                  x={left}
                  width={w}
                  height={height}
                  fill={palette[run.state]}
                />,
                run.state === 'tentative' ? (
                  <Rect
                    key={`${run.start}-stripe`}
                    x={left}
                    width={w}
                    height={height}
                    fill={`url(#${stripeId})`}
                  />
                ) : null,
              ];
            })}
          {Array.from({ length: Math.max(0, window.end - window.start - 1) }, (_, i) => {
            const hx = ((i + 1) / (window.end - window.start)) * width;
            return (
              <Line
                key={i}
                x1={hx}
                x2={hx}
                y1={height * 0.3}
                y2={height * 0.7}
                stroke={colors.card}
                strokeOpacity={0.7}
                strokeWidth={1}
              />
            );
          })}
        </Svg>
      ) : null}
    </View>
  );
}

/** `9a  12p  3p  6p` labels aligned with `DayStrip` ticks. */
export function hourTicks(window: HourWindow): { hour: number; left: number; label: string }[] {
  const span = window.end - window.start;
  const step = span > 10 ? 3 : 2;
  const out = [];
  for (let h = Math.ceil(window.start / step) * step; h <= window.end; h += step) {
    const hour12 = h % 12 || 12;
    out.push({
      hour: h,
      left: (h - window.start) / span,
      label: `${hour12}${h % 24 >= 12 ? 'p' : 'a'}`,
    });
  }
  return out;
}
